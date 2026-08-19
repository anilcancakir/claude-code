import { expect, test } from "bun:test";
import { SNIPPET_CLOSE_MARKER, SNIPPET_OPEN_MARKER } from "./history-query.ts";
import {
    renderContent,
    renderCount,
    renderRead,
    renderSessions,
} from "./history-format.ts";
import type { ContentHitRow, ReadHitRow, SessionHitRow } from "./history-format.ts";

const NOW = Date.parse("2026-08-19T00:00:00.000Z");
const ONE_HOUR_MS = 60 * 60 * 1000;

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
