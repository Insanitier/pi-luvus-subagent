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
	/** `replace` swaps Pi's coding prompt for the agent body. */
	/** `replace` (the default) makes the agent body the preamble; `append` puts it after Pi's. */
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
	/** Written agent body, when the agent declares one. */
	promptFile?: string;
};

function writePromptFile(sessionName: string, body: string): string {
	mkdirSync(PROMPT_DIR, { recursive: true });
	const file = join(PROMPT_DIR, `${sessionName}.md`);
	writeFileSync(file, body, { encoding: "utf-8", mode: PROMPT_FILE_MODE });
	return file;
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
		promptFile = writePromptFile(sessionName, agent.systemPrompt);
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
 * A wait that returns sooner than this did not run out, it failed. Re-arming on it
 * would spin, so the watcher treats it as the end of its watching.
 */
const WAIT_FLOOR_MS = 1_000;

/** How long a pane gets to close before it is left alone. */
const PANE_CLOSE_TIMEOUT_MS = 15_000;

/** How long a single key press gets to reach the child. */
const KEYSTROKE_TIMEOUT_MS = 15_000;

/** How long `agent prompt` gets before the submission is abandoned. */
const PROMPT_SUBMIT_TIMEOUT_MS = 30_000;

/** How much of a CLI's stderr is quoted back when its reply is unreadable. */
const STDERR_TAIL_CHARS = 200;

/** How long to wait before re-checking whether the child took the task. */
const SUBMIT_PROBE_MS = 2000;

/** Enter retries before a delegation declares the task unsubmitted. */
const SUBMIT_ATTEMPTS = 10;

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

/** Hand the task to the child's input box. Enter is a separate call, by design. */
async function submitTask(pi: ExtensionAPI, sessionName: string, task: string): Promise<void> {
	await callLuvus(pi, ["agent", "prompt", sessionName, task], PROMPT_SUBMIT_TIMEOUT_MS);
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
		return {
			status: "failed",
			outcome: terminal.stopReason === "aborted" ? "aborted" : "error",
			text: terminal.errorMessage?.trim() || terminal.text.trim() || `Subagent ${terminal.stopReason} before producing a result.`,
		};
	}
	return {
		status: "completed",
		outcome: terminal.stopReason === "length" ? "truncated" : "done",
		text: terminal.text.trim() || "(no output)",
	};
}

/**
 * Whether the child has taken the task yet.
 *
 * The session file is written when its first turn starts, so a child that never
 * picked the task up has no file at all. Pane status cannot answer this: Luvus
 * also infers it from process activity, and calls a child `working` before its
 * own reporter has said anything.
 */
/**
 * How many user turns a child's transcript holds. A resumed session already holds the
 * ones it ran before, so what says "it took the task" is this count going up, not a
 * user line existing.
 */
function countChildUserTurns(sessionId: string): number {
	const filePath = sessionFileFor(sessionId);
	if (filePath === undefined) return 0;
	let turns = 0;
	for (const line of readFileSync(filePath, "utf-8").split("\n")) {
		if (!line.includes('"user"')) continue;
		try {
			const entry = JSON.parse(line) as { type?: string; message?: { role?: string } };
			if (entry.type === "message" && entry.message?.role === "user") turns += 1;
		} catch {
			continue;
		}
	}
	return turns;
}
/**
 * How much of a child's answer is pushed into the parent's context.
 *
 * The official subagent example caps its own output at this size; past it the
 * answer still lives in the child's pane and session file.
 */
const COMPLETION_OUTPUT_CAP = 50 * 1024;

/** Lines of the answer shown before the card asks for Ctrl+O. */
const COLLAPSED_LINES = 3;

type CompletionDetails = { sessionId?: string; pane?: string; status?: string };

function capCompletion(text: string): string {
	if (text.length <= COMPLETION_OUTPUT_CAP) return text;
	const kept = text.slice(0, COMPLETION_OUTPUT_CAP);
	return `${kept}\n\n… truncated at ${COMPLETION_OUTPUT_CAP / 1024}KB; the rest is in the child's pane and session file.`;
}

/**
 * Draw a completion notice as a card: header plus a few lines, the rest behind
 * Ctrl+O.
 *
 * The model still receives the whole text — packaging the display is what keeps
 * the transcript readable, and dropping the text instead would hide the answer
 * from the parent.
 */
function registerCompletionRenderer(pi: ExtensionAPI): void {
	pi.registerMessageRenderer<CompletionDetails>(
		"luvus-subagent-completion",
		(message, { expanded, outputPad }, theme) => {
			const text = typeof message.content === "string" ? message.content : "";
			const [head = "", ...rest] = text.split("\n");
			const body = rest.filter((line) => line.trim().length > 0);
			const box = new Box(outputPad, 1, (line) => theme.bg("customMessageBg", line));
			box.addChild(new Text(theme.fg(message.details?.status === "failed" ? "error" : "success", head), 0, 0));
			if (expanded) {
				if (body.length > 0) box.addChild(new Markdown(body.join("\n"), 0, 0, getMarkdownTheme()));
				return box;
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
			return box;
		},
	);
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
			if (outcome !== "timeout" || Date.now() - cycleStart < WAIT_FLOOR_MS) break;
			if (isStale()) break;
		}
		const result = readChildResult(sessionId);
		// A closed pane is a delegation that ended without finishing; a wait that ran out
		// leaves a child that is still working, which is not a failure and not an end.
		if (outcome !== "timeout") {
			settleDelegation(sessionId, outcome === "gone" || result?.status === "failed" ? "failed" : "done");
		}
		if (isStale()) return;

		const elapsed = `${Math.round((Date.now() - startedAt) / 1000)}s`;
		// The notice carries the same single dimension as the tool result.
		const ended =
			outcome === "gone" ? "pane closed" : outcome === "settled" ? (result?.outcome ?? "no-answer") : "still running";
		const line = outcomeLine(ended);
		const header =
			ended === "still running"
				? `⌛ ${agentName} (still running after ${WAIT_SECONDS}s, ${sessionId})`
				: `${ended === "done" ? "✓" : "✗"} ${agentName} (${line.word}, ${elapsed}, ${sessionId})`;
		// A missing answer only needs saying while the child may still produce one: when the
		// note already explains why there is none, the placeholder is noise.
		const shown = result !== undefined ? capCompletion(result.text) : ended === "still running" ? "(no result was written)" : "";
		const body = shown.length > 0 ? [header, "", shown] : [header];
		if (line.note.length > 0) body.push("", line.note);
		pi.sendMessage(
			{
				customType: "luvus-subagent-completion",
				// The answer rides along, capped; the renderer draws it as a card so the
				// transcript stays readable without hiding the result from the parent.
				content: body.join("\n"),
				details: { sessionId, pane, status: result?.status },
				display: true,
			},
			{ deliverAs: "followUp", triggerTurn: true },
		);
	} catch (error) {
		settleDelegation(sessionId, "failed");
		if (isStale()) return;
		pi.sendMessage(
			{
				customType: "luvus-subagent-completion",
				content: `✗ ${agentName} (${sessionId}) — could not read its result: ${String(error)}`,
				details: { sessionId, pane },
				display: true,
			},
			{ deliverAs: "followUp", triggerTurn: true },
		);
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
};

/** A record outlives the widget, and only age retires it — the reference's 10 minutes. */
const RECORD_RETENTION_MS = 10 * 60_000;
/** How many parent turns the widget keeps a settled row, per the reference. */
const DONE_LINGER_TURNS = 1;
const ERROR_LINGER_TURNS = 2;
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
	// Nothing goes to the footer: the widget carries all of it, and a footer
	// left by an earlier instance must not outlive this one.
	ui.setStatus(STATUS_KEY, undefined);
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
	// A settled row is drawn for a turn or two, the reference's linger, so a finished
	// neighbour can be read beside the live one without becoming permanent furniture.
	const drawn = all.filter(
		([, entry]) =>
			entry.state === "working" ||
			turn - (entry.settledTurn ?? 0) <= (entry.state === "failed" ? ERROR_LINGER_TURNS : DONE_LINGER_TURNS),
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
	if (ui !== undefined) statusUi = ui;
	// Earlier records are not cleared here: they stay queryable until their age retires
	// them, and the widget's own linger decides what is drawn.
	delegations.set(sessionName, { startedAt: Date.now(), state: "working", pane });
	renderStatus();
}

function settleDelegation(sessionName: string, state: "done" | "failed"): void {
	const entry = delegations.get(sessionName);
	if (entry === undefined) return;
	const endedAt = Date.now();
	delegations.set(sessionName, { ...entry, endedAt, state, settledTurn: turn });
	// The replay reads the last settled entry per delegation, so appending is enough.
	entryApi?.appendEntry(SETTLED_ENTRY, { sessionName, state, endedAt } satisfies SettledEntry);
	renderStatus();
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
 * Submit the task, then confirm the child took it.
 *
 * `agent start` reports ready before the child's TUI accepts keys, so the first
 * Enter can be swallowed and the text would sit in the input box — measured at
 * 33.7s before this loop. Luvus rejects an argv argument carrying control lines,
 * so the task cannot ride in the launch; it is submitted here and confirmed
 * instead. A child that never took it stays `idle`, which is exactly what the
 * probe watches for.
 */
async function submitUntilTaken(pi: ExtensionAPI, sessionName: string, task: string): Promise<boolean> {
	const turnsBefore = countChildUserTurns(sessionName);
	await submitTask(pi, sessionName, task);
	let picked = false;
	for (let attempt = 0; attempt < SUBMIT_ATTEMPTS && !picked; attempt++) {
		await new Promise((resolve) => setTimeout(resolve, SUBMIT_PROBE_MS));
		picked = countChildUserTurns(sessionName) > turnsBefore;
		// One Enter, never the text again: it is already in the input box.
		if (!picked) await pressKey(pi, sessionName, "enter");
	}
	return picked;
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
	const ended =
		outcome === "gone" ? "pane closed" : outcome === "settled" ? (result?.outcome ?? "no-answer") : "still running";
	const line = outcomeLine(ended);
	const body = [...notes];
	if (line.note.length > 0) body.push(line.note);
	return {
		content: [
			{
				type: "text",
				text: [
					`${agentName} (${line.word}):`,
					// A missing answer only needs saying while the child may still produce one;
					// when the note explains why there is none, the line is noise.
					...(result !== undefined
						? ["", capCompletion(result.text)]
						: ended === "still running"
							? ["", "(no result was written)"]
							: []),
					...(body.length > 0 ? ["", ...body] : []),
				].join("\n"),
			},
		],
		isError: ended === "pane closed" || result?.status === "failed",
	};
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

	// A child loads this extension only for the reporter above. Handing it the
	// tools too would let subagents spawn subagents without bound.
	if (process.argv.includes(`--${SUBAGENT_CHILD_FLAG}`)) return;

	/** Set on shutdown so a background watcher never messages a dead session. */
	let sessionStale = false;
	// Completion notices are pushed into the transcript; this draws them as cards.
	registerCompletionRenderer(pi);
	entryApi = pi;

	pi.on("session_shutdown", () => {
		// The widget goes away with the session; stop the ticker and forget them.
		delegations.clear();
		stopStatusTicker();
	});

	// A switch keeps the process alive, so the previous session's records would answer
	// the status tool and hand `resume` a child this session never started. The
	// reference clears at the same boundary, for the same reason.
	// A reload or a restart must not lose the delegations: the records come back from
	// this session's own entries rather than from the process that wrote them.
	pi.on("session_start", async (_event, ctx) => {
		turn = 0;
		const started = new Map<string, DelegationEntry>();
		const settled = new Map<string, SettledEntry>();
		for (const entry of ctx.sessionManager.getEntries()) {
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
		// A delegation with no settled entry was still running when the process went
		// away, and its pane is the only thing left that can answer for it.
		for (const [name, entry] of delegations) {
			if (entry.state !== "working") continue;
			if (await paneIsGone(pi, entry.pane)) {
				delegations.set(name, { ...entry, state: "failed", endedAt: Date.now() });
			}
		}
		renderStatus();
	});

	pi.on("session_before_switch", () => {
		delegations.clear();
		stopStatusTicker();
		statusUi?.setWidget(STATUS_KEY, undefined);
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
				Type.String({
					description:
						"Session name of a delegation this session already ran, or a child session id, to continue that conversation. Transcripts are kept for 7 days; once swept, resume is unavailable and the earlier result is only in the transcript.",
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
			// the id its transcript is filed under, so one lookup serves both.
			let resumeFile: string | undefined;
			if (params.resume !== undefined) {
				const known = delegations.get(params.resume);
				if (known !== undefined && known.state === "working") {
					return {
						content: [
							{ type: "text", text: `${params.resume} is still running; steer it instead of resuming it.` },
						],
						isError: true,
					};
				}
				resumeFile = sessionFileFor(params.resume);
				if (resumeFile === undefined) {
					return {
						content: [
							{
								type: "text",
								text: `No session to resume for "${params.resume}": its transcript is gone (kept for ${SESSION_RETENTION_DAYS} days). Its earlier result is still in the transcript.`,
							},
						],
						isError: true,
					};
				}
			}
			const sessionName = params.resume ?? `${agent.name}-${randomBytes(3).toString("hex")}`;
			const plan = prepareLaunch(agent, ctx.cwd, sessionName, resumeFile);
			const { args, unresolvedSkills, promptFile } = plan;
			const wait = params.wait ?? true;

			if (params.dry_run === true) {
				// A dry run only inspects the plan. prepareLaunch already wrote the prompt
				// file, so drop it here — otherwise every plan call leaves one behind in
				// the shared directory until the retention sweep gets to it.
				if (promptFile !== undefined) rmSync(promptFile, { force: true });
				const planText = dryRunReport(agent, args, params.task, wait, sessionName, unresolvedSkills);
				return { content: [{ type: "text", text: planText }] };
			}

			// Launching is what grows both the session directory and the prompt
			// directory, so it is also the right moment to trim both.
			sweepExpiredSessions();
			sweepExpiredPrompts();

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
				// 2. Hand the task over, then confirm the child took it.
				const picked = await submitUntilTaken(pi, sessionName, params.task);
				if (!picked) {
					// Waiting on a child that never started would block for WAIT_SECONDS.
					settleDelegation(sessionName, "failed");
					settled = true;
					const unpicked = `${sessionName} never picked the task up: its pane stayed idle after ${SUBMIT_ATTEMPTS} Enter attempts. Nothing was started.`;
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
				else if (!settled) notes.push(`did not settle within ${WAIT_SECONDS}s; it is still running in pane ${pane}`);
				const result = readChildResult(sessionName);
				// A child that outlived the wait is still working: hand it to the watcher, so
				// its answer still arrives and its pane still gets closed once it settles.
				// Without this the delegation falls between the two modes and is abandoned.
				if (settled || outcome === "gone") {
					settleDelegation(sessionName, settled && result?.status !== "failed" ? "done" : "failed");
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
		promptGuidelines: [
			"Use steer to redirect a running subagent mid-run instead of waiting for it to finish and delegating the correction again.",
		],
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
				await submitTask(pi, params.sessionName, params.message);
			} catch (error) {
				return {
					content: [{ type: "text", text: `Could not reach ${params.sessionName}: ${String(error)}` }],
					isError: true,
				};
			}
			const how = params.interrupt === true ? "Interrupted, then sent" : "Sent";
			return { content: [{ type: "text", text: `${how} to ${params.sessionName}.` }] };
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
	promptGuidelines: [
		"A background delegation's answer arrives on its own; ask for it with subagent_status only when you need it sooner.",
	],
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
		if (params.wait === true && only !== undefined && only[1].state === "working") {
			const seconds = Math.max(1, Math.ceil((params.timeout_ms ?? WAIT_SECONDS * 1000) / 1000));
			const outcome = await waitForSettle(pi, only[1].pane, seconds);
			if (outcome === "gone") {
				waitedGone = true;
				settleDelegation(only[0], "failed");
			} else if (outcome === "settled") {
				const settled = readChildResult(only[0]);
				settleDelegation(only[0], settled?.status === "failed" ? "failed" : "done");
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
		const answer = params.sessionName === undefined ? undefined : readChildResult(params.sessionName);
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
