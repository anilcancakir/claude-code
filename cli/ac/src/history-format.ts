import { basename } from "node:path";

/**
 * Renders already-fetched rows from the local history archive into the plain text an MCP caller
 * reads. One function per output mode (`content`, `sessions`, `projects`, `count`, `read`), each
 * taking rows
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

/** A row of `history-query.ts`'s `projects` mode. */
export interface ProjectHitRow {
    readonly project_path: string;
    readonly hits: number;
    readonly sessions: number;
    readonly first_ts: number | null;
    readonly last_ts: number | null;
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

/** Paging facts `renderProjects` needs. */
export interface RenderProjectsOptions {
    readonly headLimit: number;
    readonly totalProjects: number;
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

// `read` gets a larger budget than `content` because its whole job is to be readable prose rather
// than a scannable index, but it needs one just as much. Measured on the shipped archive: a single
// turn's `body` reaches 882,668 characters, and the default 20-turn window of the heaviest real
// session renders 124,599 characters, about 31,000 tokens, which is past Claude Code's own 25,000-
// token MCP result cap. Four of the five heaviest sessions cross or brush that cap on a DEFAULT
// call, and `read` is the second half of this tool's central flow (a content hit, then its session),
// so an uncapped renderer would blow the caller's context on ordinary use. Neither test suite could
// have caught it: every fixture body is a few dozen bytes.
const MAX_READ_OUTPUT_BYTES = 16_000;

// Per-row cap as well as a total, so one pathological turn cannot consume the whole window and
// leave the caller with a single truncated message instead of a conversation.
const MAX_READ_ROW_CHARS = 1_200;

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
    return withheld > 0
        ? `${body}\n\n${truncationNotice(withheld, { noun: "hit(s)", narrowable: true })}`
        : body;
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
    return withheld > 0
        ? `${body}\n\n${truncationNotice(withheld, { noun: "session(s)", narrowable: true })}`
        : body;
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
 * Renders the `projects` mode: a leading total, then one line per project, busiest first.
 *
 * The full path rather than `basename`, which is what `content` and `sessions` show. Those two
 * already name a session id the caller can chain on, so a short label is enough to tell hits apart;
 * here the path IS the answer, and two of this machine's projects are called `fluttersdk.com` and
 * `fluttersdk-ai` under one parent, which a basename cannot distinguish.
 */
export function renderProjects(rows: readonly ProjectHitRow[], opts: RenderProjectsOptions): string {
    const now = opts.now ?? Date.now();
    const page = rows.slice(0, opts.headLimit);

    // The total leads, so a caller reading only the first line still learns the size of the answer
    // rather than mistaking one page for all of it.
    const header = `${opts.totalProjects} project(s) matched`;
    const lines = page.map((row) => renderProjectLine(row, now));
    const withheld = Math.max(0, opts.totalProjects - page.length);

    const body = [header, ...lines].join("\n\n");
    return withheld > 0
        ? `${body}\n\n${truncationNotice(withheld, { noun: "project(s)", narrowable: true })}`
        : body;
}

/** Renders one `projects` row. */
function renderProjectLine(row: ProjectHitRow, now: number): string {
    const range = `${formatRelativeAge(row.first_ts, now)} .. ${formatRelativeAge(row.last_ts, now)}`;

    return [
        row.project_path,
        `${row.hits} hit(s)`,
        `${row.sessions} session(s)`,
        range,
    ].join(" | ");
}

/**
 * Renders a contiguous chronological window of one session's rows, with role prefixes and a
 * leading line stating the window's position so the caller can page with `offset`.
 *
 * Two budgets apply, and both are load-bearing rather than defensive. Each turn's body is capped at
 * {@link MAX_READ_ROW_CHARS} on a word boundary, so one pathological turn is SHORTENED rather than
 * dropped: a caller asked to read a conversation, and a silently missing turn is worse than a
 * visibly truncated one. On top of that, turns are added one at a time until the running total would
 * cross {@link MAX_READ_OUTPUT_BYTES}, which covers the position line and the withheld notice too,
 * since the caller's context pays for those as well.
 *
 * The position line is derived from what was actually rendered, never from the requested window.
 * A line naming the request would hand the caller a `next offset` that skips every turn the budget
 * dropped, which turns a display detail into data the caller can never reach.
 */
export function renderRead(rows: readonly ReadHitRow[], opts: RenderReadOptions): string {
    // 1. The caller's own window first; the byte budget below trims further when it has to.
    const window = rows.slice(0, opts.limit);

    // 2. Reserve the framing before measuring any turn, at its longest possible length: the position
    //    line for the full window, and a notice whose count can never exceed `totalRows`.
    const framingBytes = Buffer.byteLength(positionLine(opts, window.length), "utf8")
        + Buffer.byteLength(truncationNotice(opts.totalRows, READ_NOTICE_SHAPE), "utf8")
        + 4; // the two "\n\n" joins that attach them
    const turnBudget = Math.max(0, MAX_READ_OUTPUT_BYTES - framingBytes);

    // 3. Add turns one at a time so the running byte total decides where the cut lands, rather than
    //    rendering everything and slicing the string, which could sever a multi-byte character.
    const blocks: string[] = [];
    let usedBytes = 0;
    for (const row of window) {
        const block = renderReadLine(row);
        const blockBytes = Buffer.byteLength(block, "utf8") + 2; // +2 for the joining "\n\n"
        if (blocks.length > 0 && usedBytes + blockBytes > turnBudget) {
            break;
        }
        blocks.push(block);
        usedBytes += blockBytes;
    }

    // 4. State what was withheld, from both causes: the turns beyond this window, and the ones this
    //    renderer's own budget cut. A caller cannot tell them apart and does not need to.
    const withheldByWindow = Math.max(0, opts.totalRows - (opts.offset + window.length));
    const withheldByBudget = window.length - blocks.length;
    const withheld = withheldByWindow + withheldByBudget;

    const body = [positionLine(opts, blocks.length), ...blocks].join("\n\n");
    return withheld > 0 ? `${body}\n\n${truncationNotice(withheld, READ_NOTICE_SHAPE)}` : body;
}

/** The leading line, stating the window `renderedCount` turns actually cover. */
function positionLine(opts: RenderReadOptions, renderedCount: number): string {
    const end = opts.offset + renderedCount;

    return `session:${opts.sessionId} | turns ${opts.offset + 1}-${end} of ${opts.totalRows}`;
}

/**
 * Renders one `read` row with its role, its `agentType` label when it is a subagent turn, and its
 * body capped on a word boundary.
 *
 * The per-row cap is what keeps the first turn safe to render unconditionally: a single `tool_use`
 * body in the real archive reaches 882,668 characters, so without it the "always render at least one
 * turn" rule above would blow the whole ceiling on its own.
 */
function renderReadLine(row: ReadHitRow): string {
    const label = row.is_sub === 1 && row.agent_type !== null ? `${row.role} (${row.agent_type})` : row.role;
    return `${label}: ${truncateOnWordBoundary(row.body, MAX_READ_ROW_CHARS)}`;
}

/**
 * `read` counts turns and has no pattern, so its notice must not advise narrowing one. Shared
 * between the byte reservation and the emitted line, which have to agree or the reservation
 * under-counts and the output can cross its ceiling.
 */
const READ_NOTICE_SHAPE = { noun: "turn(s)", narrowable: false } as const;

/**
 * The truncation notice every renderer appends when its list was cut, by limit or by budget.
 *
 * The noun and the advice both follow the caller, because one shared wording was wrong in two
 * modes at once: `sessions` counts sessions rather than hits, and `read` has no query to narrow,
 * so telling its caller to narrow one sends them looking for a parameter that does not apply.
 */
function truncationNotice(withheld: number, opts: { noun: string; narrowable: boolean }): string {
    const remedies = opts.narrowable
        ? "increase head_limit, narrow the query, or page with offset"
        : "increase head_limit or page with offset";

    return `[${withheld} ${opts.noun} withheld: ${remedies}]`;
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
