/**
 * Subagent extension entry.
 *
 * Registers three native pi tools:
 *   - `finder`  : specialized code-search subagent (baked-in spec).
 *   - `oracle`  : specialized reasoning-advisor subagent (baked-in spec).
 *   - `task`    : inline, general-purpose subagent; config read per-call from
 *                 `~/.pi/agent/subagent.json`. Because finder/oracle are also
 *                 tools, an inline subagent can whitelist them and call them
 *                 from inside its child context (grandchild pi process).
 *
 * The spawn/parse/envelope/render machinery + the standard execute body live
 * in the `Subagent` class (`subagent.ts`); specialized specs + description
 * constants live in `specialized.ts`.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
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
}
