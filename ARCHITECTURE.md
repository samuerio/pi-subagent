# Architecture

## Bird's Eye View

pi-subagent 是 `pi` 编码代理的一个扩展包，为其增加可观测、隔离上下文的子代理。主代理把单个任务委派给独立的 `pi` 子进程，每个子进程拥有自己的上下文窗口。需要并行扇出时，由主代理在同一 turn 内发出多个工具调用，pi harness 默认并发执行同一 assistant message 内的 sibling tool calls，因此并行性由 harness 而非本扩展负责。本扩展注册五类原生 tool：两个特化 subagent（`finder` 代码搜索、`oracle` 推理顾问），其配置 bake-in 在代码常量里；一个通用 inline `task`，其配置运行时从 `~/.pi/agent/subagent.json` 读取；以及三个只读的 session 审查工具 `read_session` / `read_session_compaction` / `read_session_entry`，用于事后读取子进程留下的 session JSONL。因为 finder/oracle 也是原生 tool，inline `task` 只需在自身的 `tools` 白名单里列入它们，即可在其子进程上下文内嵌套调用这些特化 subagent（触发 grandchild pi 进程）。

## Code Map

### `extensions/subagent/subagent.ts`

`Subagent` 类，封装共享的 spawn + JSON 事件解析 + envelope + TUI 渲染机器。构造时传入一个 `SubagentSpec`（name、systemPrompt、model/thinking/tools/noSkills）。`.run()` spawn 一个子 `pi --mode json -p` 进程，解析其 JSON 事件流为结果，输出精简的机器可读 envelope（status/model/cost/session 路径）加上子进程逐字输出（不设字节上限，50KB `OUTPUT_CAP` 已按用户决定删除：最终输出就是主代理要看的结果，截断无意义）。`.renderCall()`/`.renderResult()` 用 `spec.name` 作 TUI 显示名。子进程 session 持久化到 `~/.pi/agent/sessions/<spec.name>/<runId>/`，按 tool 名分区便于事后审查。

**Architecture Invariant:** 本扩展只负责"跑一个隔离子进程并报告结果"，不承担并行编排。并发形状（全并行、半串行、根据中间结果再扇出）完全交给主代理智能，靠在同一 turn 发出多个 tool call 实现。因此扩展内部没有并发上限或任务数组；并发度由 pi harness 的 sibling-tool-call 执行模型决定。

**Architecture Invariant:** 面向模型的工具参数只有 `prompt`、`description`。model/thinking/tools/noSkills 不是 per-call 参数：特化 subagent 走代码常量 SPEC，inline `task` 走 `subagent.json`。这避免了主代理在调度时做配置决策，配置全由代码/文件持有。

**API Boundary:** 模型面向的 result envelope 只携带本工具独有的信息（status、model、session、cost）；子进程自身的输出被原样透传，工具不施加任何 payload 格式。

### `extensions/subagent/specialized.ts`

导出 `FINDER_SPEC`、`ORACLE_SPEC` 两个 `SubagentSpec` 常量（内容即原 `~/.pi/agent/agents/*.md` 的 frontmatter + 正文原样内联），以及 inline `task` 用的 `INLINE_BASE_SYSTEM_PROMPT`。新增第三个特化 subagent = 加一个 SPEC 常量 + 在 `index.ts` 里 `new Subagent(SPEC)` 并 `pi.registerTool`。

**Architecture Invariant:** 特化 subagent 的 spec 是代码内常量，无运行时 .md 发现机制。

### `extensions/subagent/index.ts`

pi 扩展入口（通过 `package.json` 的 `"pi".extensions` 注册）。`session_start`/`before_agent_start` 钩子全部移除——特化 subagent 作为原生 tool，其发现靠 pi 自身的 tool description，不再需要自定义系统提示词注入。入口职责：用 `pi.registerTool` 注册全部六个 tool——静态实例化 finder/oracle；inline `task` 的 execute 每次调用现读 `subagent.json`、构造临时 `Subagent` 实例（renderCall/renderResult 委托给一个共享默认实例，渲染只依赖 result.details）；`read_session`/`read_session_compaction` 直接转发到 read-session.ts 模块的实现函数，共享 renderTranscriptResult 渲染（call/result 分隔空行 + 折叠预览）；`read_session_entry` 同样转发到 read-session.ts，带自定义 renderCall/renderResult（钻取 id 高亮 + 折叠/展开渲染，复用 renderSessionResult helper）。

### `extensions/subagent/read-session.ts`

三个只读 session 审查工具（`read_session` / `read_session_compaction` / `read_session_entry`）共居同一模块：共享的 session 引用解析/加载/格式化 helper 只在本模块内部使用，stub 头格式是三工具间的契约，合并便于同步维护。

**read_session**：只读查看 pi session JSONL。`session` 参数为双形态（pi CLI `--session <path|id>` 语义）：含 `/`、`\` 或 `.jsonl` 结尾按路径处理（`~` 展开、相对 cwd），否则按 session id 解析（`resolveSessionRef`：`SessionManager.list(cwd)` 先精确后前缀，再 `SessionManager.listAll()` 全局档，first-match 取最近修改）。id 搜索只覆盖默认 sessions 根的一层 `<project>/*.jsonl`，与官方 CLI 相同；更深的 subagent session（`sessions/<tool>/<runId>/`）按设计只走 path（subagent envelope 携带）。envelope 只携带 cwd/entry、message 计数/thinkingLevel/model（session= 与 id= 均不回显：调用方传入的 ref 可复用于所有钻取工具），作为尾部脚注输出（正文后空一行，保证折叠预览首行是 transcript 内容而非元数据）。经包导出的纯解析管线（`parseSessionEntries` → `migrateSessionEntries` → `buildSessionContext`）返回 resolved transcript（active branch、compaction applied、投影为消息）。渲染时把 compaction/branch entry id 重新对回 `compactionSummary`/`branchSummary` 块头：对 resolved entry 列表与消息列表做 zip（同一 `sessionEntryToContextMessages` 投影，同源同序，精确对齐），任何不一致即放弃全部注解，绝不错标 id。输出不截断（toolCall 只渲染 120 字符参数预览）。toolCall part 与 toolResult 消息还带一个截断的 toolCallId 匹配键 `[call_xxxxxxxx]`（`shortToolCallId`），使并行 tool call 对应到各自结果。entry id 经同一 zip 回标三处钻取句柄（`read_session_entry` 的入口）：toolResult 消息 stub（`## toolResult:<name> (id=xxxx, ~size)`，`~size` 提示该 stub 是否值得钻取，错误另带 300 字符预览）、含 toolCall part 的 assistant 消息（`→` 行尾 `id=`）、bashExecution 消息（`## bash (exit=N)` 块，输出超 300 字符折叠单行并以显式 `⋯ [truncated, full output: read_session_entry id=xxxx]` 标注结尾，短输出已全文渲染无需钻取）。

**read_session_compaction**：按 compaction entry id 重建"该次压缩的 summary 由什么加工而来"= 上一个 summary `S(n-1)` + 本次新淘汰的 raw。推导复用上游 `buildContextEntries(entries, target.parentId)`：以紧邻 compaction 前的 entry 为 leaf 取到触发前的 live context（上一条 compaction 的已摘要前缀被丢弃、其 summary 被 hoist 到最前），再裁掉 `>= target.firstKeptEntryId`（它新保留的 recent tail，未被摘要）；#2608 重复压缩规则在上游，直接继承。整段经与 `read_session` 同一 `formatTranscript` 渲染：上一个 compaction 渲染成顶部的原生 `compactionSummary` 块，因此中间 summary `S(1)..S(n-1)` 在此可达，每个 `S(k)` 恰好作为 `C_{k+1}` 的 compactionSummary 块出现一次。envelope 追加 `span=<firstRawId>..<firstKeptEntryId>`（起点跳过顶部 summary 块、指向第一条 raw），同为尾部脚注。输出不截断。

**read_session_entry**：按 read_session 输出中的 `id=` 钻取单个 entry 的全量内容，按 entry 种类分发：toolResult message（text 全文 + `details` JSON，subagent 结果把完整输出保存在 details，此工具是模型侧唯一恢复路径）、bashExecution message（命令 + 完整多行输出原文，read_session 只预览 300 字符折叠单行，此处是恢复路径）、assistant message 含 toolCall part（每个调用的完整 pretty-print 参数）。无 envelope（调用方刚在 transcript 里见过该 entry 的 stub，回显无增量；身份元数据只留 details 供 TUI 调试）。三个工具中唯一有自定义 TUI 渲染：`renderCall` 在执行前只突出钻取 id（截短 8 hex）+ session 文件名；`renderResult` 纯内容 + 空行分隔 + 逐行 toolOutput 染色，toolCall 走 details.preview 紧凑格式（每调用一行 `name {args}`），折叠态按终端宽度截取前 5 个视觉行 + `... (N more lines, to expand)` 提示，展开态全文。

**Architecture Invariant:** 三工具严格只读，不用 `SessionManager.open()`（其迁移可能重写文件）；SessionManager 只用静态只读元信息查询 `list`/`listAll`（`resolveSessionRef` 的 id→path 桥接），其余只用包导出的纯函数；`migrateSessionEntries` 必须先于 header 拆分、对完整 entry 数组执行，否则 headerless 迁移会按 version 1 重新生成全部 entry id，破坏分支结构与 `firstKeptEntryId` 引用。compaction 路径必须 guard `target.parentId`：`buildSessionPath` 对 falsy/未知 leafId 会静默回退到全局最新 entry，取错分支。

**API Boundary:** read_session 输出与两个钻取工具构成"发现 → 钻取"配对：compactionSummary 块头的 `id=`/`tokensBefore=` 是 `read_session_compaction` 的句柄；toolResult stub 行、`→` toolCall 行、bash 块截断标注上的 `id=` 是 `read_session_entry` 的句柄；这些格式是工具间契约，变更须三处同步。
### `~/.pi/agent/subagent.json` (runtime config, user-owned)

Inline 子代理的默认配置（model/thinking/tools/noSkills），全可选。缺失时子 `pi` 进程用自身默认值。仅影响 inline `task` 路径；特化 subagent 不受影响（配置 bake-in 在代码里）。

## Cross-Cutting Concerns

- **Observability:** 每个子进程的 session 持久化到 `~/.pi/agent/sessions/<tool名>/<runId>/`；其绝对 JSONL 路径在 session 事件触发时即被实时展示，因此中途被 abort 的工作仍可被检查。本版本不支持 resume，session 路径仅用于事后审查；事后审查经 `read_session`（resolved transcript，compactionSummary 块与 toolResult stub 带 entry id）、`read_session_compaction`（按 id 重建该 summary 的 update 输入：上一个 summary + 新淘汰 raw）与 `read_session_entry`（按 stub/`→` 行/bash 块头的 `id=` 钻取工具结果全量内容、工具调用完整参数或 bash 完整输出）完成，三工具同样严格只读。
- **Fault tolerance:** abort 不会丢弃已完成的工作；被中断的子进程返回 `status=aborted`，session 路径保持可检查。
- **Concurrency:** 每个 tool 一次调用只 spawn 一个子进程。并行扇出由主代理在同一 turn 发出多个 tool 调用实现，并发度由 pi harness 决定（harness 默认并发执行 sibling tool calls）。
- **Nesting:** inline `task` 在其 `subagent.json` `tools` 白名单中列入 `finder`/`oracle` 后，子 pi 进程（加载同一套扩展）即可调用这些 tool，触发 grandchild pi 进程。grandchild session 写入对应 tool 名子目录，runId 含时间戳+随机，与父不冲突。本扩展不额外标注父子 session 关联（保持简单，事后审查靠 runId 时间戳对齐）。
