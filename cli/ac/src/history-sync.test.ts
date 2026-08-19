import { afterEach, expect, test } from "bun:test";
import {
    mkdirSync,
    mkdtempSync,
    rmSync,
    rmSync as removeFile,
    statSync,
    utimesSync,
    writeFileSync,
} from "node:fs";
import { readFile as readFileAsync } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
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

/**
 * The manifest key `syncArchive` derives for one transcript: its path relative to the walked root.
 *
 * The key identifies a FILE rather than a session, because a session uuid is not unique across
 * project directories (measured live: one uuid present under two project directories with two
 * different inodes and sizes of 6,082,328 and 29,622 bytes).
 */
function keyFor(root: string, path: string): string {
    return relative(root, path);
}

/** One transcript written by {@link writeSessionIdCollision}: where it lives and which tokens it holds. */
interface CollidingTranscript {
    readonly path: string;
    readonly tokens: readonly string[];
}

/**
 * Writes the same session uuid as a transcript under two sibling project directories, the exact
 * shape measured live on this machine (`-Users-anilcan-Code-tools-myco` and
 * `-Users-anilcan-Code-tools-myco-backup` both holding `3e19ee0b-...jsonl`).
 *
 * `sharedLines` byte-identical lines are written to the head of both files before each gets its own
 * divergent tail, so the caller can choose between the two variants of the collision: zero shared
 * lines gives divergent heads (each pass sees the other file's fingerprint and forces a full
 * re-read), while enough shared lines to exceed the 64 KB head window gives MATCHING fingerprints,
 * which is the silent variant where the read would start mid-line in the other file.
 */
function writeSessionIdCollision(
    root: string,
    options: {
        readonly sharedLines: number;
        readonly tailLinesFirst: number;
        readonly tailLinesSecond: number;
    },
): { readonly sessionId: string; readonly first: CollidingTranscript; readonly second: CollidingTranscript } {
    const sessionId = "00000000-0000-4000-8000-00000000c001";
    const padding = "P".repeat(200);

    const line = (token: string, seed: number, cwd: string): string => `${JSON.stringify({
        type: "user",
        uuid: `00000000-0000-4000-8000-${seed.toString(16).padStart(12, "0")}`,
        sessionId,
        timestamp: "2026-08-01T00:00:00.000Z",
        cwd,
        message: { role: "user", content: `${token} ${padding}` },
    })}\n`;

    // The shared head must be byte-identical, so both files carry the same uuids and the same `cwd`
    // for these lines; the fake store deduplicates them on row id the way `INSERT OR IGNORE` does.
    const sharedTokens: string[] = [];
    let shared = "";
    for (let index = 0; index < options.sharedLines; index += 1) {
        const token = `ZRQPHX-SHARED-${index}`;
        sharedTokens.push(token);
        shared += line(token, 1000 + index, "/tmp/proj-collide");
    }

    const build = (
        label: string,
        dir: string,
        cwd: string,
        seedBase: number,
        tailLines: number,
    ): CollidingTranscript => {
        const tokens = [...sharedTokens];
        let content = shared;
        for (let index = 0; index < tailLines; index += 1) {
            const token = `ZRQPHX-TAIL-${label}-${index}`;
            tokens.push(token);
            content += line(token, seedBase + index, cwd);
        }

        mkdirSync(dir, { recursive: true });
        const path = join(dir, `${sessionId}.jsonl`);
        writeFileSync(path, content, "utf8");

        return { path, tokens };
    };

    return {
        sessionId,
        first: build("A", join(root, "-tmp-collide"), "/tmp/collide", 2000, options.tailLinesFirst),
        second: build("B", join(root, "-tmp-collide-backup"), "/tmp/collide-backup", 3000, options.tailLinesSecond),
    };
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
    // Skipped lines (a known, deliberately-unindexed block type such as `image` or a successful
    // `tool_result`) are counted in the report, but must never reach the store as quarantine
    // entries: that conflation is exactly the plan defect this fixture's correction exists to
    // catch.
    expect(report.skipped).toBe(corpus.expected.skippedLines);
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

    const mainEntry = store.getManifestEntry(keyFor(corpus.root, corpus.mainSessionPath));
    const subagentEntry = store.getManifestEntry(keyFor(corpus.root, corpus.subagentTranscriptPath));

    expect(mainEntry).toBeDefined();
    expect(subagentEntry).toBeDefined();
    expect(mainEntry?.cursor ?? 0).toBeGreaterThan(0);
    expect(subagentEntry?.cursor ?? 0).toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------
// Manifest keying: a session uuid is NOT unique across project directories, so the key has to
// identify a file. Both variants of the collision get a test, because only one of them is loud.
// ---------------------------------------------------------------------------

test("two transcripts sharing one session id under different project directories keep independent cursors", async () => {
    const root = freshRoot();
    const collision = writeSessionIdCollision(root, { sharedLines: 0, tailLinesFirst: 3, tailLinesSecond: 9 });
    const { store, state } = createFakeStore();

    const first = await syncArchive({ root, store });

    // Two files, two manifest rows, each cursor at its OWN file's size. One shared row would leave
    // each pass reading the other file's cursor.
    expect(store.getManifestEntry(keyFor(root, collision.first.path))?.cursor)
        .toBe(statSync(collision.first.path).size);
    expect(store.getManifestEntry(keyFor(root, collision.second.path))?.cursor)
        .toBe(statSync(collision.second.path).size);
    expect(first.rowsAdded).toBe(collision.first.tokens.length + collision.second.tokens.length);

    // The consequence that made this critical rather than theoretical: with one shared row the two
    // files flip the cursor back and forth, so every warm pass re-reads and re-distills both files
    // for good. A warm pass must be a no-op instead.
    const second = await syncArchive({ root, store });
    expect(second.rowsAdded).toBe(0);
    expect(second.changed).toBe(false);
    expect(state.quarantine.length).toBe(0);
});

test("two colliding transcripts with a byte-identical 64 KB head both ingest every line, losing none", async () => {
    const root = freshRoot();
    // 400 shared lines of roughly 300 bytes each puts the shared prefix past the 64 KB head window,
    // so both files hash to the SAME head fingerprint: the variant that produces no error at all.
    const collision = writeSessionIdCollision(root, { sharedLines: 400, tailLinesFirst: 3, tailLinesSecond: 9 });
    expect(statSync(collision.first.path).size).toBeGreaterThan(65536);
    expect(statSync(collision.second.path).size).toBeGreaterThan(statSync(collision.first.path).size);

    // Pin the walk order: the SMALLER file first, so a session-keyed manifest would leave the
    // larger file appending from a cursor that lands mid-line inside it.
    const newest = new Date(Date.now() - 1000);
    const older = new Date(Date.now() - 2000);
    utimesSync(collision.first.path, newest, newest);
    utimesSync(collision.second.path, older, older);

    const { store, state } = createFakeStore();
    await syncArchive({ root, store });

    const bodies = state.rows.map((row) => row.body).join("\n");
    const expected = new Set([...collision.first.tokens, ...collision.second.tokens]);
    const missing = [...expected].filter((token) => !bodies.includes(token));

    expect(missing).toEqual([]);
    expect(state.quarantine.length).toBe(0);
    expect(store.getManifestEntry(keyFor(root, collision.second.path))?.cursor)
        .toBe(statSync(collision.second.path).size);
});

// ---------------------------------------------------------------------------
// One file's failure is that file's failure: counted, never fatal to the pass
// ---------------------------------------------------------------------------

test("a read failure on one file is counted and the remaining files still ingest", async () => {
    const corpus = buildFixtureCorpus(freshRoot());
    const { store, state } = createFakeStore();

    const fsDeps: HistorySyncDeps = {
        readFileRange: async (path: string, start: number, end: number): Promise<Buffer> => {
            if (path === corpus.mainSessionPath) {
                // The reachable race: a `cleanupPeriodDays` sweep takes the transcript between the
                // walk and the read, or the read hits a permission failure.
                const failure = new Error("EIO: i/o error, read") as NodeJS.ErrnoException;
                failure.code = "EIO";
                throw failure;
            }
            const whole = await readFileAsync(path);
            return whole.subarray(start, end);
        },
    };

    const report = await syncArchive({ root: corpus.root, store, fs: fsDeps });

    expect(report.filesFailed).toBe(1);
    expect(report.filesScanned).toBe(3);
    expect(state.rows.length).toBeGreaterThan(0);
    expect(store.getManifestEntry(keyFor(corpus.root, corpus.projectBSessionPath))).toBeDefined();
    expect(store.getManifestEntry(keyFor(corpus.root, corpus.subagentTranscriptPath))).toBeDefined();
    expect(store.getManifestEntry(keyFor(corpus.root, corpus.mainSessionPath))).toBeUndefined();
});

test("a file that vanishes mid-read is counted as vanished rather than aborting the pass", async () => {
    const corpus = buildFixtureCorpus(freshRoot());
    const { store } = createFakeStore();

    const fsDeps: HistorySyncDeps = {
        readFileRange: async (path: string, start: number, end: number): Promise<Buffer> => {
            if (path === corpus.mainSessionPath) {
                const enoent = new Error("ENOENT: no such file or directory, open") as NodeJS.ErrnoException;
                enoent.code = "ENOENT";
                throw enoent;
            }
            const whole = await readFileAsync(path);
            return whole.subarray(start, end);
        },
    };

    const report = await syncArchive({ root: corpus.root, store, fs: fsDeps });

    expect(report.filesVanished).toBe(1);
    expect(report.filesFailed).toBe(0);
    expect(report.rowsAdded).toBeGreaterThan(0);
});

test("a store failure is not counted per file: it propagates rather than being swallowed", async () => {
    const corpus = buildFixtureCorpus(freshRoot());
    const { store } = createFakeStore();
    const failing: HistoryStore = {
        ...store,
        ingest(): HistoryIngestResult {
            throw new Error("the archive refuses this write");
        },
    };

    await expect(syncArchive({ root: corpus.root, store: failing }))
        .rejects.toThrow("the archive refuses this write");
});

test("a sqlite failure from the store propagates rather than being counted as a file failure", async () => {
    const corpus = buildFixtureCorpus(freshRoot());
    const { store } = createFakeStore();
    const failing: HistoryStore = {
        ...store,
        ingest(): HistoryIngestResult {
            // The exact shape `node:sqlite` throws: a `code` string, like every errno exception, which
            // is why the per-file catch cannot classify on the presence of `code` alone. The store
            // already decides for itself what is degraded (`busy`) and what is fatal; a fatal one
            // counted as an unreadable file would hide a broken archive behind a clean-looking report.
            const error = new Error("database disk image is malformed") as Error & {
                code: string;
                errcode: number;
            };
            error.code = "ERR_SQLITE_ERROR";
            error.errcode = 11;
            throw error;
        },
    };

    await expect(syncArchive({ root: corpus.root, store: failing }))
        .rejects.toThrow("database disk image is malformed");
});

test("an unparseable subagent meta.json yields an empty label while the transcript's rows still ingest", async () => {
    const corpus = buildFixtureCorpus(freshRoot());
    // A `.meta.json` caught mid-write while another session spawns subagents: half a JSON document.
    writeFileSync(corpus.subagentMetaPath, '{"agentType":"ac:libr', "utf8");
    const { store, state } = createFakeStore();

    const report = await syncArchive({ root: corpus.root, store });

    const subagentRows = state.rows.filter((row) => row.isSubagent);
    expect(subagentRows.length).toBeGreaterThan(0);
    for (const row of subagentRows) {
        expect(row.agentType).toBeUndefined();
    }
    expect(report.filesFailed).toBe(0);
    expect(report.rowsAdded).toBe(
        corpus.expected.proseRows + corpus.expected.toolUseRows + corpus.expected.errorRows,
    );
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

    const projectBKey = keyFor(corpus.root, corpus.projectBSessionPath);

    await syncArchive({ root: corpus.root, store, fs: fsDeps });
    const firstCursor = store.getManifestEntry(projectBKey)?.cursor;
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
    expect(store.getManifestEntry(projectBKey)?.cursor).toBe(sizeAfterAppend);

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
    expect(state.manifest.has(keyFor(corpus.root, corpus.mainSessionPath))).toBe(true);
    expect(state.manifest.has(keyFor(corpus.root, corpus.subagentTranscriptPath))).toBe(true);
    expect(state.sessions.has(corpus.projectBSessionId)).toBe(false);
});
