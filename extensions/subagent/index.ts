/**
 * Subagent extension entry.
 *
 * Registers six native pi tools:
 *   - `finder`       : specialized code-search subagent (baked-in spec).
 *   - `oracle`       : specialized reasoning-advisor subagent (baked-in spec).
 *   - `task`         : inline, general-purpose subagent; config read per-call
 *                      from `~/.pi/agent/subagent.json`. Because finder/oracle
 *                      are also tools, an inline subagent can whitelist them
 *                      and call them from inside its child context (grandchild
 *                      pi process).
 *   - `read_session` : read-only viewer for pi session JSONL files (e.g. the
 *                      `session=` path a subagent envelope reports). Custom
 *                      TUI rendering: renderCall shows the session ref (path
 *                      with $HOME collapsed to ~) + short leaf marker; plain
 *                      renderResult styling via renderTranscriptResult.
 *   - `read_session_compaction` : drill into the original (pre-compaction)
 *                      content a compaction entry replaced (the span between
 *                      the previous compaction's kept boundary and its own).
 *                      Custom TUI rendering: renderDrillCall highlights the
 *                      compaction id (shared with read_session_entry); plain
 *                      renderResult styling via renderTranscriptResult.
 *   - `read_session_entry` : drill into the full content of a specific
 *                      entry (the id= on a ## toolResult stub line, a →
 *                      tool-call line, or a ## bash block header in
 *                      read_session / read_session_compaction output).
 *                      Custom TUI rendering: renderCall highlights the
 *                      drill id (the entry kind is only known after
 *                      execute, so renderResult adds a kind summary line).
 *
 * The spawn/parse/envelope/render machinery + the standard execute body live
 * in the `Subagent` class (`subagent.ts`); specialized specs + description
 * constants live in `specialized.ts`.
 */

import * as fs from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { type ExtensionAPI, getAgentDir, keyHint } from "@earendil-works/pi-coding-agent";
import {
	READ_ENTRY_DESCRIPTION,
	READ_SESSION_COMPACTION_DESCRIPTION,
	READ_SESSION_DESCRIPTION,
	type ReadEntryDetails,
	ReadEntryParams,
	type ReadSessionCompactionDetails,
	ReadSessionCompactionParams,
	type ReadSessionDetails,
	ReadSessionParams,
	readSession,
	readSessionCompaction,
	readSessionEntry,
} from "./read-session.ts";
import { Text } from "@earendil-works/pi-tui";
import {
	FINDER_DESCRIPTION,
	FINDER_SPEC,
	INLINE_BASE_SYSTEM_PROMPT,
	ORACLE_DESCRIPTION,
	ORACLE_SPEC,
} from "./specialized.ts";
import { Subagent, SubagentParams, type SubagentSpec } from "./subagent.ts";

/**
 * Default configuration for inline subagent runs, read from
 * `~/.pi/agent/subagent.json`. All fields optional; omitted fields fall back to
 * the child pi process's own defaults.
 */
interface InlineConfig {
	model?: string;
	thinking?: string;
	tools?: string[];
	noSkills?: boolean;
}

/**
 * Load inline defaults from `~/.pi/agent/subagent.json`. Returns an empty config
 * (all defaults) when the file is missing or unreadable. JSON parse errors are
 * surfaced to the caller.
 */
function loadInlineConfig(): { config: InlineConfig; error?: string } {
	const configPath = path.join(getAgentDir(), "subagent.json");
	if (!fs.existsSync(configPath)) return { config: {} };

	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(configPath, "utf-8"));
	} catch (error) {
		return {
			config: {},
			error: `Invalid JSON in inline config: ${configPath} (${error instanceof Error ? error.message : String(error)})`,
		};
	}

	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { config: {}, error: `Inline config must be a JSON object: ${configPath}` };
	}

	const raw = parsed as Record<string, unknown>;
	const config: InlineConfig = {};

	if (typeof raw.model === "string" && raw.model.trim()) config.model = raw.model.trim();
	if (typeof raw.thinking === "string" && raw.thinking.trim()) config.thinking = raw.thinking.trim();
	if (Array.isArray(raw.tools)) {
		const tools = raw.tools.filter((t): t is string => typeof t === "string" && t.trim().length > 0).map((t) => t.trim());
		if (tools.length > 0) config.tools = tools;
	}
	if (typeof raw.noSkills === "boolean") config.noSkills = raw.noSkills;

	return { config };
}

/**
 * Shared result renderer for the session viewers. ToolExecutionComponent
 * stacks the call line and the result with no gap, so the renderer
 * self-supplies the leading blank line (same trick as the built-in
 * bash/read renderers). Collapsed: FIRST 5 visual lines at the current
 * terminal width (long lines wrap first, so the preview never exceeds 5
 * screen rows), plus the read renderer's "more lines" hint. Built as a
 * width-aware component because ToolRenderResultOptions carries no width.
 */
function renderSessionResult(styled: string, expanded: boolean, theme: any) {
	if (!expanded) {
		const state: { width?: number; lines?: string[]; skipped?: number } = {};
		const lead = [""];
		return {
			render: (width: number) => {
				if (state.lines === undefined || state.width !== width) {
					const all = new Text(styled, 0, 0).render(width);
					state.lines = all.slice(0, 5);
					state.skipped = Math.max(0, all.length - 5);
					state.width = width;
				}
				const hint =
					state.skipped && state.skipped > 0
						? [
								theme.fg("muted", `... (${state.skipped} more lines,`) +
									` ${keyHint("app.tools.expand", "to expand")}` +
									theme.fg("muted", ")"),
							]
						: [];
				return [...lead, ...state.lines, ...hint];
			},
			invalidate: () => {
				state.width = undefined;
				state.lines = undefined;
				state.skipped = undefined;
			},
		};
	}
	// Expanded: full content.
	return new Text(`\n${styled}`, 0, 0);
}

/**
 * Display-only path shortening: collapse the $HOME prefix to `~`. Purely
 * cosmetic (expandHome reverses it); used in renderCall text.
 */
function shortenPath(p: string): string {
	const home = homedir();
	return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

/**
 * Drill-call line builder shared by all three session tools' renderCall:
 * bold toolTitle + muted argument summary, reusing the component slot the
 * harness already allocated.
 */
function drillCallComponent(theme: any, context: any, title: string, muted: string) {
	const text = theme.fg("toolTitle", theme.bold(`${title} `)) + theme.fg("muted", muted);
	const component = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
	component.setText(text);
	return component;
}

/**
 * Shared renderCall for the two drill tools (`read_session_compaction`,
 * `read_session_entry`): fires before execute, when only session + entryId
 * are known, so highlight just the drill id (the thing the stubs in
 * read_session output reference). The session file is omitted: drills
 * immediately follow a read_session call, so the session context is
 * implied.
 */
function renderDrillCall(toolName: string, args: Record<string, unknown>, theme: any, context: any) {
	const entryId = typeof args.entryId === "string" ? args.entryId : "";
	const shortId = entryId ? entryId.slice(0, 8) : "?";
	return drillCallComponent(theme, context, toolName, shortId);
}

/**
 * Plain-text result renderer for `read_session` / `read_session_compaction`.
 * Styling matches read_session_entry exactly: per-line toolOutput coloring
 * (transcript has no `## details` marker lines, so the dim special case
 * doesn't apply), separator blank line + collapsed preview from the shared
 * helper. Error results dye the whole message error-colored with no
 * leading blank, matching read_session_entry's throw path.
 */
function renderTranscriptResult(result: any, opts: { expanded: boolean }, theme: any, context: any) {
	const content = result.content
		.map((part: any) => (part.type === "text" && typeof part.text === "string" ? part.text : ""))
		.join("");
	if (context.isError) return new Text(theme.fg("error", content), 0, 0);
	const styled = content.split("\n").map((line) => theme.fg("toolOutput", line)).join("\n");
	return renderSessionResult(styled, opts.expanded, theme);
}

export default function (pi: ExtensionAPI) {
	// --- Specialized subagents: static instances, registered as native tools. ---
	const finder = new Subagent(FINDER_SPEC);
	pi.registerTool({
		name: "finder",
		label: "Finder",
		description: FINDER_DESCRIPTION,
		parameters: SubagentParams,
		execute: (id, params, signal, onUpdate, ctx) => finder.execute(id, params, signal, onUpdate, ctx),
		renderCall: (args, theme, _context) => finder.renderCall(args, theme),
		renderResult: (result, opts, theme, context) => finder.renderResult(result, opts, theme, context),
	});

	const oracle = new Subagent(ORACLE_SPEC);
	pi.registerTool({
		name: "oracle",
		label: "Oracle",
		description: ORACLE_DESCRIPTION,
		parameters: SubagentParams,
		execute: (id, params, signal, onUpdate, ctx) => oracle.execute(id, params, signal, onUpdate, ctx),
		renderCall: (args, theme, _context) => oracle.renderCall(args, theme),
		renderResult: (result, opts, theme, context) => oracle.renderResult(result, opts, theme, context),
	});

	// --- Inline `task` tool: config is read per call from subagent.json, so a
	// fresh Subagent is constructed each invocation with a runtime-resolved spec.
	// Rendering depends only on result.details (not runtime config), so a shared
	// default instance backs renderCall/renderResult — same pattern as
	// finder/oracle above.
	const defaultTaskInstance = new Subagent({
		name: "task",
		systemPrompt: "",
		noSkills: true,
	});
	const { config: taskInlineConfig } = loadInlineConfig();
	pi.registerTool({
		name: "task",
		label: "Task",
		description: `Perform a task (a sub-task of the user's overall task) using a sub-agent that has access to the following tools: ${taskInlineConfig.tools && taskInlineConfig.tools.length > 0 ? taskInlineConfig.tools.join(", ") : ""}`,
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const { config: inlineConfig, error: configError } = loadInlineConfig();
			if (configError) {
				throw new Error(configError);
			}
			const inlineSpec: SubagentSpec = {
				name: "task",
				systemPrompt: INLINE_BASE_SYSTEM_PROMPT,
				model: inlineConfig.model,
				thinking: inlineConfig.thinking,
				tools: inlineConfig.tools,
				noSkills: inlineConfig.noSkills ?? true,
			};
			const instance = new Subagent(inlineSpec);
			return instance.execute(_toolCallId, params, signal, onUpdate, ctx);
		},

		renderCall: (args, theme) => defaultTaskInstance.renderCall(args, theme),
		renderResult: (result, opts, theme, context) => defaultTaskInstance.renderResult(result, opts, theme, context),
	});

	// --- read_session: read-only viewer for pi session JSONL files. Custom
	// renderResult only self-supplies the call/result separator blank line
	// (ToolExecutionComponent stacks them with no gap); collapsed preview
	// and expansion come from the shared renderSessionResult helper.
	pi.registerTool({
		name: "read_session",
		label: "Read Session",
		description: READ_SESSION_DESCRIPTION,
		parameters: ReadSessionParams,

		// renderCall: bold title + muted session ref (path with $HOME collapsed
		// to ~; id form shown as passed so it stays copyable into a drill
		// tool) plus a short leaf marker when leafId is set.
		renderCall(args, theme, context) {
			const session = typeof args.session === "string" ? args.session : "";
			const leafId = typeof args.leafId === "string" ? args.leafId : "";
			const muted = [session ? shortenPath(session) : "?", leafId ? `leaf=${leafId.slice(0, 8)}` : ""]
				.filter(Boolean)
				.join(" ");
			return drillCallComponent(theme, context, "read_session", muted);
		},
		async execute(_toolCallId, params): Promise<AgentToolResult<ReadSessionDetails>> {
			const { text, details } = await readSession(params.session, params.leafId);
			return { content: [{ type: "text", text }], details };
		},
		renderResult: renderTranscriptResult,
	});

	// --- read_session_compaction: drill into the original content a compaction
	// entry replaced. Same plain-text rendering pattern as read_session
	// (renderTranscriptResult: separator blank line + collapsed preview).
	pi.registerTool({
		name: "read_session_compaction",
		label: "Read Session Compaction",
		description: READ_SESSION_COMPACTION_DESCRIPTION,
		parameters: ReadSessionCompactionParams,
		renderCall: (args, theme, context) => renderDrillCall("read_session_compaction", args, theme, context),

		async execute(_toolCallId, params): Promise<AgentToolResult<ReadSessionCompactionDetails>> {
			const { text, details } = await readSessionCompaction(params.session, params.entryId);
			return { content: [{ type: "text", text }], details };
		},
		renderResult: renderTranscriptResult,
	});

	// --- read_session_entry: drill into the full content of a specific entry
	// (tool result / tool call arguments / bash output — the id= on the
	// matching stub in read_session output). Rendering follows the other
	// session viewers (renderSessionResult: separator blank line + preview).
	pi.registerTool({
		name: "read_session_entry",
		label: "Read Session Entry",
		description: READ_ENTRY_DESCRIPTION,
		parameters: ReadEntryParams,

		async execute(_toolCallId, params): Promise<AgentToolResult<ReadEntryDetails>> {
			const { text, details } = await readSessionEntry(params.session, params.entryId);
			return { content: [{ type: "text", text }], details };
		},

		renderCall: (args, theme, context) => renderDrillCall("read_session_entry", args, theme, context),

		renderResult(result, { expanded }, theme, context) {
			const d = result.details as ReadEntryDetails | undefined;
			const content = result.content
				.map((part) => (part.type === "text" && typeof part.text === "string" ? part.text : ""))
				.join("");
			// Throw path: createErrorToolResult wipes details to {}. Fall back
			// to the raw message, dyed error-colored (no kind to show).
			if (!d?.kind) {
				return new Text(context.isError ? theme.fg("error", content) : content, 0, 0);
			}
			// toolCall gets the compact one-line-per-call preview from details;
			// other kinds render the body as-is.
			const tuiContent = d.kind === "toolCall" ? (d.preview ?? content) : content;
			// No headers anywhere: every kind's content self-identifies (bash
			// `$ command`, toolCall `## toolCall <name>`) or is bare text the
			// caller just saw as a stub (toolResult; callId/(error) add
			// nothing the transcript stub didn't already show). Per-line
			// toolOutput styling; the leading blank line + collapsed preview
			// come from the shared renderSessionResult helper. The
			// `## details` marker line is dimmed: payload separator, not body.
			const styled = tuiContent
				.split("\n")
				.map((line) => (line === "## details" ? theme.fg("dim", line) : theme.fg("toolOutput", line)))
				.join("\n");
			return renderSessionResult(styled, expanded, theme);
		},
	});
}
