/**
 * What a delegation's end means, and how much of its answer the parent's context can hold.
 *
 * This is the one place the extension decides what an end is: `settledState` is read by the
 * settle entry, the widget and the notice's glyph, so a card can never contradict the row it
 * belongs to; `shownResult` keeps a child that is still working from handing over a turn it
 * may yet supersede; and the note for an expired wait is the only place a *move* is named,
 * because a parent blocked on something that has not moved needs one.
 */
import type { ChildOutcome, ChildResult } from "./child-session.ts";
import type { SettleOutcome } from "./luvus.ts";
// ── Result from the child's own session ────────────────────────────────────

/** Stop reasons that mean the assistant message is final rather than intermediate. */
/**
 * The word and the parenthetical note for one outcome.
 *
 * The note states what happened, never what to do about it: naming an action raises
 * its salience, which is how a parent that reads partial output as a finished result
 * ends up delegating the same work twice. Same shape as `pi-subagents`.
 */
export function outcomeLine(outcome: ChildOutcome): { word: string; note: string } {
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
 * What a wait that ended at its bound leaves behind.
 *
 * The outcome notes above deliberately name no action: they describe a partial answer,
 * and naming a move there is how a parent ends up re-delegating work that was done. This
 * one is the opposite case — the parent is blocked on something that has not moved, so
 * the way out is the message. The reference names the same moves for the same reason.
 */
export function waitExpiredNote(boundMs: number | undefined, since: string | undefined): string {
	const bound = boundMs === undefined ? "its bound" : `${Math.round(boundMs / 1000)}s`;
	return `The wait ended after ${bound}, and the child was not stopped: ${since ?? "it is still working"}. Waiting again will not unstick it — steer it with a deadline (interrupt: true makes it wrap up now), or tell the user it looks stuck.`;
}

/**
 * How much of one message's answers are pushed into the parent's context.
 *
 * The official subagent example caps its own output at this size; past it the
 * answer still lives in the child's pane and session file. The cap is on the
 * message, so a burst that settles together cannot push one cap per child.
 */
export const COMPLETION_OUTPUT_CAP = 50 * 1024;

/** Lines of the answer shown before the card asks for Ctrl+O. */
export const COLLAPSED_LINES = 3;

export function capCompletion(text: string, room = COMPLETION_OUTPUT_CAP): string {
	if (text.length <= room) return text;
	const kb = COMPLETION_OUTPUT_CAP / 1024;
	if (room <= 0) return `(answer omitted: this notice already reached ${kb}KB — read it with subagent_status or in the child's pane)`;
	return `${text.slice(0, room)}\n\n… truncated at ${kb}KB per notice; the rest is in the child's pane and session file.`;
}

/** How a delegation ended, from the wait that observed it and the child's own last turn. */
export function endedOf(outcome: SettleOutcome | undefined, result: ChildResult | undefined): ChildOutcome {
	return outcome === "gone" ? "pane closed" : outcome === "settled" ? (result?.outcome ?? "no-answer") : "still running";
}

/**
 * The registry state for a delegation whose wait ended.
 *
 * A closed pane is a failure whatever the transcript says; otherwise the child's own last
 * turn decides. One rule for the widget, the notice and the tool result: three spellings of
 * it used to drift apart.
 */
export function settledState(outcome: SettleOutcome | undefined, result: ChildResult | undefined): "done" | "failed" {
	return outcome === "gone" || result?.status === "failed" ? "failed" : "done";
}

/**
 * The answer text a result may carry, or "" when there is none to hand over.
 *
 * A child that outlived its wait is still working, and a terminal turn its session file
 * already holds is provisional — it can be superseded by a newer one before the child is
 * done. Handing it over is what made one answer arrive twice: here, and again in the
 * notice the watcher pushes when the child really settles. The outcome's own note says
 * the child is still running, so the placeholder that used to stand in for the answer is
 * noise; and the window a caller spends waiting is never the model's to shorten.
 */
export function shownResult(result: ChildResult | undefined, ended: ChildOutcome): string {
	if (ended === "still running" || result === undefined) return "";
	return capCompletion(result.text);
}



