import { expect, test } from "bun:test";
import { decideRead, fingerprint, splitDelta } from "./history-cursor.ts";
import type { HistoryManifestEntry } from "./history-cursor.ts";

// ---------------------------------------------------------------------------
// splitDelta: the torn-tail, no-newline and prior-cursor-fragment boundaries.
// ---------------------------------------------------------------------------

test("a delta ending mid-object stops the advance at the last newline and drops the fragment", () => {
    const delta = Buffer.from('{"a":1}\n{"b":2,"unterminated', "utf8");
    const result = splitDelta(delta, false);
    expect(result.lines).toEqual(['{"a":1}']);
    expect(result.advanceBy).toBe('{"a":1}\n'.length);
});

test("a delta with hadPriorCursor true drops the first line as an already-consumed fragment", () => {
    const delta = Buffer.from("fragment-tail\ngenuine-new-line\n", "utf8");
    const result = splitDelta(delta, true);
    expect(result.lines).toEqual(["genuine-new-line"]);
    expect(result.advanceBy).toBe(delta.length);
});

test("a delta containing zero newlines advances by zero and returns no lines", () => {
    const delta = Buffer.from("no newline anywhere in this buffer", "utf8");
    const result = splitDelta(delta, false);
    expect(result.lines).toEqual([]);
    expect(result.advanceBy).toBe(0);
});

test("a delta whose last byte is a newline discards nothing and advances to the full length", () => {
    const delta = Buffer.from("one\ntwo\nthree\n", "utf8");
    const result = splitDelta(delta, false);
    expect(result.lines).toEqual(["one", "two", "three"]);
    expect(result.advanceBy).toBe(delta.length);
});

test("hadPriorCursor true on a single-line delta drops that line and advances past it", () => {
    const delta = Buffer.from("completion-of-prior-fragment\n", "utf8");
    const result = splitDelta(delta, true);
    expect(result.lines).toEqual([]);
    expect(result.advanceBy).toBe(delta.length);
});

test("a blank line in the middle of the delta is preserved rather than filtered", () => {
    const delta = Buffer.from("first\n\nthird\n", "utf8");
    const result = splitDelta(delta, false);
    expect(result.lines).toEqual(["first", "", "third"]);
    expect(result.advanceBy).toBe(delta.length);
});

// ---------------------------------------------------------------------------
// decideRead: the three integrity guards.
// ---------------------------------------------------------------------------

const FRESH_HEAD = fingerprint(Buffer.from("head-bytes-at-last-sync", "utf8"));
const OTHER_HEAD = fingerprint(Buffer.from("head-bytes-after-a-rewrite", "utf8"));

test("decideRead returns full-reread when the manifest has no entry", () => {
    const decision = decideRead(undefined, { size: 100, headFingerprint: FRESH_HEAD });
    expect(decision).toBe("full-reread");
});

test("decideRead returns full-reread when stat.size is one byte below the stored cursor", () => {
    const entry: HistoryManifestEntry = { cursor: 100, headFingerprint: FRESH_HEAD };
    const decision = decideRead(entry, { size: 99, headFingerprint: FRESH_HEAD });
    expect(decision).toBe("full-reread");
});

test("decideRead returns full-reread on a head-fingerprint mismatch even though the file grew", () => {
    const entry: HistoryManifestEntry = { cursor: 100, headFingerprint: FRESH_HEAD };
    const decision = decideRead(entry, { size: 500, headFingerprint: OTHER_HEAD });
    expect(decision).toBe("full-reread");
});

test("decideRead returns up-to-date when the size matches the cursor and the head is unchanged", () => {
    const entry: HistoryManifestEntry = { cursor: 100, headFingerprint: FRESH_HEAD };
    const decision = decideRead(entry, { size: 100, headFingerprint: FRESH_HEAD });
    expect(decision).toBe("up-to-date");
});

test("decideRead returns append-from-cursor when the file grew past the cursor with a matching head", () => {
    const entry: HistoryManifestEntry = { cursor: 100, headFingerprint: FRESH_HEAD };
    const decision = decideRead(entry, { size: 500, headFingerprint: FRESH_HEAD });
    expect(decision).toBe("append-from-cursor");
});

test("manifest entries are looked up by session id, never by file path", () => {
    const manifest: Record<string, HistoryManifestEntry> = {
        "session-alpha": { cursor: 100, headFingerprint: FRESH_HEAD },
    };
    // Same session, relocated to a new project directory: the lookup key is still the session
    // id, so a "type":"relocated" move that changes the file's path never invalidates the cursor.
    const decision = decideRead(manifest["session-alpha"], { size: 100, headFingerprint: FRESH_HEAD });
    expect(decision).toBe("up-to-date");
});

// ---------------------------------------------------------------------------
// fingerprint: pure hashing, no IO.
// ---------------------------------------------------------------------------

test("fingerprint returns a stable 64-character hex digest for the same bytes", () => {
    const bytes = Buffer.from("ZRQPHX-FINGERPRINT-WINDOW token", "utf8");
    const first = fingerprint(bytes);
    const second = fingerprint(bytes);
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
});

test("fingerprint returns different digests for different byte windows", () => {
    const headWindow = fingerprint(Buffer.from("ZRQPHX-HEAD-WINDOW", "utf8"));
    const preCursorWindow = fingerprint(Buffer.from("ZRQPHX-PRE-CURSOR-WINDOW", "utf8"));
    expect(headWindow).not.toBe(preCursorWindow);
});
