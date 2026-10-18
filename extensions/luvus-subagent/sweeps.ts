/**
 * The two sweeps, and the doubt they resolve the same way: a session file that cannot be
 * read keeps its transcript, and a name that cannot be parsed keeps it too.
 *
 * Both run on the extension's own schedule rather than per delegation, and both are
 * backstops — a delegation removes its own prompt file and its own child's transcript.
 */
import { spawnSync } from "node:child_process";
import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { readSessionRecords } from "./child-session.ts";
import { DELEGATION_ENTRY, MS_PER_DAY, PROMPT_DIR, PROMPT_RETENTION_DAYS, SESSION_DIR, isDirectory, sessionRoot } from "./env.ts";
/**
 * Drop prompt files past their window.
 *
 * The backstop for launches that never reached a settle — a failed `agent
 * start`, or a parent that died mid-delegation. A completed delegation removes
 * its own file instead of waiting for this.
 */
export function sweepExpiredPrompts(): void {
	if (!isDirectory(PROMPT_DIR)) return;
	const cutoff = Date.now() - PROMPT_RETENTION_DAYS * MS_PER_DAY;
	for (const entry of readdirSync(PROMPT_DIR)) {
		const file = join(PROMPT_DIR, entry);
		try {
			if (statSync(file).mtimeMs < cutoff) rmSync(file, { force: true });
		} catch {
			// A file we cannot stat is not worth failing a delegation over.
		}
	}
}

/**
 * How long one orphan scan buys.
 *
 * A scan reads every session file there is, so a burst of launches rescans once
 * instead of once per delegation. What it looks for changes only when a
 * conversation is deleted, so the interval is about cost alone.
 */
const ORPHAN_SCAN_INTERVAL_MS = 60 * 60_000;

/**
 * How young a child session is left alone whatever the scan says.
 *
 * A parent appends the entry that names its child right after the launch, so this
 * is mostly margin: nothing here needs to hurry, and a transcript deleted on a
 * race that narrow is not recoverable.
 */
const ORPHAN_GRACE_MS = 60 * 60_000;

/** When the last scan that could be acted on ran. */
let lastOrphanScanAt = 0;

/**
 * The child names the surviving session files still carry.
 *
 * `undefined` means "keep everything": no session file at all, one that cannot be
 * read, or a marker line that will not parse — a Pi process appending to a session
 * can leave its last line short. A name missed here deletes a transcript for
 * nothing, so every doubt resolves the same way.
 *
 * A custom entry is one JSON line and only lines carrying the marker are parsed, so
 * a session that never delegated is never decoded.
 */
function referencedSessionNames(): Set<string> | undefined {
	const root = sessionRoot();
	if (!isDirectory(root)) return undefined;
	const names = new Set<string>();
	// Pi groups sessions into a directory per project, so the walk is not one level.
	const dirs = [root];
	let files = 0;
	for (let next = 0; next < dirs.length; next++) {
		const dir = dirs[next] as string;
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			return undefined;
		}
		for (const entry of entries) {
			const path = join(dir, entry);
			let directory: boolean;
			try {
				directory = statSync(path).isDirectory();
			} catch {
				return undefined;
			}
			if (directory) {
				dirs.push(path);
				continue;
			}
			if (!entry.endsWith(".jsonl")) continue;
			files++;
			// Only lines carrying the marker are decoded: a session that never delegated is
			// never parsed. A line that will not parse is a give-up rather than a skip here —
			// it might be the one naming a child, and a name missed deletes a transcript for
			// nothing.
			const records = readSessionRecords(path, {
				lineFilter: (line) => line.includes(DELEGATION_ENTRY),
				onUnparseable: "give-up",
			});
			if (records === undefined) return undefined;
			for (const record of records as { customType?: string; data?: { sessionName?: string } }[]) {
				if (record.customType === DELEGATION_ENTRY && typeof record.data?.sessionName === "string") {
					names.add(record.data.sessionName);
				}
			}
		}
	}
	// Not one session file: this is not where Pi keeps them, and an empty scan would
	// orphan every child there is.
	return files === 0 ? undefined : names;
}

/**
 * Move a file to the platform trash, falling back to an unlink.
 *
 * Pi deletes a conversation the same way, so a reaped transcript ends up where the
 * conversation it belonged to went.
 */
function discardFile(file: string): void {
	try {
		if (spawnSync("trash", [file], { encoding: "utf-8" }).status === 0) return;
	} catch {
		// No `trash` here: the unlink below is Pi's own fallback too.
	}
	rmSync(file, { force: true });
}

/**
 * Drop child sessions no surviving session file names.
 *
 * A child is reachable only through its name, and the name lives in the entries of
 * the conversation that delegated it: `resume` reopens by name and `subagent_status`
 * answers by name. So a transcript nothing names is unreachable — it is what a
 * deleted conversation leaves behind. Pi deletes one by moving its file out of
 * `sessions/` and emits no event for it, which is why this looks rather than listens.
 *
 * Three things hold a file back, and each is a way of being wrong rather than slow: a
 * name this session still holds, a child too young for its parent to have written the
 * entry, and a scan that could not read everything. Every one of them keeps a file
 * that could have gone; none deletes one that should have stayed.
 */
export function sweepOrphanSessions(isLive: (sessionName: string) => boolean): void {
	if (Date.now() - lastOrphanScanAt < ORPHAN_SCAN_INTERVAL_MS) return;
	if (!isDirectory(SESSION_DIR)) return;
	const referenced = referencedSessionNames();
	if (referenced === undefined) return;
	// Only a scan that could be acted on buys the interval: a directory nothing could be
	// read from should not stop the next launch from trying again.
	lastOrphanScanAt = Date.now();
	const cutoff = Date.now() - ORPHAN_GRACE_MS;
	for (const entry of readdirSync(SESSION_DIR)) {
		// `<timestamp>_<name>.jsonl` — the timestamp Pi writes holds no underscore.
		const separator = entry.indexOf("_");
		if (!entry.endsWith(".jsonl") || separator < 0) continue;
		const name = entry.slice(separator + 1, -".jsonl".length);
		if (referenced.has(name) || isLive(name)) continue;
		const file = join(SESSION_DIR, entry);
		try {
			if (statSync(file).mtimeMs > cutoff) continue;
		} catch {
			continue;
		}
		discardFile(file);
	}
}
