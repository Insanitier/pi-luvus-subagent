/**
 * Handing a task to a child, and reading back whether it took it.
 *
 * Two steps, because one is not enough: the paste puts the text in the child's editor, and a
 * long multi-line paste is *not* submitted by it. The evidence is the child's own transcript —
 * not its state, because a status describes the pane and this is about *this* text.
 *
 * A resume is the case that makes the evidence subtle: the session file already holds older
 * user messages, so "a user line mentions the task" can be true before anything was pasted.
 * The caller hands in where the transcript stood, and only what arrived after that counts.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TASK_MARK_IN_PANE_CHARS, readSessionRecords, sessionFileFor, taskRecordAt } from "./child-session.ts";
import { PROMPT_FILE_MODE } from "./env.ts";
import { START_POLL_MS, Tty7Error, pressKey, readPane, typeText } from "./tty7.ts";
/** How a handover ended: the child wrote the task down, or it did not, or nothing was sent. */
export type Handover =
	| { state: "taken"; record: number }
	| { state: "unsent"; code: number | undefined }
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
	pane: string,
	sessionName: string,
	task: string,
	seconds: number,
): Promise<Handover> {
	// Where the transcript stood before the paste. A resumed session shows older user
	// messages, and one of them can carry the same words — a parent that retries a task it
	// already sent would otherwise be told the child took it, without a key being pressed.
	const before = sessionRecordCount(sessionName);
	// The body goes through a file rather than argv: `send --from-file` hands the bytes over
	// exactly as written, so a task with quotes or newlines cannot arrive as a different text.
	const dir = mkdtempSync(join(tmpdir(), "tty7-subagent-task-"));
	const file = join(dir, "task.md");
	writeFileSync(file, task, { encoding: "utf-8", mode: PROMPT_FILE_MODE });
	try {
		// Paste, then submit: a long paste leaves the text sitting in the editor on its own.
		await typeText(pi, pane, file);
		await pressKey(pi, pane, "enter");
	} catch (error) {
		// A pane that went away mid-hand-over refuses the paste; the caller asks whether it
		// is gone and reports that instead of a task that was never sent. The code rides along
		// because "the pane is gone" and "the pane declined it" are different answers.
		return { state: "unsent", code: error instanceof Tty7Error ? error.code : undefined };
	} finally {
		// The bytes are in the child's editor by now; the file's only job was the handover.
		rmSync(dir, { recursive: true, force: true });
	}
	const deadline = Date.now() + seconds * 1000;
	let presses = 1;
	while (Date.now() < deadline) {
		const record = taskRecordAt(sessionName, task, before);
		if (record !== undefined) return { state: "taken", record };
		// Still missing, so the paste is sitting there unsent and Enter is the step that did
		// not land — a child that was still starting swallows one, and pressing again costs
		// nothing while submitting is the only thing left to do.
		await new Promise((resolve) => setTimeout(resolve, START_POLL_MS * 3));
		if (Date.now() >= deadline) break;
		await pressKey(pi, pane, "enter").catch(() => undefined);
		presses += 1;
	}
	return { state: "queued", presses, unsentInComposer: await taskSitsUnsent(pi, pane, task) };
}

/**
 * Whether the task text is still sitting in the child's input box.
 *
 * The one failure worth naming exactly: the paste landed and the Enters did not, so the
 * task is neither lost nor running — it is waiting for the key that submits it. Without
 * this, that case is indistinguishable from a child that read the task and ignored it,
 * and the two call for opposite next moves.
 */
export async function taskSitsUnsent(pi: ExtensionAPI, pane: string, task: string): Promise<boolean> {
	const read = await readPane(pi, pane);
	if (read === undefined) return false;
	// Enough of the task to be unmistakable; the pane wraps and indents long lines.
	return read.text.includes(task.slice(0, TASK_MARK_IN_PANE_CHARS));
}
/**
 * One message's handover, in words: what was done to this child, and what it made of it.
 *
 * Four answers, and they call for four different moves: the child has it, the pane refused it
 * and said why, it is sitting unsent in the input box (the Enters did not land — steer again
 * to press Enter), or the pane took it but nothing proves pickup yet.
 *
 * What both callers share is the four states themselves (`Handover`), not these sentences: a
 * launch words the same states with what only a launch knows — whether its pane still exists,
 * and that nothing is running — so it composes its own. `verb` is what this caller did to get
 * here, because a fresh message and an interrupting one read differently to whoever asks next.
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
	return `${verb} ${target} — queued; the paste landed, but pickup is not confirmed.`;
}

