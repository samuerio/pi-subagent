# Architecture

## Bird's Eye View

pi-subagent 是 `pi` 编码代理的一个扩展包，为其增加可观测、隔离上下文的子代理。主代理把单个任务委派给独立的 `pi` 子进程，每个子进程拥有自己的上下文窗口。需要并行扇出时，由主代理在同一 turn 内发出多个 `subagent` 工具调用，pi harness 默认并发执行同一 assistant message 内的 sibling tool calls，因此并行性由 harness 而非本扩展负责。子代理可以指向具名 agent（`~/.pi/agent/agents/*.md` 中的预置配置），也可以由主代理即兴内联一个 systemPrompt 运行。一个可选的模型白名单约束子进程允许使用的模型与 thinking 级别。

## Code Map

### `extensions/subagent/index.ts`

pi 扩展入口（通过 `package.json` 的 `"pi".extensions` 注册）。它注册 `subagent` 工具，每次调用解析一个运行规格（具名 agent 或内联），执行模型/thinking 白名单，spawn 一个子 `pi --mode json -p` 进程，把子进程的 JSON 事件流解析为结果，并输出精简的机器可读 envelope（status/model/cost/session 路径）加上子进程逐字输出。它还在 session_start 时注入 named-agents 段落（仅当 `subagent` 工具本身处于活跃工具集时才注入），并为工具调用/结果渲染 TUI 预览。内联运行使用内置的 `INLINE_BASE_SYSTEM_PROMPT`（一个精简的编码代理 persona），调用方传入的 `systemPrompt` 会被追加在其后；具名 agent 运行则直接使用该 agent 文件的正文作为 system prompt。

**Architecture Invariant:** 本扩展只负责"跑一个隔离子进程并报告结果"，不承担并行编排。并发形状（全并行、半串行、根据中间结果再扇出）完全交给主代理智能，靠在同一 turn 发出多个 tool call 实现。因此扩展内部没有并发上限或任务数组；并发度由 pi harness 的 sibling-tool-call 执行模型决定。

Depends on `agents.ts` for named-agent discovery and prompt-section rendering.

**Architecture Invariant:** 白名单采用纵深防御：不仅在 spawn 前预校验，还在子进程通过 `message_end` 事件上报实际模型时再次校验，若不在白名单则杀掉子进程并把该结果标记为 `policy-blocked`。

**API Boundary:** 模型面向的 result envelope 只携带本工具独有的信息（status、model、label、session、cost）；子进程自身的输出被原样透传，工具不施加任何 payload 格式。

### `extensions/subagent/agents.ts`

从 `~/.pi/agent/agents/*.md` 发现全局具名 agent（frontmatter 字段：name、description，可选 tools/model/thinking/noSkills），并渲染注入系统提示词的 `<available_agents>` 段落。正文作为该 agent 的 systemPrompt。输出按 name 确定性地排序。

**Architecture Invariant:** 仅支持 user 级 agent；刻意不加载项目级 agent 文件，因此可用 agent 列表永远只对应单一来源。

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

- **Observability:** 每个子进程的 session 持久化到 `~/.pi/agent/sessions/subagent/<runId>/`；其绝对 JSONL 路径在 session 事件触发时即被实时展示，因此中途被 abort 的工作仍可被检查。注意：本版本不再支持 resume，session 路径仅用于事后审查。
- **Fault tolerance:** abort 与 policy-block 不会丢弃已完成的工作；部分结果以显式 status 值（`aborted`、`policy-blocked`）返回。
- **Concurrency:** 本扩展一次调用只 spawn 一个子进程。并行扇出由主代理在同一 turn 发出多个 `subagent` 调用实现，并发度由 pi harness 决定（harness 默认并发执行 sibling tool calls）。
