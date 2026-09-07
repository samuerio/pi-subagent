/**
 * read_session_tool_result tool — drill into the full content of a specific
 * tool result inside a pi session.
 *
 * `read_session` renders every tool result as a one-line stub
 * (`## toolResult:<name> (id=<entryId>)`; errors additionally keep a short
 * preview), so transcripts stay compact. The full content — bash output, file
 * reads, error text, tool `details` — is what the agent actually saw, and it
 * is unreachable any other way: session JSONL lines are far too long for the
 * native read tool. This tool takes that `id=` and returns the complete
 * content, untruncated.
 *
 * Same discovery → drill pairing as `read_session_compaction`: the stub
 * header format is the contract between the tools. Notably, subagent tool
 * results carry their full output in `details` (their truncated result text
 * says "Full output preserved in tool details"), so this tool is the model
 * side recovery path for that promise.
 *
 * Strictly read-only (no `SessionManager.open()`); `session` accepts a path
 * or id via `resolveSessionRef`; output is untruncated by design — re-reads
 * of sessions collapse tool results via `formatTranscript`, so size does not
 * compound.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { loadSessionEntries, resolveSessionRef } from "./read-session.ts";

export const READ_TOOL_RESULT_DESCRIPTION =
	"Read the full content of a specific tool result inside a pi session. Pass a session (file " +
	"path or session id, same rules as read_session) and a tool result entry id — the id= on a " +
	"## toolResult:<name> (id=xxxx) stub line in read_session output or read_session_compaction " +
	"span output. Returns an envelope line (session path, id, tool=, callId=, isError=) followed " +
	"by the complete result content: text parts verbatim, non-text parts as placeholders, and " +
	"the tool's details rendered as JSON when present (subagent results keep their full output " +
	"in details). Untruncated. Read-only.";

export const ReadToolResultParams = Type.Object({
	session: Type.String({
		description:
			"Session file path (contains / or \\, or ends .jsonl; ~ expands to the home directory) or a session id (uuid or unambiguous prefix, from the id= field of read_session's envelope).",
	}),
	entryId: Type.String({
		description:
			"Tool result entry id to drill into. Ids are listed on ## toolResult:<name> (id=xxxx) stub lines in read_session output and read_session_compaction span output.",
	}),
});

export interface ReadToolResultDetails {
	path: string;
	entryCount: number;
}

type ToolResultAgentMessage = Extract<AgentMessage, { role: "toolResult" }>;

/**
 * Render the full content of a tool result message: text parts verbatim,
 * non-text parts as bracketed placeholders, then `details` as pretty-printed
 * JSON when present (details carry e.g. a subagent's full untruncated output).
 */
function renderToolResultContent(msg: ToolResultAgentMessage): string {
	const blocks: string[] = [];
	for (const part of msg.content) {
		if (part.type === "text") blocks.push(part.text);
		else if (part.type === "image") blocks.push("[image part omitted]");
		else blocks.push("[unknown part]");
	}
	if (msg.details !== undefined) {
		let json: string;
		try {
			json = JSON.stringify(msg.details, null, 2);
		} catch {
			json = "(unserializable details)";
		}
		blocks.push(`## details\n${json}`);
	}
	return blocks.join("\n\n").trim();
}

/**
 * Locate the target tool result entry and render its full content, wrapped in
 * an envelope. Throws with a descriptive message for unresolvable session
 * references, unknown ids, and non-tool-result ids.
 */
export async function readSessionToolResult(
	session: string,
	entryId: string,
): Promise<{ text: string; details: ReadToolResultDetails }> {
	const sessionPath = await resolveSessionRef(session);
	const { filePath, header, entries: sessionEntries } = loadSessionEntries(sessionPath);

	const target = sessionEntries.find((entry) => entry.id === entryId);
	if (!target) {
		throw new Error(
			`read_session_tool_result: no entry with id "${entryId}" in ${filePath} (${sessionEntries.length} entries). ` +
				"Tool result ids are listed on ## toolResult:<name> (id=xxxx) stub lines in read_session output.",
		);
	}
	if (target.type !== "message") {
		const hint = target.type === "compaction" ? " Use read_session_compaction for compaction entries." : "";
		throw new Error(`read_session_tool_result: entry "${entryId}" is a ${target.type} entry, not a tool result entry.${hint}`);
	}
	if (target.message.role !== "toolResult") {
		throw new Error(
			`read_session_tool_result: entry "${entryId}" is a ${target.message.role} message entry, not a tool result entry.`,
		);
	}
	const msg: ToolResultAgentMessage = target.message;

	const body = renderToolResultContent(msg) || "(empty tool result)";
	const envelopeParts = [
		`session=${filePath}`,
		header?.id ? `id=${header.id}` : undefined,
		header?.cwd ? `cwd=${header.cwd}` : undefined,
		`tool=${msg.toolName}`,
		`callId=${msg.toolCallId}`,
		`isError=${msg.isError}`,
		`entries=${sessionEntries.length}`,
	].filter((part): part is string => part !== undefined);

	const text = `[${envelopeParts.join(" ")}]\n${body}`;
	return { text, details: { path: filePath, entryCount: sessionEntries.length } };
}
