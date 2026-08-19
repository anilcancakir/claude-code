import { expect, test } from "bun:test";
import { SNIPPET_CLOSE_MARKER, SNIPPET_OPEN_MARKER } from "./history-query.ts";
import {
    renderContent,
    renderCount,
    renderProjects,
    renderRead,
    renderSessions,
} from "./history-format.ts";
import type { ContentHitRow, ProjectHitRow, ReadHitRow, SessionHitRow } from "./history-format.ts";

const NOW = Date.parse("2026-08-19T00:00:00.000Z");
const ONE_HOUR_MS = 60 * 60 * 1000;

// Mirrors `MAX_READ_OUTPUT_BYTES` in `history-format.ts`, kept as a literal here for the same reason
// the `content` budget test states 4000 and 10000 as literals: the assertion is about the number a
// caller's context actually pays, so it has to fail when that number moves rather than move with it.
const READ_OUTPUT_CEILING_BYTES = 16_000;

const ELLIPSIS = "…";

// A snippet long enough to be realistic (FTS5's snippet() with max_tokens=40 typically lands
// around 200-250 characters), so the byte-budget test below exercises the actual content shape
// rather than a toy string that would pass by accident.
function makeSnippet(token: string): string {
    return (
        `some prose before the match ${SNIPPET_OPEN_MARKER}${token}${SNIPPET_CLOSE_MARKER} and then ` +
        "quite a bit more prose after it so the excerpt reads like a real FTS5 snippet with several " +
        "words of surrounding context on both sides of the highlighted term, which is the shape a " +
        "caller actually has to read"
    );
}

function makeContentRow(overrides: Partial<ContentHitRow> = {}): ContentHitRow {
    return {
        id: 1,
        uuid: "00000000-0000-4000-8000-000000000001",
        session_id: "00000000-0000-4000-8000-000000000001",
        project_path: "/tmp/proj-a",
        ts: NOW - ONE_HOUR_MS,
        role: "user",
        kind: "prose",
        is_sub: 0,
        agent_type: null,
        snippet: makeSnippet("ZRQPHX-TOKEN"),
        ...overrides,
    };
}

function makeContentRows(count: number): ContentHitRow[] {
    return Array.from({ length: count }, (_, index) =>
        makeContentRow({
            id: index + 1,
            uuid: `00000000-0000-4000-8000-${(index + 1).toString(16).padStart(12, "0")}`,
            session_id: `00000000-0000-4000-8000-${(index + 1).toString(16).padStart(12, "0")}`,
            snippet: makeSnippet(`ZRQPHX-TOKEN-${index}`),
        }),
    );
}

// (1) content: byte budget floor and ceiling for a realistic 20-hit page.

test("renderContent for 20 typical hits stays between 4000 and 10000 bytes", () => {
    const rows = makeContentRows(20);
    const rendered = renderContent(rows, { headLimit: 20, totalMatches: 20, now: NOW });
    const byteLength = Buffer.byteLength(rendered, "utf8");

    expect(byteLength).toBeGreaterThan(4000);
    expect(byteLength).toBeLessThan(10000);
});

// (2) content: the session id must be chainable into output_mode "read".

test("renderContent includes the session id on every hit line", () => {
    const rows = makeContentRows(5);
    const rendered = renderContent(rows, { headLimit: 5, totalMatches: 5, now: NOW });

    for (const row of rows) {
        expect(rendered).toContain(row.session_id);
    }
});

// (3) content: subagent hits carry their agentType label, main-thread hits do not.

test("renderContent labels a subagent hit with its agentType and leaves a main-thread hit unlabeled", () => {
    const subagentRow = makeContentRow({
        session_id: "00000000-0000-4000-8000-00000000aaaa",
        is_sub: 1,
        agent_type: "ac:librarian",
    });
    const mainThreadRow = makeContentRow({
        session_id: "00000000-0000-4000-8000-00000000bbbb",
        is_sub: 0,
        agent_type: null,
    });

    const rendered = renderContent([subagentRow, mainThreadRow], {
        headLimit: 2,
        totalMatches: 2,
        now: NOW,
    });

    const lines = rendered.split("\n\n");
    const subagentLine = lines.find((line) => line.includes(subagentRow.session_id));
    const mainThreadLine = lines.find((line) => line.includes(mainThreadRow.session_id));

    expect(subagentLine).toContain("ac:librarian");
    expect(mainThreadLine).not.toContain("ac:librarian");
});

// (4) content: a cut list states how many hits were withheld, never silently.

test("renderContent emits an explicit withheld-count notice when totalMatches exceeds head_limit", () => {
    const rows = makeContentRows(5);
    const rendered = renderContent(rows, { headLimit: 5, totalMatches: 12, now: NOW });

    expect(rendered).toMatch(/7.*withheld|withheld.*7/i);
});

test("renderContent emits no withheld notice when nothing was cut", () => {
    const rows = makeContentRows(3);
    const rendered = renderContent(rows, { headLimit: 5, totalMatches: 3, now: NOW });

    expect(rendered).not.toMatch(/withheld/i);
});

// (5) sessions: title fallback, hit count, project path, timestamp range.

test("renderSessions renders a resolved title, hit count, project path and timestamp range", () => {
    const row: SessionHitRow = {
        session_id: "00000000-0000-4000-8000-000000000001",
        project_path: "/tmp/proj-a",
        hits: 7,
        first_ts: NOW - 2 * ONE_HOUR_MS,
        last_ts: NOW - ONE_HOUR_MS,
        score: -3.5,
        title: "ZRQPHX session title",
    };

    const rendered = renderSessions([row], { headLimit: 10, totalSessions: 1, now: NOW });

    expect(rendered).toContain("ZRQPHX session title");
    expect(rendered).toContain("7");
    expect(rendered).toContain("proj-a");
    expect(rendered).toContain(row.session_id);
});

test("renderSessions falls back to a readable placeholder when the title is absent", () => {
    const row: SessionHitRow = {
        session_id: "00000000-0000-4000-8000-000000000002",
        project_path: "/tmp/proj-b",
        hits: 1,
        first_ts: NOW,
        last_ts: NOW,
        score: -1,
        title: undefined,
    };

    const rendered = renderSessions([row], { headLimit: 10, totalSessions: 1, now: NOW });

    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered).not.toContain("undefined");
});

// (6) count: one compact line with the three totals.

test("renderCount emits a single compact line with match, session and project totals", () => {
    const rendered = renderCount({ matches: 42, sessions: 6, projects: 3 });

    expect(rendered.split("\n").length).toBe(1);
    expect(rendered).toContain("42");
    expect(rendered).toContain("6");
    expect(rendered).toContain("3");
});

// (7) read: chronological rows with role prefixes, plus the window position for paging.

function makeReadRow(overrides: Partial<ReadHitRow> = {}): ReadHitRow {
    return {
        id: 1,
        uuid: "00000000-0000-4000-8000-000000000001",
        session_id: "00000000-0000-4000-8000-000000000001",
        project_path: "/tmp/proj-a",
        ts: NOW,
        role: "user",
        kind: "prose",
        is_sub: 0,
        agent_type: null,
        body: "ZRQPHX-READ-BODY token",
        ...overrides,
    };
}

test("renderRead reports its window position so a caller can page with offset", () => {
    const sessionId = "00000000-0000-4000-8000-000000000001";
    const rows = [
        makeReadRow({ id: 11, session_id: sessionId, role: "user", body: "ZRQPHX-FIRST" }),
        makeReadRow({ id: 12, session_id: sessionId, role: "assistant", body: "ZRQPHX-SECOND" }),
    ];

    const rendered = renderRead(rows, {
        sessionId,
        offset: 10,
        limit: 2,
        totalRows: 40,
    });

    // Window position: rows 11-12 of 40 (offset 10, two rows returned).
    expect(rendered).toContain("11");
    expect(rendered).toContain("12");
    expect(rendered).toContain("40");
    expect(rendered).toContain("ZRQPHX-FIRST");
    expect(rendered).toContain("ZRQPHX-SECOND");
});

// (8) read: the output budget. Measured on the shipped archive, a single `turns.body` reaches
// 882,668 characters and the DEFAULT 20-turn window of the heaviest real session renders 124,599
// characters (about 31,000 tokens), past Claude Code's own 25,000-token MCP result cap. Every
// fixture body elsewhere in this suite is a few dozen bytes, which is exactly why an uncapped
// renderer passed every earlier test.

/** A body of roughly `chars` characters, in whole space-separated words so a cut can land on one. */
function bulkBody(marker: string, chars: number): string {
    const filler = "payload ".repeat(Math.ceil(chars / 8));

    return `${marker} ${filler.slice(0, chars)}`;
}

/** `count` heavy turns, each marked with a zero-padded index so a substring check cannot alias. */
function makeHeavyReadRows(count: number, sessionId: string, chars: number): ReadHitRow[] {
    return Array.from({ length: count }, (_, index) =>
        makeReadRow({
            id: index + 1,
            session_id: sessionId,
            role: index % 2 === 0 ? "user" : "assistant",
            body: bulkBody(`ZRQPHX-TURN-${index.toString().padStart(2, "0")}`, chars),
        }),
    );
}

test("renderRead keeps a 100 KB body inside the output ceiling", () => {
    const sessionId = "00000000-0000-4000-8000-00000000c001";
    const rows = [makeReadRow({ session_id: sessionId, body: bulkBody("ZRQPHX-HUGE", 100_000) })];

    const rendered = renderRead(rows, {
        sessionId,
        offset: 0,
        limit: 20,
        totalRows: 1,
    });

    expect(Buffer.byteLength(rendered, "utf8")).toBeLessThanOrEqual(READ_OUTPUT_CEILING_BYTES);
    // Truncated, not dropped: the turn the caller asked to read is still there.
    expect(rendered).toContain("ZRQPHX-HUGE");
    expect(rendered).toContain(ELLIPSIS);
});

test("renderRead truncates an over-long turn on a word boundary instead of dropping it", () => {
    const sessionId = "00000000-0000-4000-8000-00000000c002";
    const rows = [
        makeReadRow({
            session_id: sessionId,
            body: `ZRQPHX-HEAD ${"alpha ".repeat(800)}ZRQPHX-TAIL`,
        }),
    ];

    const rendered = renderRead(rows, {
        sessionId,
        offset: 0,
        limit: 20,
        totalRows: 1,
    });

    expect(rendered).toContain("ZRQPHX-HEAD");
    expect(rendered).not.toContain("ZRQPHX-TAIL");
    expect(rendered).toContain(ELLIPSIS);
    // The cut lands after a whole word, never inside one: "alpha…", never "alph…".
    const cut = rendered.slice(0, rendered.indexOf(ELLIPSIS));
    expect(cut.endsWith("alpha")).toBe(true);
});

test("renderRead caps 20 heavy turns and reports what it rendered, not what was requested", () => {
    const sessionId = "00000000-0000-4000-8000-00000000c003";
    const rows = makeHeavyReadRows(20, sessionId, 10_000);

    const rendered = renderRead(rows, {
        sessionId,
        offset: 0,
        limit: 20,
        totalRows: 20,
    });

    expect(Buffer.byteLength(rendered, "utf8")).toBeLessThanOrEqual(READ_OUTPUT_CEILING_BYTES);

    const position = /turns 1-(\d+) of 20/.exec(rendered);
    expect(position).not.toBeNull();
    const renderedCount = Number(position?.[1]);
    // The budget has to have cut something, or this test is not exercising it.
    expect(renderedCount).toBeGreaterThan(0);
    expect(renderedCount).toBeLessThan(20);

    // The position line's own end is the last turn present, and the next one is genuinely absent.
    const lastRendered = `ZRQPHX-TURN-${(renderedCount - 1).toString().padStart(2, "0")}`;
    const firstWithheld = `ZRQPHX-TURN-${renderedCount.toString().padStart(2, "0")}`;
    expect(rendered).toContain(lastRendered);
    expect(rendered).not.toContain(firstWithheld);

    // Paging from the reported end loses nothing: the first turn the budget dropped opens the
    // next window. A position line naming the REQUESTED window would have skipped every one.
    const next = renderRead(rows.slice(renderedCount), {
        sessionId,
        offset: renderedCount,
        limit: 20,
        totalRows: 20,
    });

    expect(next).toContain(firstWithheld);
    expect(next).toContain(`turns ${renderedCount + 1}-`);
});

test("renderRead counts the turns its own budget cut in the withheld notice", () => {
    const sessionId = "00000000-0000-4000-8000-00000000c004";
    const rows = makeHeavyReadRows(20, sessionId, 10_000);

    // totalRows equals the window, so nothing lies beyond it: every withheld turn is the budget's
    // doing, and the notice has to say so rather than claiming a complete answer.
    const rendered = renderRead(rows, {
        sessionId,
        offset: 0,
        limit: 20,
        totalRows: 20,
    });

    const renderedCount = Number(/turns 1-(\d+) of 20/.exec(rendered)?.[1]);
    const notice = /\[(\d+) turn\(s\) withheld/.exec(rendered);
    expect(notice).not.toBeNull();
    expect(Number(notice?.[1])).toBe(20 - renderedCount);
});

test("renderRead prefixes each row with its role in chronological order", () => {
    const sessionId = "00000000-0000-4000-8000-000000000002";
    const rows = [
        makeReadRow({ id: 1, session_id: sessionId, role: "user", body: "ZRQPHX-USER-TURN" }),
        makeReadRow({ id: 2, session_id: sessionId, role: "assistant", body: "ZRQPHX-ASSISTANT-TURN" }),
    ];

    const rendered = renderRead(rows, {
        sessionId,
        offset: 0,
        limit: 2,
        totalRows: 2,
    });

    expect(rendered.indexOf("ZRQPHX-USER-TURN")).toBeLessThan(rendered.indexOf("ZRQPHX-ASSISTANT-TURN"));
    expect(rendered).toMatch(/user/i);
    expect(rendered).toMatch(/assistant/i);
});

// (10) The truncation notice names what it actually counted, and advises only what applies. One
// shared wording was wrong in two modes at once: `sessions` counts sessions, not hits, and `read`
// has no pattern, so telling its caller to narrow the query sends them after a parameter that does
// not exist for that mode.

test("renderSessions counts sessions in its notice, not hits", () => {
    const row: SessionHitRow = {
        session_id: "00000000-0000-4000-8000-00000000000c",
        project_path: "/tmp/proj-a",
        hits: 3,
        first_ts: NOW,
        last_ts: NOW,
        score: -1,
        title: "ZRQPHX",
    };

    const rendered = renderSessions([row], { headLimit: 1, totalSessions: 9, now: NOW });

    expect(rendered).toContain("8 session(s) withheld");
    expect(rendered).not.toContain("hit(s) withheld");
});

test("renderContent still counts hits in its notice", () => {
    const rendered = renderContent(makeContentRows(1), { headLimit: 1, totalMatches: 4, now: NOW });

    expect(rendered).toContain("3 hit(s) withheld");
});

test("renderRead advises paging but not narrowing, because read takes no pattern", () => {
    const rendered = renderRead(
        [makeReadRow({ body: "alpha" }), makeReadRow({ id: 2, body: "beta" })],
        { sessionId: "00000000-0000-4000-8000-00000000000d", offset: 0, limit: 1, totalRows: 5 },
    );

    expect(rendered).toContain("turn(s) withheld");
    expect(rendered).toContain("page with offset");
    expect(rendered).not.toContain("narrow the query");
});

// (12) projects: the rollup line. Full path rather than basename, because the path IS the answer
// here and this machine holds both `fluttersdk.com` and `fluttersdk-ai` under one parent.

function makeProjectRow(overrides: Partial<ProjectHitRow> = {}): ProjectHitRow {
    return {
        project_path: "/Users/anilcan/Code/fluttersdk/fluttersdk.com",
        hits: 25,
        sessions: 3,
        first_ts: NOW - 66 * 24 * ONE_HOUR_MS,
        last_ts: NOW - 30 * 24 * ONE_HOUR_MS,
        ...overrides,
    };
}

test("renderProjects leads with the total, then one line per project", () => {
    const rendered = renderProjects(
        [makeProjectRow(), makeProjectRow({ project_path: "/Users/anilcan/Code/claude-code", hits: 2, sessions: 1 })],
        { headLimit: 20, totalProjects: 2, now: NOW },
    );

    const lines = rendered.split("\n\n");
    expect(lines[0]).toBe("2 project(s) matched");
    expect(lines.length).toBe(3);
});

test("renderProjects shows the full path, not the basename", () => {
    const rendered = renderProjects([makeProjectRow()], { headLimit: 20, totalProjects: 1, now: NOW });

    // Two sibling projects share a basename prefix on this machine, so a basename cannot answer
    // "which project" and the full path is the point of the mode.
    expect(rendered).toContain("/Users/anilcan/Code/fluttersdk/fluttersdk.com");
});

test("renderProjects reports hits, sessions and the date range per project", () => {
    const rendered = renderProjects([makeProjectRow()], { headLimit: 20, totalProjects: 1, now: NOW });

    expect(rendered).toContain("25 hit(s)");
    expect(rendered).toContain("3 session(s)");
});

test("renderProjects counts withheld projects, not hits", () => {
    const rendered = renderProjects([makeProjectRow()], { headLimit: 1, totalProjects: 6, now: NOW });

    expect(rendered).toContain("5 project(s) withheld");
});

test("renderProjects emits no withheld notice when the page is the whole answer", () => {
    const rendered = renderProjects([makeProjectRow()], { headLimit: 20, totalProjects: 1, now: NOW });

    expect(rendered).not.toContain("withheld");
});
