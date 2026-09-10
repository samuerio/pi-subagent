/**
 * read_session_entry tool — drill into the full content of a specific entry
 * inside a pi session.
 *
 * `read_session` renders the transcript as compact stubs: tool results as
 * one-line `## toolResult:<name> (id=xxxx, ~size)` stubs (errors keep a short
 * preview), tool calls as `→ name(120-char args preview) [call_xxx] (id=xxxx)` lines, and `!`
 * bash commands as `## bash (exit=N)` blocks with 300-char output
 * previews. The full content behind those stubs — tool results (including
 * `details`, where subagent results keep their full untruncated output),
 * tool call arguments, bash output — is what the agent actually saw, and it
 * is unreachable any other way: session JSONL lines are far too long for the
 * native read tool. This tool takes a stub's `id=` and returns the complete
 * content, untruncated, dispatched on the target entry's kind:
 *
 *   - toolResult message  → full text parts + non-text placeholders +
 *                           `details` rendered as JSON.
 *   - bashExecution message (`!` commands are persisted as plain message
 *     entries by recordBashResult) → `$ command` + the full multiline
 *     output, verbatim (no one-line collapsing, no preview cut).
 *   - assistant message with toolCall parts → each call's name + full
 *     pretty-printed arguments (the counterpart to the 120-char preview).
 *
 * Same discovery → drill pairing as `read_session_compaction`: the stub
 * header formats are the contract between the tools. Notably, subagent tool
 * results carry their full output in `details` (their truncated result text
 * says "Full output preserved in tool details"), so this tool is the model
 * side recovery path for that promise.
 *
 * Strictly read-only (no `SessionManager.open()`); `session` accepts a path
 * or id via `resolveSessionRef`; output is untruncated by design — re-reads
 * of sessions collapse stubs via `formatTranscript`, so size does not
 * compound.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { loadSessionEntries, resolveSessionRef } from "./read-session.ts";

export const READ_ENTRY_DESCRIPTION =
	"Read the full content of a specific entry inside a pi session — the content a read_session " +
	"stub truncates. Pass a session (file path or session id, same rules as read_session) and an " +
	"entry id — the id= on a ## toolResult:<name> (id=xxxx, ~size) stub line, on a → tool-call line " +
	"(→ name(args) [call-xxxx] (id=xxxx)), or in the [truncated, full output: read_session_entry id=xxxx] marker of " +
	"a ## bash (exit=N) block whose output was folded, in read_session " +
	"output or read_session_compaction span output. Returns the complete content dispatched by " +
	"entry kind: toolResult → text parts verbatim, non-text parts as placeholders, and the tool's " +
	"details rendered as JSON when present (subagent results keep their full output in details); " +
	"bashExecution (`!` command) → the command plus its full multiline output; assistant toolCall " +
	"→ each call's full pretty-printed arguments. Untruncated. Read-only.";

export const ReadEntryParams = Type.Object({
	session: Type.String({
		description:
			"Session file path (contains / or \\, or ends .jsonl; ~ expands to the home directory) or a session id (uuid or unambiguous prefix).",
	}),
	entryId: Type.String({
		description:
			"Entry id to drill into. Ids are listed on ## toolResult:<name> (id=xxxx, ~size) stub lines, → tool-call lines (→ name(args) [call-xxxx] (id=xxxx)), and in the [truncated, full output: read_session_entry id=xxxx] marker of folded ## bash (exit=N) blocks in read_session output and read_session_compaction span output.",
	}),
});

export interface ReadEntryDetails {
	path: string;
	entryCount: number;
	/** Resolved entry kind — filled at execute time (renderCall only has the id). */
	kind: "toolResult" | "bashExecution" | "toolCall";
	/** kind=toolResult. */
	tool?: string;
	callId?: string;
	isError?: boolean;
	/** kind=bashExecution. */
	command?: string;
	exitCode?: number;
	/** kind=toolCall. */
	calls?: number;
	/** kind=toolCall. Compact TUI preview lines: `name {json}` per call. */
	preview?: string;
}

type ToolResultAgentMessage = Extract<AgentMessage, { role: "toolResult" }>;
type BashExecutionAgentMessage = Extract<AgentMessage, { role: "bashExecution" }>;
type AssistantAgentMessage = Extract<AgentMessage, { role: "assistant" }>;

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
 * Render the full content of a bashExecution message (`!` command): the
 * command followed by its output verbatim — no whitespace collapsing, no
 * preview cut (read_session's `## bash` block previews only 300 collapsed
 * chars; this is the recovery path for the rest).
 */
function renderBashExecutionContent(msg: BashExecutionAgentMessage): string {
	const blocks = [`$ ${msg.command}`];
	if (msg.output) blocks.push(msg.output);
	return blocks.join("\n\n").trim();
}

/**
 * Render the full toolCall parts of an assistant message: each call's name
 * plus its complete arguments pretty-printed (the counterpart to
 * read_session's 120-char one-line preview).
 */
function renderAssistantToolCallsContent(msg: AssistantAgentMessage): string {
	const blocks: string[] = [];
	for (const part of msg.content) {
		if (part.type !== "toolCall") continue;
		let json: string;
		try {
			json = JSON.stringify(part.arguments, null, 2);
		} catch {
			json = "(unserializable arguments)";
		}
		blocks.push(`## toolCall ${part.name}${part.id ? ` [${part.id}]` : ""}\n${json}`);
	}
	return blocks.join("\n\n").trim();
}

/**
 * Locate the target entry and render its full content verbatim (no envelope:
 * the transcript stub already carries the identity metadata). Dispatches on
 * the entry's kind; throws with a descriptive
 * message for unresolvable session references, unknown ids, and entry kinds
 * with nothing to drill into (user/custom messages are fully rendered by
 * read_session; compaction entries belong to read_session_compaction).
 */
export async function readSessionEntry(
	session: string,
	entryId: string,
): Promise<{ text: string; details: ReadEntryDetails }> {
	const sessionPath = await resolveSessionRef(session);
	const { filePath, entries: sessionEntries } = loadSessionEntries(sessionPath);

	const target = sessionEntries.find((entry) => entry.id === entryId);
	if (!target) {
		throw new Error(
			`read_session_entry: no entry with id "${entryId}" in ${filePath} (${sessionEntries.length} entries). ` +
				"Entry ids are listed on ## toolResult:<name> (id=xxxx, ~size) stub lines, → tool-call lines (→ name(args) [call-xxxx] (id=xxxx)), " +
				"and in the truncation marker of folded ## bash (exit=N) blocks in read_session output.",
		);
	}
	if (target.type !== "message") {
		const hint = target.type === "compaction" ? " Use read_session_compaction for compaction entries." : "";
		throw new Error(
			`read_session_entry: entry "${entryId}" is a ${target.type} entry, not a drillable message entry.${hint}`,
		);
	}
	const msg = target.message;

	let body: string;
	let kind: ReadEntryDetails["kind"];
	let kindDetails: Partial<ReadEntryDetails> = {};
	if (msg.role === "toolResult") {
		const toolMsg: ToolResultAgentMessage = msg;
		body = renderToolResultContent(toolMsg) || "(empty tool result)";
		kind = "toolResult";
		kindDetails = { tool: toolMsg.toolName, callId: toolMsg.toolCallId, isError: toolMsg.isError };
	} else if (msg.role === "bashExecution") {
		const bashMsg: BashExecutionAgentMessage = msg;
		body = renderBashExecutionContent(bashMsg) || "(no output)";
		kind = "bashExecution";
		kindDetails = { command: bashMsg.command, exitCode: bashMsg.exitCode };
	} else if (msg.role === "assistant") {
		const assistantMsg: AssistantAgentMessage = msg;
		body = renderAssistantToolCallsContent(assistantMsg);
		kind = "toolCall";
		if (!body) {
			throw new Error(
				`read_session_entry: assistant entry "${entryId}" carries no tool calls (its text is already rendered in full by read_session).`,
			);
		}
		const calls = assistantMsg.content.filter((part) => part.type === "toolCall").length;
		kindDetails = {
			calls,
			preview: assistantMsg.content
				.filter((part) => part.type === "toolCall")
				.map((part) => `${part.name} ${JSON.stringify(part.arguments)}`)
				.join("\n"),
		};
	} else {
		throw new Error(
			`read_session_entry: entry "${entryId}" is a ${msg.role} message; only toolResult, bashExecution, and assistant-with-toolCalls entries carry drillable content. ` +
				"User and custom messages are already rendered in full by read_session.",
		);
	}

	// No envelope: the caller just saw this entry's stub in the read_session
	// transcript (tool name, call id, command, exit code are all on the stub
	// line / block header), so echoing them back adds nothing. Identity
	// metadata stays in details for TUI/debugging.
	return { text: body, details: { path: filePath, entryCount: sessionEntries.length, kind, ...kindDetails } };
}
