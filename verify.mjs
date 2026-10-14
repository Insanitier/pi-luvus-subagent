#!/usr/bin/env node
/**
 * verify.mjs — the regression net this extension did not have.
 *
 * brooks-sweep's Step 2e looks for a project test command; there was none, so
 * every structural fix was unverifiable. This runs in seconds, needs no network,
 * and launches no pane. It covers:
 *
 *   1. the module parses and loads (type stripping + the whole import graph)
 *   2. agent discovery, and the argv each fixture agent resolves to
 *   3. one whole delegation against a stub `luvus`: launch, task submit, settle
 *      detection, result extraction, the completion notice, the widget frames,
 *      the prompt-file delete and the pane close
 *
 * Isolation: HOME, PI_CODING_AGENT_DIR and LUVUS_BIN_PATH all point into a temp
 * dir, so nothing here touches the real ~/.pi/agent, a real session file, or a
 * real pane. Run it with `node verify.mjs` (or `npm test`).
 */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXTENSION = join(HERE, "extensions", "luvus-subagent.ts");
// Every temp path below — and the prompt directory the extension computes at import
// time — must land in this run's own dir, or a test run would sweep the shared one.
process.env.TMPDIR = mkdtempSync(join(tmpdir(), "luvus-verify-"));

// ── 0. Locate the Pi SDK, so its bare imports resolve outside the Pi runtime ──
const sdkRoot = (() => {
	if (process.env.PI_SDK_DIR) return process.env.PI_SDK_DIR;
	const bin = execFileSync("readlink", ["-f", execFileSync("which", ["pi"], { encoding: "utf-8" }).trim()], {
		encoding: "utf-8",
	}).trim();
	for (let dir = dirname(bin); dir !== "/"; dir = dirname(dir)) {
		const manifest = join(dir, "package.json");
		if (!existsSync(manifest)) continue;
		if (JSON.parse(readFileSync(manifest, "utf-8")).name === "@earendil-works/pi-coding-agent") return dir;
	}
	throw new Error("cannot locate @earendil-works/pi-coding-agent; set PI_SDK_DIR");
})();

registerHooks({
	resolve(specifier, context, next) {
		// Anchor the SDK's bare specifiers at its own node_modules, the way the Pi
		// runtime resolves them for an extension.
		if (specifier.startsWith("@earendil-works/") || specifier === "typebox") {
			return next(specifier, {
				...context,
				parentURL: pathToFileURL(join(sdkRoot, "node_modules", "anchor.mjs")).href,
			});
		}
		return next(specifier, context);
	},
});

// ── 1. A throwaway HOME, so the extension's own paths stay out of the way ────
const HOME = join(tmpdir(), `luvus-verify-${process.pid}`);
const AGENT_DIR = join(HOME, ".pi", "agent");
const SESSION_DIR = join(AGENT_DIR, "subagent-sessions");
const PROMPT_DIR = join(tmpdir(), "luvus-subagent-prompts");
mkdirSync(join(AGENT_DIR, "agents"), { recursive: true });
mkdirSync(SESSION_DIR, { recursive: true });
// The prompt directory exists only once something writes to it, and the checks below
// read it, so this run creates its own.
mkdirSync(PROMPT_DIR, { recursive: true });
process.env.HOME = HOME;
process.env.PI_CODING_AGENT_DIR = AGENT_DIR;

const SKILL_DIR = join(AGENT_DIR, "skills", "verify-skill");
mkdirSync(SKILL_DIR, { recursive: true });
writeFileSync(join(SKILL_DIR, "SKILL.md"), "---\nname: verify-skill\ndescription: fixture\n---\n\nFixture skill.\n");

writeFileSync(
	join(AGENT_DIR, "agents", "fixture-bare.md"),
	"---\nname: fixture-bare\ndescription: Minimal agent, no tools key.\nmodel: test/model\nthinking: low\n---\n\nBare body.\n",
);
writeFileSync(
	join(AGENT_DIR, "agents", "fixture-full.md"),
	[
		"---",
		"name: fixture-full",
		"description: Declares tools, a denylist, a skill and append mode.",
		"model: test/model",
		"thinking: high",
		"tools: read, grep",
		"disallowed_tools: write",
		"skills: verify-skill",
		"prompt_mode: append",
		"---",
		"",
		"Full body.",
		"",
	].join("\n"),
);

// ── 2. A stub `luvus`: canned envelopes, and it writes the child's session ───
const STUB = join(HOME, "luvus-stub.mjs");
const STUB_LOG = join(HOME, "stub.log");
writeFileSync(STUB_LOG, "");
writeFileSync(
	STUB,
	`#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const argv = process.argv.slice(2);
appendFileSync(process.env.LUVUS_STUB_LOG, argv.join(" ") + "\\n");
const ok = (result) => { process.stdout.write(JSON.stringify({ result })); process.exit(0); };
const sessionDir = join(process.env.HOME, ".pi", "agent", "subagent-sessions");
if (argv[0] === "agent" && argv[1] === "start") {
	// A fresh child is idle, whatever a previous delegation under this name left behind.
	writeFileSync(join(sessionDir, argv[2] + ".state"), "idle");
	ok({ pane: "42" });
}
if (argv[0] === "agent" && argv[1] === "prompt") {
	// Pasting is not submitting: Luvus puts the text in the child's input box, and the
	// transcript only gains the turn once an Enter arrives — measured against the real
	// CLI, where a 12-line paste sat unsent until a separate agent keys <target> enter.
	mkdirSync(sessionDir, { recursive: true });
	writeFileSync(join(sessionDir, argv[2] + ".pending"), argv[3]);
	ok({ submitted: true });
}
if (argv[0] === "agent" && argv[1] === "keys" && argv[3] === "enter") {
	const pending = join(sessionDir, argv[2] + ".pending");
	// A task text of NEVER_PICKED is a child that never starts working, Enter or not.
	const task = existsSync(pending) ? readFileSync(pending, "utf-8") : "NEVER_PICKED";
	// The host's view of the child: idle until the Enter lands, then working. NEVER_PICKED
	// never leaves idle, which is what an unpicked delegation looks like from here.
	writeFileSync(join(sessionDir, argv[2] + ".state"), task === "NEVER_PICKED" ? "idle" : "working");
	if (task !== "NEVER_PICKED") {
		const file = join(sessionDir, "1970-01-01T00-00-00-000Z_" + argv[2] + ".jsonl");
		const terminal = task === "ERRORED_TASK"
			? { role: "assistant", stopReason: "error", errorMessage: "upstream: connection reset", content: [] }
			: task === "ABORTED_WITH_OUTPUT_TASK"
				? {
						role: "assistant",
						stopReason: "aborted",
						errorMessage: "Operation aborted",
						content: [{ type: "text", text: "STUB_PARTIAL_ANSWER" }],
					}
				: task === "NO_ANSWER_TASK"
					? undefined
					: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "STUB_ANSWER" }] };
		appendFileSync(file, (existsSync(file) ? "\\n" : "") + [
			JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: task }] } }),
			...(terminal === undefined ? [] : [JSON.stringify({ type: "message", message: terminal })]),
		].join("\\n"));
	}
	ok({});
}
if (argv[0] === "wait") process.exit(process.env.LUVUS_STUB_GONE === "1" ? 2 : process.env.LUVUS_STUB_UNSETTLED === "1" ? 1 : 0);
if (argv[0] === "agent" && argv[1] === "get") {
	// A pane that is gone answers with the envelope Luvus uses, and a non-zero exit.
	if (process.env.LUVUS_STUB_GONE === "1") {
		process.stdout.write(JSON.stringify({ error: { code: "not_found", message: "agent target not found" } }));
		process.exit(1);
	}
	// Measured against the real CLI: a fresh child is idle, and paste + Enter moves it
	// to working within a second — which the submit reads instead of waiting on.
	const state = join(sessionDir, argv[2] + ".state");
	ok({ pane: argv[2], status: existsSync(state) ? readFileSync(state, "utf-8") : "idle" });
}
if (argv[0] === "agent" && argv[1] === "report") ok({});
if (argv[0] === "agent" && argv[1] === "release") ok({});
if (argv[0] === "pane" && argv[1] === "close") ok({});
ok({});
`,
);
chmodSync(STUB, 0o755);
process.env.LUVUS_BIN_PATH = STUB;
process.env.LUVUS_STUB_LOG = STUB_LOG;

// ── 3. Drive the real extension with a fake Pi and a fake UI ─────────────────
const exec = (bin, args, options = {}) =>
	new Promise((resolve) => {
		try {
			const stdout = execFileSync(bin, args, { encoding: "utf-8", timeout: options.timeout ?? 10_000 });
			resolve({ stdout, stderr: "", code: 0, killed: false });
		} catch (error) {
			resolve({
				stdout: error.stdout ?? "",
				stderr: error.stderr ?? "",
				code: typeof error.status === "number" ? error.status : 1,
				killed: error.killed === true,
			});
		}
	});

const tools = {};
// A notice's content is one text part per child: merging is what makes a burst of
// children cost the parent one wake-up, so the checks read the parts, not a string.
const noticeText = (notice) =>
	typeof notice.content === "string" ? notice.content : (notice.content ?? []).map((part) => part.text).join("\n");
// Registered renderers, so the card a merged notice draws can be checked too.
const renderers = {};
// Pi hands the queued notice back when it starts delivering it. A check that counts
// notices has to let the previous batch go out first, or it would absorb the next one.
const deliverQueued = async () => {
	for (const handler of handlers.get("message_start") ?? []) await handler({ message: notices.at(-1) ?? {} }, ctx);
};
const notices = [];
// Custom session entries: Pi stores them without sending them to the model, which is
// what lets the registry survive a reload.
const entries = [];
const handlers = new Map();
const noop = () => undefined;
const pi = new Proxy(
	{
		exec,
		registerTool: (definition) => (tools[definition.name] = definition),
		registerMessageRenderer: (type, renderer) => (renderers[type] = renderer),
		// Pi stores a custom message with role "custom"; the notice hooks read both fields.
		sendMessage: (message, options) => notices.push({ role: "custom", ...message, options }),
		appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
		on: (event, handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
	},
	{ get: (target, key) => (key in target ? target[key] : noop) },
);

const frames = [];
const theme = new Proxy({}, { get: () => (color, text) => `\u2039${color}\u203a${text}\u2039/${color}\u203a` });
const ui = {
	theme,
	setStatus: (key, text) => frames.push({ kind: "status", key, text }),
	setWidget: (key, content, options) => frames.push({ kind: "widget", key, content, options }),
};
// The replay reads the active branch; in the stub the whole session is one branch, so
// `getBranch` and `getEntries` are the same list.
const ctx = {
	cwd: HOME,
	hasUI: true,
	ui,
	sessionManager: { getEntries: () => entries, getBranch: () => entries, getSessionId: () => "parent-session" },
};

const failures = [];
let checks = 0;
const check = (name, condition, detail = "") => {
	checks++;
	if (condition) console.log(`  \u2705 ${name}`);
	else {
		console.log(`  \u274c ${name}${detail ? `\n       ${detail}` : ""}`);
		failures.push(name);
	}
};

const extension = await import(pathToFileURL(EXTENSION).href);
extension.default(pi);

console.log("module");
check("loads and registers both tools", typeof tools.delegate?.execute === "function" && typeof tools.steer?.execute === "function");

console.log("\nagent discovery and argv");
const agents = extension.discoverAgents(HOME).map((agent) => agent.name);
check("discovers the fixtures", JSON.stringify(agents) === JSON.stringify(["fixture-bare", "fixture-full"]), `got ${JSON.stringify(agents)}`);

const bare = extension.prepareLaunch(
	extension.discoverAgents(HOME).find((agent) => agent.name === "fixture-bare"),
	HOME,
	"fixture-bare-aaaaaa",
);
check("bare agent gets no --tools", !bare.args.includes("--tools"));
check("bare agent always gets --no-skills", bare.args.includes("--no-skills"));
check(
	"replace mode passes the empty append pair",
	bare.args.includes("--append-system-prompt") && bare.args[bare.args.indexOf("--append-system-prompt") + 1] === "",
);
// prepareLaunch only names the prompt file; the caller writes it. So the plan is
// checked for the path, and the write is checked through the same function a
// delegation uses — including the mode, which is what keeps the body owner-only.
// PROMPT_DIR is the real, shared temp directory, so a file left behind by an aborted run
// has to go first: otherwise this check fails for a reason that has nothing to do with it.
rmSync(bare.promptFile, { force: true });
check("the plan names the prompt file without creating it", !existsSync(bare.promptFile));
extension.writePromptFile(bare.promptFile, "fixture body");
check(
	"prompt file written owner-only",
	readFileSync(bare.promptFile, "utf-8") === "fixture body" && (statSync(bare.promptFile).mode & 0o777) === 0o600,
);

const full = extension.prepareLaunch(
	extension.discoverAgents(HOME).find((agent) => agent.name === "fixture-full"),
	HOME,
	"fixture-full-bbbbbb",
);
const valueOf = (flag) => full.args[full.args.indexOf(flag) + 1];
check("--tools carries the allowlist", valueOf("--tools") === "read,grep");
check("--exclude-tools carries the denylist", valueOf("--exclude-tools") === "write");
check("--skill resolves to the fixture SKILL.md", valueOf("--skill") === join(SKILL_DIR, "SKILL.md"));
check("append mode does not pass --system-prompt", !full.args.includes("--system-prompt"));
check("no unresolved skills", full.unresolvedSkills.length === 0, `got ${JSON.stringify(full.unresolvedSkills)}`);

// The prompt directory is shared by every session on the machine, so it cannot be
// isolated by HOME. Clean up after the direct prepareLaunch calls above, then
// measure the delegation by the difference — never by the directory being empty.
for (const plan of [bare, full]) rmSync(plan.promptFile, { force: true });
const promptFilesBefore = new Set(readdirSync(PROMPT_DIR));

console.log("\nend-to-end delegation against the stub CLI");
frames.length = 0;
const result = await tools.delegate.execute(
	"verify-call",
	{ agent: "fixture-bare", task: "say the thing" },
	undefined,
	undefined,
	ctx,
);
const text = result.content[0].text;
check("tool result carries the child's answer", text.includes("STUB_ANSWER"), text.slice(0, 120));
check("tool result reports the agent and status", text.startsWith("fixture-bare (done):"));

const widgetFrames = frames.filter((frame) => frame.kind === "widget" && frame.content !== undefined);
const workingFrame = widgetFrames.find((frame) => frame.content.some((line) => line.includes("working")));
check("widget shows a working row", workingFrame !== undefined);
check(
	"working row is a tree row with a dim connector and an accent glyph",
	workingFrame !== undefined &&
		workingFrame.content[1].startsWith("\u2039dim\u203a\u2514\u2500\u2039/dim\u203a \u2039accent\u203a\u25c6\u2039/accent\u203a "),
	workingFrame?.content[1],
);
check("widget ends with the trailing spacer", workingFrame !== undefined && workingFrame.content.at(-1) === "");
check("widget is placed above the editor", workingFrame?.options?.placement === "aboveEditor");
// Nothing is running any more, so the list is history: it goes away at once
// rather than lingering above the editor.
check(
	"the widget clears the moment nothing is running",
	[...frames].reverse().find((frame) => frame.kind === "widget")?.content === undefined,
	[...frames].reverse().find((frame) => frame.kind === "widget")?.content?.join(" | "),
);
check(
	"footer is never written, only cleared",
	frames.filter((frame) => frame.kind === "status").every((frame) => frame.text === undefined),
);

const stubLog = readFileSync(STUB_LOG, "utf-8");
check("the pane was closed at settle", stubLog.includes("pane close 42"), stubLog.trim().split("\n").join(" | "));
check("the task was submitted as a prompt, not as argv", stubLog.includes("agent prompt fixture-bare-"));
const promptFilesLeft = readdirSync(PROMPT_DIR).filter((name) => !promptFilesBefore.has(name));
check("the delegation deleted its own prompt file", promptFilesLeft.length === 0, promptFilesLeft.join(", "));

console.log("\nno linger");
// A settled list must not pin itself above the editor, and there is no timer to
// wait on: the widget went away at settle (checked above) and nothing repaints it.
await new Promise((resolve) => setTimeout(resolve, 1200));
check(
	"nothing repaints the widget after everything settles",
	[...frames].reverse().find((frame) => frame.kind === "widget")?.content === undefined,
	[...frames].reverse().find((frame) => frame.kind === "widget")?.content?.join(" | "),
);

console.log("\nfailure paths");
const before = new Set(readdirSync(PROMPT_DIR));

const unknown = await tools.delegate.execute("verify-unknown", { agent: "nope", task: "x" }, undefined, undefined, ctx);
check(
	"an unknown agent is an error listing the known ones",
	unknown.isError === true && unknown.content[0].text.includes("fixture-bare"),
	unknown.content[0].text,
);

// Only this check wants the stub to report an unsettled wait; the happy path
// above ran with the default (settled) behaviour.
process.env.LUVUS_STUB_UNSETTLED = "1";
const handoffLog = readFileSync(STUB_LOG, "utf-8").length;
frames.length = 0;
const unsettled = await tools.delegate.execute(
	"verify-unsettled",
	{ agent: "fixture-bare", task: "say the thing", wait: true },
	undefined,
	undefined,
	ctx,
);
check(
	"a child that never settles is reported as still running, not as an error",
	unsettled.isError !== true && unsettled.content[0].text.includes("still running after"),
	unsettled.content[0].text,
);
check(
	"an unsettled child keeps its pane",
	// The probe that ends a wait also logs, so this asks what the delegation did instead
	// of what it logged last: it waited, and it never closed the pane afterwards.
	readFileSync(STUB_LOG, "utf-8").trim().split("\n").findLastIndex((line) => line.startsWith("wait agent-status")) >
		readFileSync(STUB_LOG, "utf-8").trim().split("\n").findLastIndex((line) => line.startsWith("pane close")),
	readFileSync(STUB_LOG, "utf-8").trim().split("\n").at(-1),
);
// The wait ran out before the child did, so the delegation handed itself to the
// watcher. It stays watched — a notice only comes when the child actually ends — and
// it is never recorded as finished while it runs.
await new Promise((resolve) => setTimeout(resolve, 800));
const handedLog = readFileSync(STUB_LOG, "utf-8").slice(handoffLog).trim().split("\n");
check(
	"a blocking delegation that ran out is still watched",
	handedLog.some((line) => line.startsWith("wait agent-status")),
	handedLog.slice(0, 4).join(" | "),
);
const handedRows = (await tools.subagent_status.execute("verify-handed", {}, undefined, undefined, ctx)).content[0].text;
check(
	"a still-running delegation is not recorded as finished",
	/fixture-bare-[0-9a-f]{6}\s+working/.test(handedRows),
	handedRows,
);
process.env.LUVUS_STUB_UNSETTLED = "";

// A resumed session already holds older user messages, so "a user line exists" would
// report a picked-up task before the new one was ever submitted — and the task would sit
// in the child's input box. The delegation has to press Enter all the same.
const resumeId = "resume-fixture";
const resumeDir = join(HOME, ".pi", "agent", "subagent-sessions");
mkdirSync(resumeDir, { recursive: true });
writeFileSync(
	join(resumeDir, `1970-01-01T00-00-00-000Z_${resumeId}.jsonl`),
	JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "an older task" }] } }),
);
const resumeLogBefore = readFileSync(STUB_LOG, "utf-8");
await tools.delegate.execute(
	"verify-resume-submit",
	{ agent: "fixture-bare", task: "the new task", resume: resumeId },
	undefined,
	undefined,
	ctx,
);
const resumeLogAfter = readFileSync(STUB_LOG, "utf-8").slice(resumeLogBefore.length);
check(
	"a resumed delegation submits through the host's own confirmation",
	resumeLogAfter.includes(`agent prompt ${resumeId} the new task`) &&
		resumeLogAfter.includes(`agent keys ${resumeId} enter`),
	resumeLogAfter.trim().split("\n").slice(0, 4).join(" | "),
);

// The submit loop is SUBMIT_ATTEMPTS x SUBMIT_PROBE_MS by design, so this one
// check is the slow part of the suite (~20s).
frames.length = 0;
const unpicked = await tools.delegate.execute(
	"verify-unpicked",
	{ agent: "fixture-bare", task: "NEVER_PICKED" },
	undefined,
	undefined,
	ctx,
);
check(
	"a task the child never took is an error that says so",
	unpicked.isError === true && unpicked.content[0].text.includes("never started working"),
	unpicked.content[0].text,
);
check(
	"the failed delegation still closed its pane",
	readFileSync(STUB_LOG, "utf-8").includes("pane close 42"),
);
// A settled row is drawn only beside a live one, and the widget is cleared once nothing
// is running — so the failed row needs a delegation that stays live to be rendered at
// all. UNSETTLED keeps the watcher from ending it, and the delegation is not awaited.
process.env.LUVUS_STUB_UNSETTLED = "1";
await tools.delegate.execute("verify-live-row", { agent: "fixture-bare", task: "stay", wait: false }, undefined, undefined, ctx);
await new Promise((resolve) => setTimeout(resolve, 1500));
const widgetLines = frames
	.filter((frame) => frame.kind === "widget" && frame.content !== undefined)
	.flatMap((frame) => frame.content);
const failedRow = widgetLines.find((line) => /\u2039error\u203a\u2717\u2039\/error\u203a/.test(line) && line.includes("failed"));
check("the widget shows a failed row in the error colour", failedRow !== undefined, widgetLines.join(" | "));
delete process.env.LUVUS_STUB_UNSETTLED;
console.log("\nbackground delegation");
frames.length = 0;
await deliverQueued();
notices.length = 0;
const background = await tools.delegate.execute(
	"verify-bg",
	{ agent: "fixture-bare", task: "say the thing", wait: false },
	undefined,
	undefined,
	ctx,
);
check(
	"a background delegation returns without blocking",
	background.content[0].text.includes("(running)") && background.content[0].text.includes("steerable"),
	background.content[0].text,
);
await new Promise((resolve) => setTimeout(resolve, 2000));
check(
	"the detached watcher settles it in the widget",
	frames.some((frame) => frame.kind === "widget" && frame.content?.some((line) => line.includes("done"))),
);
// A finished row survives only beside a live one, which is where its rendering can
// be judged: the success glyph and colour, with a frozen duration.
const doneLine = [...frames]
	.reverse()
	.find((frame) => frame.kind === "widget" && frame.content?.some((line) => line.includes("done")))
	?.content?.find((line) => line.includes("done"));
check(
	"done row is frozen and coloured success",
	doneLine !== undefined && /\u2039success\u203a\u2713\u2039\/success\u203a/.test(doneLine),
	doneLine,
);
check(
	"the detached watcher sends the completion notice",
	notices.length === 1 &&
		notices[0].customType === "luvus-subagent-completion" &&
		noticeText(notices[0]).includes("STUB_ANSWER"),
	JSON.stringify(notices[0]?.content ?? null),
);
check("the detached watcher closed the pane", readFileSync(STUB_LOG, "utf-8").includes("pane close 42"));
// While the parent is streaming, Pi reads this mode: a steer lands after the current turn's
// tool calls and before the next model call, where a follow-up waits for the whole turn to
// end. While the parent is idle the two are the same, so this pins the choice that was made,
// not a timing guarantee.
check(
	"every completion notice asks to be steered, not queued as a follow-up",
	notices.length > 0 &&
		notices.every(
			(notice) => notice.options?.deliverAs === "steer" && notice.options?.triggerTurn === true,
		),
	JSON.stringify(notices.map((notice) => notice.options)),
);
console.log("\nmerged notices");
// Deliver what is queued first, the way Pi does: the same array comes back, and that
// identity is what tells the extension the queued notice has gone out.
await deliverQueued();
notices.length = 0;
const mergeA = await tools.delegate.execute("verify-merge-a", { agent: "fixture-bare", task: "say the thing", wait: false }, undefined, undefined, ctx);
const mergeB = await tools.delegate.execute("verify-merge-b", { agent: "fixture-bare", task: "say the thing", wait: false }, undefined, undefined, ctx);
const mergeNameA = mergeA.content[0].text.match(/fixture-bare-[0-9a-f]{6}/)?.[0];
const mergeNameB = mergeB.content[0].text.match(/fixture-bare-[0-9a-f]{6}/)?.[0];
await new Promise((resolve) => setTimeout(resolve, 2500));
check(
	"two children settling together cost one notice, not two",
	notices.length === 1 &&
		mergeNameA !== undefined &&
		mergeNameB !== undefined &&
		mergeNameA !== mergeNameB &&
		noticeText(notices[0]).includes(mergeNameA) &&
		noticeText(notices[0]).includes(mergeNameB),
	`${notices.length} notice(s): ${notices.map((notice) => noticeText(notice).slice(0, 80)).join(" | ")}`
);
check(
	"the merged notice carries both answers",
	(noticeText(notices[0] ?? { content: "" }).match(/STUB_ANSWER/g) ?? []).length === 2,
	noticeText(notices[0] ?? { content: "" }).slice(0, 200),
);
// The card is drawn per part: a merged notice gives each child its own header, coloured
// by the glyph that header already carries, not one header and a wall of body text.
const mergedCard = renderers["luvus-subagent-completion"](
	{
		content: [
			{ type: "text", text: "✓ worker-a (done, 4s, worker-a-aaaaaa)\n\nanswer one" },
			{ type: "text", text: "✗ worker-b (aborted, 9s, worker-b-bbbbbb)\n\nanswer two" },
		],
	},
	{ expanded: true, outputPad: 0 },
	theme,
);
const drawn = JSON.stringify(mergedCard ?? null);
check(
	"a merged card gives each child its own header, coloured by its own glyph",
	drawn.includes("‹success›✓ worker-a") && drawn.includes("‹error›✗ worker-b"),
	drawn.slice(0, 240),
);
console.log("\nstatus tool (the pi-task shape: pull, no bash)");
// The list needs a live row, and a row stays live only while its watcher holds a wait
// that never returns: this child is started with the stub reporting an unsettled wait.
process.env.LUVUS_STUB_UNSETTLED = "1";
await tools.delegate.execute(
	"verify-status-live",
	{ agent: "fixture-bare", task: "say the thing", wait: false },
	undefined,
	undefined,
	ctx,
);
const listed = await tools.subagent_status.execute("verify-status", {}, undefined, undefined, ctx);
const listText = listed.content[0].text;
check("status lists a working row", /fixture-bare-[0-9a-f]{6}\s+working/.test(listText), listText);
check("status lists a done row", /fixture-bare-[0-9a-f]{6}\s+done/.test(listText), listText);
check("status names the pane", /pane 42/.test(listText), listText);

// The answer comes back for a settled delegation, parsed from its notice.
const settledName = noticeText(notices[0] ?? { content: "" }).match(/fixture-bare-[0-9a-f]{6}/)?.[0];
const oneRow = await tools.subagent_status.execute(
	"verify-status-one",
	{ sessionName: settledName },
	undefined,
	undefined,
	ctx,
);
check(
	"status returns the settled delegation's answer",
	oneRow.content[0].text.includes("STUB_ANSWER"),
	oneRow.content[0].text,
);

const noSuch = await tools.subagent_status.execute(
	"verify-status-none",
	{ sessionName: "fixture-bare-000000" },
	undefined,
	undefined,
	ctx,
);
check(
	"status rejects an unknown name and lists the known ones",
	noSuch.isError === true && noSuch.content[0].text.includes("Known:"),
	noSuch.content[0].text,
);

// The wait below needs a child that does settle, so the stub's wait answers again.
process.env.LUVUS_STUB_UNSETTLED = "";
// The point of the tool: waiting for a child without spawning a bash command.
const bgAgain = await tools.delegate.execute(
	"verify-bg3",
	{ agent: "fixture-bare", task: "say the thing", wait: false },
	undefined,
	undefined,
	ctx,
);
const bgName = bgAgain.content[0].text.match(/fixture-bare-[0-9a-f]{6}/)?.[0];
const waited = await tools.subagent_status.execute(
	"verify-status-wait",
	{ sessionName: bgName, wait: true, timeout_ms: 5000 },
	undefined,
	undefined,
	ctx,
);
check("status can wait for a named delegation", /done/.test(waited.content[0].text), waited.content[0].text);
check(
	"the wait went through the extension, not a bash tool",
	readFileSync(STUB_LOG, "utf-8").includes("wait agent-status 42"),
);

console.log("\ngone pane and transient errors");
// A closed pane is not a timeout: nothing will ever report for it, so the delegation
// has to end now instead of counting down the whole window.
process.env.LUVUS_STUB_GONE = "1";
const gone = await tools.delegate.execute("verify-gone", { agent: "fixture-bare", task: "go away" }, undefined, undefined, ctx);
check(
	"a closed pane ends the delegation instead of counting down",
	gone.isError === true &&
		gone.content[0].text.startsWith("fixture-bare (pane closed):") &&
		gone.content[0].text.includes("was closed before it finished") &&
		// The note explains the missing answer, so the placeholder would be noise.
		!gone.content[0].text.includes("no result was written"),
	gone.content[0].text,
);
check("a closed pane is never called still running", !gone.content[0].text.includes("still running"), gone.content[0].text);
const goneStatus = await tools.subagent_status.execute("verify-gone-status", {}, undefined, undefined, ctx);
check(
	"status reports the closed delegation as failed",
	/fixture-bare-[0-9a-f]{6}\s+failed/.test(goneStatus.content[0].text),
	goneStatus.content[0].text,
);
// Clearing the screen is not forgetting: records outlive the widget and the turns it
// stopped drawing them, which is how the reference separates the two lifecycles.
for (const handler of handlers.get("before_agent_start") ?? []) {
	await handler({ systemPromptOptions: { cwd: HOME, sections: {} } }, ctx);
}
const later = await tools.subagent_status.execute("verify-later", {}, undefined, undefined, ctx);
check(
	"a settled delegation is still queryable after the widget let it go",
	/fixture-bare-[0-9a-f]{6}\s+failed/.test(later.content[0].text),
	later.content[0].text,
);
// A background delegation whose pane is already gone must still return at once, and say
// what it found rather than claiming a child that is not there is running.
const bgGone = await tools.delegate.execute("verify-bg-gone", { agent: "fixture-bare", task: "bg", wait: false }, undefined, undefined, ctx);
check("a background delegation returns at once with its pane gone", bgGone.content[0].text.includes("pane closed"), bgGone.content[0].text);
await new Promise((resolve) => setTimeout(resolve, 1500));
check(
	"the detached watcher reports a closed pane instead of still running",
	notices.some((notice) => noticeText(notice).includes("its pane was closed before it finished")),
	JSON.stringify(notices.map((notice) => noticeText(notice))),
);
process.env.LUVUS_STUB_GONE = "";
// A turn that ended on an upstream error leaves a live session behind: the parent has
// to be told it can steer instead of delegating again.
const errored = await tools.delegate.execute("verify-errored", { agent: "fixture-bare", task: "ERRORED_TASK" }, undefined, undefined, ctx);
check(
	"a failed turn is its own state, with the provider's own words",
	errored.content[0].text.startsWith("fixture-bare (error):") &&
		errored.content[0].text.includes("upstream: connection reset") &&
		errored.content[0].text.includes("the task did not finish"),
	errored.content[0].text,
);
// An interrupted turn that had already written its answer keeps that answer: the
// provider's "Operation aborted" line must not outrank what the turn produced.
const aborted = await tools.delegate.execute("verify-aborted", { agent: "fixture-bare", task: "ABORTED_WITH_OUTPUT_TASK" }, undefined, undefined, ctx);
check(
	"an interrupted turn keeps what it produced",
	aborted.content[0].text.includes("STUB_PARTIAL_ANSWER") &&
		aborted.content[0].text.includes("aborted before it finished") &&
		!aborted.content[0].text.includes("Operation aborted"),
	aborted.content[0].text,
);
// Settling without writing anything is not a finished task: it is its own state.
const noAnswer = await tools.delegate.execute("verify-no-answer", { agent: "fixture-bare", task: "NO_ANSWER_TASK" }, undefined, undefined, ctx);
check(
	"a child that settled without an answer says so",
	noAnswer.content[0].text.startsWith("fixture-bare (no answer):") &&
		noAnswer.content[0].text.includes("there is no result to read"),
	noAnswer.content[0].text,
);

console.log("\nplan and steer");
const logBefore = readFileSync(STUB_LOG, "utf-8").length;
const plan = await tools.delegate.execute(
	"verify-dry",
	{ agent: "fixture-full", task: "plan me", dry_run: true },
	undefined,
	undefined,
	ctx,
);
const planText = plan.content[0].text;
check("dry_run reports the resolved argv", planText.includes("argv:    pi ") && planText.includes("--no-skills"), planText);
check(
	"dry_run starts nothing",
	readFileSync(STUB_LOG, "utf-8").length === logBefore,
	readFileSync(STUB_LOG, "utf-8").slice(logBefore),
);

const steered = await tools.steer.execute(
	"verify-steer",
	{ sessionName: "fixture-bare-deadbe", message: "go left", interrupt: true },
	undefined,
	undefined,
	ctx,
);
const steerLog = readFileSync(STUB_LOG, "utf-8").slice(logBefore).trim().split("\n");
check("steer reports what it did", steered.content[0].text.includes("Interrupted, then"), steered.content[0].text);
check(
	"steer interrupts before it prompts",
	steerLog[0] === "agent keys fixture-bare-deadbe esc" &&
		steerLog[1] === "agent get fixture-bare-deadbe" &&
		steerLog[2] === "agent prompt fixture-bare-deadbe go left" &&
		steerLog[3] === "agent keys fixture-bare-deadbe enter",
	steerLog.join(" | "),
);

const left = readdirSync(PROMPT_DIR).filter((name) => !before.has(name));
check("no prompt file is left by any path", left.length === 0, left.join(", "));

// The reporter is the child-side half of this extension: it runs only when Luvus
// hands the process a pane. Drive it through the real event handlers.
console.log("\ndelegation prompt");
// The parent can only delegate to agents it is told about, so the catalogue is
// rebuilt every turn into its own system-prompt section. The shared `fire` helper
// passes an empty event, and this handler reads the prompt options, so drive it
// with a real event here.
const sections = { subagent_agents: "stale" };
const promptEvent = { systemPromptOptions: { cwd: HOME, sections } };
for (const handler of handlers.get("before_agent_start") ?? []) await handler(promptEvent, ctx);
check(
	"the agent catalogue is written into the system prompt",
	typeof sections.subagent_agents === "string" &&
		sections.subagent_agents.includes("- fixture-bare: Minimal agent, no tools key.") &&
		sections.subagent_agents.includes("- fixture-full:"),
	sections.subagent_agents,
);
check("a stale catalogue is replaced, not added to", !sections.subagent_agents.includes("stale"), sections.subagent_agents);
check(
	"delegate carries the delegation policy",
	(tools.delegate.promptGuidelines ?? []).some((rule) => rule.includes("When to delegate")),
	JSON.stringify(tools.delegate.promptGuidelines),
);
check(
	"delegate points at subagent_status for an answer that has not arrived",
	tools.delegate.description.includes("subagent_status"),
	tools.delegate.description,
);
check(
	"steer and subagent_status carry no guidelines: their descriptions do the work",
	(tools.steer.promptGuidelines ?? []).length === 0 && (tools.subagent_status.promptGuidelines ?? []).length === 0,
);
check(
	"guidelines are bare rules: the renderer adds the dash",
	(tools.delegate.promptGuidelines ?? []).every((rule) => !rule.startsWith("- ")),
);

console.log("\nresume");
// The check below needs a running delegation, so start one the stub keeps unsettled.
process.env.LUVUS_STUB_UNSETTLED = "1";
await tools.delegate.execute(
	"verify-resume-live",
	{ agent: "fixture-bare", task: "say the thing", wait: false },
	undefined,
	undefined,
	ctx,
);
// A delegation this session ran can be continued: Pi's own `--session <file>` reopens
// that conversation, and the id it already carries is the one this delegation keeps.
const resumeList = (await tools.subagent_status.execute("verify-resume-list", {}, undefined, undefined, ctx)).content[0].text;
const resumeSettled = resumeList.match(/(fixture-bare-[0-9a-f]{6})\s+(failed|done)/)?.[1];
const resumeWorking = resumeList.match(/(fixture-bare-[0-9a-f]{6})\s+working/)?.[1];
const resumed = await tools.delegate.execute(
	"verify-resume",
	{ agent: "fixture-bare", task: "continue where you left off", resume: resumeSettled, wait: false },
	undefined,
	undefined,
	ctx,
);
check(
	"resuming a delegation reopens its transcript",
	resumed.content[0].text.startsWith(`Resumed ${resumeSettled} in pane`),
	resumed.content[0].text,
);
check(
	"the resumed child is launched on its own session file",
	readFileSync(STUB_LOG, "utf-8").includes("-- --session /"),
	readFileSync(STUB_LOG, "utf-8").trim().split("\n").at(-1),
);
// A caller that does not want to resume says so with false: that is the shape a model
// which fills every optional parameter can actually produce, instead of inventing a
// session name for a field it cannot leave empty.
const freshFlag = await tools.delegate.execute(
	"verify-fresh-flag",
	{ agent: "fixture-bare", task: "say the thing", resume: false, wait: false },
	undefined,
	undefined,
	ctx,
);
check(
	"resume: false starts a fresh delegation",
	freshFlag.isError !== true && freshFlag.content[0].text.startsWith("Delegated to"),
	freshFlag.content[0].text,
);

const expired = await tools.delegate.execute(
	"verify-expired",
	{ agent: "fixture-bare", task: "x", resume: "no-such-session-zzzzzz" },
	undefined,
	undefined,
	ctx,
);
check(
	"an unknown session is refused, not silently started fresh",
	expired.isError === true && expired.content[0].text.includes("No session to resume"),
	expired.content[0].text,
);
const busy = await tools.delegate.execute(
	"verify-busy",
	{ agent: "fixture-bare", task: "x", resume: resumeWorking },
	undefined,
	undefined,
	ctx,
);
check(
	"a running delegation is steered, not resumed",
	busy.isError === true && busy.content[0].text.includes("still running"),
	busy.content[0].text,
);

console.log("\nsession boundary");
// A switch keeps the process alive, so records from the session being left must not answer
// this one's status tool. The boundary is `session_shutdown`, which fires for a real
// replacement — `session_before_switch` is cancellable, so clearing there would wipe the
// registry of a session that carries on.
for (const handler of handlers.get("session_shutdown") ?? []) await handler({ reason: "resume" }, ctx);
const afterSwitch = await tools.subagent_status.execute("verify-switch", {}, undefined, undefined, ctx);
check(
	"a session switch forgets the previous session's delegations",
	afterSwitch.content[0].text.includes("No delegations in this session"),
	afterSwitch.content[0].text,
);
// The restart case: the process forgets, the conversation remembers. Firing
// session_start on the same entries is what a reload does.
const replayLog = readFileSync(STUB_LOG, "utf-8").length;
for (const handler of handlers.get("session_start") ?? []) await handler({}, ctx);
const replayed = await tools.subagent_status.execute("verify-replay", {}, undefined, undefined, ctx);
check(
	"a reload brings this session's delegations back",
	/fixture-bare-[0-9a-f]{6}\s+(failed|done)/.test(replayed.content[0].text),
	replayed.content[0].text,
);
// A delegation that outlived the instance that started it has no watcher left, so the
// replay has to arm one: the invariant is that a `working` record always has a watcher.
await new Promise((resolve) => setTimeout(resolve, 1200));
const replayLines = readFileSync(STUB_LOG, "utf-8").slice(replayLog).trim().split("\n");
check(
	"a replayed delegation that is still running gets a watcher again",
	replayLines.some((line) => line.startsWith("wait agent-status")),
	replayLines.slice(0, 4).join(" | "),
);
console.log("\nchild state reporter");
process.env.LUVUS_ENV = "1";
process.env.LUVUS_PANE_ID = "77";
process.env.LUVUS_SOCKET_PATH = "/tmp/luvus-verify.sock";
extension.default(pi);
const reporterLogStart = readFileSync(STUB_LOG, "utf-8").length;
// A child session fires the same handlers, so this context needs `getBranch` too: the
// parent's replay runs on it and reads the branch it is given.
const sessionCtx = {
	mode: "tui",
	isIdle: () => true,
	sessionManager: { getSessionId: () => "child-session", getEntries: () => [], getBranch: () => [] },
};
// Several handlers can share one event name (the reporter and the parent both
// register session_shutdown), so fire every handler the extension registered.
const fire = async (event, ctx = sessionCtx) => {
	for (const handler of handlers.get(event) ?? []) await handler({}, ctx);
	await new Promise((resolve) => setTimeout(resolve, 50));
};
await fire("session_start");
await fire("agent_start");
await fire("agent_settled");
await fire("session_shutdown");
const reporterLog = readFileSync(STUB_LOG, "utf-8").slice(reporterLogStart);
check("the reporter announces idle when its session starts", /agent report 77 .*--status idle/.test(reporterLog), reporterLog);
check(
	"the reporter reports working, then done",
	/--status working/.test(reporterLog) && /--status done/.test(reporterLog),
	reporterLog,
);
check("the reporter releases its lease on shutdown", /agent release 77/.test(reporterLog), reporterLog);

console.log(
	`\n${failures.length === 0 ? "PASS" : `FAIL (${failures.length})`}: ${checks - failures.length}/${checks} checks` +
		(failures.length > 0 ? `\n  ${failures.join("\n  ")}` : ""),
);
process.exit(failures.length === 0 ? 0 : 1);
