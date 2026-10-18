/**
 * Handing a task to a child, and reading back whether it took it.
 *
 * Two steps, because one is not enough: `agent prompt` pastes the text, and a long multi-line
 * paste is *not* submitted by it. The evidence is the child's own transcript — not its state,
 * because a status describes the pane and this is about *this* text.
 *
 * A resume is the case that makes the evidence subtle: the session file already holds older
 * user messages, so "a user line mentions the task" can be true before anything was pasted.
 * The caller hands in where the transcript stood, and only what arrived after that counts.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { TASK_MARK_IN_PANE_CHARS, readSessionRecords, sessionFileFor, taskInTranscript } from "./child-session.ts";
import { LuvusError, PROMPT_SUBMIT_TIMEOUT_MS, START_POLL_MS, callLuvus, pressKey, readPane } from "./luvus.ts";
import { rememberTerminal } from "./registry.ts";
/** How a handover ended: the child wrote the task down, or it did not, or nothing was sent. */
export type Handover =
	| { state: "taken" }
	| { state: "unsent"; code: string | undefined }
	| { state: "queued"; presses: number; unsentInComposer: boolean };

/** How many records the child's transcript holds, as the baseline a handover is read against. */
function sessionRecordCount(sessionName: string): number {
	const file = sessionFileFor(sessionName);
	if (file === undefined) return 0;
	return readSessionRecords(file)?.length ?? 0;
}

/**
 * Hand a task to a child and let its own transcript say whether it took it.
 *
 * Two steps, because one is not enough: `agent prompt` pastes the text, and a long
 * multi-line paste is *not* submitted by it — measured against the real CLI, where a
 * 12-line paste sat in the child's editor until a separate `agent keys <target> enter`.
 *
 * The evidence is the child's transcript, not its status. Luvus answers `agent start`
 * with the state it saw once the pane was ready, and its guidance is to accept that
 * "without another status lookup": a second lookup lands while the pane is still coming
 * up, where the answer is a guess read off the screen (`authority: command_fallback`) or
 * not reported yet, and neither says anything about *this* message. So the launch reply
 * is the baseline, and the confirmation is the user line the child writes when it picks
 * the task up.
 *
 * A handover the host refused sent nothing at all, and is its own answer. A launch reply
 * that reported the child as working is *not* one: measured live, `agent start` answered
 * `status: "working"` for a child that was still drawing its banner and had not taken a
 * single key — the pane's state says nothing about whether this text arrived, which is
 * what Luvus' own guidance means by a status "does not by itself prove prompt readiness".
 * So the status is reported, never used to decide: the transcript decides.
 */
export async function submitAndConfirm(
	pi: ExtensionAPI,
	sessionName: string,
	task: string,
	seconds: number,
	fence?: string,
): Promise<Handover> {
	// Where the transcript stood before the paste. A resumed session shows older user
	// messages, and one of them can carry the same words — a parent that retries a task it
	// already sent would otherwise be told the child took it, without a key being pressed.
	const before = sessionRecordCount(sessionName);
	// Paste, then submit: a long paste leaves the text sitting in the editor on its own.
	try {
		const prompt = ["agent", "prompt", sessionName, task];
		// The host's own fence: it refuses the prompt unless the terminal behind the name is the
		// one this id names (`content_revision_conflict`, measured). Only callers that have read
		// the pane recently can pass one; at launch there is nothing to compare against yet.
		if (fence !== undefined) prompt.push("--terminal-id", fence);
		await callLuvus(pi, prompt, PROMPT_SUBMIT_TIMEOUT_MS);
		await pressKey(pi, sessionName, "enter");
	} catch (error) {
		// A pane that went away mid-hand-over refuses the paste; the caller asks whether it
		// is gone and reports that instead of a task that was never sent. The code rides along
		// because "the pane is gone" and "the pane declined it" are different answers.
		return { state: "unsent", code: error instanceof LuvusError ? error.code : undefined };
	}
	const deadline = Date.now() + seconds * 1000;
	let presses = 1;
	while (Date.now() < deadline) {
		if (taskInTranscript(sessionName, task, before)) return { state: "taken" };
		// Still missing, so the paste is sitting there unsent and Enter is the step that did
		// not land — a child that was still starting swallows one, and pressing again costs
		// nothing while submitting is the only thing left to do.
		await new Promise((resolve) => setTimeout(resolve, START_POLL_MS * 3));
		if (Date.now() >= deadline) break;
		await pressKey(pi, sessionName, "enter").catch(() => undefined);
		presses += 1;
	}
	return { state: "queued", presses, unsentInComposer: await taskSitsUnsent(pi, sessionName, task) };
}

/**
 * Whether the task text is still sitting in the child's input box.
 *
 * The one failure worth naming exactly: the paste landed and the Enters did not, so the
 * task is neither lost nor running — it is waiting for the key that submits it. Without
 * this, that case is indistinguishable from a child that read the task and ignored it,
 * and the two call for opposite next moves.
 */
export async function taskSitsUnsent(pi: ExtensionAPI, sessionName: string, task: string): Promise<boolean> {
	const read = await readPane(pi, sessionName);
	// A read taken here is also where a delegation first learns which terminal it is running
	// in, so a steer much later can refuse a pane id that has changed hands since.
	rememberTerminal(sessionName, read?.terminalId);
	if (read === undefined) return false;
	// Enough of the task to be unmistakable; the pane wraps and indents long lines.
	return read.text.includes(task.slice(0, TASK_MARK_IN_PANE_CHARS));
}
/**
 * A handover in words, for the tool that asked for it.
 *
 * Four answers, and they call for four different moves: the child has it, the host refused
 * it and said why, it is sitting unsent in the input box (the Enters did not land — steer
 * again to press Enter), or the host took it but nothing proves pickup yet.
 *
 * `verb` is what the caller did to get here — a fresh message and an interrupting one read
 * differently to whoever asks next.
 */
export function handoverText(verdict: Handover, target: string, verb: string): string {
	if (verdict.state === "taken") return `${verb} ${target}, and it is working.`;
	if (verdict.state === "unsent") {
		return `${verb} ${target} — nothing was sent: the host refused the message${
			verdict.code === undefined ? "" : ` (${verdict.code})`
		}.`;
	}
	if (verdict.unsentInComposer) {
		return `${verb} ${target} — the message is sitting in its input box unsent, so steer it again to press Enter.`;
	}
	return `${verb} ${target} — queued; the host took the message, but pickup is not confirmed.`;
}

