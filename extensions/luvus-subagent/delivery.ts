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
 */
import { rmSync } from "node:fs";
import { type ExtensionAPI, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Text } from "@earendil-works/pi-tui";
import { readChildResult } from "./child-session.ts";
import { WAIT_FLOOR_MS, closePane, waitForSettle, type SettleOutcome } from "./luvus.ts";
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
			customType: "luvus-subagent-completion",
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

export type SettleWatch = {
	pi: ExtensionAPI;
	pane: string;
	sessionId: string;
	agentName: string;
	promptFile: string | undefined;
	isStale: () => boolean;
};

export async function deliverWhenSettled(watch: SettleWatch): Promise<void> {
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
