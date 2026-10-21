/**
 * Everything this extension resolves about its own environment: where it keeps the files
 * it owns, where Pi keeps the ones it reads, and the constants that never vary per run.
 */
import { statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

// ── Constants ──────────────────────────────────────────────────────────────

/** Thinking levels Pi accepts on `--thinking`. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/**
 * Roots searched for a skill named in agent frontmatter, in priority order.
 *
 * Pi resolves skills against several roots and exposes no accessor for the
 * resolved set, so the name→path mapping lives here.
 */
export const skillRoots = (cwd: string): string[] => [
	join(cwd, CONFIG_DIR_NAME, "skills"),
	join(getAgentDir(), "skills"),
	join(homedir(), ".agents", "skills"),
];

/**
 * One shared directory holds every child session, so a delegation is identified
 * by its pinned session id instead of by owning a directory. It sits outside
 * `sessions/` to stay clear of Pi's own project grouping.
 */
export const SESSION_DIR = join(homedir(), ".pi", "agent", "subagent-sessions");

/** The prompt window counts days; this is one day in milliseconds. */
export const MS_PER_DAY = 86_400_000;

/**
 * Agent bodies land here as files. The prompt flags take argv directly, so this
 * is not about quoting — it keeps a body out of `ps` output. A child reads its
 * file during startup, so a settled delegation deletes it; a launch that never
 * gets that far leaves it to `sweepExpiredPrompts`.
 */
export const PROMPT_DIR = join(tmpdir(), "tty7-subagent-prompts");

/** A prompt file holds an agent body, so it is readable by its owner alone. */
export const PROMPT_FILE_MODE = 0o600;

/** Prompt files are read during startup, so they need only a short window. */
export const PROMPT_RETENTION_DAYS = 1;



/** Pi's session directory. The SDK exposes `getAgentDir` but no accessor for this. */
export const sessionRoot = (): string => join(getAgentDir(), "sessions");

/** Whether `path` is a directory. A path that cannot be stat-ed is not one. */
export function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

/**
 * The two session entry types this extension writes, and the only ones it reads back.
 *
 * A delegation keeps its record in the session rather than in this process, so these names
 * are the contract between a running delegation, a replay after a reload, and the sweep
 * that decides which child transcripts are still named by any surviving session.
 */
export const DELEGATION_ENTRY = "tty7-subagent-delegation";
export const SETTLED_ENTRY = "tty7-subagent-settled";
