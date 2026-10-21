/**
 * Every call this extension makes into the tty7 CLI, and what each answer means.
 *
 * tty7 is not a wire protocol this extension speaks: it is a CLI that already owns the
 * panes, so a delegation is `split` + `send` + `capture` + `agents` + `wait` — the same
 * moves a person makes by hand, and the same ones the tty7 skill documents. Three things
 * are deliberate rather than left to callers:
 *
 * - **A status is read, never guessed.** tty7 reports an agent from its own hooks
 *   (`inferred: false`), so a child that is drawing its banner is not called `working`.
 *   There is no screen-text fallback in here; screen text is diagnostics, not evidence.
 * - **A finished turn is confirmed by the turn counter.** `--until done` is a *state*,
 *   not an event: a pane that ended a turn before the wait began answers `done` at once,
 *   and `--changed` refuses that same state forever. Measured on server 26.9.4: the wait
 *   either returns instantly with the previous turn's `done` or hangs to its timeout.
 *   So a wait is armed with the counter and only counts when `turns` moved past it.
 * - **A refusal keeps its exit code** (`timeout(1)` convention: 124 expired, 1 died), so
 *   "not yet" and "gone" stay different answers from "broken".
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ── The CLI ────────────────────────────────────────────────────────────────

/** tty7 is on PATH inside a tty7 pane; the override exists for tests and odd installs. */
export const tty7Binary = (): string => process.env.PI_TTY7_BIN?.trim() || "tty7";

/** How long a blocking delegation waits for the child before giving up. */
export const WAIT_SECONDS = 900;

/**
 * The shortest gap between two watcher cycles.
 *
 * A wait that returns sooner than this did not run out, it answered something — and on an
 * old server that something may be the previous turn's `done`. Re-arming at once would
 * spin, so the watcher waits out the floor, then watches again.
 */
export const WAIT_FLOOR_MS = 1_000;

/** How long a pane gets to close before it is left alone. */
export const PANE_CLOSE_TIMEOUT_MS = 15_000;

/** How long a single key press gets to reach the child. */
export const KEYSTROKE_TIMEOUT_MS = 15_000;

/** How long pasting the task into the child's editor gets. */
export const PROMPT_SUBMIT_TIMEOUT_MS = 30_000;

/** How often the child's state is read while it decides to take the task. */
export const START_POLL_MS = 1_000;

/** How much of a CLI's stderr is quoted back when its reply is unreadable. */
export const STDERR_TAIL_CHARS = 200;

/** How long a fresh child gets to write the task into its transcript. Measured: a second. */
export const START_CONFIRM_SECONDS = 15;

/** How long a steer to a busy child waits for the host to see it picked the message up. */
export const STEER_CONFIRM_SECONDS = 15;

/** How long the child gets to come up — a split, a command line and Pi's own boot. */
export const READY_TIMEOUT_SECONDS = 90;

/** A pane probe is one fast read; a server that hangs must not stall a delegation. */
export const PANE_PROBE_TIMEOUT_MS = 10_000;

export type Tty7Reply = {
	result: Record<string, unknown>;
	/** What the CLI printed — for `capture --plain` that is the text, not an object. */
	stdout: string;
	/** The CLI's own exit code: 0 answered, 124 timed out, 1 the pane died. */
	code: number;
	stderr: string;
};

/**
 * A refusal, carrying the exit code it came with.
 *
 * The code is the part worth keeping: `124` is a wait that ran out, `1` is a pane that is
 * no longer there. A caller that folds the two into one message sends a parent looking for
 * a terminal that never existed.
 */
export class Tty7Error extends Error {
	readonly code: number | undefined;

	constructor(message: string, code: number | undefined) {
		super(message);
		this.name = "Tty7Error";
		this.code = code;
	}
}

/** The last JSON object on stdout: streamed verbs print output first and the object last. */
function lastObject(stdout: string): Record<string, unknown> | undefined {
	const lines = stdout.split("\n").map((line) => line.trim());
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		const line = lines[index] ?? "";
		if (!line.startsWith("{")) continue;
		try {
			const parsed = JSON.parse(line) as unknown;
			if (typeof parsed === "object" && parsed !== null) return parsed as Record<string, unknown>;
		} catch {
			// Not the object; keep looking backwards.
		}
	}
	return undefined;
}

/**
 * One CLI call, never thrown — the exit code and stderr are handed back.
 *
 * A timeout of ours is reported as `124`, the CLI's own convention, so callers that branch
 * on it do not need to know whether the wait expired or this extension stopped waiting.
 */
export async function tryTty7(
	pi: ExtensionAPI,
	args: string[],
	timeoutMs: number,
): Promise<Tty7Reply> {
	const exec = await pi.exec(tty7Binary(), args, { timeout: timeoutMs });
	const stderr = exec.stderr.trim();
	if (exec.killed) {
		return {
			result: {},
			stdout: exec.stdout,
			code: 124,
			stderr: `timed out after ${Math.round(timeoutMs / 1000)}s`,
		};
	}
	return { result: lastObject(exec.stdout) ?? {}, stdout: exec.stdout, code: exec.code, stderr };
}

/**
 * One CLI call, refused loudly.
 *
 * Used where no caller can proceed past a refusal — splitting a pane, closing one. The
 * message carries what the CLI said rather than a guess, because its stderr is already the
 * sentence a parent would need.
 */
export async function callTty7(
	pi: ExtensionAPI,
	args: string[],
	timeoutMs: number,
): Promise<Tty7Reply> {
	const reply = await tryTty7(pi, args, timeoutMs);
	if (reply.code !== 0) {
		const label = `tty7 ${args[0] ?? ""}`.trim();
		const tail = reply.stderr.slice(-STDERR_TAIL_CHARS);
		throw new Tty7Error(`${label}: ${tail.length > 0 ? tail : `exit ${reply.code}`}`, reply.code);
	}
	return reply;
}

// ── Reading state ──────────────────────────────────────────────────────────

/** What tty7 says about the agent in a pane right now. */
export type AgentView = {
	pane: string;
	status: string;
	/** How many turns the agent has started: the counter a settled turn is confirmed by. */
	turns: number | undefined;
	/** The child's own session id — pinned at launch, so it also says "this is our child". */
	sessionId: string | undefined;
	/** False when tty7 is guessing from screen text instead of reading the child's hooks. */
	reported: boolean;
};

function numberField(source: unknown, key: string): number | undefined {
	if (typeof source !== "object" || source === null) return undefined;
	const value = (source as Record<string, unknown>)[key];
	return typeof value === "number" ? value : undefined;
}

function boolField(source: unknown, key: string): boolean | undefined {
	if (typeof source !== "object" || source === null) return undefined;
	const value = (source as Record<string, unknown>)[key];
	return typeof value === "boolean" ? value : undefined;
}

function objectField(source: unknown, key: string): Record<string, unknown> | undefined {
	if (typeof source !== "object" || source === null) return undefined;
	const value = (source as Record<string, unknown>)[key];
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

/**
 * The agent in a pane, or `undefined` when tty7 has nothing to say about it.
 *
 * One call answers presence, status and the turn counter together, so a caller that needs
 * two of them does not read two different instants.
 */
export async function paneAgent(pi: ExtensionAPI, pane: string): Promise<AgentView | undefined> {
	const reply = await tryTty7(pi, ["agents", "--json"], PANE_PROBE_TIMEOUT_MS).catch(() => undefined);
	if (reply === undefined || reply.code !== 0) return undefined;
	const agents = reply.result.agents;
	if (!Array.isArray(agents)) return undefined;
	const wanted = Number(pane);
	for (const entry of agents) {
		if (numberField(entry, "pane_id") !== wanted) continue;
		const state = objectField(entry, "state");
		const status = typeof state?.status === "string" ? state.status : undefined;
		if (status === undefined) return undefined;
		return {
			pane,
			status,
			turns: numberField(state, "turns"),
			sessionId: typeof state?.session_id === "string" ? state.session_id : undefined,
			reported: state?.inferred === false,
		};
	}
	return undefined;
}

/** The state a pane reports right now, or `undefined` when it cannot be read. */
export async function paneState(pi: ExtensionAPI, pane: string): Promise<string | undefined> {
	return (await paneAgent(pi, pane))?.status;
}

/** The turn counter, or `undefined` when the pane has no agent. */
export async function paneTurns(pi: ExtensionAPI, pane: string): Promise<number | undefined> {
	return (await paneAgent(pi, pane))?.turns;
}

/**
 * Whether a delegation's pane still exists.
 *
 * `pane ls --all` rather than `agents`: a pane whose child has exited is still a pane (with
 * a shell in it), and only the pane list says whether the pane itself is gone. Only a
 * definite absence counts — a server that cannot be reached has not said the pane is gone.
 */
export async function paneIsGone(pi: ExtensionAPI, pane: string): Promise<boolean> {
	const reply = await tryTty7(pi, ["pane", "ls", "--all", "--json"], PANE_PROBE_TIMEOUT_MS).catch(
		() => undefined,
	);
	if (reply === undefined || reply.code !== 0) return false;
	const panes = reply.result.panes;
	if (!Array.isArray(panes)) return false;
	const wanted = Number(pane);
	for (const entry of panes) {
		if (numberField(entry, "pane") !== wanted) continue;
		// `hibernated` panes have no process left; `live: false` is the same thing said the
		// other way round.
		return boolField(entry, "live") === false || boolField(entry, "hibernated") === true;
	}
	return true;
}

/** A pane's screen, replayed through a terminal so what comes back is the text a person reads. */
export type PaneRead = { text: string };

export async function readPane(pi: ExtensionAPI, target: string): Promise<PaneRead | undefined> {
	const reply = await tryTty7(pi, ["capture", target, "--plain"], PANE_PROBE_TIMEOUT_MS).catch(
		() => undefined,
	);
	if (reply === undefined || reply.code !== 0) return undefined;
	// `--plain` prints text, not JSON, so the answer is on stdout and `result` is empty.
	return { text: reply.stdout };
}

// ── Starting a child ───────────────────────────────────────────────────────

export type Launch = { pane: string; status: string | undefined };

/** Quote one argv element for the pane's shell, so a task text cannot become two commands. */
function shellQuote(arg: string): string {
	if (arg.length === 0) return "''";
	return `'${arg.replaceAll("'", `'\\''`)}'`;
}

/** The command line the pane's shell runs: the child's own argv, quoted. */
export function commandLine(argv: string[]): string {
	return argv.map(shellQuote).join(" ");
}

/** The Pi binary a child is launched with. Overridable for odd installs and for tests. */
export const piBinary = (): string => process.env.PI_SUBAGENT_PI_BIN?.trim() || "pi";

/**
 * Bring up a child in a pane of its own and prove it is the one we asked for.
 *
 * Three steps, and the third is the one that matters: `split` gives a pane, `send` starts
 * the child in it, and the child is *ready* only when tty7 reports an agent in that pane
 * carrying the session id we pinned. That last check is not politeness — a fresh pane can
 * swallow the Enter that follows the text (its shell is still painting its startup), the
 * `send` still succeeds, and the pane then looks exactly like a worker that has not got
 * going yet. So the Enter is re-sent while the command is still sitting on the prompt.
 */
export async function startChild(
	pi: ExtensionAPI,
	sessionName: string,
	argv: string[],
): Promise<Launch> {
	const split = await callTty7(pi, ["split", "--vertical", "--json"], PANE_PROBE_TIMEOUT_MS);
	const pane = numberField(split.result, "pane");
	if (pane === undefined) throw new Tty7Error("tty7 split: reply carried no pane", undefined);
	const target = String(pane);

	const line = `exec ${commandLine([piBinary(), ...argv])}`;
	await callTty7(pi, ["send", target, line, "--enter"], KEYSTROKE_TIMEOUT_MS);

	const startedAt = Date.now();
	const deadline = startedAt + READY_TIMEOUT_SECONDS * 1000;
	let reEntered = false;
	for (;;) {
		const view = await paneAgent(pi, target);
		if (view?.sessionId === sessionName) return { pane: target, status: view.status };
		if (Date.now() >= deadline) {
			const read = await readPane(pi, target);
			const tail = (read?.text ?? "").split("\n").filter((part) => part.trim().length > 0).slice(-3);
			throw new Tty7Error(
				`tty7: the child did not come up in pane ${target} within ${READY_TIMEOUT_SECONDS}s${tail.length > 0 ? ` (${tail.join(" | ")})` : ""}`,
				undefined,
			);
		}
		// The swallowed-Enter check: half a second of grace, then the command still on the
		// prompt line means the carriage return was eaten and it is the one thing to resend.
		if (!reEntered && Date.now() - startedAt > 5_000) {
			const read = await readPane(pi, target);
			const lines = (read?.text ?? "").split("\n").map((part) => part.trim());
			const sitting = lines.some((part) => part.endsWith(line) || part === line);
			if (sitting && view === undefined) {
				reEntered = true;
				await callTty7(pi, ["send", target, "--enter"], KEYSTROKE_TIMEOUT_MS);
			}
		}
		await new Promise((resolve) => setTimeout(resolve, START_POLL_MS));
	}
}

// ── Talking to a running child ─────────────────────────────────────────────

export async function pressKey(pi: ExtensionAPI, pane: string, key: string): Promise<void> {
	await callTty7(pi, ["send", pane, "--key", key], KEYSTROKE_TIMEOUT_MS);
}

/**
 * Paste a file's text into the child's editor without submitting it.
 *
 * `--paste` frames the bytes in bracketed paste, so a multi-line task reaches the agent's
 * input box as text rather than as one Enter per line. The body goes through a file rather
 * than argv: a task text on the command line would be a second quoting problem on the way
 * in, and `--from-file` hands over the bytes exactly as written.
 */
export async function typeText(pi: ExtensionAPI, pane: string, file: string): Promise<void> {
	await callTty7(pi, ["send", pane, "--from-file", file, "--paste"], PROMPT_SUBMIT_TIMEOUT_MS);
}

// ── Waiting ────────────────────────────────────────────────────────────────

/** How a wait ended. `gone` is not a timeout: no state will ever arrive for that pane. */
export type SettleOutcome = "settled" | "timeout" | "gone";

/**
 * Wait for the child's next finished turn.
 *
 * `armed` is the turn counter as it stood when the child was last handed work. The wait is
 * re-armed until the counter has moved past it, because a `done` that was already true when
 * the wait began belongs to the previous turn. Measured on server 26.9.4: without this, one
 * delegation settled on a turn that had ended before its task was even submitted.
 *
 * A wait that answers at once is not believed, it is skipped — and a floor between cycles
 * stops that skip from becoming a spin.
 */
export async function waitForSettle(
	pi: ExtensionAPI,
	pane: string,
	armed?: number,
): Promise<SettleOutcome> {
	const baseline = armed ?? (await paneTurns(pi, pane)) ?? 0;
	const deadline = Date.now() + WAIT_SECONDS * 1000;
	for (;;) {
		const remaining = Math.max(1, Math.round((deadline - Date.now()) / 1000));
		const cycleStart = Date.now();
		const reply = await tryTty7(
			pi,
			["wait", pane, "--until", "done,exit", "--timeout", String(remaining), "--json"],
			(remaining + 10) * 1000,
		);
		// `1` is the pane dying under the wait; anything else that is not a clean answer (a
		// timeout, a server that refused) is decided by asking the pane below.
		if (reply.code === 1) return "gone";
		const turns = await paneTurns(pi, pane);
		if (turns !== undefined && turns > baseline) return "settled";
		if (turns === undefined) {
			if (await paneIsGone(pi, pane)) return "gone";
			// An agent that is not reporting has no turn to count; a pane that is still there
			// with no agent in it is a child that exited, which is an end, not a wait.
			if ((await paneState(pi, pane)) === undefined) return "gone";
		}
		if (Date.now() >= deadline) return "timeout";
		const spent = Date.now() - cycleStart;
		if (spent < WAIT_FLOOR_MS) await new Promise((resolve) => setTimeout(resolve, WAIT_FLOOR_MS - spent));
	}
}

export async function closePane(pi: ExtensionAPI, pane: string): Promise<void> {
	try {
		await callTty7(pi, ["pane", "close", pane], PANE_CLOSE_TIMEOUT_MS);
	} catch {
		// A pane that outlives its delegation is clutter, not a failure.
	}
}

// ── Shape helpers ──────────────────────────────────────────────────────────

/** A string field of a reply that arrived as unknown shape, or undefined. */
export function stringField(source: unknown, key: string): string | undefined {
	if (typeof source !== "object" || source === null) return undefined;
	const value = (source as Record<string, unknown>)[key];
	return typeof value === "string" ? value : undefined;
}

/** What this install's server says about itself, for the message a missing one deserves. */
export async function serverBuild(pi: ExtensionAPI): Promise<string | undefined> {
	const reply = await tryTty7(pi, ["status", "--json"], PANE_PROBE_TIMEOUT_MS).catch(() => undefined);
	if (reply === undefined || reply.code !== 0) return undefined;
	return stringField(reply.result, "build");
}
