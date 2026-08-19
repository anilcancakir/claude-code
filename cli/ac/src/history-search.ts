import { homedir } from "node:os";
import { join } from "node:path";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import {
    buildContentQuery,
    buildCountQuery,
    buildReadQuery,
    buildSessionRowCountQuery,
    buildSessionsQuery,
    toMatchExpression,
} from "./history-query.ts";
import type { HistoryQueryFilters, SqlStatement } from "./history-query.ts";
import { renderContent, renderCount, renderRead, renderSessions } from "./history-format.ts";
import type { ContentHitRow, CountRow, ReadHitRow, SessionHitRow } from "./history-format.ts";
import { syncArchive } from "./history-sync.ts";
import type { HistorySyncDeps, HistorySyncOptions, HistorySyncReport } from "./history-sync.ts";
import type {
    HistoryCellValue,
    HistoryForgetFilter,
    HistoryForgetResult,
    HistoryIngestRequest,
    HistoryIngestResult,
    HistoryResultRow,
    HistorySessionRecord,
    HistoryStore,
} from "./history-store.ts";
import type { HistoryManifestEntry } from "./history-cursor.ts";

/**
 * Search execution: the one module that composes the sync, the query builders, the store and the
 * renderers into the finished text an MCP caller or the CLI reads.
 *
 * Three properties of this module are load-bearing.
 *
 * **The store arrives injected and is only ever `import type`d here.** A value import would pull
 * `history-store.ts` into this module's static graph, and with it `node:sqlite`, which `bun test`
 * cannot load at all. `deps.store` is the seam: `history-search.test.ts` drives the whole argument
 * gate, filter plumbing, mode dispatch and dedup against a fake store, while
 * `history-search.node-check.ts` proves the composed path against a real archive under the Node
 * runner.
 *
 * **`session_id` and `path` never reach the filesystem.** `session_id` is an opaque database key,
 * bound as a parameter against `turns.session_id`; `path` is a LIKE filter on the stored
 * `project_path` column. Neither is ever joined into a path, so a traversal-shaped value has no
 * target to reach. It is still refused rather than normalized, following the same refuse-do-not-
 * repair rule as `local-fetch.ts:105-202`: a `..` segment or a path separator in a session id has no
 * legitimate meaning, and quietly rewriting one into something plausible is how a traversal becomes
 * a silent success if a later caller ever does build a path from it.
 *
 * **The sync runs before every search, never conditionally on cost.** A stale answer is worse than
 * a slow one, and a warm no-change pass is about 30 ms (a walk plus one `stat` per file). The two
 * exceptions are both degradations rather than optimizations, and each one announces itself in the
 * first line of the output: a lock-contended write, and an archive written by a newer build.
 */

/** The four shapes a search can return, named exactly as the tool schema's `output_mode` enum. */
export type HistoryOutputMode = "content" | "sessions" | "count" | "read";

/** Default page size when the caller names none. Exported so the tool schema states the same number. */
export const HISTORY_HEAD_LIMIT_DEFAULT = 20;

/**
 * Largest page a caller may ask for.
 *
 * The renderers cut on a byte budget well before this, so the bound exists to refuse an absurd
 * request early rather than to shape normal output. Exported so the tool schema's `maximum` and
 * this validation cannot drift apart.
 */
export const HISTORY_HEAD_LIMIT_MAX = 100;

/**
 * Longest session id accepted. Real ids are 36-character UUIDs; the slack absorbs a future format
 * without accepting a value long enough to be an attempt at something else.
 */
const SESSION_ID_MAX_LENGTH = 128;

const BUSY_NOTICE = "Note: another writer held the archive lock, so this search ran against the last "
    + "committed snapshot; the newest turns may be missing until the next call.";

const READ_ONLY_NOTICE = "Note: this archive was written by a newer build of ac, so it was searched "
    + "without syncing; upgrade ac to keep it current.";

/**
 * Search arguments, in the tool schema's own snake_case vocabulary.
 *
 * Deliberately loose: both callers hold text they did not author (the model's tool arguments, the
 * CLI's option strings), so narrowing is this module's job rather than its callers' precondition.
 * Every bad field raises `McpError(ErrorCode.InvalidParams)`, which the tool boundary propagates
 * unchanged because a caller error is a protocol answer, not an execution failure.
 */
export interface HistorySearchArgs {
    readonly pattern?: string;
    readonly path?: string;
    readonly output_mode?: string;
    readonly head_limit?: number;
    readonly offset?: number;
    readonly since?: string;
    readonly until?: string;
    readonly role?: string;
    readonly kind?: string;
    readonly include_subagents?: boolean;
    readonly agent_type?: string;
    readonly session_id?: string;
}

/** The sync entrypoint, injectable so the bun suite can prove the ordering without walking a tree. */
export type SyncArchiveFn = (opts: HistorySyncOptions) => Promise<HistorySyncReport>;

/** Collaborators a search needs. Only `store` is required; everything else has a production default. */
export interface HistorySearchDeps {
    readonly store: HistoryStore;
    /** Transcript root to sync from. Defaults to {@link resolveProjectsRoot}. */
    readonly projectsRoot?: string;
    /** Environment used to resolve the default projects root. Defaults to `process.env`. */
    readonly env?: Record<string, string | undefined>;
    /** Home directory used to resolve the default projects root. Defaults to `os.homedir()`. */
    readonly home?: string;
    /** Filesystem seam handed to the sync. */
    readonly fs?: HistorySyncDeps;
    /** Sync implementation. Defaults to `syncArchive`. */
    readonly sync?: SyncArchiveFn;
    /** Clock for the renderers' relative ages. Defaults to `Date.now()`. */
    readonly now?: number;
}

/** What validation produced: every caller value narrowed, escaped and paired with its own wording. */
interface SearchRequest {
    readonly mode: HistoryOutputMode;
    readonly match: string;
    readonly filters: HistoryQueryFilters;
    readonly headLimit: number;
    readonly offset: number;
    readonly sessionId: string | undefined;
    /** Human-readable list of what was applied, so an empty result can name it. */
    readonly appliedFilters: readonly string[];
}

/**
 * Resolves the Claude Code transcript root a sync walks.
 *
 * `CLAUDE_CONFIG_DIR` wins when set, because Claude Code relocates its whole storage that way, so
 * an archive built from a relocated corpus has to follow it. Mirrors `resolveArchivePaths` in
 * `history-store.ts` and is exported for the same reason: the tool handler and the CLI both need
 * this answer, and two hand-rolled copies of it would drift.
 */
export function resolveProjectsRoot(options: {
    readonly env?: Record<string, string | undefined>;
    readonly home?: string;
} = {}): string {
    const env = options.env ?? process.env;
    const configured = (env["CLAUDE_CONFIG_DIR"] ?? "").trim();
    const base = configured === "" ? join(options.home ?? homedir(), ".claude") : configured;

    return join(base, "projects");
}

/**
 * Syncs the archive, runs the search and renders the answer.
 *
 * @param args Caller arguments in the tool schema's vocabulary.
 * @param deps The store to search, plus optional injection for the sync, the filesystem and the clock.
 * @returns The finished text, never an empty string: a search that matched nothing says so and
 *          names the filters it applied, so a caller can tell a too-narrow filter from an absent topic.
 * @throws McpError with `ErrorCode.InvalidParams` for any bad argument, including a `session_id`
 *         shaped like a path. Anything else that fails propagates as a plain `Error` for the tool
 *         boundary to normalize.
 */
export async function runSearch(args: HistorySearchArgs, deps: HistorySearchDeps): Promise<string> {
    // 1. Validate first, so a hostile or malformed argument never reaches a sync, a query or the
    //    filesystem. Every rejection here happens before any work is done.
    const request = validateArgs(args);

    // 2. Sync before querying, so results are never stale. Both skips below are degradations that
    //    announce themselves in the output rather than silent shortcuts.
    const notices = await syncBeforeSearch(deps);

    // 3. Query and render. The store is handed statements built by `history-query.ts`; this module
    //    never assembles SQL from a caller value.
    const body = executeMode(request, deps);

    return notices.length === 0 ? body : `${notices.join("\n")}\n\n${body}`;
}

/**
 * Runs the pre-search sync and returns the notice lines the outcome earned.
 *
 * The busy signal is observed at the store rather than read off the sync report, because
 * `HistorySyncReport` carries no busy field while `HistoryIngestResult` does: a lock-contended
 * write is a per-file outcome inside the walk, and the walk hands it back one ingest at a time.
 */
async function syncBeforeSearch(deps: HistorySearchDeps): Promise<string[]> {
    // A file whose `user_version` exceeds this build's is readable but not writable, by the store's
    // own design. Attempting the sync anyway would throw on the first file with rows and take the
    // whole search down with it, so the read path runs alone and says so.
    if (!deps.store.writable) {
        return [READ_ONLY_NOTICE];
    }

    const sync = deps.sync ?? syncArchive;
    const observed = observeBusyWrites(deps.store);
    const options: HistorySyncOptions = {
        root: deps.projectsRoot ?? resolveProjectsRoot({ env: deps.env, home: deps.home }),
        store: observed.store,
        ...(deps.fs === undefined ? {} : { fs: deps.fs }),
    };
    const report = await sync(options);

    const notices: string[] = [];
    if (observed.wasBusy()) {
        notices.push(BUSY_NOTICE);
    }

    // A regression the per-file error isolation introduced, caught in review: before it, a read
    // failure threw and the search failed loudly. After it, the walk counts the file and carries on,
    // which is right, but the count died here because the report was discarded. That left a search
    // reporting success against an archive that had silently stopped growing, on a design whose whole
    // premise is that the archive becomes the only copy once `cleanupPeriodDays` takes the
    // transcript. Counting without surfacing is worse than throwing.
    if (report.filesFailed > 0) {
        notices.push(
            `Note: ${report.filesFailed} transcript(s) could not be read this pass, so results may be `
            + "incomplete. Run `ac history index` to see the error.",
        );
    }

    return notices;
}

/**
 * Wraps a store so the search can see whether any write during the sync lost a lock race.
 *
 * Delegation is written out member by member rather than spread, so the wrapper cannot depend on
 * how the underlying store binds its own methods.
 */
function observeBusyWrites(store: HistoryStore): { store: HistoryStore; wasBusy: () => boolean } {
    let busy = false;

    return {
        store: {
            databasePath: store.databasePath,
            schemaVersion: store.schemaVersion,
            writable: store.writable,
            getManifestEntry: (transcriptKey: string): HistoryManifestEntry | undefined => (
                store.getManifestEntry(transcriptKey)
            ),
            ingest: (request: HistoryIngestRequest): HistoryIngestResult => {
                const result = store.ingest(request);
                if (result.busy) {
                    busy = true;
                }

                return result;
            },
            upsertSession: (record: HistorySessionRecord): void => store.upsertSession(record),
            lookupSessions: (sessionIds: readonly string[]): Map<string, HistorySessionRecord> => (
                store.lookupSessions(sessionIds)
            ),
            select: (statement: SqlStatement): readonly HistoryResultRow[] => store.select(statement),
            forget: (filter: HistoryForgetFilter): HistoryForgetResult => store.forget(filter),
            close: (): void => store.close(),
        },
        wasBusy: (): boolean => busy,
    };
}

/** Dispatches to the one renderer the mode calls for. */
function executeMode(request: SearchRequest, deps: HistorySearchDeps): string {
    switch (request.mode) {
        case "content":
            return executeContent(request, deps);
        case "sessions":
            return executeSessions(request, deps);
        case "count":
            return executeCount(request, deps);
        case "read":
            return executeRead(request, deps);
    }
}

/** One hit per matching turn, with an excerpt, ranked by relevance nudged towards the recent. */
function executeContent(request: SearchRequest, deps: HistorySearchDeps): string {
    const rows = deps.store.select(buildContentQuery({
        match: request.match,
        filters: request.filters,
        limit: request.headLimit,
        offset: request.offset,
    }));
    if (rows.length === 0) {
        return emptyResultText(request);
    }

    // The totals query runs only once the page is known non-empty, so an empty search costs one
    // statement rather than two. `totalMatches` is stated relative to this offset, since the pages
    // already paged past are not something this call withheld.
    const totals = selectCounts(request, deps);

    return renderContent(rows.map(toContentHitRow), {
        headLimit: request.headLimit,
        totalMatches: Math.max(0, totals.matches - request.offset),
        ...(deps.now === undefined ? {} : { now: deps.now }),
    });
}

/**
 * One entry per session, titled, so a caller can see which conversations to open.
 *
 * Two things happen here that exist nowhere else. First, the title: `buildSessionsQuery` selects no
 * title column, and the store keeps titles in its own `sessions` table, so this is the seam that
 * resolves them through `lookupSessions` and hands them to the renderer. Second, the dedup: the SQL
 * already groups by session, and this collapses again in memory so the "one entry per session"
 * invariant holds for whatever the store returns rather than only for the grouped shape.
 */
function executeSessions(request: SearchRequest, deps: HistorySearchDeps): string {
    const rows = deps.store.select(buildSessionsQuery({
        match: request.match,
        filters: request.filters,
        limit: request.headLimit,
        offset: request.offset,
    }));
    if (rows.length === 0) {
        return emptyResultText(request);
    }

    const collapsed = collapseBySession(rows.map(toSessionHitRow));
    const titles = deps.store.lookupSessions(collapsed.map((row) => row.session_id));
    const titled = collapsed.map((row) => withTitle(row, titles.get(row.session_id)?.title));
    const totals = selectCounts(request, deps);

    return renderSessions(titled, {
        headLimit: request.headLimit,
        totalSessions: Math.max(0, totals.sessions - request.offset),
        ...(deps.now === undefined ? {} : { now: deps.now }),
    });
}

/** Match, session and project totals, the cheapest way to size a topic before reading it. */
function executeCount(request: SearchRequest, deps: HistorySearchDeps): string {
    const totals = selectCounts(request, deps);
    const line = renderCount(totals);

    // A zero count is a real answer, so the totals line stays and the filter list joins it: without
    // the filters named, a caller cannot tell a too-narrow window from an absent topic.
    return totals.matches === 0 ? `${line}\n\n${emptyExplanation(request)}` : line;
}

/** A chronological window on one session, which is how a caller opens the conversation a hit came from. */
function executeRead(request: SearchRequest, deps: HistorySearchDeps): string {
    const sessionId = request.sessionId;
    if (sessionId === undefined) {
        throw invalidParams("session_id is required when output_mode is read");
    }

    const rows = deps.store.select(buildReadQuery({
        sessionId,
        filters: request.filters,
        limit: request.headLimit,
        offset: request.offset,
    }));
    if (rows.length === 0) {
        return emptyResultText(request);
    }

    const totalRows = selectSessionTurnCount(sessionId, request.filters, deps);

    return renderRead(rows.map(toReadHitRow), {
        sessionId,
        offset: request.offset,
        limit: request.headLimit,
        totalRows,
    });
}

/** Runs the totals query, which every searching mode needs and `read` never does. */
function selectCounts(request: SearchRequest, deps: HistorySearchDeps): CountRow {
    const rows = deps.store.select(buildCountQuery({
        match: request.match,
        filters: request.filters,
    }));
    const row = rows[0];

    return {
        matches: asNumber(row?.["matches"]),
        sessions: asNumber(row?.["sessions"]),
        projects: asNumber(row?.["projects"]),
    };
}

/**
 * Total turns stored for one session, for `read`'s window position and withheld count.
 *
 * Counted over the SAME filters the window was drawn from, so the two numbers describe one row set.
 * An unfiltered count would report a window over 300 main-thread turns as "turns 1-12 of 43,780".
 */
function selectSessionTurnCount(
    sessionId: string,
    filters: HistoryQueryFilters,
    deps: HistorySearchDeps,
): number {
    const rows = deps.store.select(buildSessionRowCountQuery({
        sessionId,
        filters,
    }));

    return asNumber(rows[0]?.["total_turns"]);
}

/**
 * Collapses hit rows to one per session, keeping the best-scoring row and summing the hit counts,
 * then sorts by that best score.
 *
 * FTS5 negates BM25, so the lowest score is the strongest match and ascending order is correct.
 * Summing hits is right for both shapes this can receive: the grouped SQL emits one row per session
 * already, so nothing is summed, and an ungrouped shape's rows each carry a slice of the same
 * session's hits.
 */
function collapseBySession(rows: readonly SessionHitRow[]): SessionHitRow[] {
    const best = new Map<string, SessionHitRow>();

    for (const row of rows) {
        const existing = best.get(row.session_id);
        if (existing === undefined) {
            best.set(row.session_id, row);
            continue;
        }

        const winner = row.score < existing.score ? row : existing;
        best.set(row.session_id, {
            ...winner,
            hits: existing.hits + row.hits,
            first_ts: minTimestamp(existing.first_ts, row.first_ts),
            last_ts: maxTimestamp(existing.last_ts, row.last_ts),
        });
    }

    return [...best.values()].sort((a, b) => a.score - b.score);
}

function minTimestamp(left: number | null, right: number | null): number | null {
    if (left === null) {
        return right;
    }
    if (right === null) {
        return left;
    }

    return Math.min(left, right);
}

function maxTimestamp(left: number | null, right: number | null): number | null {
    if (left === null) {
        return right;
    }
    if (right === null) {
        return left;
    }

    return Math.max(left, right);
}

/** Attaches a resolved title, leaving it absent when the store knows none so the renderer falls back. */
function withTitle(row: SessionHitRow, title: string | undefined): SessionHitRow {
    if (title === undefined || title.trim() === "") {
        return row;
    }

    return { ...row, title };
}

// ---------------------------------------------------------------------------
// Empty results
// ---------------------------------------------------------------------------

/** The headline plus the explanation, for a mode whose row set came back empty. */
function emptyResultText(request: SearchRequest): string {
    const headline = request.mode === "read"
        ? "No turns found for that session in the local Claude Code history archive."
        : "No matches in the local Claude Code history archive.";

    return `${headline}\n\n${emptyExplanation(request)}`;
}

/** Names every filter that was applied, and what a caller should conclude from nothing matching. */
function emptyExplanation(request: SearchRequest): string {
    const applied = request.appliedFilters.length === 0
        ? "Applied filters: none."
        : `Applied filters: ${request.appliedFilters.join(", ")}.`;
    const advice = request.mode === "read"
        ? "Either that session is not in the archive, the offset is past its last turn, or one of the "
            + "filters above excluded every turn in it."
        : "Nothing matched, so either one of those filters is too narrow or the topic is genuinely "
            + "absent; drop a filter or shorten the pattern to tell the two apart.";

    return `${applied}\n${advice}`;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Every caller error in this module carries the protocol's own invalid-argument code. */
function invalidParams(message: string): McpError {
    return new McpError(ErrorCode.InvalidParams, message);
}

/**
 * Narrows and escapes every argument, and builds the human-readable filter list alongside.
 *
 * The list is assembled here rather than re-derived later because this is the one place holding both
 * the caller's own wording and the parsed value, so an empty result can name the ISO timestamp the
 * caller typed instead of the epoch millis the query bound.
 */
function validateArgs(args: HistorySearchArgs): SearchRequest {
    const mode = validateMode(args.output_mode);
    const applied: string[] = [];

    // 1. The text filter. `read` carries none by design, since it opens a window on a session
    //    rather than searching, and `buildReadQuery` has no MATCH clause to bind one to.
    const match = mode === "read" ? "" : validatePattern(args.pattern, applied);

    // 2. The session key. Required for `read`, and shape-checked wherever it appears: a value that
    //    looks like a path is refused outright rather than repaired into something plausible.
    const sessionId = validateSessionId(args.session_id, mode, applied);

    // 3. Paging.
    const headLimit = validateHeadLimit(args.head_limit);
    const offset = validateOffset(args.offset);
    if (mode === "read") {
        applied.push(`offset=${offset}`);
    }

    // 4. Metadata filters, each recorded as it is accepted.
    const filters = validateFilters(args, applied);

    return {
        mode,
        match,
        filters,
        headLimit,
        offset,
        sessionId,
        appliedFilters: applied,
    };
}

function validateMode(value: string | undefined): HistoryOutputMode {
    if (value === undefined) {
        return "content";
    }
    if (value === "content" || value === "sessions" || value === "count" || value === "read") {
        return value;
    }

    throw invalidParams("output_mode must be one of content|sessions|count|read");
}

/** Escapes the pattern into a MATCH expression, refusing one that holds no searchable token. */
function validatePattern(value: string | undefined, applied: string[]): string {
    if (typeof value !== "string") {
        throw invalidParams("pattern is required unless output_mode is read");
    }

    const match = toMatchExpression(value, { prefix: true });
    if (match === "") {
        throw invalidParams("pattern must hold at least one searchable token");
    }

    applied.push(`pattern "${value}" (tokenized full-text with prefix matching, not a regex)`);

    return match;
}

/**
 * Checks a session id's shape and refuses anything path-like.
 *
 * The id is only ever bound as a parameter against `turns.session_id`, so nothing here defends a
 * filesystem read that exists. It defends the one that must never come to exist: a separator or a
 * `..` segment has no legitimate meaning in a session id, and normalizing one away is what turns a
 * traversal attempt into a silent success the day some caller does join it onto a path. A quote, a
 * semicolon or any other SQL metacharacter passes through untouched, because parameter binding is
 * what makes those harmless and rejecting them would only teach a caller the wrong lesson.
 */
function validateSessionId(
    value: string | undefined,
    mode: HistoryOutputMode,
    applied: string[],
): string | undefined {
    if (value === undefined) {
        if (mode === "read") {
            throw invalidParams("session_id is required when output_mode is read");
        }

        return undefined;
    }

    if (typeof value !== "string" || value.trim() === "") {
        throw invalidParams("session_id must be a non-empty string");
    }

    const sessionId = value.trim();
    if (sessionId.length > SESSION_ID_MAX_LENGTH) {
        throw invalidParams(`session_id must be at most ${SESSION_ID_MAX_LENGTH} characters`);
    }
    if (/[/\\]/.test(sessionId)) {
        throw invalidParams("session_id must not contain a path separator; it is a database key, never a path");
    }
    if (sessionId.includes("..")) {
        throw invalidParams("session_id must not contain a '..' segment; it is a database key, never a path");
    }
    if (holdsControlCharacter(sessionId)) {
        throw invalidParams("session_id must not contain a control character");
    }

    if (mode === "read") {
        applied.push(`session_id "${sessionId}"`);
    }

    return sessionId;
}

/**
 * Reports whether a string holds an ASCII control character or DEL.
 *
 * Checked by code point rather than with a character-class regex, so the source file stays plain
 * text: a literal control character inside a pattern makes the file unsearchable with `grep` and
 * invisible in review.
 */
function holdsControlCharacter(value: string): boolean {
    for (const char of value) {
        const code = char.codePointAt(0) ?? 0;
        if (code < 0x20 || code === 0x7f) {
            return true;
        }
    }

    return false;
}

function validateHeadLimit(value: number | undefined): number {
    if (value === undefined) {
        return HISTORY_HEAD_LIMIT_DEFAULT;
    }
    if (!Number.isInteger(value) || value < 1 || value > HISTORY_HEAD_LIMIT_MAX) {
        throw invalidParams(`head_limit must be an integer between 1 and ${HISTORY_HEAD_LIMIT_MAX}`);
    }

    return value;
}

function validateOffset(value: number | undefined): number {
    if (value === undefined) {
        return 0;
    }
    if (!Number.isInteger(value) || value < 0) {
        throw invalidParams("offset must be an integer of 0 or more");
    }

    return value;
}

/** Builds the query filters, recording each accepted one in `applied` as it goes. */
function validateFilters(args: HistorySearchArgs, applied: string[]): HistoryQueryFilters {
    const filters: {
        path?: string;
        since?: number;
        until?: number;
        role?: "user" | "assistant";
        kind?: "prose" | "tool_use" | "tool_error";
        includeSubagents?: boolean;
        agentType?: string;
    } = {};

    const path = optionalText(args.path, "path");
    if (path !== undefined) {
        filters.path = path;
        applied.push(`project path containing "${path}"`);
    }

    const since = optionalTimestamp(args.since, "since");
    if (since !== undefined) {
        filters.since = since;
        applied.push(`since ${new Date(since).toISOString()}`);
    }

    const until = optionalTimestamp(args.until, "until");
    if (until !== undefined) {
        filters.until = until;
        applied.push(`until ${new Date(until).toISOString()}`);
    }

    const role = args.role;
    if (role !== undefined && role !== "any") {
        if (role !== "user" && role !== "assistant") {
            throw invalidParams("role must be one of user|assistant|any");
        }
        filters.role = role;
        applied.push(`role=${role}`);
    }

    const kind = args.kind;
    if (kind !== undefined && kind !== "any") {
        if (kind !== "prose" && kind !== "tool_use" && kind !== "tool_error") {
            throw invalidParams("kind must be one of prose|tool_use|tool_error|any");
        }
        filters.kind = kind;
        applied.push(`kind=${kind}`);
    }

    // Only the exclusion needs a clause; inclusion is the default and adds nothing to either the
    // query or the filter list a caller reads back.
    if (args.include_subagents === false) {
        filters.includeSubagents = false;
        applied.push("subagent turns excluded");
    }

    const agentType = optionalText(args.agent_type, "agent_type");
    if (agentType !== undefined) {
        filters.agentType = agentType;
        applied.push(`agent_type=${agentType}`);
    }

    return filters;
}

/** A text filter, treating whitespace-only as absent: a LIKE on nothing would match everything. */
function optionalText(value: string | undefined, field: string): string | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (typeof value !== "string") {
        throw invalidParams(`${field} must be a string`);
    }

    const trimmed = value.trim();

    return trimmed === "" ? undefined : trimmed;
}

/** Parses an ISO date string into epoch millis, refusing anything `Date.parse` cannot read. */
function optionalTimestamp(value: string | undefined, field: string): number | undefined {
    if (value === undefined) {
        return undefined;
    }

    const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
    if (Number.isNaN(parsed)) {
        throw invalidParams(`${field} must be an ISO 8601 date or date-time string`);
    }

    return parsed;
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

/**
 * The three coercions below narrow raw cells into the renderers' row types.
 *
 * Every column they read is written by this feature's own ingest path from the distiller's enums, so
 * an unexpected value means a corrupted archive rather than caller input. Since the renderers only
 * label with these fields, a fallback keeps a damaged row readable instead of failing a whole search
 * over one cell.
 */
function asText(value: HistoryCellValue | undefined): string {
    if (typeof value === "string") {
        return value;
    }
    if (typeof value === "number" || typeof value === "bigint") {
        return String(value);
    }

    return "";
}

function asNullableText(value: HistoryCellValue | undefined): string | null {
    return typeof value === "string" ? value : null;
}

function asNumber(value: HistoryCellValue | undefined): number {
    if (typeof value === "number") {
        return value;
    }
    if (typeof value === "bigint") {
        return Number(value);
    }
    if (typeof value === "string") {
        const parsed = Number(value);

        return Number.isNaN(parsed) ? 0 : parsed;
    }

    return 0;
}

function asNullableNumber(value: HistoryCellValue | undefined): number | null {
    if (typeof value === "number") {
        return value;
    }
    if (typeof value === "bigint") {
        return Number(value);
    }

    return null;
}

function asRole(value: HistoryCellValue | undefined): "user" | "assistant" {
    return value === "assistant" ? "assistant" : "user";
}

function asKind(value: HistoryCellValue | undefined): "prose" | "tool_use" | "tool_error" {
    if (value === "tool_use") {
        return "tool_use";
    }
    if (value === "tool_error") {
        return "tool_error";
    }

    return "prose";
}

function toContentHitRow(row: HistoryResultRow): ContentHitRow {
    return {
        id: asNumber(row["id"]),
        uuid: asText(row["uuid"]),
        session_id: asText(row["session_id"]),
        project_path: asText(row["project_path"]),
        ts: asNullableNumber(row["ts"]),
        role: asRole(row["role"]),
        kind: asKind(row["kind"]),
        is_sub: asNumber(row["is_sub"]),
        agent_type: asNullableText(row["agent_type"]),
        snippet: asText(row["snippet"]),
    };
}

function toSessionHitRow(row: HistoryResultRow): SessionHitRow {
    return {
        session_id: asText(row["session_id"]),
        project_path: asText(row["project_path"]),
        hits: asNumber(row["hits"]),
        first_ts: asNullableNumber(row["first_ts"]),
        last_ts: asNullableNumber(row["last_ts"]),
        score: asNumber(row["score"]),
    };
}

function toReadHitRow(row: HistoryResultRow): ReadHitRow {
    return {
        id: asNumber(row["id"]),
        uuid: asText(row["uuid"]),
        session_id: asText(row["session_id"]),
        project_path: asText(row["project_path"]),
        ts: asNullableNumber(row["ts"]),
        role: asRole(row["role"]),
        kind: asKind(row["kind"]),
        is_sub: asNumber(row["is_sub"]),
        agent_type: asNullableText(row["agent_type"]),
        body: asText(row["body"]),
    };
}
