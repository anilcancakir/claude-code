import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, rmSync as removeFile, statSync, utimesSync } from "node:fs";
import { readFile as readFileAsync } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncArchive } from "./history-sync.ts";
import type { HistorySyncDeps } from "./history-sync.ts";
import { appendToFixture, buildFixtureCorpus } from "./history-fixtures.ts";
import type { DistillRow } from "./history-distill.ts";
import type { HistoryManifestEntry } from "./history-cursor.ts";
import type {
    HistoryIngestRequest,
    HistoryIngestResult,
    HistoryQuarantineEntry,
    HistorySessionRecord,
    HistoryStore,
} from "./history-store.ts";

const roots: string[] = [];

function freshRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "ac-history-sync-"));
    roots.push(root);
    return root;
}

afterEach(() => {
    while (roots.length > 0) {
        const root = roots.pop();
        if (root !== undefined) {
            rmSync(root, { force: true, recursive: true });
        }
    }
});

/**
 * The observable state a fake `HistoryStore` accumulates, so a test can inspect exactly what
 * `syncArchive` handed it without any sqlite in the process, per this suite's `bun test` ban.
 */
interface FakeStoreState {
    readonly manifest: Map<string, HistoryManifestEntry>;
    readonly rows: DistillRow[];
    readonly quarantine: HistoryQuarantineEntry[];
    readonly sessions: Map<string, HistorySessionRecord>;
    readonly ingestCalls: HistoryIngestRequest[];
}

/** A minimal in-memory stand-in for `HistoryStore`, deduplicating rows on `id` the way `INSERT OR IGNORE` does. */
function createFakeStore(): { readonly store: HistoryStore; readonly state: FakeStoreState } {
    const state: FakeStoreState = {
        manifest: new Map(),
        rows: [],
        quarantine: [],
        sessions: new Map(),
        ingestCalls: [],
    };
    const seenRowIds = new Set<string>();

    const store: HistoryStore = {
        databasePath: ":memory:",
        schemaVersion: 1,
        writable: true,
        getManifestEntry(transcriptKey: string): HistoryManifestEntry | undefined {
            return state.manifest.get(transcriptKey);
        },
        ingest(request: HistoryIngestRequest): HistoryIngestResult {
            state.ingestCalls.push(request);

            let rowsAdded = 0;
            for (const row of request.rows) {
                if (seenRowIds.has(row.id)) {
                    continue;
                }
                seenRowIds.add(row.id);
                state.rows.push(row);
                rowsAdded += 1;
            }

            const quarantineList = request.quarantined ?? [];
            state.quarantine.push(...quarantineList);

            if (request.session !== undefined) {
                state.sessions.set(request.session.sessionId, request.session);
            }

            state.manifest.set(request.transcriptKey, {
                cursor: request.cursor,
                headFingerprint: request.headFingerprint,
            });

            return {
                rowsAdded,
                rowsIgnored: request.rows.length - rowsAdded,
                quarantined: quarantineList.length,
                redactions: {},
                skipped: false,
                busy: false,
            };
        },
        upsertSession(record: HistorySessionRecord): void {
            state.sessions.set(record.sessionId, record);
        },
        lookupSessions(sessionIds: readonly string[]): Map<string, HistorySessionRecord> {
            const result = new Map<string, HistorySessionRecord>();
            for (const id of sessionIds) {
                const found = state.sessions.get(id);
                if (found !== undefined) {
                    result.set(id, found);
                }
            }
            return result;
        },
        select(): [] {
            return [];
        },
        forget() {
            return { turnsRemoved: 0, sessionsRemoved: 0, quarantineRemoved: 0, busy: false };
        },
        close(): void {},
    };

    return { store, state };
}

// ---------------------------------------------------------------------------
// Row counts against the fixture's declared expectations
// ---------------------------------------------------------------------------

test("a full sync over the fixture corpus produces exactly the row counts buildFixtureCorpus declares", async () => {
    const corpus = buildFixtureCorpus(freshRoot());
    const { store, state } = createFakeStore();

    const report = await syncArchive({ root: corpus.root, store });

    const proseRows = state.rows.filter((row) => row.kind === "prose").length;
    const toolUseRows = state.rows.filter((row) => row.kind === "tool_use").length;
    const errorRows = state.rows.filter((row) => row.kind === "tool_error").length;

    expect(proseRows).toBe(corpus.expected.proseRows);
    expect(toolUseRows).toBe(corpus.expected.toolUseRows);
    expect(errorRows).toBe(corpus.expected.errorRows);
    expect(state.quarantine.length).toBe(corpus.expected.quarantineRows);
    expect(report.filesScanned).toBe(3);
    expect(report.rowsAdded).toBe(proseRows + toolUseRows + errorRows);
});

test("a subagent row is labelled with the agentType from its sibling meta.json", async () => {
    const corpus = buildFixtureCorpus(freshRoot());
    const { store, state } = createFakeStore();

    await syncArchive({ root: corpus.root, store });

    const subagentRows = state.rows.filter((row) => row.isSubagent);
    expect(subagentRows.length).toBeGreaterThan(0);
    for (const row of subagentRows) {
        expect(row.agentType).toBe("ac:librarian");
    }
});

// ---------------------------------------------------------------------------
// Manifest keying: a main transcript and its nested subagent must not clobber each other's cursor
// ---------------------------------------------------------------------------

test("a main session and its nested subagent transcript advance independent manifest cursors", async () => {
    const corpus = buildFixtureCorpus(freshRoot());
    const { store } = createFakeStore();

    await syncArchive({ root: corpus.root, store });

    const mainEntry = store.getManifestEntry(corpus.mainSessionId);
    const subagentEntry = store.getManifestEntry(corpus.subagentId);

    expect(mainEntry).toBeDefined();
    expect(subagentEntry).toBeDefined();
    expect(mainEntry?.cursor ?? 0).toBeGreaterThan(0);
    expect(subagentEntry?.cursor ?? 0).toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------
// No-change pass: zero rows added, no change reported
// ---------------------------------------------------------------------------

test("running syncArchive twice with nothing changed between adds zero rows and reports no change", async () => {
    const corpus = buildFixtureCorpus(freshRoot());
    const { store } = createFakeStore();

    const first = await syncArchive({ root: corpus.root, store });
    expect(first.rowsAdded).toBeGreaterThan(0);
    expect(first.changed).toBe(true);

    const second = await syncArchive({ root: corpus.root, store });
    expect(second.rowsAdded).toBe(0);
    expect(second.changed).toBe(false);
});

// ---------------------------------------------------------------------------
// Append path: only the delta is ingested, read as a true byte-range delta rather than a
// full re-read (a full re-read would also show zero *new* rows thanks to `INSERT OR IGNORE`,
// so the assertion below checks the actual byte range requested, not just the row count).
// ---------------------------------------------------------------------------

test("appending new lines between two syncs ingests only the delta, reading from the prior cursor onward", async () => {
    const corpus = buildFixtureCorpus(freshRoot());
    const { store } = createFakeStore();

    const reads: Array<{ path: string; start: number; end: number }> = [];
    const fsDeps: HistorySyncDeps = {
        readFileRange: async (path: string, start: number, end: number): Promise<Buffer> => {
            reads.push({ path, start, end });
            const whole = await readFileAsync(path);
            return whole.subarray(start, end);
        },
    };

    await syncArchive({ root: corpus.root, store, fs: fsDeps });
    const firstCursor = store.getManifestEntry(corpus.projectBSessionId)?.cursor;
    const sizeBeforeAppend = statSync(corpus.projectBSessionPath).size;
    expect(firstCursor).toBe(sizeBeforeAppend);

    appendToFixture(corpus.projectBSessionPath, [
        JSON.stringify({
            type: "user",
            uuid: "00000000-0000-4000-8000-0000000009f1",
            sessionId: corpus.projectBSessionId,
            timestamp: "2026-08-01T00:00:00.000Z",
            message: { role: "user", content: "ZRQPHX-PROJECT-B-APPENDED token, added between two syncs" },
        }),
    ]);
    const sizeAfterAppend = statSync(corpus.projectBSessionPath).size;

    reads.length = 0;
    const secondReport = await syncArchive({ root: corpus.root, store, fs: fsDeps });

    expect(secondReport.rowsAdded).toBe(1);
    expect(store.getManifestEntry(corpus.projectBSessionId)?.cursor).toBe(sizeAfterAppend);

    // The direct proof this is a delta read, not a full re-read that happens to add zero new
    // rows thanks to `INSERT OR IGNORE`: some read for this file must start exactly at the
    // PRIOR cursor (a strictly positive byte offset for this fixture), not at byte zero.
    const deltaRead = reads.find(
        (read) => read.path === corpus.projectBSessionPath && read.start === firstCursor,
    );
    expect(firstCursor).toBeGreaterThan(0);
    expect(deltaRead).toBeDefined();
    expect(deltaRead?.end).toBe(sizeAfterAppend);
});

// ---------------------------------------------------------------------------
// Missing subagent meta.json: label goes empty, rows still ingest
// ---------------------------------------------------------------------------

test("deleting the subagent's sibling meta.json empties the agentType label but rows still ingest", async () => {
    const corpus = buildFixtureCorpus(freshRoot());
    removeFile(corpus.subagentMetaPath, { force: true });
    const { store, state } = createFakeStore();

    const report = await syncArchive({ root: corpus.root, store });

    const subagentRows = state.rows.filter((row) => row.isSubagent);
    expect(subagentRows.length).toBeGreaterThan(0);
    for (const row of subagentRows) {
        expect(row.agentType).toBeUndefined();
    }
    expect(report.rowsAdded).toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------
// A file vanishing between the walk and the stat is counted, not fatal
// ---------------------------------------------------------------------------

test("a file removed between the walk and its stat is counted rather than aborting the sync", async () => {
    const corpus = buildFixtureCorpus(freshRoot());
    const { store } = createFakeStore();

    const fsDeps: HistorySyncDeps = {
        statFile: async (path: string) => {
            if (path === corpus.subagentTranscriptPath) {
                const enoent = new Error("ENOENT: no such file or directory") as NodeJS.ErrnoException;
                enoent.code = "ENOENT";
                throw enoent;
            }
            const stats = statSync(path);
            return { size: stats.size, mtimeMs: stats.mtimeMs };
        },
    };

    const report = await syncArchive({ root: corpus.root, store, fs: fsDeps });

    expect(report.filesVanished).toBe(1);
    expect(report.rowsAdded).toBeGreaterThan(0);
});

test("a non-ENOENT stat failure propagates rather than being swallowed", async () => {
    const corpus = buildFixtureCorpus(freshRoot());
    const { store } = createFakeStore();

    const fsDeps: HistorySyncDeps = {
        statFile: async (path: string) => {
            if (path === corpus.mainSessionPath) {
                throw new Error("EACCES: permission denied");
            }
            const stats = statSync(path);
            return { size: stats.size, mtimeMs: stats.mtimeMs };
        },
    };

    await expect(syncArchive({ root: corpus.root, store, fs: fsDeps })).rejects.toThrow("EACCES");
});

// ---------------------------------------------------------------------------
// Ordering: mtime descending BEFORE any cap, never after
// ---------------------------------------------------------------------------

test("the file list is sorted by mtime descending before a maxFiles cap is applied", async () => {
    const corpus = buildFixtureCorpus(freshRoot());
    const { store, state } = createFakeStore();

    const now = Date.now();
    const oldest = new Date(now - 3000);
    const middle = new Date(now - 2000);
    const newest = new Date(now - 1000);
    utimesSync(corpus.projectBSessionPath, oldest, oldest);
    utimesSync(corpus.subagentTranscriptPath, middle, middle);
    utimesSync(corpus.mainSessionPath, newest, newest);

    const report = await syncArchive({ root: corpus.root, store, maxFiles: 2 });

    // A cap applied before sorting would keep whichever two files the walk happened to list
    // first; sorting first and capping second must keep the two NEWEST files instead, dropping
    // the oldest (project B) entirely.
    expect(report.filesScanned).toBe(2);
    expect(state.manifest.has(corpus.mainSessionId)).toBe(true);
    expect(state.manifest.has(corpus.subagentId)).toBe(true);
    expect(state.sessions.has(corpus.projectBSessionId)).toBe(false);
});
