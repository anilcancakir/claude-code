import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { redact } from "./history-redact.ts";
import type { RedactKind } from "./history-redact.ts";
import type { HistoryManifestEntry } from "./history-cursor.ts";
import type { DistillRow } from "./history-distill.ts";
import type { SqlStatement } from "./history-query.ts";

/**
 * The only module that touches sqlite. Owns the archive's schema, its file permissions, its
 * connection pragmas, every write into it, and the single code path that removes rows from it.
 *
 * Three things about this module are load-bearing and each one is easy to get wrong invisibly.
 *
 * **The sqlite binding is reached exclusively through `await import` inside a function body.** A
 * top-level import would make an older Node fail to load this file, which cascades into the whole
 * MCP server failing to start, because `mcp.ts` is imported from the CLI entrypoint. Reached
 * dynamically, a Node without `node:sqlite` loses this one tool and keeps the other five. That is
 * also why no type in this file is imported from `node:sqlite`: a type-position import still puts
 * the specifier in the module's static text, so the structural interfaces below stand in for it.
 *
 * **The FTS5 index is external-content and SQLite does NOT maintain it.** Inserting into `turns`
 * leaves `turns_fts` empty (measured: match count 0 afterwards), and the failure mode is a search
 * that returns nothing with no error anywhere. Every successful insert into `turns` is therefore
 * followed by an explicit `INSERT INTO turns_fts(rowid, body)` inside the same transaction. A full
 * `rebuild` would also fix the index but costs about 1.5 s on the real corpus, fifty times a warm
 * sync's whole budget, so it belongs only to {@link HistoryStore.forget} where rows really vanish.
 *
 * **The archive outlives its own source data.** Claude Code's `cleanupPeriodDays` removes a
 * transcript after about 30 days, so once a turn is ingested the archive is the only copy. That is
 * why redaction runs here rather than at read time, why row removal exists in exactly one function,
 * and why a `user_version` newer than this build's refuses writes instead of guessing at a schema.
 */

/**
 * Schema version written into `PRAGMA user_version`, and the highest version this build can write.
 *
 * Bump it only alongside a migration. A file reporting a HIGHER version was written by a newer `ac`
 * whose schema this build does not know, so writing to it could silently corrupt a permanent archive
 * that has no other copy; {@link openHistoryStore} keeps such a file readable and refuses to write.
 */
export const HISTORY_SCHEMA_VERSION = 1;

/**
 * Milliseconds a writer waits for a competing writer's lock before giving up.
 *
 * sqlite's own default is 0, so a second `ac mcp` process would fail instantly rather than wait,
 * and several of them run at once on a developer machine. The value is applied as a PRAGMA and read
 * back, never through the `DatabaseSync` constructor's `timeout` option, whose availability floor
 * two sources disagree about (22.16.0 versus 22.18.0) while the PRAGMA works everywhere.
 */
const DEFAULT_BUSY_TIMEOUT_MS = 5000;

/** `PRAGMA synchronous = NORMAL` reads back as this integer, which is what the verification compares. */
const SYNCHRONOUS_NORMAL = 1;

/** Bind-parameter chunk for {@link HistoryStore.lookupSessions}, well under sqlite's variable ceiling. */
const LOOKUP_CHUNK_SIZE = 500;

const DATABASE_FILE_NAME = "history.db";

// The whole schema, created once under one transaction so two processes racing to initialize the
// same file cannot interleave halfway. `turns.ts` is deliberately NULLABLE: `DistillRow.ts` is
// `number | undefined`, and substituting 0 for an unknown timestamp would make the row
// indistinguishable from one written in 1970 and would let it satisfy every `until` filter. NULL
// fails both comparisons instead, and the ranking expression in `history-query.ts` already guards
// the arithmetic with COALESCE.
const SCHEMA_STATEMENTS: readonly string[] = [
    `CREATE TABLE IF NOT EXISTS turns (
        id INTEGER PRIMARY KEY,
        uuid TEXT UNIQUE NOT NULL,
        session_id TEXT NOT NULL,
        project_path TEXT,
        ts INTEGER,
        role TEXT NOT NULL,
        kind TEXT NOT NULL,
        is_sub INTEGER NOT NULL DEFAULT 0,
        agent_type TEXT,
        body TEXT NOT NULL
    )`,
    // External content, never contentless: `snippet()` cannot read a contentless table, and the
    // excerpt is the whole reason a caller can act on a hit.
    `CREATE VIRTUAL TABLE IF NOT EXISTS turns_fts USING fts5(
        body,
        content=turns,
        content_rowid=id,
        tokenize='unicode61'
    )`,
    "CREATE INDEX IF NOT EXISTS turns_session_ts ON turns(session_id, ts)",
    "CREATE INDEX IF NOT EXISTS turns_project_ts ON turns(project_path, ts DESC)",
    "CREATE INDEX IF NOT EXISTS turns_kind_ts ON turns(kind, ts DESC)",
    "CREATE INDEX IF NOT EXISTS turns_ts ON turns(ts DESC)",
    `CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        project_path TEXT,
        title TEXT,
        first_prompt TEXT,
        mtime INTEGER,
        is_sub INTEGER NOT NULL DEFAULT 0,
        agent_type TEXT
    )`,
    // Keyed on `transcript_key`, not on `session_id`, because a byte cursor belongs to one FILE and a
    // session id names several. A subagent transcript's lines carry their PARENT session id, and a
    // main session's uuid is not unique across project directories either (one live case measured at
    // 6,082,328 and 29,622 bytes under two project directories). Sharing a row between two files has
    // each pass read the other file's cursor: either a permanent full re-read or, when the two heads
    // match, an append that starts mid-line and loses every line between the two cursors. The caller
    // (`history-sync.ts`) derives the key from the transcript's path relative to the walked root;
    // `session_id` stays alongside so a row can still name the session a search result came from.
    `CREATE TABLE IF NOT EXISTS manifest (
        transcript_key TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        cursor INTEGER NOT NULL,
        head_fingerprint TEXT NOT NULL,
        updated_at INTEGER NOT NULL
    )`,
    // A line the distiller could not turn into rows, kept so a later parser fix can recover it once
    // the source transcript is gone. Unique on (source_path, raw) so a full re-read of an
    // unchanged file does not grow the table.
    `CREATE TABLE IF NOT EXISTS quarantine (
        id INTEGER PRIMARY KEY,
        session_id TEXT,
        project_path TEXT,
        source_path TEXT NOT NULL,
        seen_at INTEGER NOT NULL,
        raw TEXT NOT NULL,
        UNIQUE(source_path, raw)
    )`,
];

// ---------------------------------------------------------------------------
// Structural stand-ins for the sqlite binding
// ---------------------------------------------------------------------------

/** Every value this module binds to a statement parameter. */
type SqliteInputValue = string | number | bigint | null;

/** Every value sqlite can hand back. The blob arm exists for assignability, not because we store one. */
type SqliteOutputValue = string | number | bigint | null | Uint8Array;

interface SqliteStatement {
    all(...params: SqliteInputValue[]): Record<string, SqliteOutputValue>[];
    get(...params: SqliteInputValue[]): Record<string, SqliteOutputValue> | undefined;
    run(...params: SqliteInputValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
}

interface SqliteDatabase {
    exec(sql: string): void;
    prepare(sql: string): SqliteStatement;
    close(): void;
}

interface SqliteModule {
    DatabaseSync: new (path: string) => SqliteDatabase;
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/** Where the archive lives on disk. */
export interface HistoryArchivePaths {
    readonly dir: string;
    readonly databasePath: string;
}

/** Injected location and tuning, so tests never touch the user's real `~/.claude`. */
export interface HistoryStoreOptions {
    /** Archive directory, bypassing {@link resolveArchivePaths} entirely. */
    readonly dir?: string;
    /** Environment to resolve `CLAUDE_CONFIG_DIR` from. Defaults to `process.env`. */
    readonly env?: Record<string, string | undefined>;
    /** Home directory to fall back to. Defaults to `os.homedir()`. */
    readonly home?: string;
    /** Lock-wait in millis. Defaults to {@link DEFAULT_BUSY_TIMEOUT_MS}; tests lower it to stay fast. */
    readonly busyTimeoutMs?: number;
}

/** A cell as sqlite returns it. Exported so callers can narrow without re-deriving the union. */
export type HistoryCellValue = SqliteOutputValue;

/** One result row, keyed by the column names the query builders alias. */
export type HistoryResultRow = Record<string, HistoryCellValue>;

/**
 * A session's own metadata row, the store's answer to "what should this session be called".
 *
 * `title`, `firstPrompt` and `projectPath` come from `resolveSessionMeta` in `history-distill.ts`,
 * which copies Claude Code's own resolution contract, so a title shown here agrees with the one the
 * CLI's resume picker shows for the same session. `mtime` is the source transcript's, kept so a
 * caller can order sessions by recency without touching the filesystem.
 */
export interface HistorySessionRecord {
    readonly sessionId: string;
    readonly projectPath: string | undefined;
    readonly title: string | undefined;
    readonly firstPrompt: string;
    readonly mtime: number | undefined;
    readonly isSubagent: boolean;
    readonly agentType: string | undefined;
}

/** A line the distiller could not turn into rows, preserved for a later parser fix. */
export interface HistoryQuarantineEntry {
    readonly sessionId: string | undefined;
    readonly projectPath: string | undefined;
    readonly sourcePath: string;
    readonly raw: string;
}

/**
 * One file's worth of work: the rows to add, the lines to quarantine, the session metadata to
 * refresh, and the cursor arithmetic that says how far the caller got.
 *
 * `priorCursor` is what the caller's `decideRead` was based on; `cursor` is where it wants the
 * manifest left. The store re-reads the stored cursor inside its own transaction rather than
 * trusting `priorCursor`, because a concurrent sync may have advanced past this delta already.
 */
export interface HistoryIngestRequest {
    readonly transcriptKey: string;
    readonly sessionId: string;
    readonly priorCursor: number;
    readonly cursor: number;
    readonly headFingerprint: string;
    readonly rows: readonly DistillRow[];
    readonly quarantined?: readonly HistoryQuarantineEntry[];
    readonly session?: HistorySessionRecord;
}

/**
 * What one ingest actually accomplished.
 *
 * `skipped` means a concurrent sync had already taken this delta, so nothing was written and the
 * manifest was left where the other writer put it. `busy` means a competing writer held the lock
 * past the busy timeout: a degraded pass rather than a failure, since the read path stays correct
 * against the last committed snapshot and the next sync picks the delta up again.
 */
export interface HistoryIngestResult {
    readonly rowsAdded: number;
    readonly rowsIgnored: number;
    readonly quarantined: number;
    readonly redactions: Partial<Record<RedactKind, number>>;
    readonly skipped: boolean;
    readonly busy: boolean;
}

/**
 * Which rows {@link HistoryStore.forget} removes. At least one field is required; an unfiltered
 * forget would empty an archive whose source transcripts have aged out.
 *
 * `projectPath` matches EXACTLY here, unlike the substring match the search filter uses: a
 * destructive filter that reaches further than the caller typed is the wrong kind of surprise.
 * `before` compares against a turn's own timestamp, so a turn with no timestamp is never removed by
 * age alone.
 */
export interface HistoryForgetFilter {
    readonly sessionId?: string;
    readonly projectPath?: string;
    readonly before?: number;
}

/** What one forget removed. `busy` carries the same degraded-not-failed meaning as on ingest. */
export interface HistoryForgetResult {
    readonly turnsRemoved: number;
    readonly sessionsRemoved: number;
    readonly quarantineRemoved: number;
    readonly busy: boolean;
}

/** The archive, open and ready. Every method is synchronous; only opening is async. */
export interface HistoryStore {
    readonly databasePath: string;
    /** The version this file reports, which may exceed {@link HISTORY_SCHEMA_VERSION}. */
    readonly schemaVersion: number;
    /** False when the file was written by a newer build; reads still work, writes refuse. */
    readonly writable: boolean;
    getManifestEntry(transcriptKey: string): HistoryManifestEntry | undefined;
    ingest(request: HistoryIngestRequest): HistoryIngestResult;
    upsertSession(record: HistorySessionRecord): void;
    lookupSessions(sessionIds: readonly string[]): Map<string, HistorySessionRecord>;
    select(statement: SqlStatement): readonly HistoryResultRow[];
    forget(filter: HistoryForgetFilter): HistoryForgetResult;
    /** Idempotent: the CLI closes its own store while the handle may close the same one again. */
    close(): void;
}

/**
 * A store that opens on first use and only once, until an open fails.
 *
 * Copied from the `connectPromise` memoization at `mcp.ts:320-328`: the promise itself is the lock,
 * so two concurrent callers share one open rather than racing to create the schema twice. A REJECTED
 * open is not memoised, so one transient failure costs one call rather than the process's lifetime.
 */
export interface HistoryStoreHandle {
    ensureOpen(): Promise<HistoryStore>;
    close(): Promise<void>;
}

/**
 * Resolves the archive directory and database path.
 *
 * `CLAUDE_CONFIG_DIR` wins when set, because Claude Code itself relocates its whole storage that
 * way and an archive of a relocated corpus belongs beside it. Otherwise `~/.claude`, then
 * `ac/history-index/`.
 */
export function resolveArchivePaths(options: HistoryStoreOptions = {}): HistoryArchivePaths {
    const env = options.env ?? process.env;
    const configured = (env["CLAUDE_CONFIG_DIR"] ?? "").trim();
    const base = configured === "" ? join(options.home ?? homedir(), ".claude") : configured;
    const dir = options.dir ?? join(base, "ac", "history-index");

    return {
        dir,
        databasePath: join(dir, DATABASE_FILE_NAME),
    };
}

/**
 * Opens the archive, creating its directory, file and schema on first use.
 *
 * @throws Error when the sqlite binding is missing, when a pragma does not read back the value it
 *         was set to, or when the schema cannot be created.
 */
export async function openHistoryStore(options: HistoryStoreOptions = {}): Promise<HistoryStore> {
    const paths = resolveArchivePaths(options);
    const busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;

    // 1. The directory first, and 0700 even if it already exists with a looser mode: the parent
    //    `~/.claude` is world-readable, and under umask 022 an archive of everything the user has
    //    ever discussed would end up more exposed than the transcripts it was built from.
    mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
    chmodSync(paths.dir, 0o700);

    // 2. Now the file, which sqlite creates with the process umask applied, hence the explicit
    //    tightening straight afterwards. The WAL and shared-memory siblings are covered by the
    //    directory mode above, which is what actually gates another user reaching any of them.
    const sqlite = await loadSqlite();
    const db = new sqlite.DatabaseSync(paths.databasePath);
    chmodSync(paths.databasePath, 0o600);

    // 3. Pragmas, each read back. journal_mode defaults to `delete` and busy_timeout to 0, so a
    //    second writer would fail instantly instead of waiting; neither may be assumed to have
    //    taken effect just because the statement ran without error.
    applyPragmas(db, busyTimeoutMs);

    // 4. The version gate before the schema: a file from a newer build must not be touched by this
    //    one's CREATE statements either, since a renamed table would silently be recreated empty.
    const schemaVersion = readUserVersion(db);
    const writable = schemaVersion <= HISTORY_SCHEMA_VERSION;
    if (writable) {
        createSchema(db, schemaVersion);
    }

    return createStore(db, paths.databasePath, schemaVersion, writable);
}

/** Wraps {@link openHistoryStore} in the open-once memoization described on {@link HistoryStoreHandle}. */
export function createHistoryStoreHandle(options: HistoryStoreOptions = {}): HistoryStoreHandle {
    let openPromise: Promise<HistoryStore> | undefined;

    return {
        ensureOpen: (): Promise<HistoryStore> => {
            if (openPromise === undefined) {
                // The memoised promise is the lock, but only a FULFILLED one is worth keeping. Cached,
                // a rejection (a directory that briefly could not be created, a pragma lost to a
                // competing process) would be handed to every later caller and the tool would stay
                // broken until the MCP server restarts, which is the whole process lifetime.
                const attempt: Promise<HistoryStore> = openHistoryStore(options).catch((error: unknown) => {
                    if (openPromise === attempt) {
                        openPromise = undefined;
                    }

                    throw error;
                });
                openPromise = attempt;
            }

            return openPromise;
        },
        close: async (): Promise<void> => {
            if (openPromise === undefined) {
                return;
            }

            const pending = openPromise;
            openPromise = undefined;
            const store = await pending;
            store.close();
        },
    };
}

// ---------------------------------------------------------------------------
// Opening
// ---------------------------------------------------------------------------

/**
 * The single point where the sqlite specifier appears, and it is inside a function body on purpose.
 *
 * A Node without `node:sqlite` loses this one tool; a top-level import would take the whole MCP
 * server down with it, because the server module is reachable from the CLI entrypoint.
 */
async function loadSqlite(): Promise<SqliteModule> {
    try {
        const loaded: SqliteModule = await import("node:sqlite");

        return loaded;
    } catch (error) {
        throw new Error(
            "the history archive needs the node:sqlite builtin, which requires Node 22.13.0 or newer",
            { cause: error },
        );
    }
}

/**
 * Sets the three connection pragmas and verifies each one actually took.
 *
 * `busy_timeout` goes FIRST because the `journal_mode` conversion is itself a lock-taking statement
 * and sqlite's default timeout is 0. Measured on node v22.17.1 against a fresh `delete`-mode file
 * held open by a reader: the conversion fails with `database is locked` (errcode 5) after 0 ms with
 * no timeout set, and waits 329 ms when a 300 ms timeout was set first. So the old order exposed the
 * very first open on a machine, where two `ac` processes both try to convert, to an instant failure.
 * (A competing WRITER is a different shape: the conversion never calls the busy handler for that
 * one, failing in 0 ms either way, which is why `openHistoryStore` failing here is still reachable.)
 */
function applyPragmas(db: SqliteDatabase, busyTimeoutMs: number): void {
    db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");

    assertPragma(db, "PRAGMA journal_mode", "journal_mode", "wal");
    assertPragma(db, "PRAGMA busy_timeout", "timeout", busyTimeoutMs);
    assertPragma(db, "PRAGMA synchronous", "synchronous", SYNCHRONOUS_NORMAL);
}

/** Reads one pragma back and refuses to continue when it does not hold the value just set. */
function assertPragma(db: SqliteDatabase, sql: string, column: string, expected: string | number): void {
    const actual = db.prepare(sql).get()?.[column];
    if (actual !== expected) {
        throw new Error(`${sql} read back as ${String(actual)} instead of ${String(expected)}`);
    }
}

function readUserVersion(db: SqliteDatabase): number {
    const value = db.prepare("PRAGMA user_version").get()?.["user_version"];

    return typeof value === "number" ? value : 0;
}

/**
 * Creates the schema and stamps the version, both inside one transaction so two processes opening
 * the same fresh file cannot each get half of it.
 */
function createSchema(db: SqliteDatabase, currentVersion: number): void {
    db.exec("BEGIN IMMEDIATE");
    let open = true;
    try {
        for (const statement of SCHEMA_STATEMENTS) {
            db.exec(statement);
        }
        if (currentVersion < HISTORY_SCHEMA_VERSION) {
            db.exec(`PRAGMA user_version = ${HISTORY_SCHEMA_VERSION}`);
        }
        db.exec("COMMIT");
        // Cleared only once the COMMIT has actually returned: a COMMIT that throws leaves sqlite's
        // transaction OPEN (measured under contention), and clearing the flag first would skip the
        // rollback below and hand the caller a connection stuck inside a transaction for good.
        open = false;
    } finally {
        if (open) {
            rollbackQuietly(db);
        }
    }
}

/**
 * Rolls back, tolerating the one error that means the rollback was unnecessary.
 *
 * Some failures roll their own transaction back before throwing: measured on node v22.17.1, a write
 * that exceeds `max_page_count` throws `database or disk is full` (errcode 13) with the transaction
 * already gone, so the explicit ROLLBACK then throws `cannot rollback - no transaction is active`
 * (errcode 1, `ERR_SQLITE_ERROR`). Since `isBusyError` correctly refuses errcode 1, that second
 * error would propagate in place of the first and the caller would be told the rollback failed
 * instead of that the disk is full. Anything else propagates: a rollback that fails for a reason we
 * do not recognize is real news.
 */
function rollbackQuietly(db: SqliteDatabase): void {
    try {
        db.exec("ROLLBACK");
    } catch (error) {
        if (!isNoTransactionError(error)) {
            throw error;
        }
    }
}

// ---------------------------------------------------------------------------
// The store itself
// ---------------------------------------------------------------------------

const INSERT_TURN_SQL = `INSERT OR IGNORE INTO turns
    (uuid, session_id, project_path, ts, role, kind, is_sub, agent_type, body)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const INSERT_TURN_INDEX_SQL = "INSERT INTO turns_fts(rowid, body) VALUES (?, ?)";

const INSERT_QUARANTINE_SQL = `INSERT OR IGNORE INTO quarantine
    (session_id, project_path, source_path, seen_at, raw)
    VALUES (?, ?, ?, ?, ?)`;

const UPSERT_SESSION_SQL = `INSERT INTO sessions
    (session_id, project_path, title, first_prompt, mtime, is_sub, agent_type)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
        project_path = excluded.project_path,
        title = excluded.title,
        first_prompt = excluded.first_prompt,
        mtime = excluded.mtime,
        is_sub = excluded.is_sub,
        agent_type = excluded.agent_type`;

const UPSERT_MANIFEST_SQL = `INSERT INTO manifest
    (transcript_key, session_id, cursor, head_fingerprint, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(transcript_key) DO UPDATE SET
        session_id = excluded.session_id,
        cursor = excluded.cursor,
        head_fingerprint = excluded.head_fingerprint,
        updated_at = excluded.updated_at`;

const SELECT_MANIFEST_SQL = "SELECT cursor, head_fingerprint FROM manifest WHERE transcript_key = ?";

/** A body already run through {@link redact}, paired with the row it belongs to. */
interface RedactedRow {
    readonly row: DistillRow;
    readonly body: string;
}

function createStore(
    db: SqliteDatabase,
    databasePath: string,
    schemaVersion: number,
    writable: boolean,
): HistoryStore {
    // Tracked here rather than through `DatabaseSync.isTransaction`, which only exists from Node
    // 22.16.0 while this feature's floor is 22.13.0; on the versions in between the getter reads
    // `undefined` and a rollback would be skipped, leaving a write transaction open for good.
    let inTransaction = false;
    let closed = false;

    function assertWritable(): void {
        if (writable) {
            return;
        }

        throw new Error(
            `the history archive at ${databasePath} reports schema version ${schemaVersion}, but this build of `
            + `ac knows version ${HISTORY_SCHEMA_VERSION}; upgrade ac to write to this archive`,
        );
    }

    function begin(): void {
        db.exec("BEGIN IMMEDIATE");
        inTransaction = true;
    }

    function commit(): void {
        db.exec("COMMIT");
        // After the exec, never before. A COMMIT that throws leaves sqlite's transaction OPEN
        // (measured: `database is locked`, errcode 5, under a reader holding SHARED in rollback-journal
        // mode), so a flag cleared first makes `rollback()` believe there is nothing to roll back. The
        // transaction then stays open on a long-lived connection and every later call throws `cannot
        // start a transaction within a transaction`, errcode 1, which is not a busy error and so takes
        // down the search rather than degrading it.
        inTransaction = false;
    }

    function rollback(): void {
        if (!inTransaction) {
            return;
        }
        inTransaction = false;
        rollbackQuietly(db);
    }

    function readManifest(transcriptKey: string): HistoryManifestEntry | undefined {
        const row = db.prepare(SELECT_MANIFEST_SQL).get(transcriptKey);
        if (row === undefined) {
            return undefined;
        }

        return {
            cursor: Number(row["cursor"]),
            headFingerprint: String(row["head_fingerprint"]),
        };
    }

    function writeSession(record: HistorySessionRecord, counts: Record<string, number>): void {
        db.prepare(UPSERT_SESSION_SQL).run(
            record.sessionId,
            record.projectPath ?? null,
            record.title === undefined ? null : redactInto(record.title, counts),
            redactInto(record.firstPrompt, counts),
            record.mtime ?? null,
            record.isSubagent ? 1 : 0,
            record.agentType ?? null,
        );
    }

    /**
     * Writes one file's rows, quarantine lines, session metadata and cursor in a single
     * `BEGIN IMMEDIATE` transaction, so a reader never sees half a file and a crash leaves the
     * cursor where it was rather than past rows that never landed.
     */
    function ingest(request: HistoryIngestRequest): HistoryIngestResult {
        assertWritable();

        // 1. Redact before taking the write lock. It is pure CPU work over possibly thousands of
        //    rows, and holding the lock through it would stall every other `ac` process for no
        //    reason. Counts cover every redacted row, including ones a duplicate uuid then ignores.
        const redactions: Record<string, number> = {};
        const rows: RedactedRow[] = request.rows.map((row) => ({
            row,
            body: redactInto(row.body, redactions),
        }));
        const quarantined = (request.quarantined ?? []).map((entry) => ({
            entry,
            raw: redactInto(entry.raw, redactions),
        }));

        try {
            begin();
        } catch (error) {
            if (!isBusyError(error)) {
                throw error;
            }

            return emptyIngestResult(redactions, { busy: true });
        }

        try {
            // 2. Re-read the cursor INSIDE the transaction. `priorCursor` was read before the lock
            //    existed, so a concurrent sync may already have taken this delta and more; when it
            //    has, this pass writes nothing and leaves the further-along cursor alone. The
            //    fingerprint has to match for that to hold: a different head means the file was
            //    rewritten, the caller is doing a full re-read, and the cursor legitimately moves
            //    backwards.
            const stored = readManifest(request.transcriptKey);
            if (stored !== undefined
                && stored.headFingerprint === request.headFingerprint
                && stored.cursor >= request.cursor) {
                rollback();

                return emptyIngestResult(redactions, { skipped: true });
            }

            const result = writeAll(request, rows, quarantined, redactions);
            commit();

            return result;
        } catch (error) {
            rollback();
            if (!isBusyError(error)) {
                throw error;
            }

            return emptyIngestResult(redactions, { busy: true });
        }
    }

    /** The body of the ingest transaction, split out so the lock-handling above stays readable. */
    function writeAll(
        request: HistoryIngestRequest,
        rows: readonly RedactedRow[],
        quarantined: readonly { entry: HistoryQuarantineEntry; raw: string }[],
        redactions: Record<string, number>,
    ): HistoryIngestResult {
        const insertTurn = db.prepare(INSERT_TURN_SQL);
        const insertIndex = db.prepare(INSERT_TURN_INDEX_SQL);
        let rowsAdded = 0;

        // 1. One insert per row, then the matching index insert for the ones that actually landed.
        //    The external-content index is not maintained by sqlite, so skipping this leaves every
        //    search empty with no error; and indexing a row whose uuid was ignored would put a
        //    duplicate entry in the index, which is why `changes` decides rather than the row list.
        for (const { row, body } of rows) {
            const outcome = insertTurn.run(
                row.id,
                row.sessionId,
                row.projectPath,
                row.ts ?? null,
                row.role,
                row.kind,
                row.isSubagent ? 1 : 0,
                row.agentType ?? null,
                body,
            );

            if (Number(outcome.changes) === 0) {
                continue;
            }

            insertIndex.run(Number(outcome.lastInsertRowid), body);
            rowsAdded += 1;
        }

        // 2. Quarantined lines, deduplicated on (source_path, raw) so re-reading an unchanged file
        //    does not grow the table.
        const insertQuarantine = db.prepare(INSERT_QUARANTINE_SQL);
        const seenAt = Date.now();
        let quarantinedCount = 0;
        for (const { entry, raw } of quarantined) {
            const outcome = insertQuarantine.run(
                entry.sessionId ?? null,
                entry.projectPath ?? null,
                entry.sourcePath,
                seenAt,
                raw,
            );
            quarantinedCount += Number(outcome.changes) === 0 ? 0 : 1;
        }

        if (request.session !== undefined) {
            writeSession(request.session, redactions);
        }

        // 3. The cursor last: it is the record of what the statements above accomplished, so it must
        //    not be visible to another process before them.
        db.prepare(UPSERT_MANIFEST_SQL).run(
            request.transcriptKey,
            request.sessionId,
            request.cursor,
            request.headFingerprint,
            seenAt,
        );

        return {
            rowsAdded,
            rowsIgnored: rows.length - rowsAdded,
            quarantined: quarantinedCount,
            redactions,
            skipped: false,
            busy: false,
        };
    }

    /**
     * The only code path that removes rows.
     *
     * Row removal lives in exactly one function because the archive is the only copy of a turn once
     * `cleanupPeriodDays` has taken its transcript, so the sync path must have no way to reach it.
     * The index is restored with a single `rebuild` rather than per-row index maintenance: rows
     * genuinely disappear here, this runs on an explicit user command rather than on every sync, and
     * the roughly 1.5 s cost is paid once instead of per row.
     */
    function forget(filter: HistoryForgetFilter): HistoryForgetResult {
        assertWritable();

        const turns = buildForgetClauses(filter, {
            path: "project_path",
            time: "ts",
        });
        if (turns.clauses.length === 0) {
            throw new Error("forget needs at least one of sessionId, projectPath or before");
        }

        const sessions = buildForgetClauses(filter, {
            path: "project_path",
            time: "mtime",
        });
        const quarantine = buildForgetClauses(
            { sessionId: filter.sessionId, projectPath: filter.projectPath },
            { path: "project_path", time: undefined },
        );

        try {
            begin();
        } catch (error) {
            if (!isBusyError(error)) {
                throw error;
            }

            return { turnsRemoved: 0, sessionsRemoved: 0, quarantineRemoved: 0, busy: true };
        }

        try {
            const turnsRemoved = Number(
                db.prepare(`DELETE FROM turns WHERE ${turns.clauses.join(" AND ")}`).run(...turns.params).changes,
            );
            const sessionsRemoved = Number(
                db.prepare(`DELETE FROM sessions WHERE ${sessions.clauses.join(" AND ")}`)
                    .run(...sessions.params).changes,
            );
            const quarantineRemoved = quarantine.clauses.length === 0
                ? 0
                : Number(
                    db.prepare(`DELETE FROM quarantine WHERE ${quarantine.clauses.join(" AND ")}`)
                        .run(...quarantine.params).changes,
                );

            // The external-content index still points at the rowids just removed, and no per-row
            // fix-up is possible after the content row is gone, so the index is rebuilt from what
            // remains.
            db.exec("INSERT INTO turns_fts(turns_fts) VALUES('rebuild')");
            commit();

            return { turnsRemoved, sessionsRemoved, quarantineRemoved, busy: false };
        } catch (error) {
            rollback();
            if (!isBusyError(error)) {
                throw error;
            }

            return { turnsRemoved: 0, sessionsRemoved: 0, quarantineRemoved: 0, busy: true };
        }
    }

    return {
        databasePath,
        schemaVersion,
        writable,
        getManifestEntry: readManifest,
        ingest,
        upsertSession: (record: HistorySessionRecord): void => {
            assertWritable();
            writeSession(record, {});
        },
        lookupSessions: (sessionIds: readonly string[]): Map<string, HistorySessionRecord> => {
            const found = new Map<string, HistorySessionRecord>();
            for (const chunk of chunkIds(sessionIds)) {
                const placeholders = chunk.map(() => "?").join(", ");
                const rows = db
                    .prepare(
                        "SELECT session_id, project_path, title, first_prompt, mtime, is_sub, agent_type "
                        + `FROM sessions WHERE session_id IN (${placeholders})`,
                    )
                    .all(...chunk);
                for (const row of rows) {
                    const record = toSessionRecord(row);
                    found.set(record.sessionId, record);
                }
            }

            return found;
        },
        select: (statement: SqlStatement): readonly HistoryResultRow[] => (
            db.prepare(statement.sql).all(...statement.params)
        ),
        forget,
        close: (): void => {
            if (closed) {
                return;
            }
            closed = true;
            db.close();
        },
    };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Redacts one body, folding its hit counts into the caller's running total.
 *
 * The accumulator is keyed by plain string rather than by {@link RedactKind}, because
 * `Object.entries` widens a key union to `string` and recovering it would need a type assertion for
 * no gain: the map is assignable to the public `Partial<Record<RedactKind, number>>` shape as it is.
 */
function redactInto(text: string, counts: Record<string, number>): string {
    const result = redact(text);
    for (const [kind, hits] of Object.entries(result.counts)) {
        counts[kind] = (counts[kind] ?? 0) + (hits ?? 0);
    }

    return result.text;
}

function emptyIngestResult(
    redactions: Record<string, number>,
    flags: { skipped?: boolean; busy?: boolean },
): HistoryIngestResult {
    return {
        rowsAdded: 0,
        rowsIgnored: 0,
        quarantined: 0,
        redactions,
        skipped: flags.skipped === true,
        busy: flags.busy === true,
    };
}

/**
 * Renders a forget filter into clauses plus bound parameters for one table.
 *
 * `columns.time` names the table's own age column, or is undefined for a table that has no
 * comparable one, in which case an age filter contributes nothing rather than guessing.
 */
function buildForgetClauses(
    filter: HistoryForgetFilter,
    columns: { path: string; time: string | undefined },
): { clauses: string[]; params: SqliteInputValue[] } {
    const clauses: string[] = [];
    const params: SqliteInputValue[] = [];

    if (filter.sessionId !== undefined) {
        clauses.push("session_id = ?");
        params.push(filter.sessionId);
    }
    if (filter.projectPath !== undefined) {
        clauses.push(`${columns.path} = ?`);
        params.push(filter.projectPath);
    }
    if (filter.before !== undefined && columns.time !== undefined) {
        clauses.push(`${columns.time} < ?`);
        params.push(filter.before);
    }

    return { clauses, params };
}

/** Splits an id list into bind-parameter-sized chunks, since sqlite caps variables per statement. */
function chunkIds(sessionIds: readonly string[]): string[][] {
    const chunks: string[][] = [];
    for (let index = 0; index < sessionIds.length; index += LOOKUP_CHUNK_SIZE) {
        chunks.push([...sessionIds.slice(index, index + LOOKUP_CHUNK_SIZE)]);
    }

    return chunks;
}

function toSessionRecord(row: Record<string, HistoryCellValue>): HistorySessionRecord {
    return {
        sessionId: String(row["session_id"]),
        projectPath: asText(row["project_path"]),
        title: asText(row["title"]),
        firstPrompt: asText(row["first_prompt"]) ?? "",
        mtime: asNumber(row["mtime"]),
        isSubagent: Number(row["is_sub"]) === 1,
        agentType: asText(row["agent_type"]),
    };
}

function asText(value: HistoryCellValue | undefined): string | undefined {
    return typeof value === "string" ? value : undefined;
}

function asNumber(value: HistoryCellValue | undefined): number | undefined {
    return typeof value === "number" ? value : undefined;
}

/**
 * Recognizes a lock contention error, which is a degraded pass rather than a failure.
 *
 * `SQLITE_BUSY` (5) and `SQLITE_LOCKED` (6), including their extended forms. Measured on node
 * v22.17.1, a blocked writer throws an `Error` with `code: "ERR_SQLITE_ERROR"`, `errcode: 5` and
 * `errstr: "database is locked"`.
 */
function isBusyError(error: unknown): boolean {
    const primary = primaryResultCode(error);

    return primary === 5 || primary === 6;
}

/**
 * Recognizes the one rollback failure that carries no information: there was nothing to roll back.
 *
 * Errcode 1 is `SQLITE_ERROR`, which covers every SQL logic error, so the message has to narrow it:
 * matching on errcode alone would swallow a genuine failure. Measured message on node v22.17.1:
 * `cannot rollback - no transaction is active`.
 */
function isNoTransactionError(error: unknown): boolean {
    return primaryResultCode(error) === 1
        && error instanceof Error
        && error.message.includes("no transaction is active");
}

/** The primary sqlite result code behind a thrown error, or undefined when it is not a sqlite error. */
function primaryResultCode(error: unknown): number | undefined {
    if (!(error instanceof Error) || !("errcode" in error)) {
        return undefined;
    }

    const errcode = error.errcode;
    if (typeof errcode !== "number") {
        return undefined;
    }

    // Extended result codes carry the primary code in the low eight bits, so masking catches
    // `SQLITE_BUSY_SNAPSHOT` and friends alongside plain `SQLITE_BUSY`.
    return errcode & 0xff;
}
