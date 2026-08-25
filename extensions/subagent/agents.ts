/**
 * Agent discovery and configuration
 *
 * Only global (user-level) named agents are supported, configured in
 * `~/.pi/agent/agents/*.md`. Project-local agents are not loaded; the
 * subagent tool's available-agent list always matches this single source.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	thinking?: string;
	systemPrompt: string;
	filePath: string;
	noSkills?: boolean;
}

function loadAgentsFromDir(dir: string): AgentConfig[] {
	const agents: AgentConfig[] = [];

	if (!fs.existsSync(dir)) {
		return agents;
	}

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);

		if (!frontmatter.name || !frontmatter.description) {
			continue;
		}

		const tools = frontmatter.tools
			?.split(",")
			.map((t: string) => t.trim())
			.filter(Boolean);

		const thinking =
			typeof frontmatter.thinking === "string" ? frontmatter.thinking.trim() : undefined;
		const noSkillsRaw = frontmatter.noSkills;
		const noSkills =
			typeof noSkillsRaw === "boolean"
				? noSkillsRaw
				: typeof noSkillsRaw === "string"
					? noSkillsRaw.trim().toLowerCase() === "true"
					: undefined;
		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			tools: tools && tools.length > 0 ? tools : undefined,
			model: frontmatter.model,
			thinking: thinking || undefined,
			systemPrompt: body,
			filePath,
			noSkills,
		});
	}

	return agents;
}

/**
 * Discover global named agents from `~/.pi/agent/agents/*.md`.
 *
 * Result is sorted by name for deterministic output so the rendered
 * available-agents list is stable across sessions regardless of filesystem
 * readdir order.
 */
export function discoverAgents(): AgentConfig[] {
	const userDir = path.join(getAgentDir(), "agents");
	const agents = loadAgentsFromDir(userDir);
	return agents.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Render the named-agents section injected into the system prompt.
 *
 * Deterministic: input is sorted by name, no dynamic values. Returns an empty
 * string for an empty list so the caller can skip injection entirely.
 */
export function renderAgentsSection(agents: AgentConfig[]): string {
	if (agents.length === 0) return "";
	const blocks = agents
		.slice()
		.sort((a, b) => a.name.localeCompare(b.name))
		.map((a) => `  <agent>\n    <name>${a.name}</name>\n    <description>${a.description}</description>\n  </agent>`)
		.join("\n");
	return [
		"## Named Subagents",
		"The `subagent` tool can delegate to named agents, each running in an isolated context. Pass `agent: \"<name>\"` with a `task` to use one.",
		"",
		"<available_agents>",
		blocks,
		"</available_agents>",
	].join("\n");
}
