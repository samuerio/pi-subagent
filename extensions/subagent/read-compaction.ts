/**
 * read_session_compaction tool — reconstruct the exact content a specific
 * compaction entry's summary was derived from.
 *
 * A compaction's summary is `update(previousSummary, newly-expired raw)`, so
 * its input is two things: the previous compaction's summary S(n-1) and the
 * raw messages that just stopped being recent. This tool returns both.
 *
 * Derivation (mirrors pi's repeated-compaction rule, #2608): resolve the live
 * context as it was right before this compaction fired by calling
 * `buildContextEntries(entries, target.parentId)` — the entry just before the
 * compaction is the leaf. That drops the previous compaction's summarized
 * prefix and hoists its summary to the front, yielding
 * [S(n-1)] + [raw up to target.parent]. Then cut off everything at/after the
 * target's `firstKeptEntryId` (its new retained tail, which it did not
 * summarize). What remains is exactly what this compaction folded in.
 *
 * The span is rendered whole through the same `formatTranscript` read_session
 * uses: the previous compaction renders as its native `compactionSummary`
 * block at the top, followed by the raw messages. This is why the
 * intermediate summaries S(1)..S(n-1) are reachable here — each S(k) surfaces
 * exactly once, as the compactionSummary block of compaction C_{k+1}. Output
 * is untruncated (both the summary and the raw are the requested content).
 *
 * Abandoned-branch compactions are not discoverable via `read_session` (only
 * the active branch is resolved) but remain drillable here: the resolution
 * follows `target.parent`'s own parent chain.
 */

import { buildContextEntries, sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { alignAnnotations, formatTranscript, loadSessionEntries, resolveSessionRef } from "./read-session.ts";

export const READ_SESSION_COMPACTION_DESCRIPTION =
	"Reconstruct the content a specific compaction's summary was derived from: the previous " +
	"compaction summary plus the raw messages that compaction summarized. Pass a pi session (file " +
	"path or session id, same rules as read_session) and a compaction entry id (from a compactionSummary " +
	"block header in read_session output). Returns an envelope line (counts, " +
	"span=<firstRawId>..<firstKeptEntryId>) then the previous summary as a compactionSummary " +
	"block, then the raw messages summarized. For the first compaction there is no previous " +
	"summary, so only the raw is returned. Output is not truncated. Read-only.";

export const ReadSessionCompactionParams = Type.Object({
	session: Type.String({
		description:
			"Session file path (contains / or \\, or ends .jsonl; ~ expands to the home directory) or a session id (uuid or unambiguous prefix).",
	}),
	entryId: Type.String({
		description:
			"Compaction entry id to drill into. Ids are listed on compactionSummary block headers in read_session output (id=xxxx tokensBefore=N).",
	}),
});

export interface ReadSessionCompactionDetails {
	path: string;
	/** Raw on-disk entry total (whole session file, before any resolution). */
	entryCount: number;
	/** Messages in the returned body: the previous-summary block(s) + the summarized raw. */
	messageCount: number;
	/** Entries in the cut span (previous compaction + summarized raw), before projection. */
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

	// Reconstruct the live context as it was right before this compaction
	// fired: the entry just before the compaction (target.parentId) is the
	// leaf. buildContextEntries drops the previous compaction's summarized
	// prefix and hoists its summary to the front, giving
	// [S(n-1)] + [raw up to target.parent] — the exact input this compaction's
	// update consumed (the #2608 repeated-compaction rule lives upstream, so
	// we inherit it). Guard the leaf: buildSessionPath silently falls back to
	// the global latest entry for a falsy/unknown leafId, which would resolve
	// the wrong branch.
	if (!target.parentId) {
		throw new Error(
			`read_session_compaction: compaction entry "${target.id}" has no parent entry; cannot resolve the pre-compaction context.`,
		);
	}
	const contextEntries = buildContextEntries(sessionEntries, target.parentId);

	// This compaction kept everything from firstKeptEntryId onward as its new
	// retained tail; that tail is NOT part of what it summarized. Cut it off:
	// keep strictly the entries before firstKeptEntryId (the previous summary +
	// the newly-expired raw). Dangling firstKeptEntryId -> keep everything.
	const cutIdx = contextEntries.findIndex((entry) => entry.id === target.firstKeptEntryId);
	const span = cutIdx >= 0 ? contextEntries.slice(0, cutIdx) : contextEntries;

	// Render the whole span (previous summary + raw) with the same formatter
	// read_session uses; the previous compaction renders as its native
	// compactionSummary block at the top.
	const messages = span.flatMap(sessionEntryToContextMessages);
	const spanText = formatTranscript(messages, alignAnnotations(span, messages));
	const body = spanText || "(no summarized content for this compaction)";

	// The raw entry range this compaction covered, for the envelope span=.
	// Skip the hoisted previous-summary block so the range spans raw entries.
	const firstRaw = span.find((entry) => entry.type !== "compaction");

	const envelopeParts = [
		// No session=/id= echo, same rationale as read_session: the caller
		// passed the ref and can reuse it; the path stays in details.
		header?.cwd ? `cwd=${header.cwd}` : undefined,
		`entries=${sessionEntries.length}`,
		`messages=${messages.length}`,
		`span=${firstRaw?.id ?? "?"}..${target.firstKeptEntryId}`,
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
