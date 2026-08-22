# Architecture

## Bird's Eye View

pi-subagent is an extension package for the `pi` coding agent that adds observable,
steerable, isolated-context subagents. The main agent delegates tasks to child `pi`
processes — each with its own context window — as single runs, parallel fan-out, or
sequential chains, and can resume any child session mid-task by its persisted JSONL path.
An optional model allowlist constrains which models and thinking levels children may use.

## Code Map

### `extensions/subagent/index.ts`

The pi extension entry point (registered via `"pi".extensions` in `package.json`). It
registers the `subagent` tool, which resolves run specs (named agent or inline), enforces
the model/thinking allowlist, spawns child `pi --mode json -p` processes, parses their
JSON event stream into per-task results, and emits a terse machine-facing envelope
(status/model/cost/session path) plus verbatim child output. Also handles abort/timeout by
returning partial results instead of throwing, injects the named-agents section into the
system prompt at session start, and renders TUI previews for the tool call/result.

Depends on `agents.ts` for named-agent discovery and prompt-section rendering.

**Architecture Invariant:** Resume runs must never re-resolve runtime configuration
(model, thinking, tools) — the resumed session JSONL owns it; the allowlist is therefore
enforced reactively against the child's reported model, killing the child on violation.
Fresh-run options are ignored on resume by design, not rejected.

**API Boundary:** The model-facing result envelope carries only what this tool uniquely
knows; the child's own output is passed through verbatim without imposed formatting.

### `extensions/subagent/agents.ts`

Discovers global named agents from `~/.pi/agent/agents/*.md` (frontmatter: name,
description, optional tools/model/thinking) and renders the `<available_agents>` section
injected into the system prompt. Output is deterministically sorted by name.

**Architecture Invariant:** Only user-level agents are supported; project-local agent
files are deliberately not loaded, so the available-agent list always matches one source.

### `extensions/subagent/models-allowlist.json` (runtime config, not committed)

Optional policy file next to `index.ts`: allowed model ids (strings or objects with
per-thinking-level benchmark metadata), a default model, and an enabled flag. When absent
or disabled, any harness model may be used. See `models-allowlist.example.json` for shape.

### `extensions/subagent/refresh-aa-benchmarks.ts`

Maintenance script (`bun`) that scrapes Artificial Analysis pages for each allowlisted
model/thinking level and writes intelligence/coding/cost metadata back into
`models-allowlist.json`. Depends only on the allowlist file format.

### `extensions/subagent/refresh-deepswe-benchmarks.ts`

Maintenance script (`bun`) that fetches the DeepSWE live leaderboard and writes
pass@1/cost metadata per model/thinking level into `models-allowlist.json`. Same file
contract as `refresh-aa-benchmarks.ts`; the two are independent of each other.

## Cross-Cutting Concerns

- **Observability:** every child's session is persisted under
  `~/.pi/agent/sessions/subagent/<runId>/`; its absolute JSONL path is surfaced live in
  results so aborted/timed-out work stays inspectable and resumable.
- **Fault tolerance:** abort, timeout, and policy-block never discard completed work;
  partial results are returned with explicit status values (`timeout`, `aborted`,
  `policy-blocked`, `never-started`) plus resume hints.
- **Concurrency:** parallel mode is capped (8 tasks, 4 concurrent child processes);
  chain mode stops at the first failed step while flushing all completed step blocks.
