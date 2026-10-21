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

import { join } from "node:path";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { answerAlreadyDelivered, awaitQuiescence, clearQueuedNotice, deliverWhenSettled, holdDeliveryFor, queuedNotice, recordDelivery, registerCompletionRenderer, releaseDeliveryHold, teardownDelegation, wentBackToWorkNote } from "./luvus-subagent/delivery.ts";
import { capCompletion, settledState, waitExpiredNote } from "./luvus-subagent/outcome.ts";
import { type DelegationEntry, attachEntryApi, beginSession, countTurn, delegations, endSession, formatElapsed, progressLine, rememberRead, replayDelegations, restartTurnCount, settleDelegation, sinceLastRead, waitForDelegation } from "./luvus-subagent/registry.ts";
import { discoverAgents, formatArgv, prepareLaunch, promptFileFor, writePromptFile } from "./luvus-subagent/agents.ts";
import { type ChildResult, readChildProgress, readChildResult, sessionFileFor } from "./luvus-subagent/child-session.ts";
import { type SettleOutcome, START_CONFIRM_SECONDS, STEER_CONFIRM_SECONDS, paneAgent, paneIsGone, pressKey, waitForSettle } from "./luvus-subagent/tty7.ts";
import { blockingResult, dryRunReport, launchChild } from "./luvus-subagent/flow.ts";
import { handoverText, submitAndConfirm } from "./luvus-subagent/handover.ts";
import { DELEGATION_ENTRY } from "./luvus-subagent/env.ts";
import { sweepExpiredPrompts, sweepOrphanSessions } from "./luvus-subagent/sweeps.ts";
// The pieces the checks drive by name. They live in modules now; the entry keeps the
// names stable, because a check that reaches into a moved file is a check that has to
// change whenever the file moves.
export { discoverAgents, prepareLaunch, writePromptFile } from "./luvus-subagent/agents.ts";

// ── Extension entry ────────────────────────────────────────────────────────

export default function luvusSubagent(pi: ExtensionAPI) {
	// Nothing of ours runs in the child: a subagent is a plain `pi` in a tty7 pane, and
	// tty7's own agent hook reports its status from the child's events. That is also why a
	// subagent cannot spawn subagents — it never loads this extension, so it has no tool to
	// delegate with.

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
					// The state that came back with the launch is reported *with where it came from*: tty7
					// says whether an agent's status is the child reporting itself (`inferred: false`) or
					// a guess read off a booting screen, and a parent that cannot tell the two apart
					// reads the guess as work in progress.
					const now = await paneAgent(pi, sessionName);
					const whence =
						now === undefined
							? `tty7 reported ${reported} when the pane came up and has nothing to say about it now`
							: now.reported
								? `tty7 reported ${reported} when the pane came up, and its state now comes from the child's own hooks`
								: `tty7 reported ${reported} when the pane came up, and its state now is inferred from the screen`;
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
				// A finished state is watched, not believed — the child may be about to retry an
				// errored turn or to continue one it reported as done, and both happen in this pane.
				// The wait stops blocking either way; what changes is that nothing is settled, and
				// nothing is delivered, until the state has held.
				if (outcome === "settled") {
					const verdict = await awaitQuiescence(pi, sessionName, pane, () => sessionStale);
					if (verdict === "continued") {
						settled = false;
						void deliverWhenSettled({
							pi,
							pane,
							sessionId: sessionName,
							agentName: agent.name,
							promptFile,
							isStale: () => sessionStale,
						});
						// No answer in this result: it says what the child is doing, not what it said.
						return blockingResult(agent.name, "timeout", undefined, [wentBackToWorkNote()]);
					}
				}
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
				if (params.interrupt === true) {
					await pressKey(pi, params.sessionName, "esc");
				}
				const how = params.interrupt === true ? "Interrupted, then" : "Sent to";
				// A steer has no launch reply to read: the child is normally already working, which
				// is exactly when a status proves nothing. Its transcript is the evidence instead.
				const verdict = await submitAndConfirm(pi, params.sessionName, params.message, STEER_CONFIRM_SECONDS);
				// Four facts, and only four: the child wrote the message down, the pane refused
				// it and said why, it is sitting in the input box unsent, or the paste landed and
				// pickup is not confirmed yet. One function says all four, so the delegate path and this
				// one cannot drift into two accounts of the same handover.
				const text = handoverText(verdict, params.sessionName, how);
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
				rememberRead(asked, { at: Date.now(), toolUses: progress.toolUses });
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
