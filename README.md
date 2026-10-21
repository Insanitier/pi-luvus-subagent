# pi-tty7-subagent

Pi extension for delegating work to subagents that run as real `pi` processes in [tty7](https://github.com/l0ng-ai/tty7) panes, so every child is visible, interruptible, and steerable while it works.

## Requirements

- The `tty7` CLI on `PATH` (override with `PI_TTY7_BIN`), and the extension running inside a tty7 pane — the delegation splits that pane, so `TTY7_PANE` has to be set.
- The Pi agent's status hooks installed in tty7 (**Settings → Integrations → Pi**). Without them a pane reports no agent, and a launch is never confirmed.

## Install

```bash
pi install git:github.com/Insanitier/pi-tty7-subagent
```

## Agents

Subagents are declared once in Markdown, and their frontmatter becomes the child's launch argv:

- `~/.pi/agent/agents/*.md` — user agents
- `<project>/.pi/agents/*.md` — project agents, which win on a name clash

The agents that resolve are also listed in the parent's system prompt, rebuilt each turn, so the model delegates to real names instead of guessing them. `/subagent-agents` prints the same set for a human, plus the `pi` argv each one launches with.

## Tools

| Tool | What it does |
| --- | --- |
| `delegate` | Start an agent in a tty7 pane. `wait: true` (the default) blocks until it settles and returns its answer; a child that outlives that wait is handed to the same watcher a background delegation uses, so its answer still arrives — as a completion message — and its pane is still closed. `wait: false` returns as soon as the pane is up and the answer arrives later as a completion message that wakes the parent. `resume` continues a conversation this session already ran, or one named by child session id; pass `false` (or omit it) to start a fresh delegation. `dry_run: true` prints the resolved launch plan without starting anything. |
| `steer` | Send another instruction to a running subagent. `interrupt: true` presses Esc first. |
| `subagent_status` | List this session's delegations — name, state, duration, pane, and what a running child is doing; naming one also returns its answer, once that delegation is over, and `wait` blocks until it is. |

## Status widget

While at least one delegation is running, a list sits above the editor with one row per delegation (`◆ working`, `✓ done`, `✗ failed`) and live durations. A finished row stays only while it has a running neighbour to sit beside; the moment nothing is running the list is cleared, and the completion message carries the result.

## Design

The child owns its pane, so a delegation is out-of-process by construction: `wait` decides only whether the parent blocks, never where the child runs. A background delegation leaves its pane open so `steer` can still reach it.

An answer is handed over once, and only once the delegation is over — and "over" is watched, not believed: a finished state has to hold for a ten-second window with no new writing and no return to `working` before anything is recorded, delivered or closed. A child that reports the end of a turn is not necessarily a delegation that ended, because a retry extension re-runs a failed turn in the same pane seconds later and a continuation extension carries a finished one on; measuring that against a real retry, this extension used to record the delegation as failed and close the very pane the retry needed. A child that outlived a blocking wait is still working, so the terminal turn its session file already holds is provisional — it can be superseded before the child is done — and the result carries the wait's own note instead of that text. A parent that needs the answer before its own turn can end waits for it: `subagent_status` with `wait: true`, and with no `timeout_ms` that wait ends when the delegation does rather than at a number the model guessed. A wait and the completion notice are two carriers of one answer, never two answers: whichever arrives first marks it delivered, and the other stands down. A read of a child that is still working reports what it is doing and what has moved since the last read, because "do not wait again if nothing changed" is not a rule anyone can follow from a state alone — `working` reads the same whether the child is mid-tool or wedged. An expired wait says the child was not stopped and names the ways out: steer it with a deadline, or interrupt it.

Completion notices are steered, never queued as follow-ups: while the parent is streaming, Pi delivers a steer after the current turn's tool calls and before the next model call, so the notice reaches a parent that can still act on it — and it cannot land between a tool call and its result. When the parent is idle the mode makes no difference: the notice starts a run either way. A notice that arrives while an earlier one is still queued rides along with it, so several children settling together cost the parent one wake-up rather than one each; the card draws one header per child, coloured by the status its header already carries.

A pane that is closed ends its delegation at once. A wait cannot see a state that will never arrive, so the row settles as failed instead of counting down its window — a closed pane is not a slow child. A child that ended without a finished result is reported as such — `truncated`, `aborted`, `error`, `no answer` — with the provider's own words as the answer text. Pi reports no finer cause than `stopReason`, so no cause is guessed, and the note states what happened rather than what to do about it: partial output must not read as a finished result.

A handover is confirmed by the child's own transcript, never by a status. The task goes in through a file and a bracketed paste (`send --from-file … --paste`, then Enter), so its text is never an argv anywhere — not in this log, not in `ps`, not in a shell's history — and the child's user record is what proves it arrived. When nothing confirms the task within fifteen seconds, the delegation reports that instead of guessing: the pane stays open, the record stays running and steerable, and the task is not sent a second time, because a paste that was accepted may still be picked up.

A launch is proven, not assumed. `split` gives a pane, `send` starts the child's own argv in it, and the child counts as up only when tty7 reports an agent in that pane carrying the session id the argv pinned — `session_id` is the one name both sides agree on. That also settles where a status comes from: tty7 reports `inferred: false` when the child's own hooks are speaking and says so when it is guessing off the screen, and the wording a parent gets names which of the two it is. A fresh pane can swallow the Enter that followed the command (its shell is still painting its startup), and the `send` still succeeds; the launch re-sends Enter while the command is still sitting on the prompt, which is the one failure mode that otherwise looks exactly like a worker that has not got going yet.

A delegation is addressed by its pane, and a name becomes a pane through tty7 itself: `agents --json` reports the session id the launch pinned, so `steer` reaches a delegation even from a session that never started it, without this extension keeping a second map. A name tty7 does not list is refused before anything is typed, because a message typed into the wrong pane is already a change to somebody else's session.

"Finished" is measured from the child's own transcript, not from a state. tty7's `wait --until done` answers a *state*, and a state cannot tell a turn that just ended from one that ended before anybody started watching — measured on server 26.9.4, `--changed` then refuses that same `done` forever while the plain form returns at once with the previous turn's answer. So a delegation records the transcript index of the task's own user record and calls the turn settled when a terminal record appears after it, which is immune to both a stale `done` and a turn that ended before the watcher began. The pane's state only says when to look.

A delegation's record lives in the session, not in the process: the registry is rebuilt from this session's own entries, so a reload or a restart keeps it while another session never sees it. Nothing retires a record but the session ending — the widget stops drawing a settled row once nothing is running, and `subagent_status` still answers for it.

Retrying a failed turn is deliberately not this extension's job. A retry engine belongs in an extension that hooks the session's own turn lifecycle, and one install then covers the parent and every child — children load the same configured extensions. See [pi-retry](https://github.com/monotykamary/pi-retry).

Child sessions live in `~/.pi/agent/subagent-sessions`, and one is kept while some surviving session file still names it — a name is the only way back in, since `resume` reopens by it and `subagent_status` answers by it, so a transcript nothing names is what a deleted conversation left behind. Pi deletes a conversation by moving its file out of `sessions/` and emits no event for it, so the sweep looks instead of listening: it rides on a delegation launch, rescans at most once an hour, and reaps nothing it could not read in full. A child is a plain `pi`: it never loads this extension, so it has no tool to delegate with and subagents cannot spawn subagents without bound, and its status comes from tty7's own agent hook rather than a reporter of ours.

## Where the code lives
`extensions/tty7-subagent.ts` is the entry: it wires Pi's events and the three tools, and nothing else. Everything a reader needs to change in isolation sits beside it in `extensions/tty7-subagent/`, and the imports say which direction each piece may depend in: `env` holds the constants and where files live; `agents` and `sweeps` are the stateless pieces; `tty7` is the only place that calls the CLI; `child-session` is the authoritative read of a child's own session file; `registry` is the delegation table and the one row the parent sees; `outcome` says what an end means; `handover` delivers a task and reads back whether it landed; `delivery` hands an answer over exactly once; `flow` is the launch plan and the blocking answer. Nothing here is a layer for its own sake: each file is the one place a given rule can be read, which is what makes a change to that rule local.
The entry keeps the names the checks drive by name (`discoverAgents`, `prepareLaunch`, `writePromptFile`, and the default export), so a check never has to know which file a piece moved to.

## Verify

```bash
npm test         # node verify.mjs — the whole extension against a stub CLI, no network
npm install      # once: the check needs the Pi SDK types and TypeScript
npm run check    # tsc --noEmit, strict, no unused locals or parameters
```
`npm run check` is not decoration. The split into modules is only real if a missing import is a compile error rather than a runtime one, and it has already caught exactly that — a constant the settle watcher needed and a probe used when a delegation is replayed, neither of which the end-to-end checks reached.
