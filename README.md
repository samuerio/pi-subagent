# Subagent

Delegate a task to a subagent that runs in its **own isolated context** (a separate `pi`
process), then hand the result back to the main agent — while keeping the main agent's
context window clean and **every child fully observable *and* steerable for agents and humans**.

This is a deliberately *thin* primitive. The main agent is the intelligence; this tool
just gives it a clean way to spawn isolated work, **read the receipts, and inspect any child's session**
 — including after an interrupt, without losing the work already done.

---

## Install

```bash
# git (no npm account needed)
pi install git:github.com/eggmasonvalue/pi-subagent

# or npm
pi install npm:@eggmasonvalue/pi-subagent

# try it for one run without installing
pi -e git:github.com/eggmasonvalue/pi-subagent
```

Then `/reload` (or restart pi) and the `task` tool is available. See
[Inline config](#inline-config-optional) for the optional one-time config
step.

> **Security:** pi packages run with full system access — extensions execute arbitrary
> code. Review the source before installing. This one spawns child `pi` processes and
> reads/writes session JSONL under `~/.pi/agent/sessions/task/`.

---

## What this is solving for

Pi ships without built-in subagents on purpose. Mario Zechner's objections to the way
other harnesses (e.g. Claude Code) do subagents are specific and worth keeping in mind,
because this extension is built to answer each one:

| The usual complaint | What this extension does |
|---|---|
| **"Black box within a black box."** You can't see what the subagent did. | Each child's **full transcript is persisted to a session JSONL**, and the file path is returned in the result — in a terse `[status=… model=… session=…]` envelope so the supervisor sees *which model ran and how it went* without opening anything. You (or the main agent) can open the JSONL and read every step. |
| **Painful to debug.** If a child makes a mistake, you can't replay or correct its conversation. | **Sessions are inspectable.** Each child writes a normal pi session JSONL: `read` it to diagnose what happened, then dispatch a fresh subagent with a corrected task. Inspect → correct → rerun, no hidden state. |
| **Poor context transfer.** The orchestrator decides what the child sees, opaquely. | Context is explicit: the main agent writes the child's `task`. Nothing hidden. |
| **Context pollution.** People reach for subagents mid-session to "save context," then dump tool output back into the parent anyway. | The model only sees the child's **final output** (capped), not its streaming internals. Full detail lives in the session file and tool `details`, off to the side. |
| **All-or-nothing on interrupt.** Kill a runaway child and you lose the work it already finished. | **Abort flushes partial results.** On Ctrl+C / `/interrupt`, the in-flight child is killed but returns whatever it produced so far with `status=aborted`, and its `session=` path stays attached — inspectable, no sessions-dir archaeology. |

The net effect: you get the *one* genuinely useful property of subagents — an **isolated
context window for a focused sub-task** — without giving up observability or steerability.
Two features make that real rather than aspirational:

- **inspectable sessions** turn every child into something you can *inspect and correct* — the steerability a black-box subagent can't offer. Each child persists a normal pi session JSONL; `read` it to see exactly what happened, then dispatch a fresh subagent with a corrected task.
- **abort partial-flush** means interrupting is safe: you never trade away finished work to stop a runaway, and the receipts for *un*finished work are right there to inspect.

### Why no persona files

Popular subagents have every subagent as a human-written `agent.md` persona.
We removed that as the default. A SOTA supervisor model knows how to frame a sub-task and
adopt a persona far better than a static file written ahead of time. So by default this
tool runs **inline**: the main agent supplies the task at call time. Named agent files
are still supported as an *optional* convenience, not a requirement.

---

## How it works

```
main pi session
   └─ task tool call
        └─ spawns:  pi --mode json -p --session-dir <run-dir> [--model ...] [--tools ...] "<prompt>"
              ├─ streams progress to YOU (the human) live, in the tool row
              ├─ writes its full conversation to <run-dir>/<timestamp>_<uuid>.jsonl
              └─ returns a concise final output (+ session path) to the MAIN AGENT
```

Two streams, deliberately separated:

- **To the human:** live streaming of tool calls and progress (observability). This does
  **not** enter the main agent's context.
- **To the main agent:** only the final output, byte-capped, prefixed with a terse
  `[key=value …]` envelope (status, model, `session=<path>`, cost) so it can
  correlate quality↔model and read the full trace if it wants to verify or debug.
  See [Result envelope](#result-envelope).

Child sessions are written under:

```
~/.pi/agent/sessions/task/<runId>/<session>.jsonl
```

---

## Usage

You normally don't call this yourself — you ask the main agent in plain language and it
decides to use the tool. Examples:

```
Scan this repo in an isolated context and tell me where auth is handled.

Run 3 subagents in parallel: one to map the data models, one the API routes,
one the background jobs. Summarize each. (Issue three `task` calls in the
same turn; the harness runs them concurrently.)

Sequence: have a subagent find the rate-limiting code, then ask the main
agent to dispatch another subagent to propose a fix based on what it found.
```

### Mode

One task per call: `{ prompt, description }`. To fan out, issue multiple `task` tool calls
in the same turn — the pi harness executes sibling tool calls concurrently by
default, so they run in parallel without an explicit `tasks` array.

### Per-call options (all optional)

- `agent` — name of a `*.md` agent file (optional; see below).

Model, thinking, tools, and skill-discovery are not per-call options. Inline runs
use the defaults from [`subagent.json`](#inline-config-optional); named agents carry
their own `model`/`thinking`/`tools`/`noSkills` in their `*.md` frontmatter.

### Result envelope

Subagent output is consumed by the **main agent**, not a human, so each task's result is
prefixed with one terse machine-parsable line carrying only what the *tool* uniquely knows:

```
[agent=task status=done model=github-copilot/gpt-5.3-codex thinking=low turns=7 cost=0.0413 exit=end session=/…/<id>.jsonl]
<the child's own final output, verbatim, byte-capped>
```

`status` is one of `done` / `failed` / `aborted`. The tool does
**not** wrap or reformat the child's payload — if you want JSON back, tell the child (via
`task`) to emit JSON. The rich TUI rendering for the human lives in tool
`details` and never enters the main agent's context.

### Abort & partial results

On Ctrl+C / `/interrupt`, the tool **does not discard completed work**. An
in-flight child is killed and returns whatever it produced so far with
`status=aborted`, and its `session=` path stays attached so the partial trace
is inspectable. No work silently discarded, no sessions-dir archaeology.

### Inspecting child sessions

Each child persists a normal pi session JSONL at the path shown in its result's `session=`
field. `read` it to diagnose what happened, then dispatch a fresh subagent with a corrected
task if needed:

```
# the result envelope showed: session=/…/sessions/task/<runId>/<id>.jsonl
read /…/sessions/task/<runId>/<id>.jsonl

# then rerun with a corrected task:
task { prompt: "You looped on the import. The package is `foo`, not `foo-py`. Fix pyproject and re-run tests.", description: "Fix the import loop" }
```

- The `session=` path is for human/agent inspection of a child's full transcript.
- Works in single mode.

### Note on progress

Subagent calls are **synchronous fire-and-await**: the main agent's loop is suspended for
the entire call, so there is no live channel back to the model mid-run (a "heartbeat" to
the orchestrator is structurally impossible). The human *does* see live streaming in the
TUI. The synchronous answer to "what if it hangs" is `abort`, not a heartbeat.

### Named agents (optional)

If you *do* want reusable personas, drop markdown files in:

- `~/.pi/agent/agents/*.md` — global named agents (always available)

The extension automatically injects the available-agent list into the agent's
system prompt at session start, so the model knows which `agent` names it can
pass to `task` without you hand-writing an `AGENTS.md` entry. Edit agent
files and `/reload` to refresh the injected list.
```markdown
---
name: scout
description: Fast read-only codebase recon
tools: read, grep, find, ls
model: claude-haiku-4-5
thinking: low
---

You are a fast scout. Find the relevant code and report concise, cited findings.
```

Then: *"use scout to find the auth code"*. The file's `model`/`tools`/`thinking`/`noSkills`
are the agent's full config; there are no per-call overrides. `thinking` is optional; when
omitted, the child inherits the dispatching session's thinking level.

### Inline config (optional)

Inline subagent runs (calls without an `agent` name) read their defaults from:

`~/.pi/agent/subagent.json`

All fields are optional; omit the file entirely to use the child pi process's own
defaults (default model, default tools, skill discovery on). Example:

```json
{
  "model": "github-copilot/gpt-5.3-codex",
  "thinking": "low",
  "tools": ["read", "grep", "find", "ls", "bash"],
  "noSkills": true
}
```

Named agents are not affected by this file — they carry their own
`model`/`thinking`/`tools`/`noSkills` in their `*.md` frontmatter.

---

## Output & limits

- **Collapsed view:** status, last few items, usage stats (turns, tokens, cost, context).
- **Expanded view (Ctrl+O):** full task, tool calls, final output as Markdown, per-task usage.
- Model-visible output is capped at **50 KB**; the full result stays in tool
  `details` and in the child's session file.
- **Abort:** Ctrl+C / `/interrupt` kills the child process but **flushes partial results** — the in-flight child returns partial output and keeps its session path (see **Abort & partial results**).

---

## Debugging a subagent run

When a child's summary looks off, let you or the agent read the receipts:

```bash
# the session path is shown live in the tool row as soon as the child starts,
# and is included in the final result, e.g.
~/.pi/agent/sessions/task/1718000000000-ab12cd/2026....jsonl

# inspect it
pi --session <that-file>      # browse with /tree
# or just have the main agent `read` the file
```

The path is surfaced **at the start** of the child run (not just the end), so you can
open or `tail -f` the JSONL while it's still working. It is also attached to the result
**even if the run is aborted** (Ctrl+C) or crashes — which is exactly when you want the
partial trace.

That file path *is* the whole observability story. No supervisor loop, no telemetry
schema — just a pointer to the full conversation.

---

## Files

```
pi-subagent/
├── package.json                          # pi manifest (extensions entry, peerDeps)
├── README.md                             # this file
└── extensions/
    └── subagent/
        ├── index.ts                      # the extension (tool registration, spawning, rendering)
        └── agents.ts                     # optional named-agent discovery
```

## Reload

After installing (or editing) run `/reload` in pi — or restart pi — to pick up changes.
