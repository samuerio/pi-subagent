/**
 * read_session tool — read-only viewer for pi session JSONL files.
 *
 * Given a session reference (file path or session id — pi CLI's
 * `--session <path|id>` semantics, see `resolveSessionRef`), returns an
 * envelope line plus the resolved
 * transcript: the active-branch entries with compaction applied, projected
 * to messages.
 *
 * Built on the pure parse/build pipeline exported by
 * `@earendil-works/pi-coding-agent` (`parseSessionEntries` →
 * `migrateSessionEntries` → `buildContextEntries` / `buildSessionContext`).
 * `SessionManager.open()` is never used: it is a live read/write object whose
 * migration may rewrite the file. The only SessionManager surface here is the
 * static read-only metadata lookup `list`/`listAll` inside
 * `resolveSessionRef` (session id → path, mirroring the CLI's
 * `--session <path|id>`); this tool is strictly read-only.
 *
 * `ctx.messages` elements are AgentMessages dispatched by role. Session
 * entry types are projected by `buildSessionContext`:
 *   message("user"/"assistant"/"toolResult") → same roles,
 *   custom_message → role "custom", compaction → "compactionSummary",
 *   branch_summary → "branchSummary", `!` commands → "bashExecution".
 * Other entry types (custom, label, session_info, ...) do not participate
 * in context and are not rendered.
 *
 * Compaction/branch entry ids are re-attached to the rendered output: every
 * compactionSummary block header carries `id=` + `tokensBefore=` and every
 * branchSummary header carries `fromId=`. The ids are recovered by zipping
 * the resolved message list against the resolved entry list
 * (`buildContextEntries` + `sessionEntryToContextMessages` — the same
 * projection `buildSessionContext` uses, so alignment is exact). They are the
 * handles `read_session_compaction` needs to drill into the original content
 * a compaction replaced; tool result ids are the handles
 * `read_session_tool_result` needs to drill into a tool's full output.
 *
 * Shared helpers (`expandHome`, `loadSessionEntries`, `formatTranscript`)
 * are exported for `read-compaction.ts`, which renders
 * the pre-compaction span of a specific compaction entry. No separate
 * session-io module at this package size (see
 * .pi/spec/20260906-122510-read-session-compaction/plan.md).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	buildContextEntries,
	buildSessionContext,
	SessionManager,
	migrateSessionEntries,
	parseSessionEntries,
	sessionEntryToContextMessages,
	type FileEntry,
	type SessionEntry,
	type SessionHeader,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const TOOL_CALL_ARGS_PREVIEW = 120;
const TOOL_RESULT_ERROR_PREVIEW = 300;
const BASH_OUTPUT_PREVIEW = 300;

export const READ_SESSION_DESCRIPTION =
	"Read a pi session JSONL file and return its resolved transcript. Pass a session file path (~ " +
	"expands) or a session id (pi --session semantics: exact id first, then prefix match — current " +
	"project tier before global, most recently modified wins on prefix ambiguity). Id lookup only " +
	"covers sessions under ~/.pi/agent/sessions/<project>/; sessions outside that layout (e.g. " +
	"subagent sessions) are only reachable by path, which a subagent envelope reports as session=. " +
	"Returns an envelope line " +
	"(session id, cwd, entry/message counts, thinking level, model) followed by the active-branch " +
	"transcript with compaction applied: user/assistant text, tool calls, error results, and " +
	"compaction/branch summaries. compactionSummary block headers carry the compaction entry id " +
	"(id=xxxx tokensBefore=N) and branchSummary headers carry fromId=; pass a compaction id to " +
	"read_session_compaction to read the original content that compaction replaced. Tool results render as one-line stubs " +
	"carrying their entry id (## toolResult:<name> (id=xxxx)); pass that id to read_session_tool_result to read the " +
	"full content. Read-only. " +
	"Pass leafId to inspect a specific branch tip; omit it for the current leaf (the file's last " +
	"entry).";

export const ReadSessionParams = Type.Object({
	session: Type.String({
		description:
			"Session file path (contains / or \\, or ends .jsonl; ~ expands to the home directory) or a session id (uuid or unambiguous prefix, from the id= field of read_session's envelope).",
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
export function expandHome(p: string): string {
	if (p === "~") return os.homedir();
	if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
	return p;
}

/**
 * Resolve a `session` argument — path or session id — to a session JSONL
 * path. Semantics mirror the pi CLI's `--session <path|id>`
 * (resolveSessionPath):
 *
 *   - Path form (contains "/" or "\", or ends ".jsonl"): tilde-expanded and
 *     resolved against the process cwd.
 *   - Id form: exact match first, then prefix match, against the current
 *     project's session dir (`SessionManager.list(cwd)`) and then all
 *     projects (`SessionManager.listAll()`). Both lists sort by modified time
 *     descending, so a prefix match resolves to the most recently modified
 *     hit (first match) — same as the CLI.
 *
 * The id search only covers the default sessions root's first level
 * (`~/.pi/agent/sessions/<project>/*.jsonl`), exactly like the CLI. Sessions
 * nested deeper (subagent sessions live at
 * `sessions/<tool>/<runId>/*.jsonl`) are out of scope by design: the caller
 * passes their path (a subagent envelope reports it as `session=`).
 */
export async function resolveSessionRef(ref: string, toolName: string): Promise<string> {
	if (ref.includes("/") || ref.includes("\\") || ref.endsWith(".jsonl")) {
		return path.resolve(expandHome(ref));
	}

	const matchId = (sessions: readonly { id: string; path: string }[]) =>
		sessions.find((s) => s.id === ref) ?? sessions.find((s) => s.id.startsWith(ref));

	const localMatch = matchId(await SessionManager.list(process.cwd()));
	if (localMatch) return localMatch.path;
	const globalMatch = matchId(await SessionManager.listAll());
	if (globalMatch) return globalMatch.path;

	throw new Error(
		`${toolName}: no session found for "${ref}". Session ids come from the id= field of read_session's envelope. ` +
			"Id lookup only covers sessions under ~/.pi/agent/sessions/<project>/; for sessions outside that layout " +
			"(e.g. subagent sessions), pass the .jsonl path instead.",
	);
}

/** Concatenate the text parts of a message content (string or parts array). */
export function textOf(content: string | Array<{ type: string; text?: string }>): string {
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
export function formatTranscript(
	messages: readonly AgentMessage[],
	annotations: ReadonlyMap<number, string> = new Map(),
): string {
	const blocks: string[] = [];
	for (const [index, msg] of messages.entries()) {
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
				// Every result renders a one-line stub carrying its entry id —
				// the drill handle for read_session_tool_result. Errors
				// additionally keep a short preview so failures stay visible
				// inline. No annotation (zip dropped) → no stub, as before.
				const note = annotations.get(index);
				if (msg.isError) {
					const text = textOf(msg.content).trim();
					blocks.push(
						`## toolResult:${msg.toolName} (error${note ? `, ${note}` : ""})${text ? `\n${preview(text, TOOL_RESULT_ERROR_PREVIEW)}` : ""}`,
					);
				} else if (note) {
					blocks.push(`## toolResult:${msg.toolName} (${note})`);
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
				const note = annotations.get(index);
				blocks.push(`## compactionSummary${note ? ` (${note})` : ""}\n${msg.summary.trim()}`);
				break;
			}
			case "branchSummary": {
				const note = annotations.get(index);
				blocks.push(`## branchSummary${note ? ` (${note})` : ""}\n${msg.summary.trim()}`);
				break;
			}
		}
	}
	return blocks.join("\n\n");
}

/**
 * Read a session JSONL file, parse, migrate to the current version, and split
 * the header from the entry array. Shared by `read_session` and
 * `read_session_compaction`. Throws with a tool-prefixed message when the file
 * is unreadable.
 */
export function loadSessionEntries(
	rawPath: string,
	toolName: string,
): { filePath: string; header: SessionHeader | undefined; entries: SessionEntry[] } {
	const filePath = expandHome(rawPath);

	let content: string;
	try {
		content = fs.readFileSync(filePath, "utf-8");
	} catch (error) {
		throw new Error(`${toolName}: cannot read ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
	}

	const parsed = parseSessionEntries(content);
	// Migrate the FULL entry array first: migrateToCurrentVersion reads the
	// header's version. Migrating a headerless array would assume version 1 and
	// regenerate every entry id (destroying branch structure and
	// firstKeptEntryId references). Then mirror
	// SessionManager.buildContextEntries(): build functions receive entries
	// only, the header is handled separately.
	migrateSessionEntries(parsed);
	const header = parsed.find((entry): entry is SessionHeader => entry.type === "session");
	const entries = parsed.filter((entry): entry is SessionEntry => entry.type !== "session");
	return { filePath, header, entries };
}

/**
 * Re-attach compaction/branch entry ids to resolved messages. Zips the
 * resolved entry list against the message list through the same deterministic
 * projection `buildSessionContext` uses
 * (`buildContextEntries(...).flatMap(sessionEntryToContextMessages)` — every
 * entry yields 0/1 messages in order), so alignment is exact even across
 * branches and duplicate texts.
 *
 * compactionSummary messages get `id=` + `tokensBefore=`; branchSummary
 * messages get `fromId=`; toolResult messages get `id=` (the drill handle
 * for read_session_tool_result, rendered as a one-line stub). Everything
 * else is only consistency-checked.
 * Purely defensive against upstream projection changes: on ANY inconsistency
 * (count or entry-type/message-role pair) drop all annotations rather than
 * risk stamping a wrong id.
 */
export function alignAnnotations(
	entries: readonly SessionEntry[],
	messages: readonly AgentMessage[],
): ReadonlyMap<number, string> {
	const annotations = new Map<number, string>();
	let msgIdx = 0;
	for (const entry of entries) {
		for (const msg of sessionEntryToContextMessages(entry)) {
			let note: string | undefined;
			switch (entry.type) {
				case "compaction":
					if (msg.role !== "compactionSummary") return new Map();
					note = `id=${entry.id} tokensBefore=${entry.tokensBefore}`;
					break;
				case "branch_summary":
					if (msg.role !== "branchSummary") return new Map();
					note = `fromId=${entry.fromId}`;
					break;
				case "message":
					if (msg.role !== "user" && msg.role !== "assistant" && msg.role !== "toolResult") return new Map();
					// Tool results carry their entry id: the drill handle for
					// read_session_tool_result.
					if (msg.role === "toolResult") note = `id=${entry.id}`;
					break;
				case "custom_message":
					if (msg.role !== "custom") return new Map();
					break;
				default:
					// custom/label/session_info/model_change/thinking_level_change
					// entries project to zero messages; any output here means the
					// projection semantics changed and the zip cannot be trusted.
					return new Map();
			}
			if (note) annotations.set(msgIdx, note);
			msgIdx++;
		}
	}
	return msgIdx === messages.length ? annotations : new Map();
}

/**
 * Parse, migrate, and resolve a session file, then format the envelope +
 * transcript. `session` is a file path or a session id (see
 * `resolveSessionRef`). Throws with a descriptive message when the reference
 * does not resolve or the file is unreadable.
 */
export async function readSession(
	session: string,
	leafId: string | undefined,
): Promise<{ text: string; details: ReadSessionDetails }> {
	const sessionPath = await resolveSessionRef(session, "read_session");
	const { filePath, header, entries: sessionEntries } = loadSessionEntries(sessionPath, "read_session");

	const context = buildSessionContext(sessionEntries, leafId);
	const annotations = alignAnnotations(buildContextEntries(sessionEntries, leafId), context.messages);
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

	const transcript = formatTranscript(context.messages, annotations);
	const text = `[${envelopeParts.join(" ")}]\n${transcript || "(no messages)"}`;

	return {
		text,
		details: { path: filePath, entryCount: sessionEntries.length, messageCount: context.messages.length },
	};
}
