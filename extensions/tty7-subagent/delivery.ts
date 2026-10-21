/**
 * Handing an answer to the parent, exactly once.
 *
 * An answer has three carriers — the result a blocking call returns, the answer a read pulls,
 * and the notice pushed when a background child settles — and whichever arrives first
 * delivers it while the others stand down. That rule spans three call sites, so the state it
 * turns on lives here and nowhere else:
 *
 * - `recordDelivery` — this answer reached the parent.
 * - `answerAlreadyDelivered` — it did, so a read points at it instead of saying it twice.
 * - `holdDeliveryFor` / `releaseDeliveryHold` — a read is delivering it right now, so the
 *   notice stands down; a read that gives up releases the hold and the notice carries it.
 *
 * The notice is the fallback for a parent that neither asked nor waited. A notice the cap cut
 * short is not a delivery: the answer stays pullable, and `sendNotice` says which it was.
 *
 * When a delegation is over is decided here too, because "over" is what delivery waits for: a
 * finished state is watched for its own window before anything is recorded or handed over, so
 * a child that goes back to work — a retry, a continuation — is never reported as finished.
 */
import { rmSync } from "node:fs";
import { type ExtensionAPI, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Text } from "@earendil-works/pi-tui";
import { childLastWriteAt, readChildResult, type ChildResult } from "./child-session.ts";
import { terminalRecordAt } from "./child-session.ts";
import { START_POLL_MS, WAIT_FLOOR_MS, closePane, paneIsGone, paneState, waitForSettle, type SettleOutcome } from "./tty7.ts";
import { COLLAPSED_LINES, COMPLETION_OUTPUT_CAP, capCompletion, endedOf, outcomeLine, settledState, shownResult } from "./outcome.ts";
import { alreadyReported, delegations, markReported, settleDelegation } from "./registry.ts";
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

export function sendNotice(pi: ExtensionAPI, header: string, body: string): boolean {
	const queued = pendingNotice !== undefined;
	pendingNotice ??= [];
	// The cap is on the message, not on one child: a burst that settles together is one
	// message, so it must not push one cap per child into the parent. Only the body is capped:
	// a header says which child this is and how it ended, and nothing else in the message does.
	const used = pendingNotice.reduce((total, part) => total + part.text.length, 0);
	const shown = capCompletion(body, COMPLETION_OUTPUT_CAP - used);
	pendingNotice.push({ type: "text", text: shown.length > 0 ? `${header}\n\n${shown}` : header });
	if (queued) return shown === body;
	pi.sendMessage(
		{
			customType: "tty7-subagent-completion",
			// The answer rides along, capped; the renderer draws each part as its own
			// header plus a few lines, so the transcript stays readable without hiding
			// the result from the parent.
			content: pendingNotice,
			display: true,
		},
		{ deliverAs: "steer", triggerTurn: true },
	);
	// Whether the parent now holds the whole answer: a notice that hit the cap delivered only
	// part of it, and the rest stays pullable from the read.
	return shown === body;
}

/**
 * Draw a completion notice as a card: one header per child, then a few lines of its
 * answer, the rest behind Ctrl+O.
 *
 * The model still receives the whole text — packaging the display is what keeps the
 * transcript readable, and dropping the text instead would hide the answer from the
 * parent. A header's glyph is its status, so a merged card colours every child right.
 */
export function registerCompletionRenderer(pi: ExtensionAPI): void {
	pi.registerMessageRenderer("tty7-subagent-completion", (message, { expanded, outputPad }, theme) => {
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
 * How long a finished state has to hold before it is the end of the delegation.
 *
 * A terminal state is a report, not a conclusion. A child reports the end of a *turn*, and that
 * is not the same thing as the delegation being over: an extension that retries a failed turn
 * (`pi-retry` and its kin) re-runs it in the same pane seconds later, and one that continues a
 * finished agent does the same thing on purpose. Measured against a real retry extension, a
 * child that errored on a dropped connection answered normally two seconds later — while this
 * extension had already recorded it failed and closed the pane that retry needed.
 *
 * So the state is watched rather than believed: nothing is recorded, delivered or closed until
 * it has held for this window with no new writing and no return to `working`. The cost is that
 * a delegation is reported this much later than the child finished; the gain is that "done"
 * means the child stopped, which is what every reader of a state here assumes it means.
 *
 * Ten seconds, chosen against a real retry extension rather than from theory: its retry followed
 * the dropped connection within a couple of seconds, and the window has to outlast the gap a
 * retry actually takes, not the worst one imaginable. It is also what a parent pays on every
 * delegation, including the ones that simply finished — so it is the smallest window that
 * comfortably covers that measured gap, and not a round half minute.
 */
const QUIESCENCE_WINDOW_MS = 10_000;
/**
 * The window above, overridable only so the checks need not wait ten seconds per case.
 *
 * Zero is a legal value and means "take the state as reported": a suite that had to spend the
 * window on every delegation in it would be testing this window instead of what it asked about.
 */
function quiescenceMs(): number {
	const configured = process.env.PI_SUBAGENT_STATE_CONFIRM_MS;
	if (configured === undefined) return QUIESCENCE_WINDOW_MS;
	const window = Number(configured);
	return Number.isFinite(window) && window >= 0 ? window : QUIESCENCE_WINDOW_MS;
}
/**
 * Watch a finished state for the child starting again.
 *
 * Two signals, because neither is enough alone: the child's transcript, because a retry writes
 * and a child that has only lost its connection has written nothing; and the pane's own state,
 * because a continuation may start before it has anything to say. The transcript is read as its
 * mtime and never as its content: a child writing right now has a half-written last line, and a
 * parse that fails there would lose the signal at the one moment it exists for. `continued` means the child
 * is working again and the wait resumes; `quiet` means the state held, which is what makes it
 * final; `gone` is a pane that went away underneath it; `stale` is this session being torn
 * down, which has no next turn to deliver to.
 */
export async function awaitQuiescence(
	pi: ExtensionAPI,
	sessionName: string,
	pane: string,
	isStale: () => boolean,
): Promise<"continued" | "quiet" | "gone" | "stale"> {
	const window = quiescenceMs();
	if (window === 0) return "quiet";
	const baseline = childLastWriteAt(sessionName) ?? Date.now();
	const deadline = Date.now() + window;
	for (;;) {
		if (isStale()) return "stale";
		if (Date.now() >= deadline) return "quiet";
		await new Promise((resolve) => setTimeout(resolve, START_POLL_MS));
		const lastWriteAt = childLastWriteAt(sessionName);
		if (lastWriteAt !== undefined && lastWriteAt > baseline) return "continued";
		if ((await paneState(pi, pane)) === "working") return "continued";
		if (await paneIsGone(pi, pane)) return "gone";
	}
}
/**
 * What a parent is told when a child reported a finished turn and then went back to work.
 *
 * It carries no answer — an answer that may still arrive is not an answer — and it names what
 * would move the child, because a parent blocked on something that has not moved needs one.
 */
export function wentBackToWorkNote(): string {
	return "It reported its turn as finished, and then started working again before that state had held, so it is still running and stays watched with its pane open. Waiting again will not speed that up — steer it (interrupt: true makes it wrap up now) if you want it to move, or tell the user it looks stuck.";
}
/**
 * Watch a background child to completion and hand its result to the parent.
 *
 * Detached on purpose: the delegation has already returned, so nothing awaits this promise.
 * Messaging the session is what tells the parent the child is done, so this is the only
 * delivery path a background delegation has.
 */
export type SettleWatch = {
	pi: ExtensionAPI;
	pane: string;
	sessionId: string;
	/**
	 * The transcript record the watcher counts an ending from — the task's own line, when the
	 * caller that handed it over knows it. Without it the watcher starts from the last ending
	 * it can see, which is right for a child that had not picked the task up yet.
	 */
	after?: number;
	agentName: string;
	promptFile: string | undefined;
	isStale: () => boolean;
};

export async function deliverWhenSettled(watch: SettleWatch): Promise<void> {
	const { pi, pane, sessionId, agentName, promptFile, isStale } = watch;
	// One cursor, moved forward only: a child that ends a turn, goes back to work and ends
	// again must be settled by the ending that came after the watching, not by the first one.
	let cursor = watch.after ?? terminalRecordAt(sessionId) ?? -1;
	// The registry owns the start time, so the notice and the widget agree.
	const startedAt = delegations.get(sessionId)?.startedAt ?? Date.now();
	let outcome: SettleOutcome = "timeout";
	let result: ChildResult | undefined;
	try {
		// Two loops, one rule: nothing records this delegation as over until something says the
		// child itself is. The inner one waits out a wait that ran out, because a long task must
		// not be recorded as finished while it runs; the outer one gives an errored turn its retry
		// window, and goes back to waiting when the child starts working again.
		for (;;) {
			// A wait that ran out is not the child's end, so the watcher keeps watching until
			// it settles or its pane dies: a long task is never recorded as finished while it
			// is still running. The floor stops a wait that fails at once from spinning.
			for (;;) {
				const cycleStart = Date.now();
				// Measured from the ending this cycle already knew about: a child that went back to
				// work has to end *again* to be settled again.
				outcome = await waitForSettle(pi, pane, { sessionId, after: cursor });
				if (outcome !== "timeout" || isStale()) break;
				const spent = Date.now() - cycleStart;
				// A wait that failed at once is not the child's end: wait out the floor and watch
				// again, rather than leave a `working` record that nothing will ever settle.
				if (spent < WAIT_FLOOR_MS) await new Promise((resolve) => setTimeout(resolve, WAIT_FLOOR_MS - spent));
			}
			result = readChildResult(sessionId);
			// A finished state is watched, not believed: the child may be about to retry an errored
			// turn or to continue one it reported as done. Nothing is settled and nothing is
			// delivered until the window says the state held.
			if (outcome === "timeout") break;
			const verdict = await awaitQuiescence(pi, sessionId, pane, isStale);
			if (verdict === "stale") return;
			if (verdict !== "continued") break;
			// The cursor stays where it was: whatever ended the turn this window rejected is
			// still "an ending", so the next cycle recognizes the newer one at once instead of
			// blocking for an ending that has already been written.
		}
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
		// A parent that already pulled this answer has it, and one blocked on a read is being
		// handed it by that read: the notice is the fallback for a parent that neither asked
		// nor waited, so there is nothing to hand over twice.
		if (alreadyReported(sessionId) || waitingReads.has(sessionId)) return;
		const shown = shownResult(result, ended);
		const body = [shown, line.note].filter((part) => part.length > 0).join("\n\n");
		// A notice is a delivery like any other, so it is recorded as one: without that, a read
		// that arrives after it hands the same answer over again — measured, one answer arrived
		// twice, once in the tool result and once here. A notice the cap cut short is the
		// exception: the parent does not have all of it, so it stays pullable.
		if (sendNotice(pi, header, body)) markReported(sessionId);
	} catch (error) {
		settleDelegation(sessionId, "failed");
		if (isStale()) return;
		if (alreadyReported(sessionId)) return;
		if (sendNotice(pi, `✗ ${agentName} (${sessionId}) — could not read its result: ${String(error)}`, "")) {
			markReported(sessionId);
		}
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
export async function teardownDelegation(watch: {
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

// ── The carriers, and the one record they share ───────────────────────────
/**
 * The reads that are waiting, and therefore delivering this answer themselves.
 *
 * A hold, not a delivery: while a read waits for its answer the notice must stay quiet, and a
 * read that gives up takes the hold back so the notice still reaches the parent at all.
 */
const waitingReads = new Set<string>();
/**
 * A read that is about to wait holds the notice off.
 *
 * It is handing the answer over itself, so the notice must not push the same words while the
 * read is still waiting for them. A hold is not a delivery: nothing has reached the parent yet.
 */
export function holdDeliveryFor(sessionName: string): void {
	waitingReads.add(sessionName);
}
/** A wait that gave up: the notice is the carrier again. */
export function releaseDeliveryHold(sessionName: string): void {
	waitingReads.delete(sessionName);
}
/** Record that an answer reached the parent, whichever path carried it. */
export function recordDelivery(sessionName: string): void {
	markReported(sessionName);
}
/** Whether this answer already reached the parent, so a read points at it instead. */
export function answerAlreadyDelivered(sessionName: string): boolean {
	return alreadyReported(sessionName);
}
/**
 * The notice content still queued, for the hook that has to recognise its own message.
 *
 * A queued notice rides along with one already on its way, so what the parent receives is the
 * array handed to `sendMessage` — identity is how the hook knows the message in front of it is
 * this extension's, and that the queue it guards is now empty.
 */
export function queuedNotice(): { type: "text"; text: string }[] | undefined {
	return pendingNotice;
}
/** Drop what is queued: the session it belonged to is not the one being shown any more. */
export function clearQueuedNotice(): void {
	pendingNotice = undefined;
}
