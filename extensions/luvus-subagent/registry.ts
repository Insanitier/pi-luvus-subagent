/**
 * The registry: which delegations this session has, what each one is doing, and the one row
 * the parent sees while it runs.
 *
 * A delegation's record lives in the session rather than in this process — it is written as a
 * session entry when the child starts and when it settles, and rebuilt from those entries
 * after a reload — so a process that restarts keeps its delegations while another session
 * never sees them. Two lifecycles deliberately differ: the widget keeps a settled row for one
 * turn, while a record is never retired by age, because `subagent_status` still answers for a
 * delegation that ended long ago.
 *
 * Nothing here decides how an answer is handed over: that rule lives in `delivery`, and the
 * flag it turns on (`reportedAt`) is only ever set through it.
 */
import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { ChildProgress } from "./child-session.ts";
import { DELEGATION_ENTRY, SETTLED_ENTRY } from "./env.ts";
import { paneIsGone } from "./luvus.ts";
// ── Where a child is shown, and what the parent sees while it runs ─────────

/** Key the status line and the widget are published under. */
export const STATUS_KEY = "subagents";

export type Delegation = {
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
	/** What the last read of this delegation saw, so the next one can say what changed. */
	lastRead?: { at: number; toolUses: number };
	/**
	 * The terminal instance this delegation was last seen running in.
	 *
	 * The pane is a small integer the host hands out again after a close, the terminal id
	 * is not — so this is what a later steer checks before it types into a stranger's pane.
	 */
	terminalId?: string;
};

/** How many parent turns the widget keeps a settled row, per the reference. */
export const LINGER_TURNS = 1;
/** The parent turn counter the linger is measured in. */
let turn = 0;

/**
 * The session entries the registry is rebuilt from.
 *
 * Pi stores a custom entry without sending it to the model, so the record costs no
 * context and travels with the conversation: a reload, a restart or a compaction
 * brings the delegations back instead of losing them with the process.
 */

export type DelegationEntry = { sessionName: string; agent: string; task: string; pane: string; startedAt: number };
export type SettledEntry = { sessionName: string; state: "done" | "failed"; endedAt: number };

/** The API entries are appended through; set once at load, like the widget's UI. */
let entryApi: ExtensionAPI | undefined;

/**
 * One entry per delegation this session, keyed by session name — the only id the
 * tool and the detached watcher both hold.
 *
 * Records outlive the widget, the way the reference separates them: the widget draws a
 * settled delegation for a turn or two and nothing at all once nothing is running,
 * while the record still answers for as long as the conversation does. Clearing the
 * screen is not forgetting, and nothing retires a record but the session ending.
 */
export const delegations = new Map<string, Delegation>();

/**
 * Reads blocked on a delegation, resolved by the settle that ends it.
 *
 * The wait is on the registry, not on a Luvus wait of its own: the watcher settles this
 * exactly once, and the promise it resolves is the same event the notice is built from —
 * so a waiting read cannot miss the end by starting a moment too late.
 */
export const settleWaiters = new Map<string, Set<() => void>>();

/** The UI the widget is published through, and the ticker that repaints it while it runs. */
let statusUi: ExtensionUIContext | undefined;
let statusTicker: ReturnType<typeof setInterval> | undefined;

// There is deliberately no linger timer here: the widget is cleared the moment
// nothing is running (see renderStatus). A finished row is history, not a status.

/** What has changed since the parent's last read, in words a decision can be made from. */
export function sinceLastRead(progress: ChildProgress, entry: Delegation): string | undefined {
	const seen = entry.lastRead;
	// No earlier reading, so there is no delta to state: the row carries the wall-clock age
	// instead, and claiming "nothing has changed" here would be a claim with no basis.
	if (seen === undefined) return undefined;
	const ago = formatElapsed(seen.at);
	const more = progress.toolUses - seen.toolUses;
	if (more > 0) return `${more} more tool call${more === 1 ? "" : "s"} since your last read ${ago} ago`;
	// The file is what says the child is alive: a child that is thinking or streaming writes
	// without calling another tool, and calling that "nothing changed" would invite the reader
	// to interrupt a child that is working.
	if (progress.lastWriteAt !== undefined && progress.lastWriteAt > seen.at) {
		return `still writing, but no new tool call since your last read ${ago} ago`;
	}
	return `nothing has changed since your last read ${ago} ago`;
}

/** The line a running delegation adds: what it is doing, and what moved since last read. */
export function progressLine(progress: ChildProgress | undefined, since: string | undefined): string {
	// Not "no session file yet": a child writing right now has a half-written last line, and
	// the parse fails on it, so this line cannot tell the two apart and must not pretend to.
	if (progress === undefined) return "  progress: no readable transcript yet";
	const parts = [progress.activity, `${progress.toolUses} tool call${progress.toolUses === 1 ? "" : "s"}`];
	// Only the first read carries the wall-clock age: afterwards the tail already says what
	// the file has done since, and two ages in one line read as two different things.
	if (since === undefined && progress.lastWriteAt !== undefined) {
		parts.push(`last write ${formatElapsed(progress.lastWriteAt)} ago`);
	}
	return `  progress: ${parts.join(", ")}${since === undefined ? "" : ` \u2014 ${since}`}`;
}

export function formatElapsed(startedAt: number, endedAt?: number): string {
	const seconds = Math.max(0, Math.round(((endedAt ?? Date.now()) - startedAt) / 1000));
	return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}
/** Stop the 1s repaint that keeps a running delegation's duration live. */
export function stopStatusTicker(): void {
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
export function renderStatus(): void {
	const ui = statusUi;
	if (ui === undefined) return;
	// A record is not the widget's to retire: what the widget stops drawing stays
	// answerable above.
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

export function trackDelegation(sessionName: string, pane: string, ui: ExtensionUIContext | undefined): void {
	// Nothing goes to the footer: the widget carries all of it, and a footer left by an
	// earlier instance must not outlive this one. This runs once per UI, not per repaint.
	if (ui !== undefined && ui !== statusUi) {
		statusUi = ui;
		ui.setStatus(STATUS_KEY, undefined);
	}
	// Earlier records are not cleared here: nothing retires one but the session ending,
	// and the widget's own linger decides what is drawn.
	delegations.set(sessionName, { startedAt: Date.now(), state: "working", pane });
	renderStatus();
}

export function settleDelegation(sessionName: string, state: "done" | "failed"): void {
	const entry = delegations.get(sessionName);
	// The first settle wins: the caller that observed the end is the one that knows why,
	// and settling twice would append a second entry for one delegation.
	if (entry === undefined || entry.endedAt !== undefined) return;
	const endedAt = Date.now();
	delegations.set(sessionName, { ...entry, endedAt, state, settledTurn: turn });
	// The replay reads the last settled entry per delegation, so appending is enough.
	entryApi?.appendEntry(SETTLED_ENTRY, { sessionName, state, endedAt } satisfies SettledEntry);
	// A read waiting on this delegation is waiting for exactly this moment.
	for (const resolve of settleWaiters.get(sessionName) ?? []) resolve();
	settleWaiters.delete(sessionName);
	renderStatus();
}

/**
 * Wait for a delegation to be over, bounded or not.
 *
 * `boundMs` bounds the wait only: nothing here stops or interrupts the child, which is
 * why an expired wait is a fact about the reader and not about the work.
 */
export async function waitForDelegation(
	sessionName: string,
	boundMs: number | undefined,
	signal: AbortSignal | undefined,
): Promise<boolean> {
	if (delegations.get(sessionName)?.endedAt !== undefined) return true;
	await new Promise<void>((resolve) => {
		const waiters = settleWaiters.get(sessionName) ?? new Set<() => void>();
		waiters.add(resolve);
		settleWaiters.set(sessionName, waiters);
		const stop = (): void => {
			waiters.delete(resolve);
			resolve();
		};
		if (boundMs !== undefined) {
			const timer = setTimeout(stop, boundMs);
			timer.unref?.();
		}
		signal?.addEventListener("abort", stop, { once: true });
	});
	return delegations.get(sessionName)?.endedAt !== undefined;
}

/**
 * Remember what a read saw, so the next one can say what changed in between.
 *
 * The read path records this and nothing else: `lastRead` is not a field a caller may write,
 * because the whole point of it is that both sides read the same value.
 */
export function rememberRead(sessionName: string, read: { at: number; toolUses: number }): void {
	const entry = delegations.get(sessionName);
	if (entry === undefined) return;
	delegations.set(sessionName, { ...entry, lastRead: read });
}

/** Record that a delegation's answer has already reached the parent. */
export function markReported(sessionName: string): void {
	const entry = delegations.get(sessionName);
	if (entry === undefined || entry.reportedAt !== undefined) return;
	delegations.set(sessionName, { ...entry, reportedAt: Date.now() });
}

/** Whether the pushed notice would hand over an answer the parent already has. */
export function alreadyReported(sessionName: string): boolean {
	return delegations.get(sessionName)?.reportedAt !== undefined;
}

/**
 * Keep the terminal id a delegation is known by, so a later steer can tell it is still the
 * same terminal. A delegation this session never started is not tracked, and not tracking
 * it is not a failure: the read that learned the id simply had nothing to attach it to.
 */
export function rememberTerminal(sessionName: string, terminalId: string | undefined): void {
	if (terminalId === undefined) return;
	const entry = delegations.get(sessionName);
	if (entry === undefined || entry.terminalId === terminalId) return;
	delegations.set(sessionName, { ...entry, terminalId });
}

/** The fields a replay reads; nothing else about an entry matters here. */
export type ReplayEntry = { type: string; customType?: string; data?: unknown };

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
export async function replayDelegations(pi: ExtensionAPI, entries: readonly ReplayEntry[]): Promise<DelegationEntry[]> {
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

// ── The writes the entry used to do by hand ───────────────────────────────
/**
 * Point the registry at the API that writes session entries.
 *
 * Records outlive this process, so the API that appends them is handed in once rather than
 * reached for from wherever a record happens to be written.
 */
export function attachEntryApi(api: ExtensionAPI): void {
	entryApi = api;
}
/**
 * A session is being shown: the widget belongs to it and the turn count starts over.
 *
 * This is the whole of what `session_start` does to the widget — the repaint that publishes
 * it is `renderStatus`, which a replayed row needs too.
 */
export function beginSession(ui: ExtensionUIContext | undefined): void {
	turn = 0;
	statusUi = ui;
}
/** A branch was chosen without the session restarting: the linger counter starts over. */
export function restartTurnCount(): void {
	turn = 0;
}
/** The parent started a turn: the linger is counted in turns of the parent, not in seconds. */
export function countTurn(): void {
	turn++;
}
/**
 * The session is going away: nothing the widget holds outlives it.
 *
 * The records go with the session as well — a switch keeps the process alive, and the
 * previous session's records would otherwise answer the status tool and hand `resume` a
 * child this session never started.
 */
export function endSession(): void {
	delegations.clear();
	stopStatusTicker();
	// The widget goes with the session, not with the next repaint.
	statusUi?.setWidget(STATUS_KEY, undefined);
	statusUi = undefined;
	turn = 0;
}
