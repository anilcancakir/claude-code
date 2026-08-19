import { createHash } from "node:crypto";

/**
 * One row of the incremental-sync manifest for a single Claude Code transcript FILE.
 *
 * `cursor` is the byte offset the last sync consumed up to; it always sits exactly after a
 * complete newline, never at `stat.size`, because a byte past the last newline may be a torn,
 * in-progress line. `headFingerprint` hashes a fixed-size window at the start of the file, so a
 * truncate-then-rewrite that happens to land back on a size at or above `cursor` is still caught
 * even though the size check alone would have missed it.
 *
 * The manifest holding these entries is keyed per FILE, never per session. Both halves of that are
 * measured. A session id names several files: a subagent transcript's lines carry their parent's
 * session id (12 of 12 sampled files), and a main session's uuid is not unique across project
 * directories either (one live case, `3e19ee0b-d0bb-4aa1-9052-6ed71f290745.jsonl`, present under two
 * project directories at 6,082,328 and 29,622 bytes). Since a byte cursor only means anything
 * against one file's bytes, sharing a row between files either re-reads them forever or reads from
 * an offset that lands mid-line in the other file. `history-sync.ts` derives the key as the
 * transcript's path relative to the walked root.
 */
export interface HistoryManifestEntry {
    readonly cursor: number;
    readonly headFingerprint: string;
}

/**
 * The read-time probe a caller supplies for one file: its current size plus a freshly computed
 * head fingerprint. Kept separate from `fs.Stat` because this module performs no IO of its own;
 * the caller stats the file and hashes its own head window before calling {@link decideRead}.
 */
export interface HistoryReadStat {
    readonly size: number;
    readonly headFingerprint: string;
}

/** The three ways a sync pass can treat one session file, decided without touching the disk. */
export type ReadDecision = "up-to-date" | "append-from-cursor" | "full-reread";

/**
 * Chooses how much of a session file the caller needs to read this pass.
 *
 * Three integrity guards force a `full-reread`, each catching a way the stored cursor can no
 * longer be trusted:
 * 1. No manifest entry: the file has never been ingested, so there is nothing to append from.
 * 2. `stat.size` is less than `entry.cursor`: the file shrank (truncated, rotated, replaced),
 *    so appending from the old cursor would read past the new end or read the wrong bytes.
 * 3. `stat.headFingerprint` no longer matches `entry.headFingerprint`: the file's identity
 *    changed even though it may have grown, most plausibly a truncate-then-rewrite that lands on
 *    a size at or above the old cursor. Size alone cannot detect this; the head fingerprint can.
 *
 * Otherwise the file is either unchanged (`up-to-date`, same size) or has grown with its head
 * intact (`append-from-cursor`, safe to read only the delta).
 */
export function decideRead(entry: HistoryManifestEntry | undefined, stat: HistoryReadStat): ReadDecision {
    // 1. No prior entry: nothing to append from.
    if (entry === undefined) {
        return "full-reread";
    }

    // 2. Shrank below the stored cursor: truncated, rotated, or replaced.
    if (stat.size < entry.cursor) {
        return "full-reread";
    }

    // 3. Head fingerprint mismatch: the file's identity changed even though it may have grown.
    if (stat.headFingerprint !== entry.headFingerprint) {
        return "full-reread";
    }

    // 4. Same size, same head: nothing new since the last sync.
    if (stat.size === entry.cursor) {
        return "up-to-date";
    }

    // 5. Grew past the cursor with a matching head: safe to read only the new tail.
    return "append-from-cursor";
}

/** The complete lines recovered from a delta buffer, plus how many bytes the cursor should advance by. */
export interface SplitDeltaResult {
    readonly lines: readonly string[];
    readonly advanceBy: number;
}

/**
 * Splits the bytes read from a session file's cursor onward into complete lines, discarding
 * anything after the last newline so a torn, still-being-written final line is never parsed and
 * never counted as consumed.
 *
 * `hadPriorCursor` marks a delta whose read start was not the true start of the file: its first
 * line is a fragment carried over from a boundary that already got indexed at an earlier sync
 * (for instance a pre-cursor integrity window read in the same syscall as the new bytes), and
 * must be dropped rather than re-parsed or double-indexed. A delta with no newline at all has no
 * complete line to offer and advances by zero, leaving the cursor untouched until more bytes
 * arrive.
 */
export function splitDelta(buffer: Buffer, hadPriorCursor: boolean): SplitDeltaResult {
    // 1. Find the last newline; everything after it is an in-progress line that must be left
    //    for the next read rather than parsed or skipped now.
    const lastNewlineIndex = buffer.lastIndexOf(0x0a);
    if (lastNewlineIndex === -1) {
        return { lines: [], advanceBy: 0 };
    }

    // 2. Decode only the complete portion. Slicing before the final newline (rather than
    //    filtering a trailing empty string after splitting) keeps a genuine blank line in the
    //    middle of the delta intact.
    const complete = buffer.subarray(0, lastNewlineIndex + 1).toString("utf8");
    const lines = complete.split("\n").slice(0, -1);

    // 3. A prior cursor means this delta's first line is a fragment already accounted for by
    //    the previous sync, not a new record.
    const usableLines = hadPriorCursor ? lines.slice(1) : lines;

    return { lines: usableLines, advanceBy: lastNewlineIndex + 1 };
}

/**
 * Hashes a byte window with SHA-256 and returns its hex digest.
 *
 * This function performs no windowing itself: the caller reads exactly the bytes it wants
 * fingerprinted (a 64 KB head window when first ingesting a file, a 4 KB window preceding the
 * cursor when verifying an append is safe) and passes that buffer straight through. A file
 * smaller than the requested window simply yields fewer bytes to hash; there is no separate
 * "short file" case for this function to handle.
 */
export function fingerprint(bytes: Buffer | Uint8Array): string {
    return createHash("sha256").update(bytes).digest("hex");
}
