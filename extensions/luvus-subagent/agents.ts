/**
 * The agent catalogue and the launch argv it becomes.
 *
 * An agent is declared once in `.pi/agents/<name>.md`; its frontmatter plus the child's
 * pinned session id become the argv a child is started with. Discovery is read-only: this
 * module never launches anything, and `prepareLaunch` never touches the filesystem except
 * to write the child's prompt file.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import {
	PROMPT_DIR,
	PROMPT_FILE_MODE,
	SELF_PATH,
	SESSION_DIR,
	SUBAGENT_CHILD_FLAG,
	isDirectory,
	THINKING_LEVELS,
	skillRoots,
} from "./env.ts";
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
export function promptFileFor(sessionName: string): string {
	return join(PROMPT_DIR, `${sessionName}.md`);
}

/** Write an agent body for the child to read during startup. */
export function writePromptFile(file: string, body: string): void {
	mkdirSync(PROMPT_DIR, { recursive: true });
	writeFileSync(file, body, { encoding: "utf-8", mode: PROMPT_FILE_MODE });
}

/** Render argv for humans: an empty argument would otherwise be invisible. */
export function formatArgv(args: string[]): string {
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

