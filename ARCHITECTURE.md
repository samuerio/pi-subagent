# Architecture

## Bird's Eye View

pi-subagent 是 `pi` 编码代理的一个扩展包，为其增加可观测、隔离上下文的子代理。主代理把单个任务委派给独立的 `pi` 子进程，每个子进程拥有自己的上下文窗口。需要并行扇出时，由主代理在同一 turn 内发出多个工具调用，pi harness 默认并发执行同一 assistant message 内的 sibling tool calls，因此并行性由 harness 而非本扩展负责。本扩展注册三类原生 tool：两个特化 subagent（`finder` 代码搜索、`oracle` 推理顾问），其配置 bake-in 在代码常量里；以及一个通用 inline `task`，其配置运行时从 `~/.pi/agent/subagent.json` 读取。因为 finder/oracle 也是原生 tool，inline `task` 只需在自身的 `tools` 白名单里列入它们，即可在其子进程上下文内嵌套调用这些特化 subagent（触发 grandchild pi 进程）。

## Code Map

### `extensions/subagent/subagent.ts`

`Subagent` 类，封装共享的 spawn + JSON 事件解析 + envelope + TUI 渲染机器。构造时传入一个 `SubagentSpec`（name、systemPrompt、model/thinking/tools/noSkills）。`.run()` spawn 一个子 `pi --mode json -p` 进程，解析其 JSON 事件流为结果，输出精简的机器可读 envelope（status/model/cost/session 路径）加上子进程逐字输出。`.renderCall()`/`.renderResult()` 用 `spec.name` 作 TUI 显示名。子进程 session 持久化到 `~/.pi/agent/sessions/<spec.name>/<runId>/`，按 tool 名分区便于事后审查。

**Architecture Invariant:** 本扩展只负责"跑一个隔离子进程并报告结果"，不承担并行编排。并发形状（全并行、半串行、根据中间结果再扇出）完全交给主代理智能，靠在同一 turn 发出多个 tool call 实现。因此扩展内部没有并发上限或任务数组；并发度由 pi harness 的 sibling-tool-call 执行模型决定。

**Architecture Invariant:** 面向模型的工具参数只有 `prompt`、`description`。model/thinking/tools/noSkills 不是 per-call 参数：特化 subagent 走代码常量 SPEC，inline `task` 走 `subagent.json`。这避免了主代理在调度时做配置决策，配置全由代码/文件持有。

**API Boundary:** 模型面向的 result envelope 只携带本工具独有的信息（status、model、session、cost）；子进程自身的输出被原样透传，工具不施加任何 payload 格式。

### `extensions/subagent/specialized.ts`

导出 `FINDER_SPEC`、`ORACLE_SPEC` 两个 `SubagentSpec` 常量（内容即原 `~/.pi/agent/agents/*.md` 的 frontmatter + 正文原样内联），以及 inline `task` 用的 `INLINE_BASE_SYSTEM_PROMPT`。导出 helper `registerSubagentTool(pi, instance)`，把一个 `Subagent` 实例注册为原生 pi tool（封装 `pi.registerTool` 的 execute/renderCall/renderResult 样板）。新增第三个特化 subagent = 加一个 SPEC 常量 + 在 `index.ts` 里 `new Subagent(SPEC)` + `registerSubagentTool(pi, inst)`。

**Architecture Invariant:** 特化 subagent 的 spec 是代码内常量，无运行时 .md 发现机制。

### `extensions/subagent/index.ts`

pi 扩展入口（通过 `package.json` 的 `"pi".extensions` 注册）。`session_start`/`before_agent_start` 钩子全部移除——特化 subagent 作为原生 tool，其发现靠 pi 自身的 tool description，不再需要自定义系统提示词注入。入口职责：静态实例化 finder/oracle 并经 `registerSubagentTool` 注册；注册 inline `task` tool，其 execute 每次调用现读 `subagent.json`、构造临时 `Subagent` 实例并 `.run()`；renderCall/renderResult 委托给一个共享的默认 `Subagent` 实例（渲染只依赖 result.details，不依赖运行时配置）。

### `~/.pi/agent/subagent.json` (runtime config, user-owned)

Inline 子代理的默认配置（model/thinking/tools/noSkills），全可选。缺失时子 `pi` 进程用自身默认值。仅影响 inline `task` 路径；特化 subagent 不受影响（配置 bake-in 在代码里）。

## Cross-Cutting Concerns

- **Observability:** 每个子进程的 session 持久化到 `~/.pi/agent/sessions/<tool名>/<runId>/`；其绝对 JSONL 路径在 session 事件触发时即被实时展示，因此中途被 abort 的工作仍可被检查。本版本不支持 resume，session 路径仅用于事后审查。
- **Fault tolerance:** abort 不会丢弃已完成的工作；被中断的子进程返回 `status=aborted`，session 路径保持可检查。
- **Concurrency:** 每个 tool 一次调用只 spawn 一个子进程。并行扇出由主代理在同一 turn 发出多个 tool 调用实现，并发度由 pi harness 决定（harness 默认并发执行 sibling tool calls）。
- **Nesting:** inline `task` 在其 `subagent.json` `tools` 白名单中列入 `finder`/`oracle` 后，子 pi 进程（加载同一套扩展）即可调用这些 tool，触发 grandchild pi 进程。grandchild session 写入对应 tool 名子目录，runId 含时间戳+随机，与父不冲突。本扩展不额外标注父子 session 关联（保持简单，事后审查靠 runId 时间戳对齐）。
