# pi-luvus-subagent

Pi extension for delegating work to subagents that run as real `pi` processes in Luvus panes, so every child is visible, interruptible, and steerable while it works.

## Install

```bash
pi install git:github.com/Insanitier/pi-luvus-subagent
```

## Agents

Subagents are declared once in Markdown, and their frontmatter becomes the child's launch argv:

- `~/.pi/agent/agents/*.md` — user agents
- `<project>/.pi/agents/*.md` — project agents, which win on a name clash

The agents that resolve are also listed in the parent's system prompt, rebuilt each turn, so the model delegates to real names instead of guessing them. `/subagent-agents` prints the same set for a human, plus the `pi` argv each one launches with.

## Tools

| Tool | What it does |
| --- | --- |
| `delegate` | Start an agent in a Luvus pane. `wait: true` (the default) blocks until it settles and returns its answer; a child that outlives that wait is handed to the same watcher a background delegation uses, so its answer still arrives — as a completion message — and its pane is still closed. `wait: false` returns as soon as the pane is up and the answer arrives later as a completion message that wakes the parent. `resume` continues a conversation this session already ran, or one named by child session id; pass `false` (or omit it) to start a fresh delegation. `dry_run: true` prints the resolved launch plan without starting anything. |
| `steer` | Send another instruction to a running subagent. `interrupt: true` presses Esc first. |
| `subagent_status` | List this session's delegations — name, state, duration, pane, and what a running child is doing; naming one also returns its answer, once that delegation is over, and `wait` blocks until it is. |

## Status widget

While at least one delegation is running, a list sits above the editor with one row per delegation (`◆ working`, `✓ done`, `✗ failed`) and live durations. A finished row stays only while it has a running neighbour to sit beside; the moment nothing is running the list is cleared, and the completion message carries the result.

## Design

The child owns its pane, so a delegation is out-of-process by construction: `wait` decides only whether the parent blocks, never where the child runs. A background delegation leaves its pane open so `steer` can still reach it.

An answer is handed over once, and only once the delegation is over. A child that outlived a blocking wait is still working, so the terminal turn its session file already holds is provisional — it can be superseded before the child is done — and the result carries the wait's own note instead of that text. A parent that needs the answer before its own turn can end waits for it: `subagent_status` with `wait: true`, and with no `timeout_ms` that wait ends when the delegation does rather than at a number the model guessed. A wait and the completion notice are two carriers of one answer, never two answers: whichever arrives first marks it delivered, and the other stands down. A read of a child that is still working reports what it is doing and what has moved since the last read, because "do not wait again if nothing changed" is not a rule anyone can follow from a state alone — `working` reads the same whether the child is mid-tool or wedged. An expired wait says the child was not stopped and names the ways out: steer it with a deadline, or interrupt it.

Completion notices are steered, never queued as follow-ups: while the parent is streaming, Pi delivers a steer after the current turn's tool calls and before the next model call, so the notice reaches a parent that can still act on it — and it cannot land between a tool call and its result. When the parent is idle the mode makes no difference: the notice starts a run either way. A notice that arrives while an earlier one is still queued rides along with it, so several children settling together cost the parent one wake-up rather than one each; the card draws one header per child, coloured by the status its header already carries.

A pane that is closed ends its delegation at once. A wait cannot see a state that will never arrive, so the row settles as failed instead of counting down its window — a closed pane is not a slow child. A child that ended without a finished result is reported as such — `truncated`, `aborted`, `error`, `no answer` — with the provider's own words as the answer text. Pi reports no finer cause than `stopReason`, so no cause is guessed, and the note states what happened rather than what to do about it: partial output must not read as a finished result.

A handover is confirmed by the child's own transcript, never by a status: Luvus answers `agent start` with the state it saw once the pane was ready, and asking again lands while the child is still coming up, where the answer is a guess read off the screen. When nothing confirms the task within fifteen seconds, the delegation reports that instead of guessing — the pane stays open, the record stays running and steerable, and the task is not sent a second time, because a prompt that was accepted may still be picked up.

A delegation's record lives in the session, not in the process: the registry is rebuilt from this session's own entries, so a reload or a restart keeps it while another session never sees it. Nothing retires a record but the session ending — the widget stops drawing a settled row once nothing is running, and `subagent_status` still answers for it.

Retrying a failed turn is deliberately not this extension's job. A retry engine belongs in an extension that hooks the session's own turn lifecycle, and one install then covers the parent and every child — children load the same configured extensions. See [pi-retry](https://github.com/monotykamary/pi-retry).

Child sessions live in `~/.pi/agent/subagent-sessions`, and one is kept while some surviving session file still names it — a name is the only way back in, since `resume` reopens by it and `subagent_status` answers by it, so a transcript nothing names is what a deleted conversation left behind. Pi deletes a conversation by moving its file out of `sessions/` and emits no event for it, so the sweep looks instead of listening: it rides on a delegation launch, rescans at most once an hour, and reaps nothing it could not read in full. A child is launched with `--subagent-child`, which loads this extension for state reporting only — handing the child the tools too would let subagents spawn subagents without bound.

## Verify

```bash
npm test   # node verify.mjs — the whole extension against a stub CLI, no network
```
