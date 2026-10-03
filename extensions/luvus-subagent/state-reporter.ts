import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** How the luvus CLI is found. The caller owns that decision, not this module. */
export type LuvusBinary = () => string;

/** The state a Pi session reports, derived only from what it has done so far. */
function reporterState({ prompts, running, hasRun }: { prompts: number; running: boolean; hasRun: boolean }): string {
	return prompts > 0 ? "blocked" : running ? "working" : hasRun ? "done" : "idle";
}

/** Reported session ids longer than this are dropped rather than published. */
const MAX_SESSION_ID_CHARS = 512;

/**
 * Report this Pi session's state to Luvus so its pane reads `idle`/`working`/
 * `blocked`/`done` from evidence instead of process-tree guesswork.
 *
 * Without this the parent cannot tell when a child has finished: `agent prompt
 * --wait --until done` runs to its full timeout with `observed_state: null`.
 * Only the state is sent — never a prompt, a path, or any transcript content.
 */
export function installStateReporter(pi: ExtensionAPI, luvusBinary: LuvusBinary): void {
	const pane = process.env.LUVUS_PANE_ID?.trim();
	if (process.env.LUVUS_ENV !== "1" || pane === undefined || pane === "") return;
	if (process.env.LUVUS_SOCKET_PATH?.trim() === undefined) return;

	const SOURCE = "pi/extension";
	const TTL_SECONDS = 300;
	const HEARTBEAT_MS = 60_000;
	const COMMAND_TIMEOUT_MS = 5_000;

	let active = false;
	let running = false;
	let hasRun = false;
	let prompts = 0;
	let session: string | undefined;
	let sequence = Date.now() * 1000;
	let timer: ReturnType<typeof setInterval> | undefined;
	let queue: Promise<void> = Promise.resolve();
	let lastSuccessful: string | undefined;

	const skip = (ctx: { mode?: string }): boolean => !active || ctx.mode !== "tui";

	const status = (): string => reporterState({ prompts, running, hasRun });

	const report = (force = false): void => {
		if (!active) return;
		const current = status();
		const id = session;
		const key = `${current}\u0000${id ?? ""}`;
		// Serialize both the state decision and the CLI call; a failed send is retryable.
		queue = queue.then(async () => {
			if (!active || (!force && lastSuccessful === key)) return;
			const args = [
				"agent",
				"report",
				pane,
				"--source",
				SOURCE,
				"--kind",
				"pi",
				"--status",
				current,
				"--sequence",
				String(++sequence),
				"--ttl",
				String(TTL_SECONDS),
			];
			if (id !== undefined) args.push("--session", id);
			try {
				const exec = await pi.exec(luvusBinary(), args, { timeout: COMMAND_TIMEOUT_MS });
				if (exec.code === 0 && !exec.killed) lastSuccessful = key;
			} catch {
				// Retried on the next event or heartbeat.
			}
		});
	};

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		active = true;
		running = !ctx.isIdle();
		hasRun = running;
		prompts = 0;
		const id = ctx.sessionManager.getSessionId();
		session = id.length > 0 && id.length <= MAX_SESSION_ID_CHARS ? id : undefined;
		lastSuccessful = undefined;
		report();
		timer ??= setInterval(() => report(true), HEARTBEAT_MS);
	});

	pi.on("agent_start", (_event, ctx) => {
		if (skip(ctx)) return;
		running = true;
		hasRun = true;
		report();
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (skip(ctx)) return;
		running = false;
		report();
	});

	pi.on("ui_prompt_start", (_event, ctx) => {
		if (skip(ctx)) return;
		prompts++;
		report();
	});

	pi.on("ui_prompt_end", (_event, ctx) => {
		if (skip(ctx)) return;
		prompts = Math.max(0, prompts - 1);
		report();
	});

	pi.on("session_shutdown", async () => {
		if (!active) return;
		active = false;
		if (timer !== undefined) clearInterval(timer);
		timer = undefined;
		// Queued reports must finish before release; never enqueue one after this point.
		queue = queue.then(async () => {
			for (let attempt = 0; attempt < 2; attempt++) {
				try {
					const exec = await pi.exec(
						luvusBinary(),
						["agent", "release", pane, "--source", SOURCE],
						{ timeout: COMMAND_TIMEOUT_MS },
					);
					if (exec.code === 0 && !exec.killed) return;
				} catch {
					// Bounded retry only; the lease expires on its own TTL regardless.
				}
			}
		});
		await queue;
	});
}
