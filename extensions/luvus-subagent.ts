/**
 * luvus-subagent — Luvus-backed subagents for Pi.
 *
 * A subagent is a real `pi` process running in a Luvus pane, so it is visible,
 * interruptible, and steerable while it works. Agents are declared once in
 * `.pi/agents/*.md` and their frontmatter becomes the child's launch argv.
 *
 * Design: the child owns its pane (a PTY owned by the Luvus server), so every
 * delegation is out-of-process by construction. `wait` decides only whether the
 * parent blocks; it does not change where the child runs.
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	CONFIG_DIR_NAME,
	CustomEditor,
	type ExtensionAPI,
	type ExtensionUIContext,
	getAgentDir,
	getMarkdownTheme,
	parseFrontmatter,
} from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { installStateReporter } from "./luvus-subagent/state-reporter.ts";

// ── Constants ──────────────────────────────────────────────────────────────

/** Thinking levels Pi accepts on `--thinking`. */
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/**
 * Roots searched for a skill named in agent frontmatter, in priority order.
 *
 * Pi resolves skills against several roots and exposes no accessor for the
 * resolved set, so the name→path mapping lives here.
 */
const skillRoots = (cwd: string): string[] => [
	join(cwd, CONFIG_DIR_NAME, "skills"),
	join(getAgentDir(), "skills"),
	join(homedir(), ".agents", "skills"),
];

/**
 * One shared directory holds every child session, so a delegation is identified
 * by its pinned session id instead of by owning a directory. It sits outside
 * `sessions/` to stay clear of Pi's own project grouping.
 */
const SESSION_DIR = join(homedir(), ".pi", "agent", "subagent-sessions");

/** The retention windows below count days; this is one day in milliseconds. */
const MS_PER_DAY = 86_400_000;

/** Child sessions older than this are swept on the next delegation. */
const SESSION_RETENTION_DAYS = 7;

/**
 * Set on a launched child so it loads this extension for state reporting only.
 *
 * Every Pi process here runs inside a Luvus pane — the parent included — so the
 * environment cannot tell a child from its parent. An explicit flag can.
 */
const SUBAGENT_CHILD_FLAG = "subagent-child";

/**
 * Agent bodies land here as files. The prompt flags take argv directly, so this
 * is not about quoting — it keeps a body out of `ps` output. A child reads its
 * file during startup, so a settled delegation deletes it; a launch that never
 * gets that far leaves it to `sweepExpiredPrompts`.
 */
const PROMPT_DIR = join(tmpdir(), "luvus-subagent-prompts");

/** A prompt file holds an agent body, so it is readable by its owner alone. */
const PROMPT_FILE_MODE = 0o600;

/** Prompt files are read during startup, so they need only a short window. */
const PROMPT_RETENTION_DAYS = 1;

/**
 * Drop files past a retention window.
 *
 * Both sweeps below are the same shape: a cutoff, one directory listing, and a
 * best-effort delete. Only the directory, the window, and which entries count
 * differ, so those are the parameters; `keep` says which entries are eligible.
 */
function sweepExpired(dir: string, retentionDays: number, keep: (entry: string) => boolean): void {
	if (!isDirectory(dir)) return;
	const cutoff = Date.now() - retentionDays * MS_PER_DAY;
	for (const entry of readdirSync(dir)) {
		if (!keep(entry)) continue;
		const file = join(dir, entry);
		try {
			if (statSync(file).mtimeMs < cutoff) rmSync(file, { force: true });
		} catch {
			// A file we cannot stat is not worth failing a delegation over.
		}
	}
}

/**
 * Drop prompt files past that window.
 *
 * The backstop for launches that never reached a settle — a failed `agent
 * start`, or a parent that died mid-delegation. A completed delegation removes
 * its own file instead of waiting for this.
 */
function sweepExpiredPrompts(): void {
	sweepExpired(PROMPT_DIR, PROMPT_RETENTION_DAYS, () => true);
}

/**
 * Drop child sessions past their retention window.
 *
 * Swept lazily on each delegation rather than on a timer: delegations are the
 * only thing that grows this directory, so they are also the right moment to
 * trim it.
 */
function sweepExpiredSessions(): void {
	sweepExpired(SESSION_DIR, SESSION_RETENTION_DAYS, (entry) => entry.endsWith(".jsonl"));
}
/**
 * This extension's own file, so a launched child loads it too.
 *
 * The child needs it for the state reporter; without that its pane never
 * reports `done` and every blocking wait runs to its full timeout.
 */
const SELF_PATH = (() => {
	try {
		const url = import.meta.url;
		return url.startsWith("file:") ? fileURLToPath(url) : undefined;
	} catch {
		return undefined;
	}
})();

// ── Types ──────────────────────────────────────────────────────────────────

export type AgentConfig = {
	name: string;
	description: string;
	tools?: string[];
	disallowedTools?: string[];
	model?: string;
	thinking?: string;
	/** Skill names or paths; resolved to SKILL.md paths at launch time. */
	skills?: string[];
	/** `replace` (the default) makes the agent body the preamble; `append` puts it after Pi's. */
	promptMode: "replace" | "append";
	systemPrompt: string;
	source: "user" | "project";
	filePath: string;
};

/** Raw frontmatter values are `unknown`: a real YAML parser runs over them. */
type AgentFrontmatter = {
	name?: unknown;
	description?: unknown;
	tools?: unknown;
	disallowed_tools?: unknown;
	model?: unknown;
	thinking?: unknown;
	skills?: unknown;
	prompt_mode?: unknown;
};

// ── Parsing helpers ────────────────────────────────────────────────────────

/**
 * Normalize a frontmatter list to trimmed strings.
 *
 * Both spellings are valid YAML and both are in use:
 *
 *     tools: read, bash
 *     tools: [read, bash]
 *
 * Anything else yields undefined rather than throwing: one bad file must not
 * take down discovery for every other agent in the same directory.
 */
function parseList(value: unknown): string[] | undefined {
	const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
	const items = raw
		.filter((item): item is string => typeof item === "string")
		.map((item) => item.trim())
		.filter(Boolean);
	return items.length > 0 ? items : undefined;
}

function parseString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function parseThinking(value: unknown): string | undefined {
	const level = parseString(value)?.toLowerCase();
	if (level === undefined) return undefined;
	return (THINKING_LEVELS as readonly string[]).includes(level) ? level : undefined;
}

// ── Discovery ──────────────────────────────────────────────────────────────

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

/** Walk up from `cwd` to the nearest directory holding a `.pi/agents` folder. */
function findProjectAgentsDir(cwd: string): string | null {
	let current = resolve(cwd);
	for (;;) {
		const candidate = join(current, CONFIG_DIR_NAME, "agents");
		if (isDirectory(candidate)) return candidate;
		const parent = dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

function loadAgentsFromDir(dir: string, source: "user" | "project"): AgentConfig[] {
	if (!isDirectory(dir)) return [];
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return [];
	}

	const agents: AgentConfig[] = [];
	for (const entry of entries) {
		if (!entry.endsWith(".md")) continue;
		const filePath = join(dir, entry);

		let content: string;
		try {
			content = readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		let frontmatter: AgentFrontmatter;
		let body: string;
		try {
			const parsed = parseFrontmatter<AgentFrontmatter>(content);
			frontmatter = parsed.frontmatter;
			body = parsed.body;
		} catch {
			continue;
		}

		const name = parseString(frontmatter.name);
		if (name === undefined) continue;

		agents.push({
			name,
			description: parseString(frontmatter.description) ?? "",
			tools: parseList(frontmatter.tools),
			disallowedTools: parseList(frontmatter.disallowed_tools),
			model: parseString(frontmatter.model),
			thinking: parseThinking(frontmatter.thinking),
			skills: parseList(frontmatter.skills),
			promptMode: parseString(frontmatter.prompt_mode) === "append" ? "append" : "replace",
			systemPrompt: body.trim(),
			source,
			filePath,
		});
	}
	return agents;
}

/**
 * All agents visible to `cwd`. Project agents shadow user agents of the same
 * name, matching how Pi resolves its own project-local resources.
 */
export function discoverAgents(cwd: string): AgentConfig[] {
	const byName = new Map<string, AgentConfig>();
	for (const agent of loadAgentsFromDir(join(getAgentDir(), "agents"), "user")) {
		byName.set(agent.name, agent);
	}
	const projectDir = findProjectAgentsDir(cwd);
	if (projectDir !== null) {
		for (const agent of loadAgentsFromDir(projectDir, "project")) {
			byName.set(agent.name, agent);
		}
	}
	return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// ── Skill resolution ───────────────────────────────────────────────────────

/**
 * Resolve a frontmatter skill entry to a path Pi can load.
 *
 * Accepts an explicit path (anything containing a separator or ending in .md)
 * or a bare skill name, which is looked up as `<root>/<name>/SKILL.md`.
 */
export function resolveSkill(entry: string, cwd: string): string | undefined {
	const looksLikePath = entry.includes("/") || entry.endsWith(".md");
	if (looksLikePath) {
		const candidate = resolve(cwd, entry);
		return existsSync(candidate) ? candidate : undefined;
	}
	for (const root of skillRoots(cwd)) {
		const candidate = join(root, entry, "SKILL.md");
		if (existsSync(candidate)) return candidate;
	}
	return undefined;
}

// ── Preset → argv ──────────────────────────────────────────────────────────

export type LaunchPlan = {
	args: string[];
	/** Skill entries that resolved to nothing, reported instead of silently dropped. */
	unresolvedSkills: string[];
	/** Where the agent body goes, when the agent declares one. The caller writes it. */
	promptFile?: string;
};

/** Where a session's agent body goes. Pure: naming a file does not create it. */
function promptFileFor(sessionName: string): string {
	return join(PROMPT_DIR, `${sessionName}.md`);
}

/** Write an agent body for the child to read during startup. */
export function writePromptFile(file: string, body: string): void {
	mkdirSync(PROMPT_DIR, { recursive: true });
	writeFileSync(file, body, { encoding: "utf-8", mode: PROMPT_FILE_MODE });
}

/** Render argv for humans: an empty argument would otherwise be invisible. */
function formatArgv(args: string[]): string {
	return args.map((arg) => (arg.length === 0 ? '""' : arg)).join(" ");
}
/**
 * Build the child's launch argv from an agent definition.
 *
 * Everything a subagent is — model, thinking, tools, skills, prompt — is a Pi
 * CLI flag, so the preset needs no in-process session assembly. The session
 * directory and name are pinned here too, because the parent finds the child's
 * result by reading the only JSONL in the child's own session directory.
 */
export function prepareLaunch(
	agent: AgentConfig,
	cwd: string,
	sessionName: string,
	resumeFile?: string,
): LaunchPlan {
	// Pi names a session file `<timestamp>_<sessionId>.jsonl`, so pinning the id
	// makes this child's file findable in the shared directory by suffix alone.
	// Resuming skips all three flags: `--session <file>` reopens that conversation,
	// and the id it already carries is the one this delegation keeps.
	mkdirSync(SESSION_DIR, { recursive: true });
	const args: string[] =
		resumeFile === undefined
			? ["--session-dir", SESSION_DIR, "--session-id", sessionName, "--name", sessionName]
			: ["--session", resumeFile];

	// The child loads this same extension, which is what installs its reporter.
	if (SELF_PATH !== undefined && existsSync(SELF_PATH)) args.push("--extension", SELF_PATH);
	// Reporting yes, delegating no: a subagent must not spawn subagents.
	args.push(`--${SUBAGENT_CHILD_FLAG}`);

	if (agent.model !== undefined) args.push("--model", agent.model);
	if (agent.thinking !== undefined) args.push("--thinking", agent.thinking);

	// `--tools` and `--exclude-tools` are Pi's own allow/deny lists.
	if (agent.tools !== undefined) args.push("--tools", agent.tools.join(","));
	if (agent.disallowedTools !== undefined) args.push("--exclude-tools", agent.disallowedTools.join(","));

	// Discovery is always off: a subagent gets exactly the skills its own file
	// names, so an unrelated skill catalogue never reaches its prompt.
	args.push("--no-skills");
	const unresolvedSkills: string[] = [];
	for (const entry of agent.skills ?? []) {
		const path = resolveSkill(entry, cwd);
		if (path === undefined) {
			unresolvedSkills.push(entry);
			continue;
		}
		args.push("--skill", path);
	}

	let promptFile: string | undefined;
	if (agent.systemPrompt.length > 0) {
		promptFile = promptFileFor(sessionName);
		if (agent.promptMode === "replace") {
			// The empty append is load-bearing, not a typo: Pi discovers
			// `<agentDir>/APPEND_SYSTEM.md` only when no append source was passed,
			// and that file is the *main* agent's identity. An empty value adds no
			// addendum but still counts as a source, which is the only way to opt
			// out of the discovery — there is no `--no-append-system-prompt`.
			// Project context (AGENTS.md) stays on: that one is shared.
			args.push("--append-system-prompt", "", "--system-prompt", promptFile);
		} else {
			args.push("--append-system-prompt", promptFile);
		}
	}
	return { args, unresolvedSkills, promptFile };
}

// ── Luvus CLI ──────────────────────────────────────────────────────────────

/** The CLI inherits `LUVUS_SOCKET_PATH`; the extension never opens the socket itself. */
const luvusBinary = (): string => process.env.LUVUS_BIN_PATH?.trim() || "luvus";

/** How long a blocking delegation waits for the child before giving up. */
const WAIT_SECONDS = 900;
/**
 * The shortest gap between two watcher cycles.
 *
 * A wait that returns sooner than this did not run out, it failed. Re-arming at once
 * would spin, so the watcher waits out the floor — but it does not give up, because a
 * `working` record with no watcher is one nothing will ever settle.
 */
const WAIT_FLOOR_MS = 1_000;
/** How long a pane gets to close before it is left alone. */
const PANE_CLOSE_TIMEOUT_MS = 15_000;

/** How long a single key press gets to reach the child. */
const KEYSTROKE_TIMEOUT_MS = 15_000;
/** How long `agent prompt` gets to paste the task into the child's editor. */
const PROMPT_SUBMIT_TIMEOUT_MS = 30_000;
/** How long one read of a child's state gets. */
const AGENT_STATUS_TIMEOUT_MS = 10_000;

/** How often that read is repeated while a fresh child decides to start. */
const START_POLL_MS = 1_000;

/** How much of a CLI's stderr is quoted back when its reply is unreadable. */
const STDERR_TAIL_CHARS = 200;

/** How long a fresh child gets to leave `idle` before its task counts as unstarted. Measured: a second. */
const START_CONFIRM_SECONDS = 15;

/** How long a steer to a busy child waits for the host to see it picked the message up. */
const STEER_CONFIRM_SECONDS = 15;

const AGENT_START_TIMEOUT_MS = 120_000;

/** How long the child gets to come up before `agent start` gives up. */
const READY_TIMEOUT_SECONDS = 90;

type LuvusReply = {
	result: Record<string, unknown>;
	/** Non-zero means the CLI refused or timed out; callers decide whether that is fatal. */
	code: number;
};

/**
 * One Luvus CLI call.
 *
 * Luvus answers every command with `{id, result}` or `{id, error}`. A structured
 * error is thrown here because no caller can proceed past one; a non-zero exit
 * is handed back instead, because a wait that timed out is an outcome, not a bug.
 */
async function callLuvus(pi: ExtensionAPI, args: string[], timeoutMs: number): Promise<LuvusReply> {
	const exec = await pi.exec(luvusBinary(), args, { timeout: timeoutMs });
	const label = `luvus ${args[0]}${args[1] === undefined ? "" : ` ${args[1]}`}`;
	if (exec.killed) throw new Error(`${label}: timed out after ${Math.round(timeoutMs / 1000)}s`);

	const stdout = exec.stdout.trim();
	if (stdout.length === 0) {
		// Some commands (`wait …`) answer with the exit code alone.
		return { result: {}, code: exec.code };
	}
	let envelope: { result?: Record<string, unknown>; error?: { message?: string; code?: string } };
	try {
		envelope = JSON.parse(stdout) as typeof envelope;
	} catch {
		const tail = exec.stderr.trim().slice(-STDERR_TAIL_CHARS);
		throw new Error(`${label}: unreadable reply${tail.length > 0 ? ` (${tail})` : ""}`);
	}
	if (envelope.error !== undefined) {
		throw new Error(`${label}: ${envelope.error.message ?? envelope.error.code ?? "failed"}`);
	}
	return { result: envelope.result ?? {}, code: exec.code };
}

/** A child pane's id, or "" when the CLI named none. */
async function startChild(pi: ExtensionAPI, sessionName: string, args: string[]): Promise<string> {
	const started = await callLuvus(
		pi,
		// `--auto` lets Luvus pick the split direction, so a fourth child can land below
		// or above instead of the panes marching sideways forever.
		["agent", "start", sessionName, "--kind", "pi", "--auto", "--timeout", String(READY_TIMEOUT_SECONDS), "--", ...args],
		AGENT_START_TIMEOUT_MS,
	);
	return typeof started.result.pane === "string" ? started.result.pane : "";
}

async function pressKey(pi: ExtensionAPI, sessionName: string, key: string): Promise<void> {
	await callLuvus(pi, ["agent", "keys", sessionName, key], KEYSTROKE_TIMEOUT_MS);
}

/** A pane probe is one fast read; a Luvus that hangs must not stall a delegation. */
const PANE_PROBE_TIMEOUT_MS = 10_000;

/** How a wait ended. `gone` is not a timeout: no state will ever arrive for that pane. */
type SettleOutcome = "settled" | "timeout" | "gone";

/**
 * Whether a delegation's pane still exists.
 *
 * Luvus answers a missing target with an error envelope and a non-zero exit, which
 * `callLuvus` turns into a throw — so the envelope is read here. Only a definite
 * `not_found` counts: a Luvus that cannot be reached has not said the pane is gone.
 */
async function paneIsGone(pi: ExtensionAPI, pane: string): Promise<boolean> {
	const probe = await pi
		.exec(luvusBinary(), ["agent", "get", pane], { timeout: PANE_PROBE_TIMEOUT_MS })
		.catch(() => undefined);
	if (probe === undefined || probe.killed) return false;
	try {
		const envelope = JSON.parse(probe.stdout.trim()) as { error?: { code?: string } };
		return envelope.error?.code === "not_found";
	} catch {
		return false;
	}
}

/**
 * How a child ended: settled, still running, or its pane gone.
 *
 * `seconds` defaults to the window a blocking delegation uses; the status tool
 * passes its own, so asking about a child is never tied to that constant. Luvus
 * reports a closed pane and an expired wait with the same exit code and no JSON,
 * so a non-zero result asks the pane itself — a closed pane answers at once, and
 * reading that as "still running" is what leaves a parent counting for nothing.
 */
async function waitForSettle(pi: ExtensionAPI, pane: string, seconds = WAIT_SECONDS): Promise<SettleOutcome> {
	const done = await callLuvus(
		pi,
		["wait", "agent-status", pane, "--status", "done", "--timeout", String(seconds)],
		(seconds + 30) * 1000,
	);
	if (done.code === 0) return "settled";
	return (await paneIsGone(pi, pane)) ? "gone" : "timeout";
}

async function closePane(pi: ExtensionAPI, pane: string): Promise<void> {
	try {
		await callLuvus(pi, ["pane", "close", pane], PANE_CLOSE_TIMEOUT_MS);
	} catch {
		// A pane that outlives its delegation is clutter, not a failure.
	}
}


// ── Result from the child's own session ────────────────────────────────────

/** Stop reasons that mean the assistant message is final rather than intermediate. */
const TERMINAL_STOP_REASONS = new Set(["stop", "endTurn", "length", "error", "aborted"]);

/**
 * How a child's last turn ended, as a closed set.
 *
 * Pi reports no finer cause than `stopReason`, and the provider's own words ride along
 * in `errorMessage` — so this never guesses at one. `no-answer` and `pane closed` are
 * not turn outcomes but delegation ones: the first is a child that settled without
 * writing anything, the second a pane that stopped existing.
 */
type ChildOutcome = "done" | "truncated" | "aborted" | "error" | "no-answer" | "pane closed" | "still running";

type ChildResult = { status: "completed" | "failed"; text: string; outcome: ChildOutcome };

/**
 * The word and the parenthetical note for one outcome.
 *
 * The note states what happened, never what to do about it: naming an action raises
 * its salience, which is how a parent that reads partial output as a finished result
 * ends up delegating the same work twice. Same shape as `pi-subagents`.
 */
function outcomeLine(outcome: ChildOutcome): { word: string; note: string } {
	switch (outcome) {
		case "truncated":
			return { word: "truncated", note: "(hit the output limit before finishing — the answer may be truncated)" };
		case "aborted":
			return {
				word: "aborted",
				note: "(aborted before it finished — the answer may be incomplete; its pane is still there)",
			};
		case "error":
			return {
				word: "error",
				note: "(its last turn ended as error — the task did not finish; its pane is still there)",
			};
		case "no-answer":
			return {
				word: "no answer",
				note: "(it settled without writing an answer — there is no result to read; its pane is still there)",
			};
		case "pane closed":
			return { word: "pane closed", note: "(its pane was closed before it finished)" };
		case "still running":
			return { word: "still running", note: "" };
		default:
			return { word: "done", note: "" };
	}
}
/**
 * The file Pi wrote for one child session, or undefined when there is none.
 *
 * Pi names a session file `<timestamp>_<sessionId>.jsonl`; the pinned id is
 * the suffix, so this names one child exactly.
 */
function sessionFileFor(sessionId: string): string | undefined {
	if (!isDirectory(SESSION_DIR)) return undefined;
	const name = readdirSync(SESSION_DIR).find((entry) => entry.endsWith(`_${sessionId}.jsonl`));
	if (name === undefined) return undefined;
	return join(SESSION_DIR, name);
}

/**
 * Read the child's answer from the session file it wrote.
 *
 * Reading the session beats scraping the pane: the pane holds a rendered TUI
 * (borders, status bars, spinners) and only the visible tail, while the session
 * holds the complete message with a terminal stop reason.
 */
function readChildResult(sessionId: string): ChildResult | undefined {
	const filePath = sessionFileFor(sessionId);
	if (filePath === undefined) return undefined;

	let terminal: { text: string; stopReason: string; errorMessage?: string } | undefined;
	for (const line of readFileSync(filePath, "utf-8").split("\n")) {
		if (line.trim().length === 0) continue;
		let entry: unknown;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		const message = (entry as { type?: string; message?: Record<string, unknown> }).message;
		if ((entry as { type?: string }).type !== "message" || message === undefined) continue;
		if (message.role !== "assistant") continue;
		const stopReason = message.stopReason;
		if (typeof stopReason !== "string" || !TERMINAL_STOP_REASONS.has(stopReason)) continue;
		const content = Array.isArray(message.content) ? message.content : [];
		const text = content
			.filter((part): part is { type: string; text: string } => {
				const candidate = part as { type?: unknown; text?: unknown };
				return candidate.type === "text" && typeof candidate.text === "string";
			})
			.map((part) => part.text)
			.join("");
		terminal = {
			text,
			stopReason,
			errorMessage: typeof message.errorMessage === "string" ? message.errorMessage : undefined,
		};
	}

	if (terminal === undefined) return undefined;
	if (terminal.stopReason === "error" || terminal.stopReason === "aborted") {
		// What the turn produced outranks why it ended: an interrupted turn often holds a
		// complete answer, and the provider's own error line would throw it away.
		return {
			status: "failed",
			outcome: terminal.stopReason === "aborted" ? "aborted" : "error",
			text: terminal.text.trim() || terminal.errorMessage?.trim() || `Subagent ${terminal.stopReason} before producing a result.`,
		};
	}
	return {
		status: "completed",
		outcome: terminal.stopReason === "length" ? "truncated" : "done",
		text: terminal.text.trim() || "(no output)",
	};
}

/**
 * How much of one message's answers are pushed into the parent's context.
 *
 * The official subagent example caps its own output at this size; past it the
 * answer still lives in the child's pane and session file. The cap is on the
 * message, so a burst that settles together cannot push one cap per child.
 */
const COMPLETION_OUTPUT_CAP = 50 * 1024;

/** Lines of the answer shown before the card asks for Ctrl+O. */
const COLLAPSED_LINES = 3;

function capCompletion(text: string, room = COMPLETION_OUTPUT_CAP): string {
	if (text.length <= room) return text;
	const kb = COMPLETION_OUTPUT_CAP / 1024;
	if (room <= 0) return `(answer omitted: this notice already reached ${kb}KB — read it with subagent_status or in the child's pane)`;
	return `${text.slice(0, room)}\n\n… truncated at ${kb}KB per notice; the rest is in the child's pane and session file.`;
}

/** How a delegation ended, from the wait that observed it and the child's own last turn. */
function endedOf(outcome: SettleOutcome | undefined, result: ChildResult | undefined): ChildOutcome {
	return outcome === "gone" ? "pane closed" : outcome === "settled" ? (result?.outcome ?? "no-answer") : "still running";
}

/**
 * The registry state for a delegation whose wait ended.
 *
 * A closed pane is a failure whatever the transcript says; otherwise the child's own last
 * turn decides. One rule for the widget, the notice and the tool result: three spellings of
 * it used to drift apart.
 */
function settledState(outcome: SettleOutcome | undefined, result: ChildResult | undefined): "done" | "failed" {
	return outcome === "gone" || result?.status === "failed" ? "failed" : "done";
}

/**
 * The answer text for a delegation, or the placeholder when there is none.
 *
 * A missing answer only needs saying while the child may still produce one: when the
 * outcome's note already explains why there is none, the placeholder is noise.
 */
function shownResult(result: ChildResult | undefined, ended: ChildOutcome): string {
	if (result !== undefined) return capCompletion(result.text);
	return ended === "still running" ? "(no result was written)" : "";
}

/**
 * Completion notices, delivered as one message.
 *
 * A notice that arrives while an earlier one is still waiting to be delivered rides
 * along with it, so a burst of children settling costs the parent one wake-up instead
 * of one each. Identity is what says the queued message went out: `message_start`
 * hands back the same array. The settled-and-idle check is the net under it, because a
 * delivery discarded with Escape never starts, and nothing else would clear it.
 *
 * `steer`, not `followUp`: while the parent is streaming, Pi reads the mode and delivers a
 * steer after the current turn's tool calls and before the next model call, so the notice
 * reaches a parent that can still act on it; a follow-up waits for the whole turn to end,
 * which is how a parent that already asked ends up handed the same answer twice. While the
 * parent is idle the two are the same thing — `triggerTurn` starts the run either way — and
 * a steer cannot split a tool call from its result.
 */
let pendingNotice: { type: "text"; text: string }[] | undefined;

function sendNotice(pi: ExtensionAPI, header: string, body: string): void {
	const queued = pendingNotice !== undefined;
	pendingNotice ??= [];
	// The cap is on the message, not on one child: a burst that settles together is one
	// message, so it must not push one cap per child into the parent. Only the body is capped:
	// a header says which child this is and how it ended, and nothing else in the message does.
	const used = pendingNotice.reduce((total, part) => total + part.text.length, 0);
	const shown = capCompletion(body, COMPLETION_OUTPUT_CAP - used);
	pendingNotice.push({ type: "text", text: shown.length > 0 ? `${header}\n\n${shown}` : header });
	if (queued) return;
	pi.sendMessage(
		{
			customType: "luvus-subagent-completion",
			// The answer rides along, capped; the renderer draws each part as its own
			// header plus a few lines, so the transcript stays readable without hiding
			// the result from the parent.
			content: pendingNotice,
			display: true,
		},
		{ deliverAs: "steer", triggerTurn: true },
	);
}

/**
 * Draw a completion notice as a card: one header per child, then a few lines of its
 * answer, the rest behind Ctrl+O.
 *
 * The model still receives the whole text — packaging the display is what keeps the
 * transcript readable, and dropping the text instead would hide the answer from the
 * parent. A header's glyph is its status, so a merged card colours every child right.
 */
function registerCompletionRenderer(pi: ExtensionAPI): void {
	pi.registerMessageRenderer("luvus-subagent-completion", (message, { expanded, outputPad }, theme) => {
		const parts =
			typeof message.content === "string"
				? [message.content]
				: message.content.filter((part) => part.type === "text").map((part) => part.text);
		const box = new Box(outputPad, 1, (line) => theme.bg("customMessageBg", line));
		for (const part of parts) {
			const [head = "", ...rest] = part.split("\n");
			const body = rest.filter((line) => line.trim().length > 0);
			const color = head.startsWith("✗") ? "error" : head.startsWith("⌛") ? "muted" : "success";
			box.addChild(new Text(theme.fg(color, head), 0, 0));
			if (expanded) {
				if (body.length > 0) box.addChild(new Markdown(body.join("\n"), 0, 0, getMarkdownTheme()));
				continue;
			}
			const preview = body.slice(0, COLLAPSED_LINES);
			if (preview.length > 0) box.addChild(new Text(theme.fg("toolOutput", preview.join("\n")), 0, 0));
			if (body.length > preview.length) {
				box.addChild(
					new Text(
						theme.fg("muted", `… ${body.length - preview.length} more lines (Ctrl+O to expand)`),
						0,
						0,
					),
				);
			}
		}
		return box;
	});
}
/**
 * Watch a background child to completion and hand its result to the parent.
 *
 * Detached on purpose: the delegation has already returned, so nothing awaits
 * this promise. Messaging the session is what tells the parent the child is
 * done, so this is the only delivery path a background delegation has.
 */
type SettleWatch = {
	pi: ExtensionAPI;
	pane: string;
	sessionId: string;
	agentName: string;
	promptFile: string | undefined;
	isStale: () => boolean;
};

async function deliverWhenSettled(watch: SettleWatch): Promise<void> {
	const { pi, pane, sessionId, agentName, promptFile, isStale } = watch;
	// The registry owns the start time, so the notice and the widget agree.
	const startedAt = delegations.get(sessionId)?.startedAt ?? Date.now();
	let outcome: SettleOutcome = "timeout";
	try {
		// A wait that ran out is not the child's end, so the watcher keeps watching until
		// it settles or its pane dies: a long task is never recorded as finished while it
		// is still running. The floor stops a wait that fails at once from spinning.
		for (;;) {
			const cycleStart = Date.now();
			outcome = await waitForSettle(pi, pane);
			if (outcome !== "timeout" || isStale()) break;
			const spent = Date.now() - cycleStart;
			// A wait that failed at once is not the child's end: wait out the floor and watch
			// again, rather than leave a `working` record that nothing will ever settle.
			if (spent < WAIT_FLOOR_MS) await new Promise((resolve) => setTimeout(resolve, WAIT_FLOOR_MS - spent));
		}
		const result = readChildResult(sessionId);
		// A closed pane is a delegation that ended without finishing; a wait that ran out
		// leaves a child that is still working, which is not a failure and not an end.
		// The one rule, computed once: the settle entry, the widget and the notice's glyph
		// all read it, so a card cannot contradict the row it belongs to.
		const state = settledState(outcome, result);
		if (outcome !== "timeout") settleDelegation(sessionId, state);
		if (isStale()) return;

		const elapsed = `${Math.round((Date.now() - startedAt) / 1000)}s`;
		// The notice carries the same single dimension as the tool result.
		const ended = endedOf(outcome, result);
		const line = outcomeLine(ended);
		// The glyph is the state, so the card and the widget agree; `line.word` still carries
		// the nuance — `truncated`, `no-answer`. A `still running` outcome cannot reach here:
		// the loop gives up only on a wait that ended or on a session that is stale.
		const header = `${state === "done" ? "✓" : "✗"} ${agentName} (${line.word}, ${elapsed}, ${sessionId})`;
		// A parent that already pulled this answer has it; the notice is the fallback for one
		// that never asked, so there is nothing to hand over twice.
		if (alreadyReported(sessionId)) return;
		const shown = shownResult(result, ended);
		const body = [shown, line.note].filter((part) => part.length > 0).join("\n\n");
		sendNotice(pi, header, body);
	} catch (error) {
		settleDelegation(sessionId, "failed");
		if (isStale()) return;
		if (alreadyReported(sessionId)) return;
		sendNotice(pi, `✗ ${agentName} (${sessionId}) — could not read its result: ${String(error)}`, "");
	} finally {
		await teardownDelegation({ pi, pane, promptFile, settled: outcome === "settled" });
	}
}

/**
 * Remove a delegation's prompt file and, when it settled, close its pane.
 *
 * The prompt file goes first and unconditionally: even a child that never
 * settled read its body during startup. A pane still working is kept.
 */
async function teardownDelegation(watch: {
	pi: ExtensionAPI;
	pane: string;
	promptFile: string | undefined;
	settled: boolean;
}): Promise<void> {
	const { pi, pane, promptFile, settled } = watch;
	// A child that never settled keeps its pane: it is still working, and
	// closing it would kill work the parent was told is still in progress.
	// The child read its body during startup; by now it cannot still need it.
	if (promptFile !== undefined) rmSync(promptFile, { force: true });
	if (!settled) return;
	await closePane(pi, pane);
}

// ── Where a child is shown, and what the parent sees while it runs ─────────

/** Key the status line and the widget are published under. */
const STATUS_KEY = "subagents";

type Delegation = {
	startedAt: number;
	endedAt?: number;
	state: "working" | "done" | "failed";
	pane: string;
	/** The parent turn it settled in: the widget's linger is counted in turns. */
	settledTurn?: number;
	/**
	 * When the answer reached the parent. Both delivery paths set it — the result a parent
	 * pulled, and the blocking call's own result — so the pushed notice can tell that it has
	 * nothing left to add. Whichever path delivers first wins; the notice is the fallback for
	 * a parent that never asked.
	 */
	reportedAt?: number;
};

/** A record outlives the widget, and only age retires it — the reference's 10 minutes. */
const RECORD_RETENTION_MS = 10 * 60_000;
/** How many parent turns the widget keeps a settled row, per the reference. */
const LINGER_TURNS = 1;
/** The parent turn counter the linger is measured in. */
let turn = 0;

/**
 * The session entries the registry is rebuilt from.
 *
 * Pi stores a custom entry without sending it to the model, so the record costs no
 * context and travels with the conversation: a reload, a restart or a compaction
 * brings the delegations back instead of losing them with the process.
 */
const DELEGATION_ENTRY = "luvus-subagent-delegation";
const SETTLED_ENTRY = "luvus-subagent-settled";

type DelegationEntry = { sessionName: string; agent: string; task: string; pane: string; startedAt: number };
type SettledEntry = { sessionName: string; state: "done" | "failed"; endedAt: number };

/** The API entries are appended through; set once at load, like the widget's UI. */
let entryApi: ExtensionAPI | undefined;

/**
 * One entry per delegation this session, keyed by session name — the only id the
 * tool and the detached watcher both hold.
 *
 * Records outlive the widget, the way the reference separates them: a settled
 * delegation stays queryable for ten minutes, while the widget draws it for a turn
 * or two and not at all once nothing is running. Clearing the screen is not forgetting.
 */
const delegations = new Map<string, Delegation>();
let statusUi: ExtensionUIContext | undefined;
let statusTicker: ReturnType<typeof setInterval> | undefined;

// There is deliberately no linger timer here: the widget is cleared the moment
// nothing is running (see renderStatus). A finished row is history, not a status.

function formatElapsed(startedAt: number, endedAt?: number): string {
	const seconds = Math.max(0, Math.round(((endedAt ?? Date.now()) - startedAt) / 1000));
	return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}
/** Stop the 1s repaint that keeps a running delegation's duration live. */
function stopStatusTicker(): void {
	if (statusTicker === undefined) return;
	clearInterval(statusTicker);
	statusTicker = undefined;
}

/**
 * Repaint the widget from the registry.
 *
 * Rows follow the todo overlay's shape — a heading, `├─`/`└─` rows, a trailing
 * spacer — because it is the same slot above the editor, and one line per
 * delegation colored by state reads faster than a footer that only tallied.
 */
function renderStatus(): void {
	const ui = statusUi;
	if (ui === undefined) return;
	// Records retire by age, never by the widget's absence.
	for (const [name, entry] of delegations) {
		if (entry.endedAt !== undefined && Date.now() - entry.endedAt > RECORD_RETENTION_MS) delegations.delete(name);
	}
	const all = [...delegations.entries()];
	// The widget exists only while a delegation is running: a settled list left above
	// the editor reads as "still going" long after the work stopped. What it has drawn
	// is not forgotten — the status tool still answers from the records above.
	const running = all.filter(([, entry]) => entry.state === "working").length;
	if (running === 0) {
		stopStatusTicker();
		ui.setWidget(STATUS_KEY, undefined);
		return;
	}
	// A settled row is drawn for a turn, the reference's linger, so a finished neighbour
	// can be read beside the live one without becoming permanent furniture. A replayed row
	// has no settledTurn and is never drawn: this turn did not run it.
	const drawn = all.filter(
		([, entry]) =>
			entry.state === "working" ||
			(entry.settledTurn !== undefined && turn - entry.settledTurn <= LINGER_TURNS),
	);
	const theme = ui.theme;
	// Padded so the states and the durations line up across rows.
	const nameWidth = Math.max(...drawn.map(([name]) => name.length));
	const stateWidth = Math.max(...drawn.map(([, entry]) => entry.state.length));
	const lines = [theme.fg("accent", "Subagents")];
	drawn.forEach(([name, entry], index) => {
		const glyph = entry.state === "working" ? "◆" : entry.state === "done" ? "✓" : "✗";
		const color = entry.state === "working" ? "accent" : entry.state === "done" ? "success" : "error";
		const connector = theme.fg("dim", index === drawn.length - 1 ? "└─" : "├─");
		lines.push(
			`${connector} ${theme.fg(color, glyph)} ${theme.fg(color, name.padEnd(nameWidth))}  ${theme.fg(color, entry.state.padEnd(stateWidth))}  ${theme.fg("dim", formatElapsed(entry.startedAt, entry.endedAt))}`,
		);
	});
	// Pi spaces the widget from the editor above it but not below, so the last
	// row would otherwise sit flush against the input box.
	lines.push("");
	// Above the editor, where the todo widget sits.
	ui.setWidget(STATUS_KEY, lines, { placement: "aboveEditor" });
	// Only a running delegation has a duration worth repainting.
	if (statusTicker === undefined) {
		statusTicker = setInterval(renderStatus, 1000);
		statusTicker.unref();
	}
}

function trackDelegation(sessionName: string, pane: string, ui: ExtensionUIContext | undefined): void {
	// Nothing goes to the footer: the widget carries all of it, and a footer left by an
	// earlier instance must not outlive this one. This runs once per UI, not per repaint.
	if (ui !== undefined && ui !== statusUi) {
		statusUi = ui;
		ui.setStatus(STATUS_KEY, undefined);
	}
	// Earlier records are not cleared here: they stay queryable until their age retires
	// them, and the widget's own linger decides what is drawn.
	delegations.set(sessionName, { startedAt: Date.now(), state: "working", pane });
	renderStatus();
}

function settleDelegation(sessionName: string, state: "done" | "failed"): void {
	const entry = delegations.get(sessionName);
	// The first settle wins: the caller that observed the end is the one that knows why,
	// and settling twice would append a second entry for one delegation.
	if (entry === undefined || entry.endedAt !== undefined) return;
	const endedAt = Date.now();
	delegations.set(sessionName, { ...entry, endedAt, state, settledTurn: turn });
	// The replay reads the last settled entry per delegation, so appending is enough.
	entryApi?.appendEntry(SETTLED_ENTRY, { sessionName, state, endedAt } satisfies SettledEntry);
	renderStatus();
}

/** Record that a delegation's answer has already reached the parent. */
function markReported(sessionName: string): void {
	const entry = delegations.get(sessionName);
	if (entry === undefined || entry.reportedAt !== undefined) return;
	delegations.set(sessionName, { ...entry, reportedAt: Date.now() });
}

/** Whether the pushed notice would hand over an answer the parent already has. */
function alreadyReported(sessionName: string): boolean {
	return delegations.get(sessionName)?.reportedAt !== undefined;
}

/** The fields a replay reads; nothing else about an entry matters here. */
type ReplayEntry = { type: string; customType?: string; data?: unknown };

/**
 * Rebuild the registry from this conversation's own entries, and return the delegations
 * that were still running when the process went away.
 *
 * From the *branch*, not the whole session: `getEntries` returns every branch, so a
 * `/tree` navigation would otherwise bring back the delegations of the branch that was
 * left behind — and `resume` would accept a name from it.
 *
 * A returned entry has no watcher: the instance that armed one is gone. The caller arms
 * a fresh one, because the invariant is that a `working` record has a watcher.
 */
async function replayDelegations(pi: ExtensionAPI, entries: readonly ReplayEntry[]): Promise<DelegationEntry[]> {
	const started = new Map<string, DelegationEntry>();
	const settled = new Map<string, SettledEntry>();
	for (const entry of entries) {
		if (entry.type !== "custom") continue;
		if (entry.customType === DELEGATION_ENTRY) {
			const data = entry.data as DelegationEntry;
			started.set(data.sessionName, data);
		}
		if (entry.customType === SETTLED_ENTRY) {
			const data = entry.data as SettledEntry;
			settled.set(data.sessionName, data);
		}
	}
	delegations.clear();
	for (const [name, start] of started) {
		const end = settled.get(name);
		// No settledTurn: a replayed row is queryable but never drawn, because the
		// widget's linger is about this turn, and this turn did not run it.
		delegations.set(name, { startedAt: start.startedAt, pane: start.pane, state: end?.state ?? "working", endedAt: end?.endedAt });
	}
	// A delegation with no settled entry was still running when the process went away.
	// Its pane is the only thing left that can answer for it: a pane that is gone is a
	// failure, and one that is still there needs the caller to watch it again.
	const resumed: DelegationEntry[] = [];
	for (const [name, start] of started) {
		const entry = delegations.get(name);
		if (entry?.state !== "working") continue;
		if (await paneIsGone(pi, entry.pane)) {
			delegations.set(name, { ...entry, state: "failed", endedAt: Date.now() });
		} else {
			resumed.push(start);
		}
	}
	renderStatus();
	return resumed;
}

// ── Delegation flow ────────────────────────────────────────────────────────

/** The dry-run answer: the resolved plan, with nothing started. */
function dryRunReport(
	agent: AgentConfig,
	args: string[],
	task: string,
	wait: boolean,
	sessionName: string,
	unresolvedSkills: string[],
): string {
	return [
		`agent:   ${agent.name} [${agent.source}]`,
		`file:    ${agent.filePath}`,
		`argv:    pi ${formatArgv(args)}`,
		`task:    ${task}`,
		`wait:    ${wait}`,
		`session: ${sessionName}`,
		unresolvedSkills.length > 0 ? `unresolved: ${unresolvedSkills.join(", ")}` : "",
	]
		.filter(Boolean)
		.join("\n");
}

/** Open the child's pane, then register it so its duration covers the whole delegation. */
async function launchChild(
	pi: ExtensionAPI,
	sessionName: string,
	plan: LaunchPlan,
	ui: ExtensionUIContext | undefined,
): Promise<string> {
	const pane = await startChild(pi, sessionName, plan.args);
	// Tracked from the launch, so the duration covers the whole delegation.
	// No UI in print or JSON mode; the widget is simply not drawn there.
	trackDelegation(sessionName, pane, ui);
	return pane;
}

/**
 * The host's own view of a child's state, or undefined when it cannot be read (a pane
 * that is gone answers with an error envelope, which `callLuvus` throws on).
 */
async function agentStatus(pi: ExtensionAPI, sessionName: string): Promise<string | undefined> {
	try {
		const reply = await callLuvus(pi, ["agent", "get", sessionName], AGENT_STATUS_TIMEOUT_MS);
		return typeof reply.result.status === "string" ? reply.result.status : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Hand a task to a child and let the host say whether it started.
 *
 * Two steps, because one is not enough: `agent prompt` pastes the text, and a long
 * multi-line paste is *not* submitted by it — measured against the real CLI, where a
 * 12-line paste sat in the child's editor until a separate `agent keys <target> enter`.
 *
 * The evidence is the host's own `status` field, read rather than waited on: `wait
 * agent-status` only sees transitions that begin *after* it starts, and by then the paste
 * and Enter have already happened, so it can only ever time out. Measured: a fresh child
 * is `idle`, and paste + Enter moves it to `working` within a second. A child that was
 * already busy cannot be judged this way — its status proves nothing about *this*
 * message — so the answer there is "queued, not confirmed": true, and not a failure.
 */
async function submitAndConfirm(
	pi: ExtensionAPI,
	sessionName: string,
	task: string,
	seconds: number,
): Promise<"taken" | "queued"> {
	// A busy child is unreadable from here: its status is already working, so nothing it
	// does afterwards is evidence about this message.
	const before = await agentStatus(pi, sessionName);
	// Paste, then submit: a long paste leaves the text sitting in the editor.
	await callLuvus(pi, ["agent", "prompt", sessionName, task], PROMPT_SUBMIT_TIMEOUT_MS);
	await pressKey(pi, sessionName, "enter");
	if (before !== "idle") return "queued";
	// A fresh child is idle, so any other status means it took what we just sent.
	const deadline = Date.now() + seconds * 1000;
	while (Date.now() < deadline) {
		if ((await agentStatus(pi, sessionName)) !== "idle") return "taken";
		await new Promise((resolve) => setTimeout(resolve, START_POLL_MS));
	}
	return "queued";
}

/** The blocking path's tool result: the child's answer, capped, plus any notes. */
function blockingResult(
	agentName: string,
	outcome: SettleOutcome | undefined,
	result: ChildResult | undefined,
	notes: string[],
): { content: { type: "text"; text: string }[]; isError: boolean } {
	// One dimension, like the reference: how the delegation ended. The wait decides when
	// the child produced no result at all, the child's own last turn decides otherwise,
	// and a turn that landed no answer is its own state rather than `done`.
	const ended = endedOf(outcome, result);
	const line = outcomeLine(ended);
	const shown = shownResult(result, ended);
	const body = [...notes];
	if (line.note.length > 0) body.push(line.note);
	return {
		content: [
			{
				type: "text",
				text: [
					`${agentName} (${line.word}):`,
					...(shown.length > 0 ? ["", shown] : []),
					...(body.length > 0 ? ["", ...body] : []),
				].join("\n"),
			},
		],
		// The same single rule the widget and the notice read, not a second reading of it.
		isError: settledState(outcome, result) === "failed",
	};
}


// ── The child's editor: a pasted task is text, never a paste marker ────────

/** The markers a terminal wraps a bracketed paste in. */
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

/**
 * An editor that takes a bracketed paste as typed text.
 *
 * Pi condenses a large paste into a marker in the editor, and a task delivered
 * through the child's pane arrives as exactly one bracketed paste — so the marker is
 * what the model ends up seeing. Feeding the paste back through `handleInput` one
 * character at a time leaves the text itself in the editor instead.
 *
 * The technique is raw-paste's (github.com/tmustier/pi-extensions). Unlike it there
 * is no arming command: this is installed only in a child, where every paste is a
 * machine handing over a task and the marker is never wanted. Newlines are fed as
 * `\n`, which is what that extension normalises to for the same reason.
 */
class RawPasteEditor extends CustomEditor {
	private buffering = false;
	private buffer = "";

	handleInput(data: string): void {
		if (this.buffering) {
			this.buffer += data;
			const end = this.buffer.indexOf(PASTE_END);
			if (end === -1) return;
			const pasted = this.buffer.slice(0, end);
			const rest = this.buffer.slice(end + PASTE_END.length);
			this.buffer = "";
			this.buffering = false;
			for (const char of pasted.replace(/\r\n?/g, "\n")) super.handleInput(char);
			if (rest.length > 0) this.handleInput(rest);
			return;
		}
		const start = data.indexOf(PASTE_START);
		if (start === -1) {
			super.handleInput(data);
			return;
		}
		super.handleInput(data.slice(0, start));
		this.buffering = true;
		this.handleInput(data.slice(start + PASTE_START.length));
	}
}

/**
 * Install that editor, in a child only.
 *
 * A human's editor wants the marker — it is how a big paste stays editable — so this
 * is never installed where someone is typing. A child has no UI worth the trade.
 */
function installRawPaste(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.setEditorComponent((tui, theme, keybindings) => new RawPasteEditor(tui, theme, keybindings));
	});
}

// ── Extension entry ────────────────────────────────────────────────────────

export default function luvusSubagent(pi: ExtensionAPI) {
	// Loaded in the child too: this is what makes its pane report a real state.
	installStateReporter(pi, luvusBinary);

	// Registering keeps `--subagent-child` a legal option; the value is read from
	// argv below, because pi only exposes flags from session_start onwards —
	// too late to decide whether a tool gets registered at all.
	pi.registerFlag(SUBAGENT_CHILD_FLAG, {
		type: "boolean",
		description: "Run as a subagent child: report state, but offer no delegation tools.",
	});

	// A child loads this extension for the reporter above, and for the editor that keeps
	// a pasted task from reaching its model as a marker. Handing it the tools too would
	// let subagents spawn subagents without bound.
	if (process.argv.includes(`--${SUBAGENT_CHILD_FLAG}`)) {
		installRawPaste(pi);
		return;
	}

	/** Set while this session is being torn down, so a watcher never messages a dead one. */
	let sessionStale = false;
	// Completion notices are pushed into the transcript; this draws them as cards.
	registerCompletionRenderer(pi);
	// A queued notice is cleared by identity when Pi starts delivering it, and by this
	// net when it never does: a delivery discarded with Escape never starts.
	pi.on("message_start", ({ message }) => {
		if (message.role === "custom" && message.customType === "luvus-subagent-completion" && message.content === pendingNotice) {
			pendingNotice = undefined;
		}
	});
	pi.on("agent_settled", (_event, ctx) => {
		if (ctx.isIdle()) pendingNotice = undefined;
	});
	entryApi = pi;

	// The session is replaced for real here: `session_shutdown` fires for a reload, a new
	// session, a resume and a fork, and it cannot be cancelled. `session_before_switch` can
	// be — a handler that cancels leaves no `session_start` behind — so it must not be the
	// boundary that ends a session's watchers or clears its registry: a stale flag set there
	// would never be cleared, and every later completion notice would be dropped.
	pi.on("session_shutdown", () => {
		sessionStale = true;
		pendingNotice = undefined;
		delegations.clear();
		stopStatusTicker();
		// The widget goes with the session, not with the next repaint.
		statusUi?.setWidget(STATUS_KEY, undefined);
		statusUi = undefined;
	});

	// A switch keeps the process alive, so the previous session's records would answer
	// the status tool and hand `resume` a child this session never started. The
	// reference clears at the same boundary, for the same reason.
	// A reload or a restart must not lose the delegations: the records come back from
	// this session's own entries rather than from the process that wrote them.
	pi.on("session_start", async (_event, ctx) => {
		// A reload or a switch keeps the process, so this session's watchers start clean.
		sessionStale = false;
		turn = 0;
		// The widget is published through a UI this instance has not seen yet: without this,
		// a replayed row for a child that is still running would never be drawn at all.
		statusUi = ctx.hasUI ? ctx.ui : undefined;
		// A delegation that outlived the instance that started it has no watcher left, so
		// nothing would settle it, close its pane, or push its answer. Arm one here — not in
		// `session_tree`, which shares the replay but must not re-arm.
		for (const entry of await replayDelegations(pi, ctx.sessionManager.getBranch())) {
			void deliverWhenSettled({
				pi,
				pane: entry.pane,
				sessionId: entry.sessionName,
				agentName: entry.agent,
				promptFile: promptFileFor(entry.sessionName),
				isStale: () => sessionStale,
			});
		}
	});

	// A tree navigation keeps both the session and the process, and it changes which branch
	// is active: the registry has to follow the branch the user is on now.
	pi.on("session_tree", async (_event, ctx) => {
		turn = 0;
		await replayDelegations(pi, ctx.sessionManager.getBranch());
	});

	/**
	 * The parent can only delegate to an agent it knows about, so the catalogue is
	 * rebuilt every turn and dropped into its own system-prompt section. Same
	 * content the reference extensions inline into a tool definition, minus the
	 * stale list that would bake in at load time.
	 */
	pi.on("before_agent_start", (event) => {
		// The parent turn the widget's linger is counted in.
		turn++;
		const agents = discoverAgents(event.systemPromptOptions.cwd);
		if (agents.length === 0) {
			delete event.systemPromptOptions.sections.subagent_agents;
			return;
		}
		event.systemPromptOptions.sections.subagent_agents = [
			"delegate can launch these subagents, declared in .pi/agents/*.md:",
			...agents.map((agent) =>
				agent.description.length > 0 ? `- ${agent.name}: ${agent.description}` : `- ${agent.name}`,
			),
		].join("\n");
	});
	/** Dev aid: show what each agent resolves to before any pane is opened. */
	pi.registerCommand("subagent-agents", {
		description: "List subagent definitions and the Pi argv each one launches with",
		handler: async (_args, ctx) => {
			const agents = discoverAgents(ctx.cwd);
			if (agents.length === 0) {
				ctx.ui.notify(`No agents found (looked in ${join(getAgentDir(), "agents")})`, "info");
				return;
			}
			const lines = agents.map((agent) => {
				const { args, unresolvedSkills } = prepareLaunch(agent, ctx.cwd, agent.name);
				const head = `${agent.name} [${agent.source}]`;
				const detail = args.length > 0 ? formatArgv(args) : "(inherits parent settings)";
				const warn =
					unresolvedSkills.length > 0 ? `\n    unresolved skills: ${unresolvedSkills.join(", ")}` : "";
				return `${head}\n    ${detail}${warn}`;
			});
			ctx.ui.notify(lines.join("\n\n"), "info");
		},
	});

	pi.registerTool({
		name: "delegate",
		label: "Subagent",
		description:
			"Delegate a task to a subagent running in a visible Luvus pane. wait: false returns as soon as the pane is up and the answer arrives later as a completion message; ask for it sooner with subagent_status. Use dry_run to inspect the resolved launch plan without starting anything.",
		promptSnippet: "Delegate a task to a subagent running in a visible Luvus pane",
		// The delegation policy, tuned from the subagents fork: when to reach for an
		// agent, when to search directly instead, and what the answer means.
		promptGuidelines: [
			"When to delegate — reach for this when the task matches an available subagent, when you have independent work to run in parallel, or when answering would mean reading across several files. Delegate it and you keep the conclusion, not the file dumps.",
			"For a single-fact lookup where you already know the file, symbol, or value, search directly. Once you have delegated an investigation, do NOT also run it yourself — wait for the result.",
			"Provide clear, detailed prompts so the subagent can work autonomously.",
			"A subagent's answer comes back as text and is also shown to the user — relay what matters instead of repeating it.",
			"Never fabricate or predict a pending subagent's result. If the user asks before it arrives, say it is still running.",
		],
		parameters: Type.Object({
			agent: Type.String({ description: "Agent name, from the subagents listed in your context" }),
			task: Type.String({ description: "Task to delegate" }),
			resume: Type.Optional(
				// A boolean as well as a string: a caller that does not want to resume has
				// to be able to say so. Some models fill every optional parameter and have
				// no way to leave a string empty, so they invent a placeholder and the
				// call fails; false is a value they can actually produce.
				Type.Union([Type.Boolean(), Type.String()], {
					description:
						"Pass false (or omit it) to start a fresh delegation. Pass the session name of a delegation this session already ran, or a child session id, to continue that conversation. Transcripts are kept for 7 days; once swept, resume is unavailable and the earlier result is only in the transcript.",
				}),
			),
			wait: Type.Optional(
				Type.Boolean({
					description: "Block until the subagent settles and return its result (default true)",
				}),
			),
			dry_run: Type.Optional(
				Type.Boolean({ description: "Return the resolved launch plan without starting a pane" }),
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const agent = discoverAgents(ctx.cwd).find((candidate) => candidate.name === params.agent);
			if (agent === undefined) {
				const known = discoverAgents(ctx.cwd)
					.map((candidate) => candidate.name)
					.join(", ");
				return {
					content: [{ type: "text", text: `Unknown agent "${params.agent}". Known: ${known || "(none)"}` }],
					isError: true,
				};
			}

			// Resume names a delegation this session ran, or a child session id. Both are
			// the id its transcript is filed under, so one lookup serves both. Anything
			// that is not a non-empty string means "start a fresh delegation".
			const wantedResume =
				typeof params.resume === "string" && params.resume.trim().length > 0 ? params.resume.trim() : undefined;
			let resumeFile: string | undefined;
			if (wantedResume !== undefined) {
				const known = delegations.get(wantedResume);
				if (known !== undefined && known.state === "working") {
					return {
						content: [
							{ type: "text", text: `${wantedResume} is still running; steer it instead of resuming it.` },
						],
						isError: true,
					};
				}
				resumeFile = sessionFileFor(wantedResume);
				if (resumeFile === undefined) {
					return {
						content: [
							{
								type: "text",
								text: `No session to resume for "${wantedResume}": its transcript is gone (kept for ${SESSION_RETENTION_DAYS} days). Its earlier result is still in the transcript.`,
							},
						],
						isError: true,
					};
				}
			}
			const sessionName = wantedResume ?? `${agent.name}-${randomBytes(3).toString("hex")}`;
			const plan = prepareLaunch(agent, ctx.cwd, sessionName, resumeFile);
			const { args, unresolvedSkills, promptFile } = plan;
			const wait = params.wait ?? true;

			if (params.dry_run === true) {
				// A dry run only inspects the plan, and naming the prompt file created nothing —
				// so there is nothing to clean up here.
				const planText = dryRunReport(agent, args, params.task, wait, sessionName, unresolvedSkills);
				return { content: [{ type: "text", text: planText }] };
			}

			// Launching is what grows both the session directory and the prompt
			// directory, so it is also the right moment to trim both.
			sweepExpiredSessions();
			sweepExpiredPrompts();
			// The child reads its body during startup, so it must exist before the pane opens.
			if (promptFile !== undefined) writePromptFile(promptFile, agent.systemPrompt);

			// 1. Launch the child in its own pane; the task follows as a message.
			const pane = await launchChild(pi, sessionName, plan, ctx.hasUI ? ctx.ui : undefined);
			pi.appendEntry(DELEGATION_ENTRY, {
				sessionName,
				agent: agent.name,
				task: params.task,
				pane,
				startedAt: delegations.get(sessionName)?.startedAt ?? Date.now(),
			} satisfies DelegationEntry);

			// Blocking is the only difference between the two modes: the child owns a
			// pane either way, so it stays visible and steerable throughout. `settled`
			// also means the pane is finished, which is what the teardown looks at.
			let settled = false;
			let outcome: SettleOutcome | undefined;
			try {
				// 2. Hand the task over, and let the host say whether the child started.
				const started = await submitAndConfirm(pi, sessionName, params.task, START_CONFIRM_SECONDS);
				if (started === "queued") {
					// A pane that is already gone is not an unstarted task: report it the way every
					// other closed pane is, not as a countdown that never ran.
					if (await paneIsGone(pi, pane)) {
						settleDelegation(sessionName, "failed");
						settled = true;
						markReported(sessionName);
						return blockingResult(agent.name, "gone", undefined, []);
					}
					// Waiting on a child that never started would block for WAIT_SECONDS.
					settleDelegation(sessionName, "failed");
					settled = true;
					const unpicked = `${sessionName} never started working: it stayed idle for ${START_CONFIRM_SECONDS}s after the task was pasted and submitted. Nothing is running; its pane is closed.`;
					return { content: [{ type: "text", text: unpicked }], isError: true };
				}
				if (wait) {
					outcome = await waitForSettle(pi, pane);
					settled = outcome === "settled";
				}
				const notes: string[] = [];
				if (unresolvedSkills.length > 0) notes.push(`unresolved skills: ${unresolvedSkills.join(", ")}`);
				if (!wait) {
					// Nothing awaits this: the delegation returns now, and the watcher
					// reports the result once the child settles.
					void deliverWhenSettled({ pi, pane, sessionId: sessionName, agentName: agent.name, promptFile, isStale: () => sessionStale });
					const notice = [
						`${resumeFile === undefined ? "Delegated to" : "Resumed"} ${sessionName} in pane ${pane} (running).`,
						"It keeps running there; the pane is visible and steerable.",
						...notes,
					].join("\n");
					return { content: [{ type: "text", text: notice }] };
				}
				if (outcome === "gone") notes.push(`its pane was closed before it finished; nothing is running in pane ${pane} any more`);
				else if (!settled) {
					// Not WAIT_SECONDS: a wait that failed at once also lands here, and the
					// elapsed time is true either way.
					const watched = formatElapsed(delegations.get(sessionName)?.startedAt ?? Date.now());
					notes.push(`still running after ${watched} in pane ${pane}, which the watcher now owns`);
				}
				const result = readChildResult(sessionName);
				// A child that outlived the wait is still working: hand it to the watcher, so
				// its answer still arrives and its pane still gets closed once it settles.
				// Without this the delegation falls between the two modes and is abandoned.
				if (settled || outcome === "gone") {
					settleDelegation(sessionName, settledState(outcome, result));
					// The answer is in this tool result, so the watcher must not push it too.
					markReported(sessionName);
				} else {
					void deliverWhenSettled({
						pi,
						pane,
						sessionId: sessionName,
						agentName: agent.name,
						promptFile,
						isStale: () => sessionStale,
					});
				}
				return blockingResult(agent.name, outcome, result, notes);
			} finally {
				// 3. The blocking delegation is over; do not leave its pane — or the
				//    prompt file, which the child read during startup — behind.
				await teardownDelegation({ pi, pane, promptFile, settled: settled && pane !== "" });
			}
		},

		renderCall(args, theme) {
			const suffix = args.dry_run === true ? " (dry run)" : "";
			return new Text(
				theme.fg("toolTitle", theme.bold("delegate ")) +
					theme.fg("accent", args.agent) +
					theme.fg("dim", suffix),
				0,
				0,
			);
		},
	});

	/**
	 * Nudge a child that is already running. A background delegation leaves its
	 * pane open precisely so this stays possible.
	 */
	pi.registerTool({
		name: "steer",
		label: "Steer subagent",
		description:
			"Send an additional instruction to a subagent that is already running in its Luvus pane. Set interrupt to stop its current work first; a background delegation keeps its pane open for this.",
		promptSnippet: "Send an additional instruction to a running subagent",
		parameters: Type.Object({
			sessionName: Type.String({ description: "Subagent session name, as returned by delegate" }),
			message: Type.String({ description: "Instruction to send" }),
			interrupt: Type.Optional(
				Type.Boolean({ description: "Press Esc first to stop the subagent's current work (default false)" }),
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			try {
				if (params.interrupt === true) {
					await pressKey(pi, params.sessionName, "esc");
				}
				const how = params.interrupt === true ? "Interrupted, then" : "Sent to";
				const verdict = await submitAndConfirm(pi, params.sessionName, params.message, STEER_CONFIRM_SECONDS);
				// Two facts, and only two: the host took the message, and — for a child that was
				// idle — whether it started. A busy child proves nothing about this message, so
				// "queued" is the honest answer there, not a failure.
				const text =
					verdict === "taken"
						? `${how} ${params.sessionName}, and it is working.`
						: `${how} ${params.sessionName} — queued; the host took the message, but pickup is not confirmed.`;
				return { content: [{ type: "text", text }] };
			} catch (error) {
				return {
					content: [{ type: "text", text: `Could not reach ${params.sessionName}: ${String(error)}` }],
					isError: true,
				};
			}
		},
	});

	/**
	 * Let the parent ask about its own delegations instead of polling Luvus through
	 * bash: the widget is for the human, and a bash `luvus wait` is auto-backgrounded
	 * by whatever background-task extension happens to be installed. The shape
	 * follows pi-task's `task_status` — pull, with an optional wait.
	 */
	pi.registerTool({
		name: "subagent_status",
		label: "Subagent status",
		description:
			"List this session's subagent delegations and their state. With wait: true, block until the named delegation settles (or timeout_ms passes) and return its answer.",
		promptSnippet: "Check on subagents this session delegated",
		parameters: Type.Object({
			sessionName: Type.Optional(
				Type.String({
					description: "Subagent session name, as returned by delegate. Omit for every delegation in this session.",
				}),
			),
			wait: Type.Optional(Type.Boolean({ description: "Block until it settles (default false)" })),
			timeout_ms: Type.Optional(
				Type.Number({
					description: "How long to wait, in milliseconds (default: the window a blocking delegate uses)",
				}),
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const all = [...delegations.entries()];
			const rows = params.sessionName === undefined ? all : all.filter(([name]) => name === params.sessionName);
			if (params.sessionName !== undefined && rows.length === 0) {
				const known = all.map(([name]) => name).join(", ");
				return {
					content: [
						{ type: "text", text: `No delegation named ${params.sessionName}. Known: ${known || "(none)"}` },
					],
					isError: true,
				};
			}
			if (rows.length === 0) return { content: [{ type: "text", text: "No delegations in this session." }] };

			// Waiting is the only thing here that is not a read, and a wait that observed a
			// settle must land in the registry — otherwise the tool blocks, then reports
			// `working`, contradicting itself.
			const only = rows.length === 1 ? rows[0] : undefined;
			let waitedGone = false;
			// The wait's own read is the answer, so the transcript is parsed once and the window
			// in which a pushed notice sees no delivery yet is one statement wide.
			let waitedAnswer: ChildResult | undefined;
			if (params.wait === true && only !== undefined && only[1].state === "working") {
				const seconds = Math.max(1, Math.ceil((params.timeout_ms ?? WAIT_SECONDS * 1000) / 1000));
				const outcome = await waitForSettle(pi, only[1].pane, seconds);
				if (outcome === "gone") {
					waitedGone = true;
					settleDelegation(only[0], "failed");
				} else if (outcome === "settled") {
					waitedAnswer = readChildResult(only[0]);
					settleDelegation(only[0], settledState(outcome, waitedAnswer));
					// Handed over by the reply below — but only when the caller named the
					// delegation, which is the only case that includes the answer.
					if (waitedAnswer !== undefined && params.sessionName !== undefined) markReported(only[0]);
				}
			}

			// The registry is the authority on state: it is written by the settle watcher,
			// which knows a delegation is over. The child's session file only supplies the
			// text — its last terminal turn can predate a steer, so it must not decide state.
			// Re-read the registry: the wait above may have settled a row, and rendering the
			// pre-wait snapshot would report `working` right after blocking on it.
			// A wait that found the pane gone leaves a reason behind: `failed` alone would
			// not say whether anything is still running.
			const notes: string[] = [];
			if (waitedGone) notes.push(`pane ${only?.[1].pane ?? ""} is gone: the delegation ended when its pane was closed`);
			const current = [...delegations.entries()].filter(
				([name]) => params.sessionName === undefined || name === params.sessionName,
			);
			const lines = current.map(([name, entry]) => {
				return `${name}  ${entry.state}  ${formatElapsed(entry.startedAt, entry.endedAt)}  pane ${entry.pane}`;
			});
			const asked = params.sessionName;
			// Reuse the wait's read: a second read would repeat the parse and reopen the window.
			let answer: ChildResult | undefined;
			if (asked !== undefined) {
				answer = asked === only?.[0] && waitedAnswer !== undefined ? waitedAnswer : readChildResult(asked);
			}
			// The answer is final only once the delegation is over: a child steered after a
			// terminal turn still has a newer answer coming, and its notice must survive this pull.
			if (asked !== undefined && answer !== undefined && delegations.get(asked)?.state !== "working") {
				markReported(asked);
			}
			return {
				content: [
					{
						type: "text",
						text: [
							lines.join("\n"),
							...(notes.length > 0 ? ["", ...notes] : []),
							...(answer === undefined
								? []
								: ["", `answer from ${params.sessionName}:`, "", capCompletion(answer.text)]),
						].join("\n"),
					},
				],
			};
		},
	});
}
