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

Then `/reload` (or restart pi) and the `subagent` tool is available. See
[Model allowlist](#model-allowlist-optional-recommended) for the optional one-time config
step.

> **Security:** pi packages run with full system access — extensions execute arbitrary
> code. Review the source before installing. This one spawns child `pi` processes and
> reads/writes session JSONL under `~/.pi/agent/sessions/subagent/`.

---

## What this is solving for

Pi ships without built-in subagents on purpose. Mario Zechner's objections to the way
other harnesses (e.g. Claude Code) do subagents are specific and worth keeping in mind,
because this extension is built to answer each one:

| The usual complaint | What this extension does |
|---|---|
| **"Black box within a black box."** You can't see what the subagent did. | Each child's **full transcript is persisted to a session JSONL**, and the file path is returned in the result — in a terse `[status=… model=… session=…]` envelope so the supervisor sees *which model ran and how it went* without opening anything. You (or the main agent) can open the JSONL and read every step. |
| **Painful to debug.** If a child makes a mistake, you can't replay or correct its conversation. | **Sessions are inspectable.** Each child writes a normal pi session JSONL: `read` it to diagnose what happened, then dispatch a fresh subagent with a corrected task. Inspect → correct → rerun, no hidden state. |
| **Poor context transfer.** The orchestrator decides what the child sees, opaquely. | Context is explicit: the main agent writes the child's `task` (and optionally an inline `systemPrompt`, `model`, `tools`). Nothing hidden. |
| **Context pollution.** People reach for subagents mid-session to "save context," then dump tool output back into the parent anyway. | The model only sees the child's **final output** (capped), not its streaming internals. Full detail lives in the session file and tool `details`, off to the side. |
| **All-or-nothing on interrupt.** Kill a fan-out and you lose the work that already finished. | **Abort flushes partial results.** On Ctrl+C / `/interrupt`, completed tasks return their full output, in-flight tasks return partial output, and **every task keeps its own session path** — each one inspectable. No work silently discarded, no sessions-dir archaeology. |

The net effect: you get the *one* genuinely useful property of subagents — an **isolated
context window for a focused sub-task** — without giving up observability or steerability.
Two features make that real rather than aspirational:

- **inspectable sessions** turn every child into something you can *inspect and correct* — the steerability a black-box subagent can't offer. Each child persists a normal pi session JSONL; `read` it to see exactly what happened, then dispatch a fresh subagent with a corrected task.
- **abort partial-flush** means interrupting is safe: you never trade away finished work to stop a runaway, and the receipts for *un*finished work are right there to inspect.

### Why no persona files

Popular subagents have every subagent as a human-written `agent.md` persona.
We removed that as the default. A SOTA supervisor model knows how to frame a sub-task and
adopt a persona far better than a static file written ahead of time. So by default this
tool runs **inline**: the main agent supplies the task (and optionally a system prompt) at
call time. Named agent files are still supported as an *optional* convenience, not a
requirement.

---

## How it works

```
main pi session
   └─ subagent tool call
        └─ spawns:  pi --mode json -p --session-dir <run-dir> [--model ...] [--tools ...] "Task: ..."
              ├─ streams progress to YOU (the human) live, in the tool row
              ├─ writes its full conversation to <run-dir>/<timestamp>_<uuid>.jsonl
              └─ returns a concise final output (+ session path) to the MAIN AGENT
```

Two streams, deliberately separated:

- **To the human:** live streaming of tool calls and progress (observability). This does
  **not** enter the main agent's context.
- **To the main agent:** only the final output, byte-capped, prefixed with a terse
  `[key=value …]` envelope (status, model, `label`, `session=<path>`, cost) so it can
  correlate quality↔model and read the full trace if it wants to verify or debug.
  See [Result envelope](#result-envelope).

Child sessions are written under:

```
~/.pi/agent/sessions/subagent/<runId>/<session>.jsonl
```

---

## Usage

You normally don't call this yourself — you ask the main agent in plain language and it
decides to use the tool. Examples:

```
Scan this repo in an isolated context and tell me where auth is handled.

Run 3 subagents in parallel: one to map the data models, one the API routes,
one the background jobs. Summarize each.

Sequence: have a subagent find the rate-limiting code, then ask the main
agent to dispatch another subagent to propose a fix based on what it found.
```

### Modes

| Mode | Shape | Use when |
|------|-------|----------|
| **Single** | `{ task }` | One focused isolated task. |
| **Parallel** | `{ tasks: [{ task }, ...] }` | Independent tasks that don't touch the same files. |

### Per-call options (all optional)

- `systemPrompt` — inline persona/instructions for the child.
- `model` — e.g. `sonnet`, `provider/id`.
- `thinking` — optional passthrough to child `--thinking` (no hardcoded validation in this extension).
- `tools` — allowlist, e.g. `["read", "grep", "find", "ls"]` for a read-only scout.
- `cwd` — working directory for the child process.
- `agent` — name of a `*.md` agent file (optional; see below).
- `label` — a correlation tag echoed back in the result envelope (e.g. the repo/feature a task maps to). Removes guesswork when fanning out.

### Result envelope

Subagent output is consumed by the **main agent**, not a human, so each task's result is
prefixed with one terse machine-parsable line carrying only what the *tool* uniquely knows:

```
[label=harden-repo-3 agent=inline status=done model=github-copilot/gpt-5.3-codex thinking=low turns=7 cost=0.0413 exit=end session=/…/<id>.jsonl]
<the child's own final output, verbatim, byte-capped>
```

`status` is one of `done` / `failed` / `aborted` / `never-started` / `policy-blocked`. The tool does
**not** wrap or reformat the child's payload — if you want JSON back, tell the child (via
`task`/`systemPrompt`) to emit JSON. The rich TUI rendering for the human lives in tool
`details` and never enters the main agent's context.

### Abort & partial results

On Ctrl+C / `/interrupt`, the tool **no longer discards completed work**. Every task that
finished returns its full output; in-flight tasks return partial output with
`status=aborted`; tasks that hadn't launched return `status=never-started`. **Every task
keeps its own `session=` path**, so nothing requires digging through the sessions dir. The
aggregate header reports the mix (e.g. `2 done · 1 aborted · 1 never-started`); the
`session=` field on each result points at the unfinished child's JSONL for inspection.

### Inspecting child sessions

Each child persists a normal pi session JSONL at the path shown in its result's `session=`
field. `read` it to diagnose what happened, then dispatch a fresh subagent with a corrected
task if needed:

```
# the result envelope showed: session=/…/sessions/subagent/<runId>/<id>.jsonl
read /…/sessions/subagent/<runId>/<id>.jsonl

# then rerun with a corrected task:
subagent { task: "You looped on the import. The package is `foo`, not `foo-py`. Fix pyproject and re-run tests." }
```

- The `session=` path is for human/agent inspection of a child's full transcript.
- Works in single and parallel.

### Discovering models

```
subagent { listModels: true }
```

Returns compact model-policy JSON: `columns` plus `models` rows, the resolved `default`,
whether the policy is enabled, and the config path. No subagent is spawned.

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
pass to `subagent` without you hand-writing an `AGENTS.md` entry. Edit agent
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

Then: *"use scout to find the auth code"*. Inline `model`/`tools`/`thinking` passed at call
time override the file's values. `thinking` is optional; when omitted (both in the file and
the call), the child inherits the dispatching session's thinking level for fresh runs.

### Model allowlist (optional, recommended)

To hard-restrict which child models can be used, copy
`extensions/subagent/models-allowlist.example.json` to:

`~/.pi/agent/extensions/subagent/models-allowlist.json`

Then edit the copied file with the model IDs and thinking levels you want to allow.

A populated entry looks like this after benchmark data has been refreshed:

```json
{
  "id": "github-copilot/gpt-5.5",
  "levels": {
    "high": {
      "artificialAnalysis": {
        "intelligence": 55.1,
        "coding": 70.8,
        "cost": 4.63
      },
      "deepSWE": {
        "pass": 0.619,
        "cost": 4.47
      }
    },
    "xhigh": {
      "artificialAnalysis": {
        "intelligence": 57.2,
        "coding": 74.1,
        "cost": 6.61
      },
      "deepSWE": {
        "pass": 0.700,
        "cost": 6.61
      }
    }
  },
  "description": "Strong coding model"
}
```

Artificial Analysis provides composite intelligence, coding, and cost metrics. DeepSWE provides coding-agent pass rate and cost. Either source is optional; an empty source or level means no matching data has been imported yet. Benchmark values are advisory; pi model metadata remains authoritative for capability validation.

It supports either plain model ids (strings) or richer objects with an `id`, optional `levels`, and an optional human-readable `description`. Benchmark values under `levels` are formatted into the compact model-facing output described by `levelsLegend`. Unknown extra fields are preserved in the JSON but are not included in the compact `listModels` response:

```json
{
  "enabled": true,
  "allowed": [
    {
      "id": "github-copilot/gpt-5.3-codex",
      "levels": {
        "low": {},
        "medium": {},
        "high": {},
        "xhigh": {}
      },
      "description": "Great default for most coding tasks"
    },
  ],
  "default": "github-copilot/gpt-5.3-codex"
}
```

Behavior when enabled:

- Effective model resolution is: inline `model` → named-agent `model` → allowlist `default`.
- The resolved model must match an allowed `id` exactly.
- **`levels` is enforced, not just descriptive.** If an allowed entry includes a `levels` object, the resolved `thinking` value must be one of its keys or the call fails. Remove a level key (e.g. remove `"xhigh"`) to block it for that model. Omit the `levels` key on an entry entirely to leave thinking unrestricted for that model.
- If no model resolves and no `default` is set, the call fails early.
- If the file is missing, policy is disabled (legacy behavior).

### Refreshing benchmark data

The allowlist is edited directly in `models-allowlist.json`. To refresh the optional
per-level data for configured entries, run from the package checkout:

```bash
bun extensions/subagent/refresh-aa-benchmarks.ts
bun extensions/subagent/refresh-deepswe-benchmarks.ts
```

Missing benchmark pages or rows are reported as warnings and do not remove configured
models or thinking levels. Benchmark data is advisory; runtime validation uses pi's model metadata.

---

## Output & limits

- **Collapsed view:** status, last few items, usage stats (turns, tokens, cost, context).
- **Expanded view (Ctrl+O):** full task, tool calls, final output as Markdown, per-task usage.
- Parallel model-visible output is capped at **50 KB per task**; the full result stays in
  tool `details` and in the child's session file.
- **Abort:** Ctrl+C / `/interrupt` kills child processes but **flushes partial results** — completed tasks return their output, in-flight tasks return partial output, and every task keeps its session path (see **Abort & partial results**).
- Parallel mode is limited to 8 tasks, 4 concurrent.

---

## Debugging a subagent run

When a child's summary looks off, let you or the agent read the receipts:

```bash
# the session path is shown live in the tool row as soon as the child starts,
# and is included in the final result, e.g.
~/.pi/agent/sessions/subagent/1718000000000-ab12cd/2026....jsonl

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
        ├── agents.ts                     # optional named-agent discovery
        ├── models-allowlist.example.json # policy template
        ├── refresh-aa-benchmarks.ts     # refreshes per-level Artificial Analysis data
        └── refresh-deepswe-benchmarks.ts # refreshes per-level DeepSWE data
```

## Reload

After installing (or editing) run `/reload` in pi — or restart pi — to pick up changes.
