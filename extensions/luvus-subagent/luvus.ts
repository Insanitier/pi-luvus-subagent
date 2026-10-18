/**
 * Every call this extension makes into the Luvus CLI, and what each answer means.
 *
 * The CLI is the only way this extension touches another terminal: start a child's pane,
 * hand it a task, press a key, read what the pane shows, wait for a state, close it. Two
 * things are deliberate rather than left to callers — a refusal keeps the code the host used
 * (`LuvusError.code`), so "the pane is gone" and "the pane declined it" stay different
 * answers; and a wait that timed out is an outcome rather than a throw, because a non-zero
 * exit is not the same thing as a bug.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
// ── Luvus CLI ──────────────────────────────────────────────────────────────

/** The CLI inherits `LUVUS_SOCKET_PATH`; the extension never opens the socket itself. */
export const luvusBinary = (): string => process.env.LUVUS_BIN_PATH?.trim() || "luvus";

/** How long a blocking delegation waits for the child before giving up. */
export const WAIT_SECONDS = 900;
/**
 * The shortest gap between two watcher cycles.
 *
 * A wait that returns sooner than this did not run out, it failed. Re-arming at once
 * would spin, so the watcher waits out the floor — but it does not give up, because a
 * `working` record with no watcher is one nothing will ever settle.
 */
export const WAIT_FLOOR_MS = 1_000;
/** How long a pane gets to close before it is left alone. */
export const PANE_CLOSE_TIMEOUT_MS = 15_000;

/** How long a single key press gets to reach the child. */
export const KEYSTROKE_TIMEOUT_MS = 15_000;
/** How long `agent prompt` gets to paste the task into the child's editor. */
export const PROMPT_SUBMIT_TIMEOUT_MS = 30_000;
/** How often the child's transcript is read while it decides to take the task. */
export const START_POLL_MS = 1_000;

/** How much of a task is matched against the child's transcript. */
/** How much of a CLI's stderr is quoted back when its reply is unreadable. */
export const STDERR_TAIL_CHARS = 200;

/** How long a fresh child gets to write the task into its transcript. Measured: a second. */
export const START_CONFIRM_SECONDS = 15;

/** How long a steer to a busy child waits for the host to see it picked the message up. */
export const STEER_CONFIRM_SECONDS = 15;

export const AGENT_START_TIMEOUT_MS = 120_000;

/** How long the child gets to come up before `agent start` gives up. */
export const READY_TIMEOUT_SECONDS = 90;

export type LuvusReply = {
	result: Record<string, unknown>;
	/** Non-zero means the CLI refused or timed out; callers decide whether that is fatal. */
	code: number;
};

/**
 * A refusal from the host, carrying the code it used.
 *
 * The code is the part worth keeping: `agent_not_running` means the pane is gone, while a
 * refusal with no code is a pane that is there and declined what was sent. A caller that
 * folds the two into one message sends a parent looking for a terminal that no longer
 * exists.
 */
export class LuvusError extends Error {
	readonly code: string | undefined;

	constructor(message: string, code: string | undefined) {
		super(message);
		this.name = "LuvusError";
		this.code = code;
	}
}

/**
 * One Luvus CLI call.
 *
 * Luvus answers every command with `{id, result}` or `{id, error}`. A structured
 * error is thrown here because no caller can proceed past one; a non-zero exit
 * is handed back instead, because a wait that timed out is an outcome, not a bug.
 */
export async function callLuvus(pi: ExtensionAPI, args: string[], timeoutMs: number): Promise<LuvusReply> {
	const exec = await pi.exec(luvusBinary(), args, { timeout: timeoutMs });
	const label = `luvus ${args[0]}${args[1] === undefined ? "" : ` ${args[1]}`}`;
	if (exec.killed) throw new Error(`${label}: timed out after ${Math.round(timeoutMs / 1000)}s`);

	const stdout = exec.stdout.trim();
	if (stdout.length === 0) {
		// Some commands (`wait …`) answer with the exit code alone.
		return { result: {}, code: exec.code };
	}
	let envelope: { result?: Record<string, unknown>; error?: { message?: string; code?: string } };
	try {
		envelope = JSON.parse(stdout) as typeof envelope;
	} catch {
		const tail = exec.stderr.trim().slice(-STDERR_TAIL_CHARS);
		throw new Error(`${label}: unreadable reply${tail.length > 0 ? ` (${tail})` : ""}`);
	}
	if (envelope.error !== undefined) {
		throw new LuvusError(
			`${label}: ${envelope.error.message ?? envelope.error.code ?? "failed"}`,
			typeof envelope.error.code === "string" ? envelope.error.code : undefined,
		);
	}
	return { result: envelope.result ?? {}, code: exec.code };
}

/**
 * What `agent start` says about the pane it just brought up.
 *
 * The status rides along because this reply is the only reading taken while the agent
 * is known to be ready: Luvus answers it once readiness is established, and its own
 * guidance is to accept it instead of looking the state up again (see
 * `submitAndConfirm`).
 */
export type Launch = { pane: string; status: string | undefined };

/** A child pane's id, or "" when the CLI named none. */
export async function startChild(pi: ExtensionAPI, sessionName: string, args: string[]): Promise<Launch> {
	const started = await callLuvus(
		pi,
		// `--auto` lets Luvus pick the split direction, so a fourth child can land below
		// or above instead of the panes marching sideways forever.
		["agent", "start", sessionName, "--kind", "pi", "--auto", "--timeout", String(READY_TIMEOUT_SECONDS), "--", ...args],
		AGENT_START_TIMEOUT_MS,
	);
	return {
		pane: typeof started.result.pane === "string" ? started.result.pane : "",
		status: typeof started.result.status === "string" ? started.result.status : undefined,
	};
}

export async function pressKey(pi: ExtensionAPI, sessionName: string, key: string): Promise<void> {
	await callLuvus(pi, ["agent", "keys", sessionName, key], KEYSTROKE_TIMEOUT_MS);
}

/** A pane probe is one fast read; a Luvus that hangs must not stall a delegation. */
export const PANE_PROBE_TIMEOUT_MS = 10_000;

/** How a wait ended. `gone` is not a timeout: no state will ever arrive for that pane. */
export type SettleOutcome = "settled" | "timeout" | "gone";

/**
 * Whether a delegation's pane still exists.
 *
 * Luvus answers a missing target with an error envelope and a non-zero exit, which
 * `callLuvus` turns into a throw — so the envelope is read here. Only a definite
 * `not_found` counts: a Luvus that cannot be reached has not said the pane is gone.
 */
export async function paneIsGone(pi: ExtensionAPI, pane: string): Promise<boolean> {
	const probe = await pi
		.exec(luvusBinary(), ["agent", "get", pane], { timeout: PANE_PROBE_TIMEOUT_MS })
		.catch(() => undefined);
	if (probe === undefined || probe.killed) return false;
	try {
		const envelope = JSON.parse(probe.stdout.trim()) as { error?: { code?: string } };
		return envelope.error?.code === "not_found";
	} catch {
		return false;
	}
}

/**
 * How a child ended: settled, still running, or its pane gone.
 *
 * The window is the blocking delegation's own and is not the caller's to shorten: a
 * wait that returns before the child is done is what a poll loop is made of.
 *
 * Luvus reports both endings with exit code 2: a closed pane prints `pane not found` on
 * stderr, an expired wait prints nothing at all (both measured). Reading that difference
 * would mean matching human text — which is localized, and which `--json` does not turn
 * into an error envelope here, `wait` rejecting the flag as a usage error. So a non-zero
 * result asks the pane itself: a closed pane answers at once, and reading that as "still
 * running" is what leaves a parent counting for nothing.
 *
 * A wait also has to be addressed by pane id: `wait agent-status <name>` is a usage error
 * (measured). Pane ids are small integers the host reuses after a close, which is why
 * identity is fenced where a message is actually sent — see `steerSubagent`.
 */
export async function waitForSettle(pi: ExtensionAPI, pane: string): Promise<SettleOutcome> {
	const done = await callLuvus(
		pi,
		["wait", "agent-status", pane, "--status", "done", "--timeout", String(WAIT_SECONDS)],
		(WAIT_SECONDS + 30) * 1000,
	);
	if (done.code === 0) return "settled";
	return (await paneIsGone(pi, pane)) ? "gone" : "timeout";
}

export async function closePane(pi: ExtensionAPI, pane: string): Promise<void> {
	try {
		await callLuvus(pi, ["pane", "close", pane], PANE_CLOSE_TIMEOUT_MS);
	} catch {
		// A pane that outlives its delegation is clutter, not a failure.
	}
}

/** A string field of a reply that arrived as unknown shape, or undefined. */
export function stringField(source: unknown, key: string): string | undefined {
	if (typeof source !== "object" || source === null) return undefined;
	const value = (source as Record<string, unknown>)[key];
	return typeof value === "string" ? value : undefined;
}

/** One read of a pane: what it shows, and which terminal instance is showing it. */
export type PaneRead = { text: string; terminalId: string | undefined };

/**
 * Read a pane's text, and the identity of the terminal showing it.
 *
 * The terminal id is the only handle that survives a pane id being reused: `pane` is a
 * small integer the host hands out again after a close, while `terminal_id` names the
 * instance. It is read on the paths that come later rather than at launch — a pane this
 * delegation started seconds ago cannot be somebody else's yet.
 */
export async function readPane(pi: ExtensionAPI, target: string): Promise<PaneRead | undefined> {
	const read = await callLuvus(pi, ["agent", "read", target], PANE_PROBE_TIMEOUT_MS).catch(() => undefined);
	if (read === undefined) return undefined;
	return { text: stringField(read.result, "text") ?? "", terminalId: stringField(read.result, "terminal_id") };
}

/**
 * Who is claiming the pane's state, in the host's own words.
 *
 * `agent explain` is the evidence behind a status, which is what a parent needs when the
 * status is surprising: `integration_report` is the child's own reporter speaking, while
 * `command_fallback` or `screen_text` is Luvus guessing at what the pane draws. Measured
 * live: a child still drawing its banner was reported `working` by a guess — and without
 * this the failure message passes that guess on as a fact.
 */
export async function stateAuthority(pi: ExtensionAPI, target: string): Promise<string | undefined> {
	const explained = await callLuvus(pi, ["agent", "explain", target], PANE_PROBE_TIMEOUT_MS).catch(
		() => undefined,
	);
	if (explained === undefined) return undefined;
	const evidence = explained.result.state_evidence;
	const source = stringField(evidence, "source") ?? stringField(explained.result.authority, "source");
	if (source === undefined) return undefined;
	const confidence = stringField(evidence, "confidence");
	return confidence === undefined ? source : `${source} (${confidence})`;
}

