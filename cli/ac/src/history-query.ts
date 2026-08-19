/**
 * FTS5 query construction for the local history archive.
 *
 * Two separate hazards live here, which is why they share one module. The first is that raw user
 * text is not a valid FTS5 query: `node:sqlite` reads as a column filter, `C++` as a syntax error,
 * `a OR` as a dangling operator. Every one of those is an ordinary thing to type, so escaping is a
 * correctness requirement rather than hardening. The second is that FTS5 auxiliary functions
 * (`snippet()`, `bm25()`, `rank`) resolve only against a table named in the OUTER `FROM` clause, so
 * the cheap `rowid IN (SELECT rowid FROM turns_fts ...)` shape silently forecloses excerpts and
 * ranking. Each builder therefore picks its shape from what its mode actually needs.
 *
 * The module produces strings and parameter arrays only. It opens no database and reads no
 * filesystem, which is what lets its whole surface be asserted under `bun test`, where `node:sqlite`
 * cannot load at all.
 */

/** The only parameter types these builders bind. Every caller value arrives as one of these two. */
export type SqlParameter = string | number;

/**
 * A statement and its positional parameters, kept apart on purpose: no builder ever renders a
 * caller value into `sql`, so an injection into the FTS5 query grammar has no entry point.
 */
export interface SqlStatement {
    readonly sql: string;
    readonly params: readonly SqlParameter[];
}

/**
 * Metadata filters, applied against the `turns` table's own b-tree indexed columns rather than
 * against the FTS index, which has no b-tree on any column.
 *
 * Every field is optional and an absent field emits no clause. `role` and `kind` take concrete
 * values only: the tool schema's `"any"` default means "no filter", which callers express by
 * omitting the field. `includeSubagents` is the one inverted flag, since `true` is the default and
 * only `false` needs a clause.
 */
export interface HistoryQueryFilters {
    readonly path?: string;
    readonly since?: number;
    readonly until?: number;
    readonly role?: "user" | "assistant";
    readonly kind?: "prose" | "tool_use" | "tool_error";
    readonly includeSubagents?: boolean;
    readonly agentType?: string;
}

/** A text search with no window, which is all the `count` mode needs. */
export interface HistoryCountQuery {
    readonly match: string;
    readonly filters: HistoryQueryFilters;
}

/** A text search plus the result window the `content` and `sessions` modes page through. */
export interface HistorySearchQuery extends HistoryCountQuery {
    readonly limit: number;
    readonly offset: number;
}

/** A window on one session, addressed by its opaque database key. Carries no search term. */
export interface HistoryReadQuery {
    readonly sessionId: string;
    readonly limit: number;
    readonly offset: number;
}

/**
 * Markers FTS5 wraps around each matched term inside a `snippet()` result. Exported because the
 * formatter preserves them in its output and needs to name them without duplicating the choice.
 */
export const SNIPPET_OPEN_MARKER = "«";

/** Closing counterpart of {@link SNIPPET_OPEN_MARKER}. */
export const SNIPPET_CLOSE_MARKER = "»";

// snippet()'s max_tokens argument must sit in 1..64 (fts5.html 5.1.3). 40 tokens lands near the
// 400-character excerpt the formatter renders, so the trim happens on a word boundary there rather
// than on a token boundary here.
const SNIPPET_MAX_TOKENS = 40;

const SNIPPET_ELLIPSIS = "…";

// FTS5 multiplies BM25 by -1, so a lower score is a better match and plain ascending order is
// correct. The recency term is deliberately tiny: `ts` is epoch millis (about 1.75e12), so dividing
// by 1e15 keeps the nudge under 0.002 while BM25 scores span whole numbers. It breaks ties towards
// the newer turn without letting recency outrank relevance.
//
// COALESCE is not defensive noise. `history-distill.ts` types a row's `ts` as `number | undefined`,
// so a turn whose `timestamp` is absent or unparseable stores NULL. In SQL `bm25(...) - NULL` is
// NULL, and NULL sorts FIRST under ASC, which would silently float every timestamp-less turn to the
// top of every search instead of ranking it. Measured on the real corpus, all 40,302 sampled
// conversational lines carry a string timestamp and `"timestamp":null` never appears, so this is a
// latent path rather than a live bug, but it corrupts ranking without erroring and the archive is
// permanent, so the guard stays.
const RANK_EXPRESSION = "bm25(turns_fts) - (COALESCE(t.ts, 0) / 1e15)";

// Backslash as the LIKE escape character, so a `%` or `_` inside a caller's path is matched
// literally instead of acting as a wildcard. SQLite treats no character as special inside a string
// literal, so '\' is a one-character string.
const LIKE_ESCAPE_CLAUSE = "ESCAPE '\\'";

const TURN_COLUMNS = [
    "t.id AS id",
    "t.uuid AS uuid",
    "t.session_id AS session_id",
    "t.project_path AS project_path",
    "t.ts AS ts",
    "t.role AS role",
    "t.kind AS kind",
    "t.is_sub AS is_sub",
    "t.agent_type AS agent_type",
] as const;

interface FilterFragments {
    readonly clauses: readonly string[];
    readonly params: readonly SqlParameter[];
}

/**
 * Escapes a user pattern into a valid FTS5 MATCH expression.
 *
 * Splits on whitespace, drops empty tokens, wraps each token in double quotes while doubling any
 * internal double quote, and appends the prefix star OUTSIDE the closing quote (`"term"*`, never
 * `"term*"`, per fts5.html 3.1 and 3.3). Tokens join with a single space, which FTS5 reads as an
 * implicit AND. Quoting is what neutralizes `:`, `+`, a leading `-` and a bare `OR`, all of which
 * are query-grammar syntax outside quotes and plain characters inside them.
 *
 * @param pattern Raw text as the caller typed it.
 * @param opts `prefix: true` makes every token a prefix term.
 * @returns The MATCH expression, or an empty string when the pattern holds no tokens. An empty
 *          expression is not a valid MATCH operand (FTS5 throws `syntax error near ""`), so callers
 *          treat it as "no text filter" and the builders here refuse to bind one.
 */
export function toMatchExpression(pattern: string, opts: { prefix: boolean }): string {
    const suffix = opts.prefix ? "*" : "";

    return pattern
        .split(/\s+/)
        .filter((token) => token !== "")
        .map((token) => `"${token.replaceAll("\"", "\"\"")}"${suffix}`)
        .join(" ");
}

/**
 * Builds the `content` mode statement: one row per matching turn, with an excerpt and a ranking.
 *
 * Uses the join shape, because `snippet()` and `bm25()` need `turns_fts` in the outer `FROM`. The
 * FTS table stays unaliased; aliasing it breaks the implicit MATCH operand. Selects the `turns`
 * metadata columns under their own names plus a `snippet` column.
 *
 * @throws Error when `match` is empty, which FTS5 rejects rather than treating as "match all".
 */
export function buildContentQuery(query: HistorySearchQuery): SqlStatement {
    assertNonEmptyMatch(query.match, "content");

    const filters = buildFilterFragments(query.filters);
    const columns = [
        ...TURN_COLUMNS,
        `snippet(turns_fts, 0, '${SNIPPET_OPEN_MARKER}', '${SNIPPET_CLOSE_MARKER}', `
            + `'${SNIPPET_ELLIPSIS}', ${SNIPPET_MAX_TOKENS}) AS snippet`,
    ];

    const sql = [
        `SELECT ${columns.join(", ")}`,
        "FROM turns_fts",
        "JOIN turns t ON t.id = turns_fts.rowid",
        whereClause(filters.clauses),
        `ORDER BY ${RANK_EXPRESSION} ASC`,
        "LIMIT ? OFFSET ?",
    ].join("\n");

    return {
        sql,
        params: [
            query.match,
            ...filters.params,
            query.limit,
            query.offset,
        ],
    };
}

/**
 * Builds the `sessions` mode statement: one row per session, ranked by its best-scoring turn.
 *
 * Collapsing happens in SQL rather than after the fetch, so `LIMIT` counts sessions instead of
 * turns and a single chatty session cannot fill the whole window. `project_path` is aggregated with
 * `MAX` rather than left bare: a relocated session holds more than one path and the renderer needs
 * one deterministic label for it.
 *
 * The nesting is not stylistic. Measured on node v22.17.1 against this schema,
 * `MIN(bm25(turns_fts) - ...)` throws "unable to use function bm25 in the requested context": an
 * FTS5 auxiliary function cannot be evaluated inside an aggregate. So the rank is computed in the
 * inner block, where `turns_fts` is in `FROM` and the context is an ordinary expression, and the
 * outer block aggregates it as a plain column. `MIN` is the best score because FTS5 negates BM25.
 *
 * `MATERIALIZED` is load-bearing for the same reason. On SQLite 3.50.0, both a plain subquery and a
 * plain `WITH hit AS (...)` get flattened into the outer aggregate query, which reintroduces the
 * rejected context; the barrier is what keeps the two blocks separate.
 *
 * @throws Error when `match` is empty.
 */
export function buildSessionsQuery(query: HistorySearchQuery): SqlStatement {
    assertNonEmptyMatch(query.match, "sessions");

    const filters = buildFilterFragments(query.filters);
    const hitColumns = [
        "t.session_id AS session_id",
        "t.project_path AS project_path",
        "t.ts AS ts",
        `${RANK_EXPRESSION} AS score`,
    ];
    const columns = [
        "hit.session_id AS session_id",
        "MAX(hit.project_path) AS project_path",
        "COUNT(*) AS hits",
        "MIN(hit.ts) AS first_ts",
        "MAX(hit.ts) AS last_ts",
        "MIN(hit.score) AS score",
    ];

    const sql = [
        "WITH hit AS MATERIALIZED (",
        `    SELECT ${hitColumns.join(", ")}`,
        "    FROM turns_fts",
        "    JOIN turns t ON t.id = turns_fts.rowid",
        `    ${whereClause(filters.clauses, { indent: "    " })}`,
        ")",
        `SELECT ${columns.join(", ")}`,
        "FROM hit",
        "GROUP BY hit.session_id",
        "ORDER BY score ASC",
        "LIMIT ? OFFSET ?",
    ].join("\n");

    return {
        sql,
        params: [
            query.match,
            ...filters.params,
            query.limit,
            query.offset,
        ],
    };
}

/**
 * Builds the `count` mode statement: match, session and project totals in one row.
 *
 * This is the one mode that needs no auxiliary function, so it takes the cheaper subquery shape and
 * leaves `turns_fts` out of the outer `FROM` entirely. `t.rowid` is `t.id`, since an
 * `INTEGER PRIMARY KEY` column IS the rowid, which is what makes the subquery a direct rowid lookup.
 *
 * @throws Error when `match` is empty.
 */
export function buildCountQuery(query: HistoryCountQuery): SqlStatement {
    assertNonEmptyMatch(query.match, "count");

    const filters = buildFilterFragments(query.filters);
    const columns = [
        "COUNT(*) AS matches",
        "COUNT(DISTINCT t.session_id) AS sessions",
        "COUNT(DISTINCT t.project_path) AS projects",
    ];

    const sql = [
        `SELECT ${columns.join(", ")}`,
        "FROM turns t",
        whereClause([
            "t.rowid IN (SELECT rowid FROM turns_fts WHERE turns_fts MATCH ?)",
            ...filters.clauses,
        ], { withMatch: false }),
    ].join("\n");

    return {
        sql,
        params: [
            query.match,
            ...filters.params,
        ],
    };
}

/**
 * Builds the `read` mode statement: a chronological window on one session, with no MATCH at all.
 *
 * That absence is the point. `read` is how a caller opens the conversation a hit came from, so it
 * has to work with no pattern, and a MATCH clause would both require one and reorder the rows away
 * from reading order. `session_id` is an opaque database key bound as a parameter; it never reaches
 * a filesystem path. The `t.id` tiebreak keeps paging stable when two turns share a millisecond.
 */
export function buildReadQuery(query: HistoryReadQuery): SqlStatement {
    const columns = [
        ...TURN_COLUMNS,
        "t.body AS body",
    ];

    const sql = [
        `SELECT ${columns.join(", ")}`,
        "FROM turns t",
        "WHERE t.session_id = ?",
        "ORDER BY t.ts ASC, t.id ASC",
        "LIMIT ? OFFSET ?",
    ].join("\n");

    return {
        sql,
        params: [
            query.sessionId,
            query.limit,
            query.offset,
        ],
    };
}

/**
 * Refuses an empty MATCH operand.
 *
 * FTS5 answers an empty match expression with `fts5: syntax error near ""`, so binding one turns a
 * whitespace-only pattern into a thrown query. Callers validate the pattern before reaching here;
 * this is the backstop that keeps the invalid statement from ever being built.
 */
function assertNonEmptyMatch(match: string, mode: string): void {
    if (match.trim() === "") {
        throw new Error(`the ${mode} query needs a non-empty MATCH expression; FTS5 rejects an empty one`);
    }
}

/**
 * Renders the metadata filters into clause fragments plus their parameters, in one fixed order so
 * the positional parameters line up with the placeholders as they appear in the text.
 */
function buildFilterFragments(filters: HistoryQueryFilters): FilterFragments {
    const clauses: string[] = [];
    const params: SqlParameter[] = [];

    // 1. Path is a substring match on the stored project path, which subsumes the prefix case and
    //    lets a caller pass a bare directory name. LIKE wildcards inside the value are escaped.
    if (filters.path !== undefined) {
        clauses.push(`t.project_path LIKE ? ${LIKE_ESCAPE_CLAUSE}`);
        params.push(toSubstringPattern(filters.path));
    }

    // 2. The time window is epoch millis against the indexed `ts` column, inclusive at both ends.
    if (filters.since !== undefined) {
        clauses.push("t.ts >= ?");
        params.push(filters.since);
    }
    if (filters.until !== undefined) {
        clauses.push("t.ts <= ?");
        params.push(filters.until);
    }

    if (filters.role !== undefined) {
        clauses.push("t.role = ?");
        params.push(filters.role);
    }
    if (filters.kind !== undefined) {
        clauses.push("t.kind = ?");
        params.push(filters.kind);
    }

    // 3. Only the exclusion needs a clause, and it compares against a literal 0 rather than a bound
    //    value, because the flag is a mode of this query and not a caller-supplied datum.
    if (filters.includeSubagents === false) {
        clauses.push("t.is_sub = 0");
    }

    if (filters.agentType !== undefined) {
        clauses.push("t.agent_type = ?");
        params.push(filters.agentType);
    }

    return {
        clauses,
        params,
    };
}

/** Wraps a caller value as a LIKE substring pattern, escaping the two LIKE wildcards inside it. */
function toSubstringPattern(value: string): string {
    return `%${value.replace(/[\\%_]/g, "\\$&")}%`;
}

/**
 * Assembles the WHERE clause. `withMatch` prepends the FTS operand for the join shape, where the
 * MATCH sits in the outer WHERE; the count shape passes its own subquery in as the first clause.
 * `indent` keeps the continuation lines aligned when the clause sits inside a nested block.
 */
function whereClause(clauses: readonly string[], opts: { withMatch?: boolean; indent?: string } = {}): string {
    const all = opts.withMatch === false ? clauses : ["turns_fts MATCH ?", ...clauses];

    return `WHERE ${all.join(`\n${opts.indent ?? ""}  AND `)}`;
}
