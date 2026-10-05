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
| `delegate` | Start an agent in a Luvus pane. `wait: true` (the default) blocks until it settles and returns its answer; a child that outlives that wait is handed to the same watcher a background delegation uses, so its answer still arrives and its pane is still closed. `wait: false` returns as soon as the pane is up and the answer arrives later as a completion message. `resume` continues a conversation this session already ran, or one named by child session id. `dry_run: true` prints the resolved launch plan without starting anything. |
| `steer` | Send another instruction to a running subagent. `interrupt: true` presses Esc first. |
| `subagent_status` | List this session's delegations — name, state, duration, pane — or with `wait: true` block until one settles and return its answer. |

## Status widget

While at least one delegation is running, a list sits above the editor with one row per delegation (`◆ working`, `✓ done`, `✗ failed`) and live durations. A finished row stays only while it has a running neighbour to sit beside; the moment nothing is running the list is cleared, and the completion message carries the result.

## Design

The child owns its pane, so a delegation is out-of-process by construction: `wait` decides only whether the parent blocks, never where the child runs. A background delegation leaves its pane open so `steer` can still reach it.

Completion notices are delivered as follow-ups, never steered mid-turn, so a notice cannot land between a tool call and its result.

A pane that is closed ends its delegation at once. A wait cannot see a state that will never arrive, so the row settles as failed instead of counting down its window — a closed pane is not a slow child. A child that ended without a finished result is reported as such — `truncated`, `aborted`, `error`, `no answer` — with the provider's own words as the answer text. Pi reports no finer cause than `stopReason`, so no cause is guessed, and the note states what happened rather than what to do about it: partial output must not read as a finished result.

A delegation's record lives in the session, not in the process: the registry is rebuilt from this session's own entries, so a reload or a restart keeps it while another session never sees it. Transcripts are kept for 7 days, which is what `resume` reopens; once swept, resume is unavailable and the earlier result is only in the transcript.

Retrying a failed turn is deliberately not this extension's job. A retry engine belongs in an extension that hooks the session's own turn lifecycle, and one install then covers the parent and every child — children load the same configured extensions. See [pi-retry](https://github.com/monotykamary/pi-retry).

Child sessions live in `~/.pi/agent/subagent-sessions` and are swept after 7 days. A child is launched with `--subagent-child`, which loads this extension for state reporting only — handing the child the tools too would let subagents spawn subagents without bound.

## Verify

```bash
npm test   # node verify.mjs — the whole extension against a stub CLI, no network
```
