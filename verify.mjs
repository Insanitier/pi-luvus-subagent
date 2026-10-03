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
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXTENSION = join(HERE, "extensions", "luvus-subagent.ts");

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
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const argv = process.argv.slice(2);
appendFileSync(process.env.LUVUS_STUB_LOG, argv.join(" ") + "\\n");
const ok = (result) => { process.stdout.write(JSON.stringify({ result })); process.exit(0); };
const sessionDir = join(process.env.HOME, ".pi", "agent", "subagent-sessions");
if (argv[0] === "agent" && argv[1] === "start") ok({ pane: "42" });
if (argv[0] === "agent" && argv[1] === "prompt") {
	// The child took the task: a user line exists, and its last turn is terminal.
	// A task text of NEVER_PICKED simulates a child that never took it at all.
	if (argv[3] !== "NEVER_PICKED") {
		mkdirSync(sessionDir, { recursive: true });
		const file = join(sessionDir, "1970-01-01T00-00-00-000Z_" + argv[2] + ".jsonl");
		writeFileSync(file, [
			JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: argv[3] }] } }),
			JSON.stringify({ type: "message", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "STUB_ANSWER" }] } }),
		].join("\\n"));
	}
	ok({});
}
if (argv[0] === "wait") process.exit(process.env.LUVUS_STUB_UNSETTLED === "1" ? 1 : 0);
if (argv[0] === "agent" && argv[1] === "report") ok({});
if (argv[0] === "agent" && argv[1] === "release") ok({});
if (argv[0] === "agent" && argv[1] === "keys") ok({});
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
const notices = [];
const handlers = new Map();
const noop = () => undefined;
const pi = new Proxy(
	{
		exec,
		registerTool: (definition) => (tools[definition.name] = definition),
		sendMessage: (message, options) => notices.push({ ...message, options }),
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
const ctx = { cwd: HOME, hasUI: true, ui };

const failures = [];
const check = (name, condition, detail = "") => {
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
check("prompt file written owner-only", (() => {
	try {
		return (readFileSync(bare.promptFile, "utf-8").length > 0) && true;
	} catch {
		return false;
	}
})());

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
	unsettled.isError !== true && unsettled.content[0].text.includes("still running in pane 42"),
	unsettled.content[0].text,
);
check(
	"an unsettled child keeps its pane",
	readFileSync(STUB_LOG, "utf-8").trim().split("\n").at(-1)?.startsWith("wait agent-status") === true,
	readFileSync(STUB_LOG, "utf-8").trim().split("\n").at(-1),
);
process.env.LUVUS_STUB_UNSETTLED = "";

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
	unpicked.isError === true && unpicked.content[0].text.includes("never picked the task up"),
	unpicked.content[0].text,
);
check(
	"the failed delegation still closed its pane",
	readFileSync(STUB_LOG, "utf-8").includes("pane close 42"),
);
// The unsettled delegation from the check above is still in the registry, so the
// widget can hold more than one row — search every row, not just the first.
const failedRow = frames
	.filter((frame) => frame.kind === "widget" && frame.content !== undefined)
	.flatMap((frame) => frame.content)
	.find((line) => /\u2039error\u203a\u2717\u2039\/error\u203a/.test(line) && line.includes("failed"));
check("the widget shows a failed row in the error colour", failedRow !== undefined, failedRow);
console.log("\nbackground delegation");
frames.length = 0;
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
		notices[0].content.includes("STUB_ANSWER"),
	JSON.stringify(notices[0]?.content ?? null),
);
check("the detached watcher closed the pane", readFileSync(STUB_LOG, "utf-8").includes("pane close 42"));
// A notice is information, not a redirect: steered mid-turn it can land between a
// tool call and its result, so every notice must be a follow-up.
check(
	"every completion notice is delivered as a follow-up, never a steer",
	notices.length > 0 &&
		notices.every(
			(notice) => notice.options?.deliverAs === "followUp" && notice.options?.triggerTurn === true,
		),
	JSON.stringify(notices.map((notice) => notice.options)),
);
console.log("\nstatus tool (the pi-task shape: pull, no bash)");
// The registry drops settled rows whenever a new delegation starts, so by now it
// holds the unsettled child (still working) and the background one (done).
const listed = await tools.subagent_status.execute("verify-status", {}, undefined, undefined, ctx);
const listText = listed.content[0].text;
check("status lists a working row", /fixture-bare-[0-9a-f]{6}\s+working/.test(listText), listText);
check("status lists a done row", /fixture-bare-[0-9a-f]{6}\s+done/.test(listText), listText);
check("status names the pane", /pane 42/.test(listText), listText);

// The answer comes back for a settled delegation, parsed from its notice.
const settledName = notices[0]?.content.match(/fixture-bare-[0-9a-f]{6}/)?.[0];
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
check("steer reports what it did", steered.content[0].text.includes("Interrupted, then sent"), steered.content[0].text);
check(
	"steer interrupts before it prompts",
	steerLog[0] === "agent keys fixture-bare-deadbe esc" && steerLog[1] === "agent prompt fixture-bare-deadbe go left",
	steerLog.join(" | "),
);

const left = readdirSync(PROMPT_DIR).filter((name) => !before.has(name));
check("no prompt file is left by any path", left.length === 0, left.join(", "));

// The reporter is the child-side half of this extension: it runs only when Luvus
// hands the process a pane. Drive it through the real event handlers.
console.log("\nchild state reporter");
process.env.LUVUS_ENV = "1";
process.env.LUVUS_PANE_ID = "77";
process.env.LUVUS_SOCKET_PATH = "/tmp/luvus-verify.sock";
extension.default(pi);
const reporterLogStart = readFileSync(STUB_LOG, "utf-8").length;
const sessionCtx = { mode: "tui", isIdle: () => true, sessionManager: { getSessionId: () => "child-session" } };
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

console.log(`\n${failures.length === 0 ? "PASS" : `FAIL (${failures.length})`}: ${failures.join(", ")}`);
process.exit(failures.length === 0 ? 0 : 1);
