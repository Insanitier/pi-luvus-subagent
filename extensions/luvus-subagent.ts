/**
 * luvus-subagent — Luvus-backed subagents for Pi.
 *
 * A subagent is a real `pi` process running in a Luvus pane, so it is visible,
 * interruptible, and steerable while it works. Agents are declared once in
 * `.pi/agents/*.md` and their frontmatter becomes the child's launch argv.
 *
 * Design: the child owns its pane (a PTY owned by the Luvus server), so every
 * delegation is out-of-process by construction. `wait` decides only whether the
 * parent blocks; it does not change where the child runs.
 */

import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	CONFIG_DIR_NAME,
	type AgentToolResult,
	CustomEditor,
	type ExtensionAPI,
	type ExtensionUIContext,
	getAgentDir,
	getMarkdownTheme,
	parseFrontmatter,
} from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { installStateReporter } from "./luvus-subagent/state-reporter.ts";
import {
	answerAlreadyDelivered,
	clearQueuedNotice,
	deliverWhenSettled,
	holdDeliveryFor,
	queuedNotice,
	recordDelivery,
	registerCompletionRenderer,
	releaseDeliveryHold,
	teardownDelegation,
} from "./luvus-subagent/delivery.ts";
import {
	COLLAPSED_LINES,
	COMPLETION_OUTPUT_CAP,
	capCompletion,
	endedOf,
	outcomeLine,
	settledState,
	shownResult,
	waitExpiredNote,
} from "./luvus-subagent/outcome.ts";
import {
	type Delegation,
	type DelegationEntry,
	type ReplayEntry,
	LINGER_TURNS,
	STATUS_KEY,
	attachEntryApi,
	beginSession,
	countTurn,
	delegations,
	endSession,
	entryApi,
	formatElapsed,
	progressLine,
	rememberTerminal,
	renderStatus,
	replayDelegations,
	restartTurnCount,
	settleDelegation,
	settleWaiters,
	sinceLastRead,
	stopStatusTicker,
	trackDelegation,
	waitForDelegation,
} from "./luvus-subagent/registry.ts";
import {
	type AgentConfig,
	type LaunchPlan,
	discoverAgents,
	formatArgv,
	prepareLaunch,
	promptFileFor,
	writePromptFile,
} from "./luvus-subagent/agents.ts";
import {
	type ChildOutcome,
	type ChildProgress,
	type ChildResult,
	readChildProgress,
	readChildResult,
	sessionFileFor,
	taskInTranscript,
	TASK_MARK_IN_PANE_CHARS,
} from "./luvus-subagent/child-session.ts";
import {
	type Launch,
	type SettleOutcome,
	PROMPT_SUBMIT_TIMEOUT_MS,
	START_CONFIRM_SECONDS,
	START_POLL_MS,
	STEER_CONFIRM_SECONDS,
	WAIT_FLOOR_MS,
	WAIT_SECONDS,
	callLuvus,
	closePane,
	LuvusError,
	luvusBinary,
	paneIsGone,
	pressKey,
	readPane,
	startChild,
	stateAuthority,
	waitForSettle,
} from "./luvus-subagent/luvus.ts";
import { installRawPaste } from "./luvus-subagent/editor.ts";
import { DELEGATION_ENTRY, SETTLED_ENTRY, SUBAGENT_CHILD_FLAG } from "./luvus-subagent/env.ts";
import { sweepExpiredPrompts, sweepOrphanSessions } from "./luvus-subagent/sweeps.ts";
// The pieces the checks drive by name. They live in modules now; the entry keeps the
// names stable, because a check that reaches into a moved file is a check that has to
// change whenever the file moves.
export { discoverAgents, prepareLaunch, writePromptFile } from "./luvus-subagent/agents.ts";





/**
 * Watch a background child to completion and hand its result to the parent.
 *
 * Detached on purpose: the delegation has already returned, so nothing awaits
 * this promise. Messaging the session is what tells the parent the child is
 * done, so this is the only delivery path a background delegation has.
 */
// ── Delegation flow ────────────────────────────────────────────────────────

/** The dry-run answer: the resolved plan, with nothing started. */
function dryRunReport(
	agent: AgentConfig,
	args: string[],
	task: string,
	wait: boolean,
	sessionName: string,
	unresolvedSkills: string[],
): string {
	return [
		`agent:   ${agent.name} [${agent.source}]`,
		`file:    ${agent.filePath}`,
		`argv:    pi ${formatArgv(args)}`,
		`task:    ${task}`,
		`wait:    ${wait}`,
		`session: ${sessionName}`,
		unresolvedSkills.length > 0 ? `unresolved: ${unresolvedSkills.join(", ")}` : "",
	]
		.filter(Boolean)
		.join("\n");
}

/** Open the child's pane, then register it so its duration covers the whole delegation. */
async function launchChild(
	pi: ExtensionAPI,
	sessionName: string,
	plan: LaunchPlan,
	ui: ExtensionUIContext | undefined,
): Promise<Launch> {
	const launch = await startChild(pi, sessionName, plan.args);
	// Tracked from the launch, so the duration covers the whole delegation.
	// No UI in print or JSON mode; the widget is simply not drawn there.
	trackDelegation(sessionName, launch.pane, ui);
	return launch;
}


/** How a handover ended: the child wrote the task down, or it did not, or nothing was sent. */
type Handover =
	| { state: "taken" }
	| { state: "unsent"; code: string | undefined }
	| { state: "queued"; presses: number; unsentInComposer: boolean };

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
async function submitAndConfirm(
	pi: ExtensionAPI,
	sessionName: string,
	task: string,
	seconds: number,
	fence?: string,
): Promise<Handover> {
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
		if (taskInTranscript(sessionName, task)) return { state: "taken" };
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
async function taskSitsUnsent(pi: ExtensionAPI, sessionName: string, task: string): Promise<boolean> {
	const read = await readPane(pi, sessionName);
	// A read taken here is also where a delegation first learns which terminal it is running
	// in, so a steer much later can refuse a pane id that has changed hands since.
	rememberTerminal(sessionName, read?.terminalId);
	if (read === undefined) return false;
	// Enough of the task to be unmistakable; the pane wraps and indents long lines.
	return read.text.includes(task.slice(0, TASK_MARK_IN_PANE_CHARS));
}

/** The blocking path's tool result: the child's answer, capped, plus any notes. */
function blockingResult(
	agentName: string,
	outcome: SettleOutcome | undefined,
	result: ChildResult | undefined,
	notes: string[],
): AgentToolResult<unknown> {
	// One dimension, like the reference: how the delegation ended. The wait decides when
	// the child produced no result at all, the child's own last turn decides otherwise,
	// and a turn that landed no answer is its own state rather than `done`.
	const ended = endedOf(outcome, result);
	const line = outcomeLine(ended);
	const shown = shownResult(result, ended);
	const body = [...notes];
	if (line.note.length > 0) body.push(line.note);
	return {
		content: [
			{
				type: "text",
				text: [
					`${agentName} (${line.word}):`,
					...(shown.length > 0 ? ["", shown] : []),
					...(body.length > 0 ? ["", ...body] : []),
				].join("\n"),
			},
		],
		// The same single rule the widget and the notice read, not a second reading of it.
		isError: settledState(outcome, result) === "failed",
		details: {},
	};
}


// ── Extension entry ────────────────────────────────────────────────────────

export default function luvusSubagent(pi: ExtensionAPI) {
	// Loaded in the child too: this is what makes its pane report a real state.
	installStateReporter(pi, luvusBinary);

	// Registering keeps `--subagent-child` a legal option; the value is read from
	// argv below, because pi only exposes flags from session_start onwards —
	// too late to decide whether a tool gets registered at all.
	pi.registerFlag(SUBAGENT_CHILD_FLAG, {
		type: "boolean",
		description: "Run as a subagent child: report state, but offer no delegation tools.",
	});

	// A child loads this extension for the reporter above, and for the editor that keeps
	// a pasted task from reaching its model as a marker. Handing it the tools too would
	// let subagents spawn subagents without bound.
	if (process.argv.includes(`--${SUBAGENT_CHILD_FLAG}`)) {
		installRawPaste(pi);
		return;
	}

	/** Set while this session is being torn down, so a watcher never messages a dead one. */
	let sessionStale = false;
	// Completion notices are pushed into the transcript; this draws them as cards.
	registerCompletionRenderer(pi);
	// A queued notice is cleared by identity when Pi starts delivering it, and by this
	// net when it never does: a delivery discarded with Escape never starts.
	pi.on("message_start", ({ message }) => {
		if (message.role === "custom" && message.customType === "luvus-subagent-completion" && message.content === queuedNotice()) {
			clearQueuedNotice();
		}
	});
	pi.on("agent_settled", (_event, ctx) => {
		if (ctx.isIdle()) clearQueuedNotice();
	});
	attachEntryApi(pi);

	// The session is replaced for real here: `session_shutdown` fires for a reload, a new
	// session, a resume and a fork, and it cannot be cancelled. `session_before_switch` can
	// be — a handler that cancels leaves no `session_start` behind — so it must not be the
	// boundary that ends a session's watchers or clears its registry: a stale flag set there
	// would never be cleared, and every later completion notice would be dropped.
	pi.on("session_shutdown", () => {
		sessionStale = true;
		clearQueuedNotice();
		endSession();
	});

	// A switch keeps the process alive, so the previous session's records would answer
	// the status tool and hand `resume` a child this session never started. The
	// reference clears at the same boundary, for the same reason.
	// A reload or a restart must not lose the delegations: the records come back from
	// this session's own entries rather than from the process that wrote them.
	pi.on("session_start", async (_event, ctx) => {
		// A reload or a switch keeps the process, so this session's watchers start clean.
		sessionStale = false;
		// The widget is published through a UI this instance has not seen yet: without this,
		// a replayed row for a child that is still running would never be drawn at all.
		beginSession(ctx.hasUI ? ctx.ui : undefined);
		// A delegation that outlived the instance that started it has no watcher left, so
		// nothing would settle it, close its pane, or push its answer. Arm one here — not in
		// `session_tree`, which shares the replay but must not re-arm.
		for (const entry of await replayDelegations(pi, ctx.sessionManager.getBranch())) {
			void deliverWhenSettled({
				pi,
				pane: entry.pane,
				sessionId: entry.sessionName,
				agentName: entry.agent,
				promptFile: promptFileFor(entry.sessionName),
				isStale: () => sessionStale,
			});
		}
	});

	// A tree navigation keeps both the session and the process, and it changes which branch
	// is active: the registry has to follow the branch the user is on now.
	pi.on("session_tree", async (_event, ctx) => {
		restartTurnCount();
		await replayDelegations(pi, ctx.sessionManager.getBranch());
	});

	/**
	 * The parent can only delegate to an agent it knows about, so the catalogue is
	 * rebuilt every turn and dropped into its own system-prompt section. Same
	 * content the reference extensions inline into a tool definition, minus the
	 * stale list that would bake in at load time.
	 */
	pi.on("before_agent_start", (event) => {
		// The parent turn the widget's linger is counted in.
		countTurn();
		const agents = discoverAgents(event.systemPromptOptions.cwd);
		if (agents.length === 0) {
			delete event.systemPromptOptions.sections.subagent_agents;
			return;
		}
		event.systemPromptOptions.sections.subagent_agents = [
			"delegate can launch these subagents, declared in .pi/agents/*.md:",
			...agents.map((agent) =>
				agent.description.length > 0 ? `- ${agent.name}: ${agent.description}` : `- ${agent.name}`,
			),
		].join("\n");
	});
	/** Dev aid: show what each agent resolves to before any pane is opened. */
	pi.registerCommand("subagent-agents", {
		description: "List subagent definitions and the Pi argv each one launches with",
		handler: async (_args, ctx) => {
			const agents = discoverAgents(ctx.cwd);
			if (agents.length === 0) {
				ctx.ui.notify(`No agents found (looked in ${join(getAgentDir(), "agents")})`, "info");
				return;
			}
			const lines = agents.map((agent) => {
				const { args, unresolvedSkills } = prepareLaunch(agent, ctx.cwd, agent.name);
				const head = `${agent.name} [${agent.source}]`;
				const detail = args.length > 0 ? formatArgv(args) : "(inherits parent settings)";
				const warn =
					unresolvedSkills.length > 0 ? `\n    unresolved skills: ${unresolvedSkills.join(", ")}` : "";
				return `${head}\n    ${detail}${warn}`;
			});
			ctx.ui.notify(lines.join("\n\n"), "info");
		},
	});

	pi.registerTool({
		name: "delegate",
		label: "Subagent",
		description:
			"Delegate a task to a subagent running in a visible Luvus pane. wait: true (the default) blocks until it settles and returns its answer; wait: false returns as soon as the pane is up, and the answer arrives later as a completion message that wakes you — or, when you need it before your turn can end, wait for it with subagent_status wait: true. Use dry_run to inspect the resolved launch plan without starting anything.",
		promptSnippet: "Delegate a task to a subagent running in a visible Luvus pane",
		// The delegation policy, tuned from the subagents fork: when to reach for an
		// agent, when to search directly instead, and what the answer means. Three rules,
		// not five: the catalogue already says which agent fits, the mechanism is in the
		// description, and a rule that only restates either one is not worth its tokens.
		promptGuidelines: [
			"Reach for a subagent when answering would mean reading across several files, or when you have independent work to run in parallel — you keep the conclusion, not the file dumps.",
			"For a single fact you can already locate, search directly; once a delegation is running, do not investigate the same thing yourself — wait for it (subagent_status with wait: true) rather than reading the same files again.",
			"Give the subagent a self-contained task, and relay what matters from its answer instead of repeating it; never predict a pending result — if the user asks first, say it is still running.",
		],
		parameters: Type.Object({
			agent: Type.String({ description: "Agent name, from the subagents listed in your context" }),
			task: Type.String({ description: "Task to delegate" }),
			resume: Type.Optional(
				// A boolean as well as a string: a caller that does not want to resume has
				// to be able to say so. Some models fill every optional parameter and have
				// no way to leave a string empty, so they invent a placeholder and the
				// call fails; false is a value they can actually produce.
				Type.Union([Type.Boolean(), Type.String()], {
					description:
						"Pass false (or omit it) to start a fresh delegation. Pass the session name of a delegation this session already ran, or a child session id, to continue that conversation. A transcript is kept while a session file still names it, so it outlives its conversation only as long as another one names it; once it is gone, resume is unavailable and the earlier result is only in the transcript.",
				}),
			),
			wait: Type.Optional(
				Type.Boolean({
					description: "Block until the subagent settles and return its result (default true)",
				}),
			),
			dry_run: Type.Optional(
				Type.Boolean({ description: "Return the resolved launch plan without starting a pane" }),
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const agent = discoverAgents(ctx.cwd).find((candidate) => candidate.name === params.agent);
			if (agent === undefined) {
				const known = discoverAgents(ctx.cwd)
					.map((candidate) => candidate.name)
					.join(", ");
				return {
					content: [{ type: "text", text: `Unknown agent "${params.agent}". Known: ${known || "(none)"}` }],
					isError: true,
					details: {},
				};
			}

			// Resume names a delegation this session ran, or a child session id. Both are
			// the id its transcript is filed under, so one lookup serves both. Anything
			// that is not a non-empty string means "start a fresh delegation".
			const wantedResume =
				typeof params.resume === "string" && params.resume.trim().length > 0 ? params.resume.trim() : undefined;
			let resumeFile: string | undefined;
			if (wantedResume !== undefined) {
				const known = delegations.get(wantedResume);
				if (known !== undefined && known.state === "working") {
					return {
						content: [
							{ type: "text", text: `${wantedResume} is still running; steer it instead of resuming it.` },
						],
						isError: true,
						details: {},
					};
				}
				resumeFile = sessionFileFor(wantedResume);
				if (resumeFile === undefined) {
					return {
						content: [
							{
								type: "text",
								text: `No session to resume for "${wantedResume}": its transcript is gone. Its earlier result is still in the transcript.`,
							},
						],
						isError: true,
						details: {},
					};
				}
			}
			const sessionName = wantedResume ?? `${agent.name}-${randomBytes(3).toString("hex")}`;
			const plan = prepareLaunch(agent, ctx.cwd, sessionName, resumeFile);
			const { args, unresolvedSkills, promptFile } = plan;
			const wait = params.wait ?? true;

			if (params.dry_run === true) {
				// A dry run only inspects the plan, and naming the prompt file created nothing —
				// so there is nothing to clean up here.
				const planText = dryRunReport(agent, args, params.task, wait, sessionName, unresolvedSkills);
				return { content: [{ type: "text", text: planText }], details: {} };
			}

			// Launching is what grows the prompt directory and what decides whether a
			// child session is still named by anything, so both get trimmed here.
			sweepOrphanSessions((name) => delegations.has(name));
			sweepExpiredPrompts();
			// The child reads its body during startup, so it must exist before the pane opens.
			if (promptFile !== undefined) writePromptFile(promptFile, agent.systemPrompt);

			// 1. Launch the child in its own pane; the task follows as a message.
			const launch = await launchChild(pi, sessionName, plan, ctx.hasUI ? ctx.ui : undefined);
			const pane = launch.pane;
			pi.appendEntry(DELEGATION_ENTRY, {
				sessionName,
				agent: agent.name,
				task: params.task,
				pane,
				startedAt: delegations.get(sessionName)?.startedAt ?? Date.now(),
			} satisfies DelegationEntry);

			// Blocking is the only difference between the two modes: the child owns a
			// pane either way, so it stays visible and steerable throughout. `settled`
			// also means the pane is finished, which is what the teardown looks at.
			let settled = false;
			let outcome: SettleOutcome | undefined;
			try {
				// 2. Hand the task over, and let the child's own transcript say whether it took it.
				const started = await submitAndConfirm(pi, sessionName, params.task, START_CONFIRM_SECONDS);
				if (started.state === "unsent") {
					// Nothing reached the child, so this is a failure however the pane looks.
					settleDelegation(sessionName, "failed");
					settled = true;
					if (await paneIsGone(pi, pane)) {
						recordDelivery(sessionName);
						return blockingResult(agent.name, "gone", undefined, []);
					}
					return {
						content: [
							{
								type: "text",
								text: `${sessionName} could not be handed the task: the host refused the paste${
									started.code === undefined ? "" : ` (${started.code})`
								} (its pane is still there), so nothing was sent and nothing is running.`,
							},
						],
						isError: true,
						details: {},
					};
				}
				if (started.state === "queued") {
					// A pane that is already gone is not an unstarted task: report it the way every
					// other closed pane is, not as a countdown that never ran.
					if (await paneIsGone(pi, pane)) {
						settleDelegation(sessionName, "failed");
						settled = true;
						recordDelivery(sessionName);
						return blockingResult(agent.name, "gone", undefined, []);
					}
					// Nothing proved the child took the task, but the prompt was pasted and
					// submitted, so it can still be picked up — and a second paste into the same
					// pane would send it twice. So this is unconfirmed, not failed: the record
					// stays `working` (steer and status still apply), the pane is left open, and
					// the watcher still delivers whatever the child eventually says.
					void deliverWhenSettled({
						pi,
						pane,
						sessionId: sessionName,
						agentName: agent.name,
						promptFile,
						isStale: () => sessionStale,
					});
					const reported = launch.status === undefined ? "no status" : `"${launch.status}"`;
					const presses = `${started.presses} Enter${started.presses === 1 ? "" : "s"}`;
					// The state that came back with the launch is reported *with the authority behind it*:
					// a guess read off a booting screen is not the child saying anything, and a parent that
					// cannot tell the two apart reads the guess as work in progress.
					const source = await stateAuthority(pi, sessionName);
					const whence =
						source === undefined
							? `the host reported ${reported} when the pane came up`
							: `the host reported ${reported} when the pane came up, and its state now comes from ${source}`;
					// Two failures wear the same face and call for opposite moves, so they are named
					// apart: a task sitting in the input box is not lost and not running — it is waiting
					// for the key that submits it, and pressing it again is the whole fix.
					const unpicked = started.unsentInComposer
						? `${sessionName} still has the task sitting in its input box: the paste landed, and ${presses} over ${START_CONFIRM_SECONDS}s did not submit it (${whence}). Nothing is running — steer it to press that key again, rather than sending the task a second time.`
						: `${sessionName} did not confirm the task: it was pasted and submitted ${presses} over ${START_CONFIRM_SECONDS}s, its transcript still held no such message, and its input box is empty (${whence}). It may still be picked up, so check it or steer it instead of sending the task again; its pane is left open.`;
					return { content: [{ type: "text", text: unpicked }], details: {}, isError: true };
				}
				if (wait) {
					outcome = await waitForSettle(pi, pane);
					settled = outcome === "settled";
				}
				const notes: string[] = [];
				if (unresolvedSkills.length > 0) notes.push(`unresolved skills: ${unresolvedSkills.join(", ")}`);
				if (!wait) {
					// Nothing awaits this: the delegation returns now, and the watcher
					// reports the result once the child settles.
					void deliverWhenSettled({ pi, pane, sessionId: sessionName, agentName: agent.name, promptFile, isStale: () => sessionStale });
					const notice = [
						`${resumeFile === undefined ? "Delegated to" : "Resumed"} ${sessionName} in pane ${pane} (running).`,
						"It keeps running there; the pane is visible and steerable.",
						...notes,
					].join("\n");
					return { content: [{ type: "text", text: notice }], details: {} };
				}
				if (outcome === "gone") notes.push(`its pane was closed before it finished; nothing is running in pane ${pane} any more`);
				else if (!settled) {
					// Not WAIT_SECONDS: a wait that failed at once also lands here, and the
					// elapsed time is true either way. The wait that can outlast it is named,
					// so the parent does not have to improvise one out of repeated reads.
					const watched = formatElapsed(delegations.get(sessionName)?.startedAt ?? Date.now());
					notes.push(
						`still running after ${watched} in pane ${pane}, which the watcher now owns; wait for it with subagent_status ${sessionName} wait:true, or steer it`,
					);
				}
				const result = readChildResult(sessionName);
				// A child that outlived the wait is still working: hand it to the watcher, so
				// its answer still arrives and its pane still gets closed once it settles.
				// Without this the delegation falls between the two modes and is abandoned.
				if (settled || outcome === "gone") {
					settleDelegation(sessionName, settledState(outcome, result));
					// The answer is in this tool result, so the watcher must not push it too.
					recordDelivery(sessionName);
				} else {
					void deliverWhenSettled({
						pi,
						pane,
						sessionId: sessionName,
						agentName: agent.name,
						promptFile,
						isStale: () => sessionStale,
					});
				}
				return blockingResult(agent.name, outcome, result, notes);
			} finally {
				// 3. The blocking delegation is over; do not leave its pane — or the
				//    prompt file, which the child read during startup — behind.
				await teardownDelegation({ pi, pane, promptFile, settled: settled && pane !== "" });
			}
		},

		renderCall(args, theme) {
			const suffix = args.dry_run === true ? " (dry run)" : "";
			return new Text(
				theme.fg("toolTitle", theme.bold("delegate ")) +
					theme.fg("accent", args.agent) +
					theme.fg("dim", suffix),
				0,
				0,
			);
		},
	});

	/**
	 * Nudge a child that is already running. A background delegation leaves its
	 * pane open precisely so this stays possible.
	 */
	pi.registerTool({
		name: "steer",
		label: "Steer subagent",
		description:
			"Send an additional instruction to a subagent that is already running in its Luvus pane. Set interrupt to stop its current work first; a background delegation keeps its pane open for this.",
		promptSnippet: "Send an additional instruction to a running subagent",
		parameters: Type.Object({
			sessionName: Type.String({ description: "Subagent session name, as returned by delegate" }),
			message: Type.String({ description: "Instruction to send" }),
			interrupt: Type.Optional(
				Type.Boolean({ description: "Press Esc first to stop the subagent's current work (default false)" }),
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			try {
				// Identity before delivery: the pane id is an integer the host hands out again after a
				// close, so the terminal behind this name has to be the one this delegation was last
				// seen in, or the message lands in a stranger's pane. A read that fails is not a
				// verdict — a Luvus that cannot be reached has said nothing — so only a definite
				// mismatch refuses here, and the same id rides along as the host's own fence.
				const seen = await readPane(pi, params.sessionName);
				const known = delegations.get(params.sessionName)?.terminalId;
				if (seen?.terminalId !== undefined && known !== undefined && known !== seen.terminalId) {
					return {
						content: [
							{
								type: "text",
								text: `Not sent: the pane behind ${params.sessionName} is a different terminal now (it was ${known}, it is ${seen.terminalId}), so the message would have gone somewhere else. Its delegation is still in subagent_status.`,
							},
						],
						isError: true,
						details: {},
					};
				}
				rememberTerminal(params.sessionName, seen?.terminalId);
				if (params.interrupt === true) {
					await pressKey(pi, params.sessionName, "esc");
				}
				const how = params.interrupt === true ? "Interrupted, then" : "Sent to";
				// A steer has no launch reply to read: the child is normally already working, which
				// is exactly when a status proves nothing. Its transcript is the evidence instead.
				const verdict = await submitAndConfirm(
					pi,
					params.sessionName,
					params.message,
					STEER_CONFIRM_SECONDS,
					seen?.terminalId,
				);
				// Four facts, and only four: the child wrote the message down, the host refused it and
				// said why, it is sitting in the input box unsent, or it was accepted and not written
				// down yet.
				const text =
					verdict.state === "taken"
						? `${how} ${params.sessionName}, and it is working.`
						: verdict.state === "unsent"
							? `${how} ${params.sessionName} — nothing was sent: the host refused the message${
									verdict.code === undefined ? "" : ` (${verdict.code})`
								}.`
							: verdict.unsentInComposer
								? `${how} ${params.sessionName} — the message is sitting in its input box unsent, so steer it again to press Enter.`
								: `${how} ${params.sessionName} — queued; the host took the message, but pickup is not confirmed.`;
				return { content: [{ type: "text", text }], details: {} };
			} catch (error) {
				return {
					content: [{ type: "text", text: `Could not reach ${params.sessionName}: ${String(error)}` }],
					isError: true,
					details: {},
				};
			}
		},
	});

	/**
	 * Let the parent read its own delegations instead of scraping Luvus through bash:
	 * the widget is for the human, and a bash `luvus wait` is auto-backgrounded by
	 * whatever background-task extension happens to be installed.
	 *
	 * This is a read, and `wait` belongs here, where the reference puts it: a model-set
	 * window on a read is a poll loop, but a parent that needs the result before its own
	 * turn can end has nowhere else to stand. What keeps it honest is that the wait ends
	 * when the *delegation* is over rather than at a number the model guessed, and that the
	 * answer it hands over is the one the notice would have pushed — so the two cannot both
	 * arrive.
	 */
	pi.registerTool({
		name: "subagent_status",
		label: "Subagent status",
		description:
			"List this session's subagent delegations and their state. Naming one also returns its answer, once that delegation is over. Set wait to be told when it is over instead of asking again: the answer then reaches you here or on the completion notice, never both.",
		promptSnippet: "Check on subagents this session delegated, and wait for one to finish",
		parameters: Type.Object({
			sessionName: Type.Optional(
				Type.String({
					description: "Subagent session name, as returned by delegate. Omit for every delegation in this session.",
				}),
			),
			wait: Type.Optional(
				Type.Boolean({
					description:
						"Block until that delegation is over before answering, instead of coming back to ask again. Needs sessionName. Default: false.",
				}),
			),
			timeout_ms: Type.Optional(
				Type.Number({
					description:
						"Milliseconds to bound a wait; omit to wait until the delegation is over. An expired wait does not stop the child: read the progress line it returns, and if nothing has changed since your last read, waiting again will not unstick it.",
				}),
			),
		}),

		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			const asked = params.sessionName;
			if (params.wait === true && asked === undefined) {
				return {
					content: [
						{ type: "text", text: "wait needs a sessionName: waiting for every delegation has no single answer." },
					],
					isError: true,
					details: {},
				};
			}
			const all = [...delegations.entries()];
			const rows = params.sessionName === undefined ? all : all.filter(([name]) => name === params.sessionName);
			if (params.sessionName !== undefined && rows.length === 0) {
				const known = all.map(([name]) => name).join(", ");
				return {
					content: [
						{ type: "text", text: `No delegation named ${params.sessionName}. Known: ${known || "(none)"}` },
					],
					isError: true,
					details: {},
				};
			}
			if (rows.length === 0) return { content: [{ type: "text", text: "No delegations in this session." }], details: {} };
			const before = asked === undefined ? undefined : delegations.get(asked);
			// The claim goes on before the wait: the watcher settles this delegation, and while
			// this call is going to hand the answer over the notice must not push it too. A call
			// that gives up takes the claim back, so the notice is the path that still delivers.
			let expired = false;
			if (params.wait === true && asked !== undefined && before?.endedAt === undefined) {
				holdDeliveryFor(asked);
				const over = await waitForDelegation(asked, params.timeout_ms, signal);
				releaseDeliveryHold(asked);
				expired = !over;
			}
			// Everything below reads the registry again, because a wait just moved it: a row or a
			// state taken before the wait would report the child as still working in the same
			// result that hands over its answer.
			const shown = [...delegations.entries()].filter(([name]) => asked === undefined || name === asked);
			const current = asked === undefined ? undefined : delegations.get(asked);
			// The registry is the authority on state: it is written by the settle watcher,
			// which knows a delegation is over. The child's session file only supplies the
			// text — its last terminal turn can predate a steer, so it must not decide state,
			// and while the delegation is running that turn is provisional. Handing it over
			// here is what made one answer arrive twice: this read, then the notice pushed
			// when the child really settled. Reading it is also what tells that notice it has
			// nothing left to add, so the two paths cannot both deliver the same answer.
			let answer: ChildResult | undefined;
			// Whether the parent already holds this answer: the notice records its own delivery now,
			// so a read can tell an answer it is handing over for the first time from one that is
			// already in the conversation. Repeating it would be the same words twice, and a parent
			// that reads a notice as "the rest of the story" is what that costs.
			let delivered = false;
			if (asked !== undefined && current?.state !== "working") {
				delivered = answerAlreadyDelivered(asked);
				answer = readChildResult(asked);
				if (answer !== undefined) recordDelivery(asked);
			}
			// Read once: the row says what the child is doing, and remembering it is what lets
			// the next read say whether anything moved in between.
			const progress = asked === undefined || current?.state !== "working" ? undefined : readChildProgress(asked);
			const since = progress === undefined || current === undefined ? undefined : sinceLastRead(progress, current);
			const lines = shown.map(([name, entry]) => {
				const head = `${name}  ${entry.state}  ${formatElapsed(entry.startedAt, entry.endedAt)}  pane ${entry.pane}`;
				return entry.state === "working" ? `${head}\n${progressLine(progress, since)}` : head;
			});
			if (asked !== undefined && progress !== undefined && current !== undefined) {
				delegations.set(asked, { ...current, lastRead: { at: Date.now(), toolUses: progress.toolUses } });
			}
			// A parent that asks again for an answer it already has is pointed at it rather than
			// handed the same words twice: the notice carries them above, and the child's session
			// file still holds them for anyone who needs the text back later.
			const deliveredNote =
				delivered && asked !== undefined
					? `${asked} handed this answer over already: it is in the completion notice above${
							sessionFileFor(asked) === undefined
								? ""
								: `, and the child's own session file has it at ${sessionFileFor(asked)}`
						}.`
					: undefined;
			return {
				content: [
					{
						type: "text",
						text: [
							lines.join("\n"),
							...(answer === undefined || delivered
								? []
								: ["", `answer from ${asked}:`, "", capCompletion(answer.text)]),
							...(deliveredNote === undefined ? [] : ["", deliveredNote]),
							...(expired ? ["", waitExpiredNote(params.timeout_ms, since)] : []),
						].join("\n"),
					},
				],
				details: {},
			};
		},
	});
}
