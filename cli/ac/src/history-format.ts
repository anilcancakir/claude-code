import { basename } from "node:path";

/**
 * Renders already-fetched rows from the local history archive into the plain text an MCP caller
 * reads. One function per output mode (`content`, `sessions`, `count`, `read`), each taking rows
 * whose shape mirrors exactly the columns `history-query.ts`'s builders select, plus the paging
 * facts (`head_limit`, `offset`, totals) the caller already knows from its own query.
 *
 * Nothing in this module opens a database or reads a filesystem: every renderer is a pure
 * transform over data handed to it, which is what lets the whole surface be asserted under
 * `bun test`. Two rules apply everywhere: the session id is always visible on a `content` hit,
 * because it is the only handle a caller has to chain into `output_mode: "read"`
 * (`claude-historian` issue #47 recorded metadata-only output making a calling agent dismiss the
 * tool entirely once that chain broke); and a cut list always says how many hits it withheld, so
 * a truncated answer is never mistaken for a complete one.
 */

/** A row of `history-query.ts`'s `content` mode, exactly as `node:sqlite` returns it. */
export interface ContentHitRow {
    readonly id: number;
    readonly uuid: string;
    readonly session_id: string;
    readonly project_path: string;
    readonly ts: number | null;
    readonly role: "user" | "assistant";
    readonly kind: "prose" | "tool_use" | "tool_error";
    readonly is_sub: number;
    readonly agent_type: string | null;
    readonly snippet: string;
}

/**
 * A row of `history-query.ts`'s `sessions` mode, plus an optional `title`.
 *
 * `buildSessionsQuery` never selects a title column, because the plan never declared one on the
 * `sessions` table when Step 3 shipped it. The title arrives as an input this renderer accepts
 * rather than requires, resolved by whichever store method the caller wires in; a session with
 * no resolvable title renders a plain fallback instead of failing.
 */
export interface SessionHitRow {
    readonly session_id: string;
    readonly project_path: string;
    readonly hits: number;
    readonly first_ts: number | null;
    readonly last_ts: number | null;
    readonly score: number;
    readonly title?: string;
}

/** The single row `history-query.ts`'s `count` mode returns. */
export interface CountRow {
    readonly matches: number;
    readonly sessions: number;
    readonly projects: number;
}

/** A row of `history-query.ts`'s `read` mode, exactly as `node:sqlite` returns it. */
export interface ReadHitRow {
    readonly id: number;
    readonly uuid: string;
    readonly session_id: string;
    readonly project_path: string;
    readonly ts: number | null;
    readonly role: "user" | "assistant";
    readonly kind: "prose" | "tool_use" | "tool_error";
    readonly is_sub: number;
    readonly agent_type: string | null;
    readonly body: string;
}

/** Paging and truncation facts `renderContent` needs; the caller already has all three. */
export interface RenderContentOptions {
    readonly headLimit: number;
    readonly totalMatches: number;
    /** Injectable clock for deterministic tests; defaults to `Date.now()`. */
    readonly now?: number;
}

/** Paging facts `renderSessions` needs. */
export interface RenderSessionsOptions {
    readonly headLimit: number;
    readonly totalSessions: number;
    readonly now?: number;
}

/** Window and paging facts `renderRead` needs to report its own position. */
export interface RenderReadOptions {
    readonly sessionId: string;
    readonly offset: number;
    readonly limit: number;
    readonly totalRows: number;
}

// Roughly 8 KB for the default `content` call, well inside Claude Code's 25,000-token MCP result
// cap (Must Have, plan-wide). "Roughly" because the ceiling stops adding hits rather than slicing
// a hit's own text mid-character, so the true output can land a little under it, never far over.
const MAX_CONTENT_OUTPUT_BYTES = 8000;

// "roughly 400 characters on a word boundary" (Step 8 Description). Applied on top of FTS5's own
// `snippet()` truncation, which already targets about this length but is measured in tokens, not
// characters, so a snippet with unusually long tokens could still run over.
const SNIPPET_TRUNCATE_CHARS = 400;

const ELLIPSIS = "…";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * Renders up to `head_limit` `content` hits, one header line plus one snippet line per hit,
 * stopping early if the running total would cross the output ceiling.
 *
 * @param rows Already-fetched hits, in the order the query ranked them.
 * @param opts `totalMatches` is the true count across every page, used to compute how many hits
 *             this call withheld even when none of `rows` itself gets dropped for budget reasons.
 */
export function renderContent(rows: readonly ContentHitRow[], opts: RenderContentOptions): string {
    const now = opts.now ?? Date.now();

    // 1. Apply the caller's own page size first; the byte budget below trims further if needed.
    const page = rows.slice(0, opts.headLimit);

    // 2. Add hits one at a time so the running byte total decides where the budget cuts, rather
    //    than rendering everything and truncating the string, which could sever a multi-byte
    //    character or a marker pair mid-way.
    const blocks: string[] = [];
    let usedBytes = 0;
    for (let index = 0; index < page.length; index++) {
        const row = page[index];
        if (row === undefined) {
            continue;
        }
        const block = renderContentHit(row, index + 1, now);
        const blockBytes = Buffer.byteLength(block, "utf8") + 2; // +2 for the joining "\n\n"
        if (blocks.length > 0 && usedBytes + blockBytes > MAX_CONTENT_OUTPUT_BYTES) {
            break;
        }
        blocks.push(block);
        usedBytes += blockBytes;
    }

    // 3. State what was withheld, whether the cause is the caller's own head_limit or this
    //    renderer's output budget; the caller cannot tell the two apart from the count alone, and
    //    it does not need to.
    const withheldByLimit = Math.max(0, opts.totalMatches - page.length);
    const withheldByBudget = page.length - blocks.length;
    const withheld = withheldByLimit + withheldByBudget;

    const body = blocks.join("\n\n");
    return withheld > 0 ? `${body}\n\n${truncationNotice(withheld)}` : body;
}

/** Renders one `content` hit's header line plus its truncated snippet. */
function renderContentHit(row: ContentHitRow, position: number, now: number): string {
    const fields = [
        `#${position}`,
        formatRelativeAge(row.ts, now),
        basename(row.project_path),
        `session:${row.session_id}`,
        row.kind,
    ];
    if (row.is_sub === 1 && row.agent_type !== null) {
        fields.push(`subagent:${row.agent_type}`);
    }

    return `${fields.join(" | ")}\n${truncateOnWordBoundary(row.snippet, SNIPPET_TRUNCATE_CHARS)}`;
}

/**
 * Renders up to `head_limit` sessions, one line per session naming its resolved title, hit
 * count, project and timestamp range.
 */
export function renderSessions(rows: readonly SessionHitRow[], opts: RenderSessionsOptions): string {
    const now = opts.now ?? Date.now();
    const page = rows.slice(0, opts.headLimit);

    const lines = page.map((row) => renderSessionLine(row, now));
    const withheld = Math.max(0, opts.totalSessions - page.length);

    const body = lines.join("\n\n");
    return withheld > 0 ? `${body}\n\n${truncationNotice(withheld)}` : body;
}

/** Renders one `sessions` row. A missing `title` gets a plain fallback rather than "undefined". */
function renderSessionLine(row: SessionHitRow, now: number): string {
    const title = row.title ?? "(untitled session)";
    const range = `${formatRelativeAge(row.first_ts, now)} .. ${formatRelativeAge(row.last_ts, now)}`;

    return [
        title,
        `${row.hits} hit(s)`,
        basename(row.project_path),
        `session:${row.session_id}`,
        range,
    ].join(" | ");
}

/** Renders the `count` mode's single compact line. */
export function renderCount(row: CountRow): string {
    return `${row.matches} match(es) across ${row.sessions} session(s) in ${row.projects} project(s)`;
}

/**
 * Renders a contiguous chronological window of one session's rows, with role prefixes and a
 * leading line stating the window's position so the caller can page with `offset`.
 */
export function renderRead(rows: readonly ReadHitRow[], opts: RenderReadOptions): string {
    const window = rows.slice(0, opts.limit);
    const windowEnd = opts.offset + window.length;

    const positionLine = `session:${opts.sessionId} | turns ${opts.offset + 1}-${windowEnd} of ${opts.totalRows}`;
    const lines = window.map((row) => renderReadLine(row));

    const withheld = Math.max(0, opts.totalRows - windowEnd);
    const body = [positionLine, ...lines].join("\n\n");
    return withheld > 0 ? `${body}\n\n${truncationNotice(withheld)}` : body;
}

/** Renders one `read` row with its role, and its `agentType` label when it is a subagent turn. */
function renderReadLine(row: ReadHitRow): string {
    const label = row.is_sub === 1 && row.agent_type !== null ? `${row.role} (${row.agent_type})` : row.role;
    return `${label}: ${row.body}`;
}

/** The one truncation notice every renderer appends when its list was cut, by limit or by budget. */
function truncationNotice(withheld: number): string {
    return `[${withheld} hit(s) withheld: increase head_limit, narrow the query, or page with offset]`;
}

/**
 * Cuts `text` at `maxChars` on the nearest earlier whitespace boundary, so a snippet never ends
 * mid-word. Text at or under the limit passes through unchanged.
 */
function truncateOnWordBoundary(text: string, maxChars: number): string {
    if (text.length <= maxChars) {
        return text;
    }

    const slice = text.slice(0, maxChars);
    const lastSpace = slice.lastIndexOf(" ");
    const cut = lastSpace > 0 ? slice.slice(0, lastSpace) : slice;
    return `${cut}${ELLIPSIS}`;
}

/** Renders a timestamp as a short relative age, or a plain fallback when `ts` is absent. */
function formatRelativeAge(ts: number | null | undefined, now: number): string {
    if (ts === null || ts === undefined) {
        return "unknown time";
    }

    const deltaMs = now - ts;
    if (deltaMs < MINUTE_MS) {
        return "just now";
    }
    if (deltaMs < HOUR_MS) {
        return `${Math.floor(deltaMs / MINUTE_MS)}m ago`;
    }
    if (deltaMs < DAY_MS) {
        return `${Math.floor(deltaMs / HOUR_MS)}h ago`;
    }
    return `${Math.floor(deltaMs / DAY_MS)}d ago`;
}
