/**
 * The child's own session file: what it answered, what it is doing, and whether it took the
 * task it was handed.
 *
 * This is the extension's authoritative channel, and it is deliberately host-independent:
 * a pane shows a rendered TUI with borders, spinners and only the visible tail, while the
 * session file holds the complete message with a terminal stop reason. Pi writes the user
 * message when it takes a task over, so "my message arrived" is a fact here rather than an
 * inference from a status.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { SESSION_DIR, isDirectory } from "./env.ts";

/**
 * How much of a task is matched against a session record.
 *
 * Long enough to be unmistakable, and safe because a session record is stored as written:
 * nothing wraps it. A pane read is not — see `TASK_MARK_IN_PANE_CHARS`.
 */
const TASK_MARK_CHARS = 64;
/**
 * How much of a task is matched against what a pane shows.
 *
 * Shorter than the transcript mark on purpose: a pane wraps and indents long lines, so a
 * wider mark could fail to match text that is right there in the editor.
 */
export const TASK_MARK_IN_PANE_CHARS = 32;

/**
 * The records in a session file, and what a line that cannot be parsed means.
 *
 * Pi appends to this file while the extension reads it, so its last line can be half written.
 * That is the one rule every reader here has to resolve — and there are two honest answers,
 * which is why the policy is an argument rather than a default:
 *
 * - `skip` is for a reader asking about *this* child: the half line belongs to a record the
 *   child is still writing, and skipping it loses nothing that was already true.
 * - `give-up` is for the sweeper, which decides what to delete: a line it cannot parse might
 *   be the one naming a child, so the only safe answer is to read nothing at all.
 *
 * `undefined` means the file could not be read; records that are missing lines mean only
 * those lines were skipped. `lineFilter` exists for the sweeper as well: it reads every
 * session on disk and must not decode lines that cannot name a child, which is a cost
 * decision rather than a semantic one.
 */
export function readSessionRecords(
	file: string,
	options: { lineFilter?: (line: string) => boolean; onUnparseable?: "skip" | "give-up" } = {},
): Record<string, unknown>[] | undefined {
	let text: string;
	try {
		text = readFileSync(file, "utf-8");
	} catch {
		return undefined;
	}
	const records: Record<string, unknown>[] = [];
	for (const line of text.split("\n")) {
		if (line.trim().length === 0) continue;
		if (options.lineFilter !== undefined && !options.lineFilter(line)) continue;
		try {
			const record = JSON.parse(line) as unknown;
			if (typeof record === "object" && record !== null) records.push(record as Record<string, unknown>);
		} catch {
			// Half a line: the child was writing it while this read it, and what that means
			// depends on who is asking — see the note above.
			if (options.onUnparseable === "give-up") return undefined;
		}
	}
	return records;
}
/** Stop reasons that mean the assistant message is final rather than intermediate. */
export const TERMINAL_STOP_REASONS = new Set(["stop", "endTurn", "length", "error", "aborted"]);

/**
 * How a child's last turn ended, as a closed set.
 *
 * Pi reports no finer cause than `stopReason`, and the provider's own words ride along
 * in `errorMessage` — so this never guesses at one. `no-answer` and `pane closed` are
 * not turn outcomes but delegation ones: the first is a child that settled without
 * writing anything, the second a pane that stopped existing.
 */
export type ChildOutcome = "done" | "truncated" | "aborted" | "error" | "no-answer" | "pane closed" | "still running";

export type ChildResult = { status: "completed" | "failed"; text: string; outcome: ChildOutcome };


/**
 * The file Pi wrote for one child session, or undefined when there is none.
 *
 * Pi names a session file `<timestamp>_<sessionId>.jsonl`; the pinned id is
 * the suffix, so this names one child exactly.
 */
export function sessionFileFor(sessionId: string): string | undefined {
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
export function readChildResult(sessionId: string): ChildResult | undefined {
	const filePath = sessionFileFor(sessionId);
	if (filePath === undefined) return undefined;

	const records = readSessionRecords(filePath);
	if (records === undefined) return undefined;
	let terminal: { text: string; stopReason: string; errorMessage?: string } | undefined;
	for (const entry of records) {
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

/** What a running child is doing, read from the session file it writes as it goes. */
export type ChildProgress = {
	/** Named tool calls so far — the cheapest honest measure of work actually done. */
	toolUses: number;
	/** The last thing it was seen doing. */
	activity: string;
	/** When the file last changed: when the child last put anything on paper. */
	lastWriteAt: number | undefined;
};

/**
 * How far along a child is, for a parent that has to judge whether waiting is still the
 * right move.
 *
 * A state alone cannot answer that: `working` reads the same whether the child is
 * mid-tool or wedged, so a rule like "do not wait again if nothing changed" has nothing
 * to test against. The facts come from the file the child writes as it goes.
 */
export function readChildProgress(sessionId: string): ChildProgress | undefined {
	const filePath = sessionFileFor(sessionId);
	if (filePath === undefined) return undefined;
	const records = readSessionRecords(filePath);
	if (records === undefined) return undefined;
	let toolUses = 0;
	let activity = "no tool call yet";
	for (const entry of records as { type?: string; message?: { role?: string; content?: unknown } }[]) {
		if (entry.type !== "message" || entry.message === undefined) continue;
		const content = Array.isArray(entry.message.content) ? entry.message.content : [];
		for (const part of content) {
			const piece = part as { type?: string; name?: string };
			if (piece.type !== "toolCall") continue;
			toolUses += 1;
			activity = typeof piece.name === "string" ? `calling ${piece.name}` : "calling a tool";
		}
		if (entry.message.role === "assistant" && content.some((part) => (part as { type?: string }).type === "text")) {
			activity = "writing";
		}
	}
	let lastWriteAt: number | undefined;
	try {
		lastWriteAt = statSync(filePath).mtimeMs;
	} catch {
		lastWriteAt = undefined;
	}
	return { toolUses, activity, lastWriteAt };
}

/**
 * Whether the child's own transcript holds this task as a user message.
 *
 * A status describes the pane; this describes *this* text. Pi writes the user message when it
 * takes the task over, so the transcript is the one place where "my message arrived" is a fact
 * instead of an inference.
 *
 * `fromRecord` is where the transcript stood before the text was pasted, and it is the whole
 * reason this is not a plain search: a resumed session already holds user messages, and a
 * parent retrying a task with the same words would otherwise be told the child took it while
 * the text was still sitting in its editor.
 */
export function taskInTranscript(sessionId: string, task: string, fromRecord = 0): boolean {
	const file = sessionFileFor(sessionId);
	if (file === undefined) return false;
	// Whole records, not a filtered scan: the index this is asked about counts every record
	// the file holds, so filtering first would move the boundary it is measured against.
	const mark = task.slice(0, TASK_MARK_CHARS);
	const records = readSessionRecords(file);
	if (records === undefined) return false;
	const said = records.slice(fromRecord) as { message?: { role?: string; content?: { type?: string; text?: string }[] } }[];
	for (const record of said) {
		const message = record.message;
		if (message?.role !== "user" || !Array.isArray(message.content)) continue;
		const said = message.content.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("");
		if (said.includes(mark)) return true;
	}
	return false;
}
