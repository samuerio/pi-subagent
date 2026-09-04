/**
 * read_session tool — read-only viewer for pi session JSONL files.
 *
 * Given a session file path (typically the `session=` path surfaced in a
 * subagent tool result), returns an envelope line plus the resolved
 * transcript: the active-branch entries with compaction applied, projected
 * to messages.
 *
 * Built on the pure parse/build pipeline exported by
 * `@earendil-works/pi-coding-agent` (`parseSessionEntries` →
 * `migrateSessionEntries` → `buildContextEntries` / `buildSessionContext`).
 * No `SessionManager`: `SessionManager.open()` is a live read/write object
 * whose migration may rewrite the file; this tool is strictly read-only.
 *
 * `ctx.messages` elements are AgentMessages dispatched by role. Session
 * entry types are projected by `buildSessionContext`:
 *   message("user"/"assistant"/"toolResult") → same roles,
 *   custom_message → role "custom", compaction → "compactionSummary",
 *   branch_summary → "branchSummary", `!` commands → "bashExecution".
 * Other entry types (custom, label, session_info, ...) do not participate
 * in context and are not rendered.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	buildSessionContext,
	migrateSessionEntries,
	parseSessionEntries,
	type FileEntry,
	type SessionEntry,
	type SessionHeader,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/** Byte cap on the returned transcript (head-truncated, mirroring OUTPUT_CAP). */
const READ_CAP = 50 * 1024;
const TOOL_CALL_ARGS_PREVIEW = 120;
const TOOL_RESULT_ERROR_PREVIEW = 300;
const BASH_OUTPUT_PREVIEW = 300;

export const READ_SESSION_DESCRIPTION =
	"Read a pi session JSONL file and return its resolved transcript. Pass the path to a session " +
	"file, e.g. the session= path reported in a subagent tool result. Returns an envelope line " +
	"(session id, cwd, entry/message counts, thinking level, model) followed by the active-branch " +
	"transcript with compaction applied: user/assistant text, tool calls, error results, and " +
	"compaction/branch summaries. Read-only. Pass leafId to inspect a specific branch tip; omit " +
	"it for the current leaf (the file's last entry).";

export const ReadSessionParams = Type.Object({
	path: Type.String({
		description:
			"Path to a pi session JSONL file (e.g. the session= path from a subagent envelope). ~ expands to the home directory.",
	}),
	leafId: Type.Optional(
		Type.String({
			description:
				"Optional entry id: return the branch ending at this entry instead of the current leaf. Unknown ids fall back to the latest entry.",
		}),
	),
});

export interface ReadSessionDetails {
	path: string;
	entryCount: number;
	messageCount: number;
}

/** Expand a leading `~` to the home directory. */
function expandHome(p: string): string {
	if (p === "~") return os.homedir();
	if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
	return p;
}

/** Concatenate the text parts of a message content (string or parts array). */
function textOf(content: string | Array<{ type: string; text?: string }>): string {
	if (typeof content === "string") return content;
	return content
		.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("");
}

/** One-line, whitespace-collapsed preview. */
function preview(text: string, max: number): string {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > max ? `${line.slice(0, max)}...` : line;
}

function formatToolCallArgs(args: Record<string, unknown>): string {
	let json: string;
	try {
		json = JSON.stringify(args);
	} catch {
		json = "(unserializable arguments)";
	}
	return preview(json, TOOL_CALL_ARGS_PREVIEW);
}

/**
 * Format the resolved transcript. Dispatch on message role — NOT on session
 * entry type (entry types are projected away by buildSessionContext; see the
 * module docblock for the mapping).
 */
function formatTranscript(messages: readonly AgentMessage[]): string {
	const blocks: string[] = [];
	for (const msg of messages) {
		switch (msg.role) {
			case "user": {
				const text = textOf(msg.content).trim();
				if (text) blocks.push(`## user\n${text}`);
				break;
			}
			case "assistant": {
				const lines: string[] = [];
				for (const part of msg.content) {
					if (part.type === "text") {
						const text = part.text.trim();
						if (text) lines.push(text);
					} else if (part.type === "toolCall") {
						lines.push(`→ ${part.name}(${formatToolCallArgs(part.arguments)})`);
					}
					// thinking parts are skipped
				}
				if (lines.length > 0) blocks.push(`## assistant\n${lines.join("\n")}`);
				break;
			}
			case "toolResult": {
				// Normal results are inferable from the toolCall line; only render
				// errors so failures stay visible without bloating the transcript.
				if (msg.isError) {
					const text = textOf(msg.content).trim();
					if (text) blocks.push(`## toolResult:${msg.toolName} (error)\n${preview(text, TOOL_RESULT_ERROR_PREVIEW)}`);
				}
				break;
			}
			case "custom": {
				const text = textOf(msg.content).trim();
				if (text) blocks.push(`## custom:${msg.customType}\n${text}`);
				break;
			}
			case "bashExecution": {
				const output = msg.output ? preview(msg.output, BASH_OUTPUT_PREVIEW) : "";
				blocks.push(`## bash (exit=${msg.exitCode ?? "?"})\n$ ${msg.command}${output ? `\n${output}` : ""}`);
				break;
			}
			case "compactionSummary": {
				blocks.push(`## compactionSummary\n${msg.summary.trim()}`);
				break;
			}
			case "branchSummary": {
				blocks.push(`## branchSummary\n${msg.summary.trim()}`);
				break;
			}
		}
	}
	return blocks.join("\n\n");
}

function truncateTranscript(transcript: string, filePath: string): string {
	const byteLength = Buffer.byteLength(transcript, "utf8");
	if (byteLength <= READ_CAP) return transcript;

	let truncated = transcript.slice(0, READ_CAP);
	while (Buffer.byteLength(truncated, "utf8") > READ_CAP) {
		truncated = truncated.slice(0, -1);
	}
	const omitted = byteLength - Buffer.byteLength(truncated, "utf8");
	return `${truncated}\n\n[Truncated: ${omitted} bytes omitted. Full transcript: ${filePath}]`;
}

/**
 * Parse, migrate, and resolve a session file, then format the envelope +
 * transcript. Throws with a descriptive message when the file is unreadable.
 */
export async function readSession(
	rawPath: string,
	leafId: string | undefined,
): Promise<{ text: string; details: ReadSessionDetails }> {
	const filePath = expandHome(rawPath);

	let content: string;
	try {
		content = fs.readFileSync(filePath, "utf-8");
	} catch (error) {
		throw new Error(`read_session: cannot read ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
	}

	const entries = parseSessionEntries(content);
	// Migrate the FULL entry array first: migrateToCurrentVersion reads the
	// header's version. Migrating a headerless array would assume version 1 and
	// regenerate every entry id (destroying branch structure and
	// firstKeptEntryId references). Then mirror
	// SessionManager.buildContextEntries(): build functions receive entries
	// only, the header is handled separately.
	migrateSessionEntries(entries);
	const header = entries.find((entry): entry is SessionHeader => entry.type === "session");
	const sessionEntries = entries.filter((entry): entry is SessionEntry => entry.type !== "session");

	const context = buildSessionContext(sessionEntries, leafId);
	const envelopeParts = [
		`session=${filePath}`,
		header?.id ? `id=${header.id}` : undefined,
		header?.cwd ? `cwd=${header.cwd}` : undefined,
		`entries=${sessionEntries.length}`,
		`messages=${context.messages.length}`,
		`thinkingLevel=${context.thinkingLevel}`,
		context.model?.provider && context.model?.modelId
			? `model=${context.model.provider}/${context.model.modelId}`
			: undefined,
	].filter((part): part is string => part !== undefined);

	const transcript = formatTranscript(context.messages);
	const body = transcript || "(no messages)";
	const text = `[${envelopeParts.join(" ")}]\n${truncateTranscript(body, filePath)}`;

	return {
		text,
		details: { path: filePath, entryCount: sessionEntries.length, messageCount: context.messages.length },
	};
}
