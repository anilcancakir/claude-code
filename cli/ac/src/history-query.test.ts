import { expect, test } from "bun:test";
import {
    buildContentQuery,
    buildCountQuery,
    buildProjectCountQuery,
    buildProjectsQuery,
    buildReadQuery,
    buildSessionRowCountQuery,
    buildSessionsQuery,
    SNIPPET_CLOSE_MARKER,
    SNIPPET_OPEN_MARKER,
    degradedTokens,
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
            name: "projects",
            statement: buildProjectsQuery({
                match,
                filters: ALL_FILTERS,
                limit: 20,
                offset: 0,
            }),
        },
        {
            name: "projectCount",
            statement: buildProjectCountQuery({
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
    // The colon stays inside the quotes in EVERY dotless-i variant, which is the property under
    // test: expansion must not open a hole the quoting closed.
    expect(toMatchExpression("node:sqlite", { prefix: true }))
        .toBe("(\"node:sqlite\"* OR \"node:sqlıte\"*)");
});

test("toMatchExpression quotes C++, whose plus signs are a raw MATCH syntax error", () => {
    expect(toMatchExpression("C++", { prefix: true })).toBe("\"C++\"*");
});

test("toMatchExpression quotes a leading hyphen, which raw MATCH reads as a column filter", () => {
    const expression = toMatchExpression("gozden -gecirildi", { prefix: true });

    // `gozden` carries no `i` and so keeps its exact pre-expansion shape; `-gecirildi` carries
    // three and fans out to 2^3, with the leading hyphen quoted inside every one of them.
    expect(expression).toBe(
        "\"gozden\"* AND (\"-gecirildi\"* OR \"-gecırildi\"* OR \"-gecirıldi\"* OR \"-gecırıldi\"* "
        + "OR \"-gecirildı\"* OR \"-gecırildı\"* OR \"-gecirıldı\"* OR \"-gecırıldı\"*)",
    );
});

test("toMatchExpression quotes a dangling OR, which raw MATCH reads as an operator", () => {
    expect(toMatchExpression("a OR", { prefix: true })).toBe("\"a\"* AND \"OR\"*");
});

// (2) toMatchExpression: quoting, whitespace and the empty case.

test("toMatchExpression doubles an internal double quote and emits one token per word", () => {
    const expression = toMatchExpression("he said \"hi\"", { prefix: false });

    // Doubling happens per variant, so the escaping survives the expansion rather than being
    // applied to a token that is later rewritten.
    expect(expression).toBe("\"he\" AND (\"said\" OR \"saıd\") AND (\"\"\"hi\"\"\" OR \"\"\"hı\"\"\")");
});

test("toMatchExpression appends the prefix star outside the closing quote", () => {
    expect(toMatchExpression("frankenphp", { prefix: true })).toBe("\"frankenphp\"*");
    expect(toMatchExpression("frankenphp", { prefix: false })).toBe("\"frankenphp\"");
});

test("toMatchExpression returns an empty string for whitespace-only input", () => {
    expect(toMatchExpression("   ", { prefix: true })).toBe("");
});

test("toMatchExpression drops empty tokens from runs of mixed whitespace", () => {
    expect(toMatchExpression("  alpha \t\n beta  ", { prefix: true })).toBe("\"alpha\"* AND \"beta\"*");
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

// (7) The dotless-i expansion. `unicode61` folds every Turkish letter except `ı` (U+0131), so a
// token varying over that one axis is exactly sufficient: measured over the real archive,
// `calısıyor` returns 1,899 hits against `çalışıyor`'s 1,896, while `bilgi` returns 663 and
// `bılgı` returns 0.

test("toMatchExpression leaves a token with no i exactly as it was before the expansion", () => {
    expect(toMatchExpression("frankenphp", { prefix: true })).toBe("\"frankenphp\"*");
    expect(toMatchExpression("gozden", { prefix: true })).toBe("\"gozden\"*");
});

test("toMatchExpression expands one i into both spellings under OR", () => {
    expect(toMatchExpression("bir", { prefix: true })).toBe("(\"bir\"* OR \"bır\"*)");
});

test("toMatchExpression reaches one group from either spelling of a token with no other Turkish letter", () => {
    // `bilgi` and `bılgı` differ ONLY on the expanded axis, so here the two spellings really do
    // converge on one string. Where a token also carries ç, ş, ğ, ö or ü the two spellings stay
    // textually different and converge only after the tokenizer folds them, which a string
    // assertion cannot see; `history-store.node-check.ts` proves that case against a real index.
    expect(toMatchExpression("bilgi", { prefix: false }))
        .toBe(toMatchExpression("bılgı", { prefix: false }));
});

test("toMatchExpression canonicalizes the dotted capital I onto the expanded axis", () => {
    expect(toMatchExpression("İ", { prefix: false })).toBe("(\"i\" OR \"ı\")");
});

test("toMatchExpression covers every combination, not just all-dotted and all-dotless", () => {
    const expression = toMatchExpression("çalışıyor", { prefix: false });

    // ç and ş are left ALONE: the tokenizer already folds them at match time, so rewriting them
    // here would be redundant. Only the `ı` axis varies, and it varies over every combination,
    // because the real spelling is mixed and an all-or-nothing pair would miss it.
    expect(expression).toContain("\"çalışıyor\"");
    expect(expression).toContain("\"çalişiyor\"");
    expect(expression).toContain("\"çalışiyor\"");
    expect(expression).toContain("\"çalişıyor\"");
});

test("toMatchExpression caps the fan-out and falls back to the two bulk spellings", () => {
    // Six `i` positions would be 64 terms. Past the cap the group keeps all-dotted and all-dotless.
    const expression = toMatchExpression("iiiiii", { prefix: false });

    expect(expression).toBe("(\"iiiiii\" OR \"ıııııı\")");
});

test("toMatchExpression expands the largest uncapped word to exactly 32 terms", () => {
    const expression = toMatchExpression("iiiii", { prefix: false });

    expect(expression.split(" OR ").length).toBe(32);
});

test("toMatchExpression keeps each token's group independent, so tokens AND rather than multiply", () => {
    const expression = toMatchExpression("bir iki", { prefix: false });

    // Two groups separated by a space, which FTS5 reads as AND. The cost is the SUM of the two
    // fan-outs, not their product.
    expect(expression).toBe("(\"bir\" OR \"bır\") AND (\"iki\" OR \"ıki\" OR \"ikı\" OR \"ıkı\")");
});

test("toMatchExpression preserves a surrogate pair while rewriting an i beside it", () => {
    // Positions are computed in code units and the array is split the same way, so an emoji must
    // survive the rejoin intact.
    const expression = toMatchExpression("i\u{1F600}", { prefix: false });

    expect(expression).toBe("(\"i\u{1F600}\" OR \"ı\u{1F600}\")");
});

// (8) degradedTokens: naming the tokens the tokenizer strips down to a near-match-all prefix.
// Measured on the real archive, `C++` searches the bare prefix `c` and returns 168,241 of 189,644
// indexed turns, which reads as an answer and carries no information.

test("degradedTokens names a symbol-only word and what it actually searches", () => {
    expect(degradedTokens("C++")).toEqual([["C++", "C"]]);
    expect(degradedTokens("C#")).toEqual([["C#", "C"]]);
});

test("degradedTokens stays silent when the surviving run is still useful", () => {
    // The prefix star attaches to the LAST run, so `node:sqlite` searches `sqlite` and is fine.
    expect(degradedTokens("node:sqlite")).toEqual([]);
    expect(degradedTokens("laravel migration")).toEqual([]);
});

test("degradedTokens stays silent on a plain word, punctuation being the trigger", () => {
    // `a` is one character but loses nothing, so there is nothing to explain to the caller.
    expect(degradedTokens("a")).toEqual([]);
    expect(degradedTokens("çalışıyor")).toEqual([]);
});

test("degradedTokens reports every degraded token in the order typed", () => {
    expect(degradedTokens("C++ real F#")).toEqual([["C++", "C"], ["F#", "F"]]);
});

test("degradedTokens treats a Turkish letter as content, not punctuation", () => {
    // The class is Unicode letters and numbers, so a non-ASCII word is never reported as degraded.
    expect(degradedTokens("iş")).toEqual([]);
});

// (9) projects mode: the rollup that answers "which projects on this machine did I work on X in".

test("buildProjectsQuery groups by project and orders by hit volume, not relevance", () => {
    const statement = buildProjectsQuery({
        match: "\"dusk\"*",
        filters: {},
        limit: 20,
        offset: 0,
    });

    expect(statement.sql).toContain("GROUP BY t.project_path");
    expect(statement.sql).toContain("ORDER BY hits DESC, last_ts DESC");

    // No auxiliary function, so it must NOT pay for the materialized CTE that `sessions` needs
    // only because of its MIN(bm25(...)) aggregate.
    expect(statement.sql).not.toContain("bm25(");
    expect(statement.sql).not.toContain("MATERIALIZED");
});

test("buildProjectsQuery counts distinct sessions per project, so one busy session is not many", () => {
    const statement = buildProjectsQuery({ match: "\"dusk\"*", filters: {}, limit: 20, offset: 0 });

    expect(statement.sql).toContain("COUNT(DISTINCT t.session_id) AS sessions");
});

test("buildProjectsQuery binds the match and the window in order, concatenating nothing", () => {
    const statement = buildProjectsQuery({
        match: "\"dusk\"*",
        filters: { path: HOSTILE_PATH },
        limit: 7,
        offset: 14,
    });

    expect(statement.params[0]).toBe("\"dusk\"*");
    expect(statement.params.at(-2)).toBe(7);
    expect(statement.params.at(-1)).toBe(14);
    expect(statement.sql).not.toContain(HOSTILE_PATH);
});

test("buildProjectCountQuery counts distinct projects and takes no window", () => {
    const statement = buildProjectCountQuery({ match: "\"dusk\"*", filters: {} });

    expect(statement.sql).toContain("COUNT(DISTINCT t.project_path) AS total_projects");
    expect(statement.sql).not.toContain("LIMIT");
});

test("both projects builders refuse an empty match, which FTS5 answers with a syntax error", () => {
    expect(() => buildProjectsQuery({ match: "", filters: {}, limit: 20, offset: 0 })).toThrow();
    expect(() => buildProjectCountQuery({ match: "", filters: {} })).toThrow();
});
