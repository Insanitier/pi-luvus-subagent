/**
 * The delegation pipeline: what a launch resolves to, and what a finished delegation answers.
 *
 * `dryRunReport` and `blockingResult` are the two ends of the same pipeline — the plan before
 * anything starts, and the single dimension of how it ended — so both read the same launch
 * plan and neither of them decides anything on its own.
 */
import type { AgentConfig, LaunchPlan } from "./agents.ts";
import { formatArgv } from "./agents.ts";
import type { ChildResult } from "./child-session.ts";
import type { AgentToolResult, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Launch, SettleOutcome } from "./tty7.ts";
import { startChild } from "./tty7.ts";
import { endedOf, outcomeLine, settledState, shownResult } from "./outcome.ts";
import { trackDelegation } from "./registry.ts";

/** The dry-run answer: the resolved plan, with nothing started. */
export function dryRunReport(
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
export async function launchChild(
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



/** The blocking path's tool result: the child's answer, capped, plus any notes. */
export function blockingResult(
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
