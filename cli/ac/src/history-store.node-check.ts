import { after, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    HISTORY_SCHEMA_VERSION,
    createHistoryStoreHandle,
    openHistoryStore,
    resolveArchivePaths,
} from "./history-store.ts";
import type { HistoryIngestResult, HistoryResultRow, HistoryStore } from "./history-store.ts";
import type { DistillRow } from "./history-distill.ts";
import {
    buildContentQuery,
    buildCountQuery,
    buildReadQuery,
    buildSessionsQuery,
    toMatchExpression,
} from "./history-query.ts";

// This suite runs under `node --experimental-strip-types --test`, never under `bun test`: bun 1.3.10
// cannot resolve `node:sqlite` the moment the binding is used, which is why the filename ends in
// `.node-check.ts` rather than `.test.ts`. See the Codebase Conventions note in the plan.

const roots: string[] = [];
const stores: HistoryStore[] = [];

after(() => {
    for (const store of stores) {
        store.close();
    }
    for (const root of roots) {
        rmSync(root, { force: true, recursive: true });
    }
});

/** Fresh temp archive directory, registered for cleanup. Never touches the user's real `~/.claude`. */
function tempArchiveDir(): string {
    const root = mkdtempSync(join(tmpdir(), "ac-history-"));
    roots.push(root);

    return join(root, "archive");
}

/** Opens a store against a fresh temp directory and registers it for cleanup. */
async function openTempStore(overrides: { dir?: string; busyTimeoutMs?: number } = {}): Promise<HistoryStore> {
    const store = await openHistoryStore({
        dir: overrides.dir ?? tempArchiveDir(),
        busyTimeoutMs: overrides.busyTimeoutMs,
    });
    stores.push(store);

    return store;
}

let rowSeed = 0;

/** Builds one distilled row with a unique uuid unless the caller pins one. */
function makeRow(body: string, overrides: Partial<DistillRow> = {}): DistillRow {
    rowSeed += 1;

    return {
        id: `uuid-${rowSeed}`,
        sessionId: "session-a",
        projectPath: "/tmp/proj-a",
        ts: 1_750_000_000_000,
        role: "user",
        kind: "prose",
        isSubagent: false,
        agentType: undefined,
        body,
        ...overrides,
    };
}

/** Minimal ingest request around a row list, so each test states only what it cares about. */
function ingestOnce(
    store: HistoryStore,
    rows: readonly DistillRow[],
    cursor = 100,
): HistoryIngestResult {
    return store.ingest({
        transcriptKey: `key-${cursor}-${rows.length}-${rowSeed}`,
        sessionId: rows[0]?.sessionId ?? "session-a",
        priorCursor: 0,
        cursor,
        headFingerprint: "fingerprint-a",
        rows,
    });
}

function firstRow(rows: readonly HistoryResultRow[]): HistoryResultRow {
    const row = rows[0];
    assert.ok(row !== undefined, "expected at least one row");

    return row;
}

function count(store: HistoryStore, sql: string, ...params: readonly (string | number)[]): number {
    return Number(firstRow(store.select({ sql, params }))["c"]);
}

// Smoke test for the `test:node` runner itself (Step 6): proves an in-memory FTS5 table with the
// `unicode61` tokenizer folds Turkish diacritics, so a diacritic-free prefix query still matches
// diacritic-bearing indexed text.
test("unicode61 tokenizer folds Turkish diacritics for a prefix match", () => {
    const db = new DatabaseSync(":memory:");

    db.exec("CREATE VIRTUAL TABLE turns_fts USING fts5(body, tokenize='unicode61')");
    db.prepare("INSERT INTO turns_fts(body) VALUES (?)").run("gözden geçirildi");

    const row = db
        .prepare("SELECT body FROM turns_fts WHERE turns_fts MATCH ?")
        .get('"gozden"*');

    assert.equal(row?.body, "gözden geçirildi");

    db.close();
});

test("resolveArchivePaths prefers CLAUDE_CONFIG_DIR over the home directory", () => {
    const relocated = resolveArchivePaths({ env: { CLAUDE_CONFIG_DIR: "/tmp/elsewhere" }, home: "/tmp/home" });
    assert.equal(relocated.dir, join("/tmp/elsewhere", "ac", "history-index"));

    const defaulted = resolveArchivePaths({ env: {}, home: "/tmp/home" });
    assert.equal(defaulted.dir, join("/tmp/home", ".claude", "ac", "history-index"));
    assert.equal(defaulted.databasePath, join(defaulted.dir, "history.db"));
});

test("creates the archive directory 0700 and the database file 0600", async () => {
    const dir = tempArchiveDir();
    const store = await openTempStore({ dir });

    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.equal(statSync(store.databasePath).mode & 0o777, 0o600);
});

test("sets and reads back journal_mode, busy_timeout and synchronous", async () => {
    const store = await openTempStore();

    assert.equal(firstRow(store.select({ sql: "PRAGMA journal_mode", params: [] }))["journal_mode"], "wal");
    assert.equal(firstRow(store.select({ sql: "PRAGMA busy_timeout", params: [] }))["timeout"], 5000);
    assert.equal(firstRow(store.select({ sql: "PRAGMA synchronous", params: [] }))["synchronous"], 1);
    const version = firstRow(store.select({ sql: "PRAGMA user_version", params: [] }))["user_version"];
    assert.equal(version, HISTORY_SCHEMA_VERSION);
});

test("re-ingesting the same uuid leaves exactly one row and one index entry", async () => {
    const store = await openTempStore();
    const row = makeRow("KRXQ-DUPLICATE marker body");

    const first = ingestOnce(store, [row], 100);
    const second = ingestOnce(store, [row], 200);

    assert.equal(first.rowsAdded, 1);
    assert.equal(second.rowsAdded, 0);
    assert.equal(second.rowsIgnored, 1);
    assert.equal(count(store, "SELECT count(*) AS c FROM turns WHERE uuid = ?", row.id), 1);
    assert.equal(
        count(store, "SELECT count(*) AS c FROM turns_fts WHERE turns_fts MATCH ?", '"KRXQ-DUPLICATE"*'),
        1,
    );
});

test("redacts every body before binding it", async () => {
    const store = await openTempStore();
    const token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    const result = ingestOnce(store, [makeRow(`leaked ${token} in prose`)]);

    const stored = String(firstRow(store.select({ sql: "SELECT body FROM turns", params: [] }))["body"]);

    assert.ok(stored.includes("[REDACTED:"), `expected a redaction marker, got ${stored}`);
    assert.ok(!stored.includes(token), "the raw token must never reach the archive");
    assert.equal(result.redactions["github-pat"], 1);
});

test("a row written through the normal path is findable via MATCH with no rebuild", async () => {
    const store = await openTempStore();

    ingestOnce(store, [makeRow("VZPL-EXTERNAL-CONTENT marker written through ingest")]);

    // The assertion that catches a missing per-row index insert: SQLite does not populate an
    // external-content FTS5 index when you insert into its content table, and no `rebuild` runs on
    // the write path, so a zero here means the index insert is missing rather than merely late.
    assert.equal(
        count(store, "SELECT count(*) AS c FROM turns_fts WHERE turns_fts MATCH ?", '"VZPL-EXTERNAL-CONTENT"*'),
        1,
    );
});

test("snippet() returns highlighted text through the external-content index", async () => {
    const store = await openTempStore();

    ingestOnce(store, [makeRow("prelude WJQT-SNIPPET-TARGET and the rest of the sentence")]);

    const statement = buildContentQuery({
        match: toMatchExpression("WJQT-SNIPPET-TARGET", { prefix: false }),
        filters: {},
        limit: 5,
        offset: 0,
    });
    const snippet = String(firstRow(store.select(statement))["snippet"]);

    assert.ok(snippet.includes("«"), `expected highlight markers, got ${snippet}`);
    assert.ok(snippet.includes("WJQT"), `expected the matched term in the excerpt, got ${snippet}`);
});

test("executes every Step 3 builder against the real schema, including the hostile query inputs", async () => {
    const store = await openTempStore();

    ingestOnce(store, [
        makeRow("opened with node:sqlite and closed again", { sessionId: "session-a" }),
        makeRow("compiled the C++ target twice", { sessionId: "session-a" }),
        makeRow("node:sqlite mentioned in another session", { sessionId: "session-b" }),
        makeRow("unrelated body in a third session", { sessionId: "session-c", projectPath: "/tmp/proj-b" }),
    ]);

    // 1. content: MATCH plus a metadata filter, on the input that throws when passed raw.
    const content = store.select(buildContentQuery({
        match: toMatchExpression("node:sqlite", { prefix: true }),
        filters: { path: "proj-a", role: "user" },
        limit: 10,
        offset: 0,
    }));
    assert.equal(content.length, 2);

    // 2. count: the cheaper subquery shape, on the other input that throws when passed raw.
    const counted = firstRow(store.select(buildCountQuery({
        match: toMatchExpression("C++", { prefix: true }),
        filters: { kind: "prose" },
    })));
    assert.ok(Number(counted["matches"]) >= 1, "the C++ pattern must return a count rather than throw");

    // 3. sessions: the aggregate-plus-MATERIALIZED shape, the only one FTS5 can reject outright.
    const sessions = store.select(buildSessionsQuery({
        match: toMatchExpression("node:sqlite", { prefix: true }),
        filters: {},
        limit: 10,
        offset: 0,
    }));
    assert.equal(sessions.length, 2);
    assert.deepEqual(
        sessions.map((row) => String(row["session_id"])).sort(),
        ["session-a", "session-b"],
    );
    assert.equal(Number(firstRow(sessions.filter((row) => row["session_id"] === "session-a"))["hits"]), 1);

    // 4. read: no MATCH at all, addressed by session id alone.
    const read = store.select(buildReadQuery({ sessionId: "session-a", limit: 10, offset: 0 }));
    assert.equal(read.length, 2);
});

test("refuses to write when the archive's user_version is newer than this build knows", async () => {
    const dir = tempArchiveDir();
    const store = await openTempStore({ dir });
    ingestOnce(store, [makeRow("HFTR-PRE-UPGRADE body")]);
    store.close();

    const raw = new DatabaseSync(store.databasePath);
    raw.exec(`PRAGMA user_version = ${HISTORY_SCHEMA_VERSION + 7}`);
    raw.close();

    const newer = await openTempStore({ dir });
    assert.equal(newer.writable, false);
    assert.equal(newer.schemaVersion, HISTORY_SCHEMA_VERSION + 7);

    assert.throws(
        () => ingestOnce(newer, [makeRow("HFTR-POST-UPGRADE body")]),
        (error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            assert.ok(message.includes(String(HISTORY_SCHEMA_VERSION + 7)), `must name the file version: ${message}`);
            assert.ok(message.includes(String(HISTORY_SCHEMA_VERSION)), `must name the build version: ${message}`);

            return true;
        },
    );

    // The read path stays usable against a newer archive; only writing is refused.
    assert.equal(count(newer, "SELECT count(*) AS c FROM turns"), 1);
});

test("re-reads the manifest cursor inside the transaction and skips a delta another sync already took", async () => {
    const store = await openTempStore();

    const first = store.ingest({
        transcriptKey: "session-a",
        sessionId: "session-a",
        priorCursor: 0,
        cursor: 100,
        headFingerprint: "fingerprint-a",
        rows: [makeRow("QLMT-FIRST-PASS body")],
    });
    assert.equal(first.skipped, false);
    assert.deepEqual(store.getManifestEntry("session-a"), { cursor: 100, headFingerprint: "fingerprint-a" });

    // A competing sync advances the cursor past our delta between our decision and our write.
    const raw = new DatabaseSync(store.databasePath);
    raw.exec("PRAGMA busy_timeout = 5000");
    raw.prepare("UPDATE manifest SET cursor = 500 WHERE transcript_key = ?").run("session-a");
    raw.close();

    const second = store.ingest({
        transcriptKey: "session-a",
        sessionId: "session-a",
        priorCursor: 100,
        cursor: 300,
        headFingerprint: "fingerprint-a",
        rows: [makeRow("QLMT-STALE-PASS body")],
    });

    assert.equal(second.skipped, true);
    assert.equal(second.rowsAdded, 0);
    assert.equal(store.getManifestEntry("session-a")?.cursor, 500);
    assert.equal(count(store, "SELECT count(*) AS c FROM turns"), 1);
});

test("a full re-read after a head-fingerprint change resets the cursor rather than skipping", async () => {
    const store = await openTempStore();

    store.ingest({
        transcriptKey: "session-a",
        sessionId: "session-a",
        priorCursor: 0,
        cursor: 900,
        headFingerprint: "fingerprint-a",
        rows: [makeRow("YBNC-BEFORE-REWRITE body")],
    });

    const rewritten = store.ingest({
        transcriptKey: "session-a",
        sessionId: "session-a",
        priorCursor: 0,
        cursor: 120,
        headFingerprint: "fingerprint-b",
        rows: [makeRow("YBNC-AFTER-REWRITE body")],
    });

    assert.equal(rewritten.skipped, false);
    assert.deepEqual(store.getManifestEntry("session-a"), { cursor: 120, headFingerprint: "fingerprint-b" });
});

test("upserts a session row and looks its title up by id", async () => {
    const store = await openTempStore();

    store.upsertSession({
        sessionId: "session-a",
        projectPath: "/tmp/proj-a",
        title: "GHTP-SESSION-TITLE",
        firstPrompt: "the very first thing asked",
        mtime: 1_750_000_000_000,
        isSubagent: false,
        agentType: undefined,
    });
    store.upsertSession({
        sessionId: "session-a",
        projectPath: "/tmp/proj-a",
        title: "GHTP-SESSION-TITLE-RENAMED",
        firstPrompt: "the very first thing asked",
        mtime: 1_750_000_001_000,
        isSubagent: false,
        agentType: undefined,
    });
    store.upsertSession({
        sessionId: "session-sub",
        projectPath: "/tmp/proj-a",
        title: undefined,
        firstPrompt: "",
        mtime: 1_750_000_002_000,
        isSubagent: true,
        agentType: "ac:librarian",
    });

    const found = store.lookupSessions(["session-a", "session-sub", "session-missing"]);

    assert.equal(found.size, 2);
    assert.equal(found.get("session-a")?.title, "GHTP-SESSION-TITLE-RENAMED");
    assert.equal(found.get("session-sub")?.title, undefined);
    assert.equal(found.get("session-sub")?.isSubagent, true);
    assert.equal(found.get("session-sub")?.agentType, "ac:librarian");
    assert.equal(count(store, "SELECT count(*) AS c FROM sessions"), 2);
});

test("quarantines a raw line once per source, redacted", async () => {
    const store = await openTempStore();
    const token = "ghp_zyxwvutsrqponmlkjihgfedcba9876543210";

    const entry = {
        sessionId: "session-a",
        projectPath: "/tmp/proj-a",
        sourcePath: "/tmp/proj-a/session-a.jsonl",
        raw: `{"type":"user","body":"${token}"`,
    };
    const first = store.ingest({
        transcriptKey: "session-a",
        sessionId: "session-a",
        priorCursor: 0,
        cursor: 100,
        headFingerprint: "fingerprint-a",
        rows: [],
        quarantined: [entry],
    });
    const second = store.ingest({
        transcriptKey: "session-a",
        sessionId: "session-a",
        priorCursor: 0,
        cursor: 200,
        headFingerprint: "fingerprint-a",
        rows: [],
        quarantined: [entry],
    });

    assert.equal(first.quarantined, 1);
    assert.equal(second.quarantined, 0);

    const stored = String(firstRow(store.select({ sql: "SELECT raw FROM quarantine", params: [] }))["raw"]);
    assert.ok(!stored.includes(token), "a quarantined raw line must be redacted like any other body");
});

test("forget removes only the matching rows and restores index consistency", async () => {
    const store = await openTempStore();

    ingestOnce(store, [
        makeRow("MRVK-FORGET-ME body", { sessionId: "session-doomed" }),
        makeRow("MRVK-FORGET-ME again", { sessionId: "session-doomed" }),
        makeRow("MRVK-KEEP-ME body", { sessionId: "session-kept" }),
    ]);
    store.upsertSession({
        sessionId: "session-doomed",
        projectPath: "/tmp/proj-a",
        title: undefined,
        firstPrompt: "",
        mtime: 1,
        isSubagent: false,
        agentType: undefined,
    });

    const result = store.forget({ sessionId: "session-doomed" });

    assert.equal(result.turnsRemoved, 2);
    assert.equal(result.sessionsRemoved, 1);
    assert.equal(count(store, "SELECT count(*) AS c FROM turns"), 1);
    assert.equal(count(store, "SELECT count(*) AS c FROM turns_fts WHERE turns_fts MATCH ?", '"MRVK-FORGET-ME"*'), 0);
    assert.equal(count(store, "SELECT count(*) AS c FROM turns_fts WHERE turns_fts MATCH ?", '"MRVK-KEEP-ME"*'), 1);
});

test("forget refuses to run with no filter at all", async () => {
    const store = await openTempStore();

    assert.throws(() => store.forget({}), /at least one/);
});

test("a competing writer surfaces as a degraded result rather than a thrown failure", async () => {
    const dir = tempArchiveDir();
    const store = await openTempStore({ dir, busyTimeoutMs: 50 });

    const blocker = new DatabaseSync(store.databasePath);
    blocker.exec("PRAGMA busy_timeout = 50");
    blocker.exec("BEGIN IMMEDIATE");
    blocker
        .prepare(
            "INSERT INTO manifest(transcript_key, session_id, cursor, head_fingerprint, updated_at) "
            + "VALUES (?, ?, ?, ?, ?)",
        )
        .run("other", "other", 1, "fingerprint-z", 1);

    const result = ingestOnce(store, [makeRow("XKDW-BLOCKED body")]);

    blocker.exec("ROLLBACK");
    blocker.close();

    assert.equal(result.busy, true);
    assert.equal(result.rowsAdded, 0);
    assert.equal(count(store, "SELECT count(*) AS c FROM turns"), 0);
});

test("the handle opens the database once and hands the same store to concurrent callers", async () => {
    const handle = createHistoryStoreHandle({ dir: tempArchiveDir() });

    const [first, second] = await Promise.all([handle.ensureOpen(), handle.ensureOpen()]);
    assert.equal(first, second);

    await handle.close();
});

test("the handle retries a rejected open instead of caching the rejection", async () => {
    const dir = tempArchiveDir();
    writeFileSync(dir, "a regular file standing where the archive directory belongs", "utf8");
    const handle = createHistoryStoreHandle({ dir });

    await assert.rejects(handle.ensureOpen(), /EEXIST/);

    // One transient open failure must not disable the tool for the rest of the process. The memoised
    // promise is the lock, so a REJECTED one has to be cleared: kept, it is handed to every later
    // caller and the search stays broken until the MCP server restarts.
    unlinkSync(dir);
    const store = await handle.ensureOpen();
    assert.equal(store.writable, true);
    assert.equal(count(store, "SELECT count(*) AS c FROM turns"), 0);

    await handle.close();
});

// ---------------------------------------------------------------------------
// Transaction and connection lifetime edges. Each error code below was measured on node v22.17.1
// rather than assumed, because the whole failure mode is one error replacing another.
// ---------------------------------------------------------------------------

test("a COMMIT that fails under contention leaves the connection usable for the next ingest", async () => {
    const store = await openTempStore({ busyTimeoutMs: 50 });

    // Rollback-journal mode is the shape where the COMMIT ITSELF can fail: the writer holds RESERVED
    // through its inserts and needs EXCLUSIVE to commit, which a reader's SHARED lock denies.
    // Measured: `database is locked`, errcode 5, and sqlite leaves the transaction OPEN. So clearing
    // the in-transaction flag BEFORE the COMMIT exec skips the rollback, sqlite stays inside a
    // transaction nothing will close, and every later call throws `cannot start a transaction within
    // a transaction`, errcode 1, which `isBusyError` correctly refuses to read as contention.
    store.select({ sql: "PRAGMA journal_mode = delete", params: [] });

    const reader = new DatabaseSync(store.databasePath);
    reader.exec("PRAGMA busy_timeout = 50");
    reader.exec("BEGIN");
    reader.prepare("SELECT count(*) AS c FROM turns").get();

    const blocked = ingestOnce(store, [makeRow("PTQN-COMMIT-BLOCKED body")]);
    assert.equal(blocked.busy, true);

    reader.exec("ROLLBACK");
    reader.close();

    const recovered = ingestOnce(store, [makeRow("PTQN-AFTER-FAILED-COMMIT body")]);

    assert.equal(recovered.busy, false);
    assert.equal(recovered.rowsAdded, 1);
    // Exactly one row: the blocked attempt's row was rolled back rather than left half-committed.
    assert.equal(count(store, "SELECT count(*) AS c FROM turns"), 1);
});

test("an ingest that dies of a full database surfaces that error rather than a rollback error", async () => {
    const store = await openTempStore();

    // `max_page_count` just above the current size is a deterministic disk-full: measured, the write
    // throws `database or disk is full`, errcode 13, and sqlite has ALREADY rolled the transaction
    // back, so the explicit ROLLBACK that follows throws `cannot rollback - no transaction is
    // active`, errcode 1. Untolerated, that second error replaces the first one on its way out and
    // the caller is told the rollback failed instead of that the disk is full.
    const pages = Number(firstRow(store.select({ sql: "PRAGMA page_count", params: [] }))["page_count"]);
    store.select({ sql: `PRAGMA max_page_count = ${pages + 2}`, params: [] });

    const oversized = Array.from(
        { length: 200 },
        (_unused, index) => makeRow(`SDFL-DISK-FULL-${index} ${"x".repeat(4096)}`),
    );

    assert.throws(
        () => ingestOnce(store, oversized),
        (error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            assert.ok(message.includes("disk is full"), `the original failure must survive: ${message}`);

            return true;
        },
    );

    // And the store is still usable once the ceiling is lifted, rather than stuck in a transaction.
    store.select({ sql: "PRAGMA max_page_count = 1073741823", params: [] });
    const recovered = ingestOnce(store, [makeRow("SDFL-AFTER-FULL body")]);

    assert.equal(recovered.rowsAdded, 1);
});

test("the busy timeout is in force before the journal-mode conversion", async () => {
    const dir = tempArchiveDir();
    mkdirSync(dir, { recursive: true });
    const databasePath = join(dir, "history.db");

    // A fresh archive file still in sqlite's default `delete` journal mode with a reader holding
    // SHARED on it: the first open on a machine, racing a second `ac` process. Measured, the WAL
    // conversion DOES call the busy handler for this shape, failing in 0 ms under sqlite's default
    // timeout of 0 and waiting 329 ms when a 300 ms timeout was set first. The wait is the only
    // observable difference, since both orders end in the same error here.
    const holder = new DatabaseSync(databasePath);
    holder.exec("CREATE TABLE probe(id INTEGER PRIMARY KEY)");
    holder.exec("BEGIN");
    holder.prepare("SELECT count(*) AS c FROM probe").get();

    const startedAt = Date.now();
    await assert.rejects(openHistoryStore({ dir, busyTimeoutMs: 300 }), /database is locked/);
    const elapsed = Date.now() - startedAt;

    holder.exec("ROLLBACK");
    holder.close();

    assert.ok(elapsed >= 200, `the conversion must wait out the busy timeout, waited ${elapsed} ms`);
});
