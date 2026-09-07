/**
 * read_session_compaction tool — drill into the original (pre-compaction)
 * content a specific compaction entry replaced.
 *
 * Semantics mirror pi's repeated-compaction rule (official docs +
 * `prepareCompaction`): a compaction summarizes the span from the previous
 * compaction's kept boundary (`firstKeptEntryId`) up to its own
 * `firstKeptEntryId`. This tool renders exactly that span, raw:
 *
 *   - start = `firstKeptEntryId` of the latest compaction entry that precedes
 *     the target on its parent chain (no earlier compaction → path start;
 *     dangling id → the entry right after that compaction, mirroring
 *     `prepareCompaction`'s boundaryStart fallback),
 *   - end (exclusive) = the target's `firstKeptEntryId` (dangling → the
 *     target's own position).
 *
 * The span is rendered entry by entry with `sessionEntryToContextMessages`,
 * with compaction entries explicitly excluded — deliberately NOT re-run
 * through `buildSessionContext`: `sessionEntryToContextMessages` maps a
 * compaction entry to its compactionSummary message, and the span may contain
 * an absorbed previous compaction or an older one that survived inside a kept
 * range. Excluding them keeps the output pure original content with no
 * summary blocks.
 *
 * Partition property: adjacent compactions' spans tile the session history
 * without overlap; the union of all spans plus the current resolved
 * transcript is the complete history. One call covers one compaction
 * generation; no recursion needed. Output is untruncated (the span is the
 * requested raw content; re-reads of sessions collapse tool results via
 * formatTranscript, so size does not compound).
 *
 * Abandoned-branch compactions are not discoverable via `read_session` (only
 * the active branch is resolved) but remain drillable here: the span walk
 * follows the target's own parent chain.
 */

import {
	sessionEntryToContextMessages,
	type CompactionEntry,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { alignAnnotations, formatTranscript, loadSessionEntries, resolveSessionRef } from "./read-session.ts";

export const READ_SESSION_COMPACTION_DESCRIPTION =
	"Read the original (pre-compaction) content that a specific compaction entry replaced. " +
	"Pass a pi session (file path or session id, same rules as read_session) and a compaction " +
	"entry id (from a compactionSummary block header in read_session output). Returns an envelope " +
	"line (session id, counts, " +
	"span=<firstIncludedId>..<firstKeptEntryId>) followed by the raw messages that compaction " +
	"summarized: the span from the previous compaction's kept boundary up to this compaction's " +
	"firstKeptEntryId, rendered without summary blocks (compaction entries inside the span are " +
	"skipped). Adjacent compactions have disjoint spans, so drilling each compaction id recovers " +
	"the full history. Output is not truncated: the span is the raw content, the whole point of " +
	"this tool. Read-only.";

export const ReadSessionCompactionParams = Type.Object({
	session: Type.String({
		description:
			"Session file path (contains / or \\, or ends .jsonl; ~ expands to the home directory) or a session id (uuid or unambiguous prefix, from the id= field of read_session's envelope).",
	}),
	entryId: Type.String({
		description:
			"Compaction entry id to drill into. Ids are listed on compactionSummary block headers in read_session output (id=xxxx tokensBefore=N).",
	}),
});

export interface ReadSessionCompactionDetails {
	path: string;
	entryCount: number;
	messageCount: number;
	spanEntryCount: number;
}

/**
 * Locate the target compaction entry, slice its summarized span off the
 * parent-chain path, render the span raw, and wrap it in an envelope.
 * `session` is a file path or a session id (see resolveSessionRef in
 * read-session.ts). Throws with a descriptive message for unresolvable
 * session references, unknown ids, non-compaction ids, and unreadable files.
 */
export async function readSessionCompaction(
	session: string,
	entryId: string,
): Promise<{ text: string; details: ReadSessionCompactionDetails }> {
	const sessionPath = await resolveSessionRef(session);
	const { filePath, header, entries: sessionEntries } = loadSessionEntries(sessionPath);

	const target = sessionEntries.find((entry) => entry.id === entryId);
	if (!target) {
		throw new Error(
			`read_session_compaction: no entry with id "${entryId}" in ${filePath} (${sessionEntries.length} entries). ` +
				"Compaction ids are listed on compactionSummary block headers in read_session output.",
		);
	}
	if (target.type !== "compaction") {
		throw new Error(`read_session_compaction: entry "${entryId}" is a ${target.type} entry, not a compaction entry.`);
	}

	// Walk the target's parent chain — same semantics as the unexported
	// buildSessionPath (index by id, follow parentId links up to the root,
	// reverse). The target is the leaf of this walk. A dangling parentId ends
	// the walk early, exactly like upstream.
	const byId = new Map(sessionEntries.map((entry) => [entry.id, entry]));
	const path: SessionEntry[] = [];
	let current: SessionEntry | undefined = target;
	while (current) {
		path.push(current);
		current = current.parentId ? byId.get(current.parentId) : undefined;
	}
	path.reverse();
	const targetIdx = path.length - 1;

	// End (exclusive): the target's firstKeptEntryId, falling back to the
	// target's own position when the id dangles or points past the target.
	const k2Idx = path.findIndex((entry) => entry.id === target.firstKeptEntryId);
	const endIdx = k2Idx >= 0 && k2Idx <= targetIdx ? k2Idx : targetIdx;

	// Start: the kept boundary of the latest compaction entry before the target.
	let prevComp: CompactionEntry | undefined;
	for (let i = 0; i < targetIdx; i++) {
		const entry = path[i];
		if (entry.type === "compaction") prevComp = entry;
	}
	let startIdx = 0;
	if (prevComp) {
		const prevCompIdx = path.findIndex((entry) => entry.id === prevComp.id);
		const boundaryIdx = path.findIndex((entry) => entry.id === prevComp.firstKeptEntryId);
		// Dangling boundary → the entry right after that compaction (mirrors
		// prepareCompaction's boundaryStart fallback). Both fallbacks clamp to
		// endIdx so the span is never negative.
		startIdx = boundaryIdx >= 0 && boundaryIdx <= endIdx ? boundaryIdx : prevCompIdx + 1;
		if (startIdx > endIdx) startIdx = endIdx;
	}

	const span = path.slice(startIdx, endIdx);
	const spanEntries = span.filter((entry) => entry.type !== "compaction");
	const messages = spanEntries.flatMap(sessionEntryToContextMessages);

	// Tool result stubs carry their entry ids in span output too (same zip as
	// read_session; on any inconsistency annotations drop, rendering stays).
	const spanText = formatTranscript(messages, alignAnnotations(spanEntries, messages));
	const body = spanText || "(no summarized content for this compaction)";

	const envelopeParts = [
		`session=${filePath}`,
		header?.id ? `id=${header.id}` : undefined,
		header?.cwd ? `cwd=${header.cwd}` : undefined,
		`entries=${sessionEntries.length}`,
		`messages=${messages.length}`,
		`span=${path[startIdx]?.id ?? "?"}..${path[endIdx]?.id ?? "?"}`,
	].filter((part): part is string => part !== undefined);

	const text = `[${envelopeParts.join(" ")}]\n${body}`;

	return {
		text,
		details: {
			path: filePath,
			entryCount: sessionEntries.length,
			messageCount: messages.length,
			spanEntryCount: span.length,
		},
	};
}
