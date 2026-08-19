import { expect, test } from "bun:test";
import {
    buildContentQuery,
    buildCountQuery,
    buildReadQuery,
    buildSessionRowCountQuery,
    buildSessionsQuery,
    SNIPPET_CLOSE_MARKER,
    SNIPPET_OPEN_MARKER,
    toMatchExpression,
} from "./history-query.ts";
import type { HistoryQueryFilters, SqlStatement } from "./history-query.ts";

// Every value below is hostile on purpose: a quote, a comment opener and a statement terminator.
// Any builder that concatenates rather than binds will show one of them inside its SQL string.
const HOSTILE_PATH = "Code/claude-code'--";
const HOSTILE_AGENT_TYPE = "ac:librarian'; DROP TABLE turns;--";
const HOSTILE_SESSION_ID = "0f2c-1d'; DROP TABLE turns;--";
const HOSTILE_VALUES: readonly string[] = [
    HOSTILE_PATH,
    HOSTILE_AGENT_TYPE,
    HOSTILE_SESSION_ID,
];

const SINCE_MS = 1_700_000_000_000;
const UNTIL_MS = 1_800_000_000_000;

const ALL_FILTERS: HistoryQueryFilters = {
    path: HOSTILE_PATH,
    since: SINCE_MS,
    until: UNTIL_MS,
    role: "assistant",
    kind: "tool_error",
    includeSubagents: false,
    agentType: HOSTILE_AGENT_TYPE,
};

interface NamedStatement {
    readonly name: string;
    readonly statement: SqlStatement;
}

// One corpus of statements the structural tests below sweep, so a fifth builder added later without
// a test of its own is still held to the FROM-clause and aliasing rules.
function everyBuilder(): readonly NamedStatement[] {
    const match = toMatchExpression("node:sqlite'--", { prefix: true });

    return [
        {
            name: "content",
            statement: buildContentQuery({
                match,
                filters: ALL_FILTERS,
                limit: 20,
                offset: 0,
            }),
        },
        {
            name: "sessions",
            statement: buildSessionsQuery({
                match,
                filters: ALL_FILTERS,
                limit: 20,
                offset: 0,
            }),
        },
        {
            name: "count",
            statement: buildCountQuery({
                match,
                filters: ALL_FILTERS,
            }),
        },
        {
            name: "read",
            statement: buildReadQuery({
                sessionId: HOSTILE_SESSION_ID,
                filters: ALL_FILTERS,
                limit: 20,
                offset: 0,
            }),
        },
        {
            name: "sessionRowCount",
            statement: buildSessionRowCountQuery({
                sessionId: HOSTILE_SESSION_ID,
                filters: ALL_FILTERS,
            }),
        },
    ];
}

// Drops every parenthesized group, so what remains is the outer query. FTS5 auxiliary functions
// resolve against the OUTER FROM clause only, which is exactly what a plain `sql.includes("turns_fts")`
// cannot tell apart from a `turns_fts` buried in a subquery.
function stripParenthesizedGroups(sql: string): string {
    let depth = 0;
    let out = "";
    for (const char of sql) {
        if (char === "(") {
            depth += 1;
            continue;
        }
        if (char === ")") {
            depth -= 1;
            continue;
        }
        if (depth === 0) {
            out += char;
        }
    }
    return out;
}

function outerFromClause(sql: string): string {
    const flattened = stripParenthesizedGroups(sql).replace(/\s+/g, " ");
    const found = /\bFROM\b(.*?)(?:\bWHERE\b|\bGROUP BY\b|\bORDER BY\b|\bLIMIT\b|$)/i.exec(flattened);
    const clause = found?.[1];
    if (clause === undefined) {
        throw new Error(`no outer FROM clause in: ${sql}`);
    }
    return clause.trim();
}

// Splits a statement into its query blocks: the outer query with every parenthesized group removed,
// plus one block per parenthesized group, recursively. An auxiliary function resolves against the
// FROM clause of the block that CALLS it, so the structural rule has to be checked per block rather
// than once against the outermost FROM.
function queryBlocks(sql: string): readonly string[] {
    const groups: string[] = [];
    let outer = "";
    let depth = 0;
    let current = "";

    for (const char of sql) {
        if (char === "(") {
            depth += 1;
            if (depth === 1) {
                current = "";
                continue;
            }
        }
        if (char === ")") {
            depth -= 1;
            if (depth === 0) {
                groups.push(current);
                continue;
            }
        }
        if (depth === 0) {
            outer += char;
        } else {
            current += char;
        }
    }

    return [
        outer,
        ...groups.flatMap((group) => queryBlocks(group)),
    ];
}

function tablesIn(fromClause: string): readonly string[] {
    return fromClause.split(/[^A-Za-z0-9_]+/).filter((token) => token !== "");
}

function usesAuxiliaryFunction(sql: string): boolean {
    return sql.includes("snippet(") || sql.includes("bm25(") || /\bORDER BY\s+rank\b/i.test(sql);
}

// Both spellings of an alias break the implicit MATCH operand: the explicit `turns_fts AS f` and the
// implicit `turns_fts f`. A literal check for the first form alone would pass the second.
function aliasesFtsTable(sql: string): boolean {
    const explicit = /\bturns_fts\s+AS\b/i.test(sql);
    const implicit = /\bturns_fts\b(?!\s*\.)\s+(?!(?:AS|JOIN|LEFT|INNER|CROSS|ON|MATCH|WHERE|GROUP|ORDER|LIMIT)\b)[A-Za-z_]/i
        .test(sql);
    return explicit || implicit;
}

function countPlaceholders(sql: string): number {
    return sql.split("?").length - 1;
}

// (1) toMatchExpression: the four inputs measured to throw when passed raw to MATCH.

test("toMatchExpression quotes a colon token, which raw MATCH reads as a column filter", () => {
    expect(toMatchExpression("node:sqlite", { prefix: true })).toBe("\"node:sqlite\"*");
});

test("toMatchExpression quotes C++, whose plus signs are a raw MATCH syntax error", () => {
    expect(toMatchExpression("C++", { prefix: true })).toBe("\"C++\"*");
});

test("toMatchExpression quotes a leading hyphen, which raw MATCH reads as a column filter", () => {
    expect(toMatchExpression("gozden -gecirildi", { prefix: true })).toBe("\"gozden\"* \"-gecirildi\"*");
});

test("toMatchExpression quotes a dangling OR, which raw MATCH reads as an operator", () => {
    expect(toMatchExpression("a OR", { prefix: true })).toBe("\"a\"* \"OR\"*");
});

// (2) toMatchExpression: quoting, whitespace and the empty case.

test("toMatchExpression doubles an internal double quote and emits one token per word", () => {
    const expression = toMatchExpression("he said \"hi\"", { prefix: false });

    expect(expression).toBe("\"he\" \"said\" \"\"\"hi\"\"\"");
    expect(expression.split(" ").length).toBe(3);
});

test("toMatchExpression appends the prefix star outside the closing quote", () => {
    expect(toMatchExpression("frankenphp", { prefix: true })).toBe("\"frankenphp\"*");
    expect(toMatchExpression("frankenphp", { prefix: false })).toBe("\"frankenphp\"");
});

test("toMatchExpression returns an empty string for whitespace-only input", () => {
    expect(toMatchExpression("   ", { prefix: true })).toBe("");
});

test("toMatchExpression drops empty tokens from runs of mixed whitespace", () => {
    expect(toMatchExpression("  alpha \t\n beta  ", { prefix: true })).toBe("\"alpha\"* \"beta\"*");
});

// (3) An empty match expression is refused, because FTS5 throws `syntax error near ""` on one.

test("buildContentQuery refuses an empty match expression", () => {
    expect(() =>
        buildContentQuery({
            match: toMatchExpression("   ", { prefix: true }),
            filters: {},
            limit: 20,
            offset: 0,
        }),
    ).toThrow(/empty/i);
});

test("buildSessionsQuery refuses an empty match expression", () => {
    expect(() =>
        buildSessionsQuery({
            match: "",
            filters: {},
            limit: 20,
            offset: 0,
        }),
    ).toThrow(/empty/i);
});

test("buildCountQuery refuses an empty match expression", () => {
    expect(() =>
        buildCountQuery({
            match: "",
            filters: {},
        }),
    ).toThrow(/empty/i);
});

// (4) The read mode carries no MATCH at all, which is what lets it run with no pattern.

test("buildReadQuery generates no MATCH clause", () => {
    const statement = buildReadQuery({
        sessionId: "0f2c-1d",
        filters: {},
        limit: 50,
        offset: 100,
    });

    expect(statement.sql).not.toContain("MATCH");
    expect(statement.sql).not.toContain("turns_fts");
});

test("buildReadQuery selects one session in chronological order with a window", () => {
    const statement = buildReadQuery({
        sessionId: "0f2c-1d",
        filters: {},
        limit: 50,
        offset: 100,
    });

    expect(statement.sql).toContain("t.session_id = ?");
    expect(statement.sql).toContain("ORDER BY t.ts ASC");
    expect(statement.sql).toContain("LIMIT ? OFFSET ?");
    expect(statement.params).toEqual([
        "0f2c-1d",
        50,
        100,
    ]);
});

// A `read` builder that bound only the session id made `include_subagents`, `role` and `kind` inert
// in that one mode while the caller was still told they had been applied. Measured on the shipped
// archive, 52 of 144 sessions mix main-thread and subagent turns under one session id, worst case
// 27,388 subagent turns against 16,392 main ones, so an ignored exclusion hands back a window made
// almost entirely of what the caller asked to leave out.
test("buildReadQuery binds every metadata filter, so read is not the one mode that ignores them", () => {
    const statement = buildReadQuery({
        sessionId: "0f2c-1d",
        filters: ALL_FILTERS,
        limit: 50,
        offset: 100,
    });

    expect(statement.sql).toContain("t.session_id = ?");
    expect(statement.sql).toContain("t.project_path LIKE ? ESCAPE '\\'");
    expect(statement.sql).toContain("t.role = ?");
    expect(statement.sql).toContain("t.kind = ?");
    expect(statement.sql).toContain("t.is_sub = 0");
    expect(statement.sql).toContain("t.agent_type = ?");
    expect(statement.params).toEqual([
        "0f2c-1d",
        `%${HOSTILE_PATH}%`,
        SINCE_MS,
        UNTIL_MS,
        "assistant",
        "tool_error",
        HOSTILE_AGENT_TYPE,
        50,
        100,
    ]);
});

// The window position and the withheld count are computed against this total, so it has to count
// the same rows `buildReadQuery` selects. Counting the unfiltered session instead would report
// "turns 1-12 of 43,780" for a window drawn from 300 filtered turns.
test("buildSessionRowCountQuery counts exactly the rows the read window is drawn from", () => {
    const filters: HistoryQueryFilters = {
        role: "user",
        kind: "prose",
        includeSubagents: false,
    };
    const count = buildSessionRowCountQuery({
        sessionId: "0f2c-1d",
        filters,
    });
    const read = buildReadQuery({
        sessionId: "0f2c-1d",
        filters,
        limit: 20,
        offset: 0,
    });

    expect(count.sql).toContain("COUNT(*) AS total_turns");
    expect(count.sql).toContain("FROM turns t");
    expect(count.sql).not.toContain("LIMIT");
    expect(count.sql).not.toContain("OFFSET");
    expect(count.params).toEqual([
        "0f2c-1d",
        "user",
        "prose",
    ]);
    // Same WHERE clause as the window it describes, minus the paging the count has no use for.
    const whereOf = (sql: string): string => {
        const start = sql.indexOf("WHERE");
        const end = sql.indexOf("ORDER BY");

        return (end === -1 ? sql.slice(start) : sql.slice(start, end)).trim();
    };
    expect(whereOf(count.sql)).toBe(whereOf(read.sql));
});

// (5) The two query shapes. Auxiliary functions are only reachable when turns_fts is in the outer FROM.

test("content mode joins the FTS table into the outer FROM so snippet and bm25 resolve", () => {
    const statement = buildContentQuery({
        match: "\"alpha\"*",
        filters: {},
        limit: 20,
        offset: 0,
    });

    expect(statement.sql).toContain("snippet(turns_fts, 0,");
    expect(statement.sql).toContain("bm25(turns_fts)");
    expect(tablesIn(outerFromClause(statement.sql))).toContain("turns_fts");
    expect(statement.sql).toContain("JOIN turns t ON t.id = turns_fts.rowid");
    expect(statement.sql).toContain("WHERE turns_fts MATCH ?");
});

test("content mode orders by bm25 ascending with a recency nudge, since FTS5 negates bm25", () => {
    const statement = buildContentQuery({
        match: "\"alpha\"*",
        filters: {},
        limit: 20,
        offset: 0,
    });

    expect(statement.sql).toContain("ORDER BY bm25(turns_fts) - (COALESCE(t.ts, 0) / 1e15) ASC");
});

// A turn whose `timestamp` was absent or unparseable stores NULL, and `bm25(...) - NULL` is NULL,
// which sorts FIRST under ASC. Without COALESCE every timestamp-less turn would outrank every real
// match in every search, silently and without an error.
test("the rank expression is NULL-safe, so a timestamp-less turn cannot outrank a real match", () => {
    for (const { name, statement } of everyBuilder()) {
        if (!statement.sql.includes("bm25(")) {
            continue;
        }
        expect(statement.sql, `${name} must not divide a bare t.ts`).not.toMatch(/\(\s*t\.ts\s*\//);
        expect(statement.sql, `${name} must guard t.ts with COALESCE`).toContain("COALESCE(t.ts, 0)");
    }
});

test("sessions mode collapses to one row per session, ranked by its best-scoring turn", () => {
    const statement = buildSessionsQuery({
        match: "\"alpha\"*",
        filters: {},
        limit: 10,
        offset: 0,
    });

    expect(statement.sql).toContain("GROUP BY hit.session_id");
    expect(statement.sql).toContain("MIN(hit.score) AS score");
    expect(statement.sql).toContain("COUNT(*) AS hits");
    expect(statement.sql).toContain("ORDER BY score ASC");
});

// Measured on node v22.17.1 against this schema: `MIN(bm25(turns_fts) - ...)` throws
// "unable to use function bm25 in the requested context". An FTS5 auxiliary function cannot be
// evaluated inside an aggregate, so the rank is computed in an inner block where it is legal and
// aggregated in the outer one, over an ordinary column by then.
test("sessions mode never calls an FTS5 auxiliary function inside an aggregate", () => {
    const statement = buildSessionsQuery({
        match: "\"alpha\"*",
        filters: {},
        limit: 10,
        offset: 0,
    });

    expect(/\b(?:MIN|MAX|SUM|AVG|COUNT)\s*\(\s*(?:bm25|snippet|highlight)\s*\(/i.test(statement.sql)).toBe(false);
    expect(statement.sql).toContain("bm25(turns_fts) - (COALESCE(t.ts, 0) / 1e15) AS score");
});

// Nesting alone is not enough. Measured on SQLite 3.50.0 as bundled by node v22.17.1: a plain
// subquery and a plain `WITH hit AS (...)` are both flattened into the outer aggregate query, which
// puts bm25 straight back into the context that rejects it. Only a flattening barrier survives, and
// MATERIALIZED is the explicit one.
test("sessions mode materializes the ranked block so SQLite cannot flatten it into the aggregate", () => {
    const statement = buildSessionsQuery({
        match: "\"alpha\"*",
        filters: {},
        limit: 10,
        offset: 0,
    });

    expect(statement.sql).toContain("WITH hit AS MATERIALIZED (");
});

test("every query block that calls an FTS5 auxiliary function names turns_fts in its own FROM clause", () => {
    const unreachable: string[] = [];
    const withAux: string[] = [];

    for (const { name, statement } of everyBuilder()) {
        if (usesAuxiliaryFunction(statement.sql)) {
            withAux.push(name);
        }
        for (const block of queryBlocks(statement.sql)) {
            if (!usesAuxiliaryFunction(block)) {
                continue;
            }
            if (!tablesIn(outerFromClause(block)).includes("turns_fts")) {
                unreachable.push(`${name}: ${block.trim().slice(0, 60)}`);
            }
        }
    }

    expect(unreachable).toEqual([]);
    // Guards the loop above against being vacuously true: these two modes must keep using them.
    expect(withAux).toEqual([
        "content",
        "sessions",
    ]);
});

test("count mode uses the rowid subquery form and calls no auxiliary function", () => {
    const statement = buildCountQuery({
        match: "\"alpha\"*",
        filters: {},
    });

    expect(statement.sql).toContain("t.rowid IN (SELECT rowid FROM turns_fts WHERE turns_fts MATCH ?)");
    expect(usesAuxiliaryFunction(statement.sql)).toBe(false);
    expect(statement.sql).not.toContain("highlight(");
    expect(tablesIn(outerFromClause(statement.sql))).not.toContain("turns_fts");
    expect(statement.sql).toContain("COUNT(DISTINCT t.session_id)");
});

test("no builder aliases the FTS table, in either the explicit or the implicit spelling", () => {
    const aliased: string[] = [];

    for (const { name, statement } of everyBuilder()) {
        if (statement.sql.includes("turns_fts AS") || aliasesFtsTable(statement.sql)) {
            aliased.push(name);
        }
    }

    expect(aliased).toEqual([]);
});

// (6) Parameterization. No caller value reaches the SQL text, and every placeholder has a value.

test("no builder interpolates a caller value into its SQL text", () => {
    const leaks: string[] = [];

    for (const { name, statement } of everyBuilder()) {
        for (const value of HOSTILE_VALUES) {
            if (statement.sql.includes(value)) {
                leaks.push(`${name}: ${value}`);
            }
        }
    }

    expect(leaks).toEqual([]);
});

test("every builder binds exactly as many parameters as it declares placeholders", () => {
    const mismatched: string[] = [];

    for (const { name, statement } of everyBuilder()) {
        if (countPlaceholders(statement.sql) !== statement.params.length) {
            mismatched.push(`${name}: ${countPlaceholders(statement.sql)} placeholders, ${statement.params.length} params`);
        }
    }

    expect(mismatched).toEqual([]);
});

test("content mode binds every filter positionally, in the order the clauses appear", () => {
    const statement = buildContentQuery({
        match: "\"alpha\"*",
        filters: ALL_FILTERS,
        limit: 20,
        offset: 40,
    });

    expect(statement.params).toEqual([
        "\"alpha\"*",
        `%${HOSTILE_PATH}%`,
        SINCE_MS,
        UNTIL_MS,
        "assistant",
        "tool_error",
        HOSTILE_AGENT_TYPE,
        20,
        40,
    ]);
});

test("an omitted filter emits no clause at all", () => {
    const statement = buildContentQuery({
        match: "\"alpha\"*",
        filters: {},
        limit: 20,
        offset: 0,
    });

    // Asserted on the clause forms, not on the column names: every one of these columns also appears
    // in the SELECT list, so a bare name check would pass for the wrong reason.
    expect(statement.sql).not.toContain("project_path LIKE");
    expect(statement.sql).not.toContain("t.ts >=");
    expect(statement.sql).not.toContain("t.ts <=");
    expect(statement.sql).not.toContain("t.role =");
    expect(statement.sql).not.toContain("t.kind =");
    expect(statement.sql).not.toContain("t.agent_type =");
    expect(statement.sql).not.toContain("t.is_sub =");
    expect(statement.sql).not.toContain("AND");
    expect(statement.params).toEqual([
        "\"alpha\"*",
        20,
        0,
    ]);
});

test("includeSubagents false compares against a constant, not a bound caller value", () => {
    const statement = buildCountQuery({
        match: "\"alpha\"*",
        filters: {
            includeSubagents: false,
        },
    });

    expect(statement.sql).toContain("t.is_sub = 0");
    expect(statement.params).toEqual(["\"alpha\"*"]);
});

test("includeSubagents true emits no is_sub clause", () => {
    const statement = buildCountQuery({
        match: "\"alpha\"*",
        filters: {
            includeSubagents: true,
        },
    });

    expect(statement.sql).not.toContain("t.is_sub");
});

test("a path filter matches a substring of project_path and escapes LIKE wildcards", () => {
    const statement = buildCountQuery({
        match: "\"alpha\"*",
        filters: {
            path: "100%_raw",
        },
    });

    expect(statement.sql).toContain("t.project_path LIKE ? ESCAPE '\\'");
    expect(statement.params).toEqual([
        "\"alpha\"*",
        "%100\\%\\_raw%",
    ]);
});

test("body text is never matched with LIKE; text matching goes through FTS5 only", () => {
    for (const { statement } of everyBuilder()) {
        expect(statement.sql).not.toContain("body LIKE");
        expect(statement.sql).not.toContain("'%' ||");
    }
});

// (7) The snippet markers are this module's contract with the formatter, so they are asserted here.

test("snippet markers are distinct and appear in the generated snippet call", () => {
    const statement = buildContentQuery({
        match: "\"alpha\"*",
        filters: {},
        limit: 20,
        offset: 0,
    });

    expect(SNIPPET_OPEN_MARKER).not.toBe(SNIPPET_CLOSE_MARKER);
    expect(statement.sql).toContain(`'${SNIPPET_OPEN_MARKER}'`);
    expect(statement.sql).toContain(`'${SNIPPET_CLOSE_MARKER}'`);
});
