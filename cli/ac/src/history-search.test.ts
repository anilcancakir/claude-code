import { expect, test } from "bun:test";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import {
    HISTORY_HEAD_LIMIT_MAX,
    resolveProjectsRoot,
    runSearch,
} from "./history-search.ts";
import type { HistorySearchArgs, HistorySearchDeps } from "./history-search.ts";
import type { SqlStatement } from "./history-query.ts";
import type { HistorySyncDeps, HistorySyncOptions, HistorySyncReport } from "./history-sync.ts";
import type {
    HistoryForgetResult,
    HistoryIngestResult,
    HistoryResultRow,
    HistorySessionRecord,
    HistoryStore,
} from "./history-store.ts";

/**
 * Every assertion here runs against an injected fake store, never against sqlite: `bun test`
 * cannot load `node:sqlite` at all, which is why `history-search.ts` holds only an `import type`
 * of the store. What this suite proves is the argument gate, the filter plumbing, the mode
 * dispatch, the per-session dedup and the empty-result message. The composed sync-query-render
 * path against a real archive is proven by `history-search.node-check.ts` under the Node runner.
 */

const PROJECTS_ROOT = "/tmp/ac-history-search-projects";

/** What a fake store hands back per mode, plus the switches a degradation test needs. */
interface FakeStoreOptions {
    readonly contentRows?: readonly HistoryResultRow[];
    readonly sessionRows?: readonly HistoryResultRow[];
    readonly countRow?: HistoryResultRow;
    readonly readRows?: readonly HistoryResultRow[];
    readonly readTotal?: number;
    readonly titles?: ReadonlyMap<string, string>;
    readonly busyOnIngest?: boolean;
    readonly writable?: boolean;
}

/** Everything the fake store observed, so a test can assert on what actually reached the query. */
interface FakeStoreState {
    readonly statements: SqlStatement[];
    readonly lookups: string[][];
    ingestCalls: number;
}

function contentRow(overrides: Partial<Record<string, string | number | null>> = {}): HistoryResultRow {
    return {
        id: 1,
        uuid: "uuid-1",
        session_id: "sess-1",
        project_path: "/tmp/proj-a",
        ts: 1_750_000_000_000,
        role: "user",
        kind: "prose",
        is_sub: 0,
        agent_type: null,
        snippet: "a «ZRQPHX» hit body",
        ...overrides,
    };
}

function sessionRow(overrides: Partial<Record<string, string | number | null>> = {}): HistoryResultRow {
    return {
        session_id: "sess-1",
        project_path: "/tmp/proj-a",
        hits: 2,
        first_ts: 1_750_000_000_000,
        last_ts: 1_750_000_100_000,
        score: -3,
        ...overrides,
    };
}

function readRow(overrides: Partial<Record<string, string | number | null>> = {}): HistoryResultRow {
    return {
        id: 1,
        uuid: "uuid-1",
        session_id: "sess-1",
        project_path: "/tmp/proj-a",
        ts: 1_750_000_000_000,
        role: "user",
        kind: "prose",
        is_sub: 0,
        agent_type: null,
        body: "ZRQPHX body of a read turn",
        ...overrides,
    };
}

/**
 * A `HistoryStore` stand-in that answers `select` from canned rows, routed by the shape of the
 * statement it is handed, and records every statement so a test can assert that a caller value
 * arrived as a bound parameter rather than as SQL text.
 */
function createFakeStore(options: FakeStoreOptions = {}): { store: HistoryStore; state: FakeStoreState } {
    const state: FakeStoreState = {
        statements: [],
        lookups: [],
        ingestCalls: 0,
    };

    const store: HistoryStore = {
        databasePath: ":fake:",
        schemaVersion: 1,
        writable: options.writable ?? true,
        getManifestEntry: (): undefined => undefined,
        ingest: (): HistoryIngestResult => {
            state.ingestCalls += 1;

            return {
                rowsAdded: 0,
                rowsIgnored: 0,
                quarantined: 0,
                redactions: {},
                skipped: false,
                busy: options.busyOnIngest === true,
            };
        },
        upsertSession: (): void => undefined,
        lookupSessions: (sessionIds: readonly string[]): Map<string, HistorySessionRecord> => {
            state.lookups.push([...sessionIds]);
            const found = new Map<string, HistorySessionRecord>();
            for (const sessionId of sessionIds) {
                const title = options.titles?.get(sessionId);
                if (title === undefined) {
                    continue;
                }
                found.set(sessionId, {
                    sessionId,
                    projectPath: "/tmp/proj-a",
                    title,
                    firstPrompt: "first prompt",
                    mtime: 1_750_000_000_000,
                    isSubagent: false,
                    agentType: undefined,
                });
            }

            return found;
        },
        select: (statement: SqlStatement): readonly HistoryResultRow[] => {
            state.statements.push(statement);
            if (statement.sql.includes("snippet(")) {
                return options.contentRows ?? [];
            }
            if (statement.sql.includes("WITH hit AS")) {
                return options.sessionRows ?? [];
            }
            if (statement.sql.includes("AS matches")) {
                return [options.countRow ?? { matches: 0, sessions: 0, projects: 0 }];
            }
            if (statement.sql.includes("AS total_turns")) {
                return [{ total_turns: options.readTotal ?? (options.readRows?.length ?? 0) }];
            }

            return options.readRows ?? [];
        },
        forget: (): HistoryForgetResult => ({
            turnsRemoved: 0,
            sessionsRemoved: 0,
            quarantineRemoved: 0,
            busy: false,
        }),
        close: (): void => undefined,
    };

    return { store, state };
}

/** A filesystem seam whose every member throws, so any IO from the search path is a hard failure. */
function hostileFs(): HistorySyncDeps {
    const explode = (): never => {
        throw new Error("the search path must not touch the filesystem");
    };

    return {
        listSessionFiles: explode,
        statFile: explode,
        readFileRange: explode,
        readSubagentMeta: explode,
    };
}

function emptyReport(): HistorySyncReport {
    return {
        filesScanned: 0,
        filesVanished: 0,
        filesFailed: 0,
        rowsAdded: 0,
        quarantined: 0,
        skipped: 0,
        redactions: 0,
        elapsedMillis: 0,
        changed: false,
    };
}

/** A sync stand-in that records its calls, so a test can prove the sync ran (or did not). */
function createSyncSpy(): { sync: (opts: HistorySyncOptions) => Promise<HistorySyncReport>; calls: HistorySyncOptions[] } {
    const calls: HistorySyncOptions[] = [];

    return {
        sync: async (opts: HistorySyncOptions): Promise<HistorySyncReport> => {
            calls.push(opts);

            return emptyReport();
        },
        calls,
    };
}

function depsFor(store: HistoryStore, overrides: Partial<HistorySearchDeps> = {}): HistorySearchDeps {
    return {
        store,
        projectsRoot: PROJECTS_ROOT,
        fs: hostileFs(),
        now: 1_750_000_200_000,
        ...overrides,
    };
}

async function expectInvalidParams(promise: Promise<string>, fragment: string): Promise<void> {
    try {
        await promise;
    } catch (error) {
        expect(error).toBeInstanceOf(McpError);
        expect((error as McpError).code).toBe(ErrorCode.InvalidParams);
        expect((error as McpError).message).toContain(fragment);
        return;
    }

    throw new Error(`expected an McpError mentioning ${fragment}`);
}

test("a session_id holding a traversal segment is rejected before anything runs", async () => {
    const { store, state } = createFakeStore({ readRows: [readRow()] });
    const spy = createSyncSpy();
    const args: HistorySearchArgs = {
        output_mode: "read",
        session_id: "../../etc/passwd",
    };

    await expectInvalidParams(runSearch(args, depsFor(store, { sync: spy.sync })), "session_id");

    // The rejection is what proves no filesystem path was ever built from it: the sync never ran,
    // the store was never queried, and the injected filesystem would have thrown if touched.
    expect(spy.calls.length).toBe(0);
    expect(state.statements.length).toBe(0);
});

test("a session_id holding a path separator is rejected rather than normalized", async () => {
    const { store } = createFakeStore({ readRows: [readRow()] });
    const spy = createSyncSpy();

    await expectInvalidParams(
        runSearch({ output_mode: "read", session_id: "sess-1/../sess-2" }, depsFor(store, { sync: spy.sync })),
        "session_id",
    );
    await expectInvalidParams(
        runSearch({ output_mode: "read", session_id: "a\\b" }, depsFor(store, { sync: spy.sync })),
        "session_id",
    );
});

test("a session_id holding a single quote reaches the query as a bound parameter", async () => {
    const hostile = "sess-1'; DROP TABLE turns; --";
    const { store, state } = createFakeStore({ readRows: [], readTotal: 0 });
    const spy = createSyncSpy();

    const text = await runSearch(
        { output_mode: "read", session_id: hostile },
        depsFor(store, { sync: spy.sync }),
    );

    expect(text).toContain("No turns");
    expect(text).toContain(hostile);
    const read = state.statements.find((statement) => statement.sql.includes("t.body AS body"));
    expect(read).toBeDefined();
    expect(read?.params).toContain(hostile);
    expect(read?.sql).not.toContain("'");
});

test("runSearch itself performs no filesystem access", async () => {
    const { store } = createFakeStore({ contentRows: [contentRow()], countRow: { matches: 1, sessions: 1, projects: 1 } });
    const spy = createSyncSpy();

    const text = await runSearch(
        { pattern: "ZRQPHX", path: "../../etc" },
        depsFor(store, { sync: spy.sync }),
    );

    expect(text.length).toBeGreaterThan(0);
    expect(spy.calls.length).toBe(1);
    expect(spy.calls[0]?.root).toBe(PROJECTS_ROOT);
});

test("the path filter never becomes a directory read", async () => {
    const listed: string[] = [];
    const explode = (): never => {
        throw new Error("only the projects root may be walked");
    };
    const { store, state } = createFakeStore({
        contentRows: [contentRow()],
        countRow: { matches: 1, sessions: 1, projects: 1 },
    });

    // The real syncArchive runs here, with a filesystem seam that records every directory it is
    // asked to walk and throws on every other call. `path` must reach the SQL as a LIKE parameter
    // and must never widen the walk.
    const text = await runSearch({ pattern: "ZRQPHX", path: "/tmp/proj-a" }, {
        store,
        projectsRoot: PROJECTS_ROOT,
        now: 1_750_000_200_000,
        fs: {
            listSessionFiles: async (root: string): Promise<readonly string[]> => {
                listed.push(root);

                return [];
            },
            statFile: explode,
            readFileRange: explode,
            readSubagentMeta: explode,
        },
    });

    expect(listed).toEqual([PROJECTS_ROOT]);
    expect(text.length).toBeGreaterThan(0);
    const content = state.statements.find((statement) => statement.sql.includes("snippet("));
    expect(content?.params).toContain("%/tmp/proj-a%");
});

test("every output mode renders non-empty text", async () => {
    const titles = new Map([["sess-1", "ZRQPHX-TITLE-ONE"]]);
    const { store } = createFakeStore({
        contentRows: [contentRow(), contentRow({ id: 2, uuid: "uuid-2", session_id: "sess-2" })],
        sessionRows: [sessionRow(), sessionRow({ session_id: "sess-2", score: -4 })],
        countRow: { matches: 2, sessions: 2, projects: 1 },
        readRows: [readRow(), readRow({ id: 2, uuid: "uuid-2", role: "assistant" })],
        readTotal: 2,
        titles,
    });
    const spy = createSyncSpy();
    const deps = depsFor(store, { sync: spy.sync });

    const content = await runSearch({ pattern: "ZRQPHX" }, deps);
    const sessions = await runSearch({ pattern: "ZRQPHX", output_mode: "sessions" }, deps);
    const count = await runSearch({ pattern: "ZRQPHX", output_mode: "count" }, deps);
    const read = await runSearch({ output_mode: "read", session_id: "sess-1" }, deps);

    expect(content).toContain("session:sess-1");
    expect(sessions).toContain("ZRQPHX-TITLE-ONE");
    expect(count).toContain("2 match(es)");
    expect(read).toContain("turns 1-2 of 2");
    expect(spy.calls.length).toBe(4);
});

test("sessions mode collapses many hits in one session into a single entry", async () => {
    const { store } = createFakeStore({
        sessionRows: [
            sessionRow({ hits: 2, score: -3 }),
            sessionRow({ hits: 3, score: -7 }),
            sessionRow({ hits: 4, score: -5 }),
            sessionRow({ session_id: "sess-2", hits: 1, score: -9 }),
        ],
        countRow: { matches: 10, sessions: 2, projects: 1 },
        titles: new Map([["sess-1", "ZRQPHX-TITLE-ONE"]]),
    });
    const spy = createSyncSpy();

    const text = await runSearch(
        { pattern: "ZRQPHX", output_mode: "sessions" },
        depsFor(store, { sync: spy.sync }),
    );

    const blocks = text.split("\n\n");
    expect(blocks.length).toBe(2);
    expect(text.match(/session:sess-1/g)?.length).toBe(1);
    // Every collapsed row's hits belong to the same session, so the entry carries their sum.
    expect(text).toContain("9 hit(s)");
    // The best (lowest) bm25-derived score wins the final sort, so sess-2 at -9 leads.
    expect(blocks[0]).toContain("session:sess-2");
    expect(blocks[1]).toContain("session:sess-1");
});

test("sessions mode resolves titles through the store's session lookup", async () => {
    const { store, state } = createFakeStore({
        sessionRows: [sessionRow(), sessionRow({ session_id: "sess-2", score: -4 })],
        countRow: { matches: 2, sessions: 2, projects: 1 },
        titles: new Map([["sess-1", "ZRQPHX-TITLE-ONE"]]),
    });
    const spy = createSyncSpy();

    const text = await runSearch(
        { pattern: "ZRQPHX", output_mode: "sessions" },
        depsFor(store, { sync: spy.sync }),
    );

    expect(state.lookups).toEqual([["sess-2", "sess-1"]]);
    expect(text).toContain("ZRQPHX-TITLE-ONE");
    expect(text).toContain("(untitled session)");
});

test("an empty result names every applied filter", async () => {
    const { store } = createFakeStore({ countRow: { matches: 0, sessions: 0, projects: 0 } });
    const spy = createSyncSpy();

    const text = await runSearch({
        pattern: "ZRQPHX-ABSENT",
        path: "/tmp/proj-a",
        since: "2026-08-01T00:00:00.000Z",
        until: "2026-08-19T00:00:00.000Z",
        role: "user",
        kind: "prose",
        include_subagents: false,
        agent_type: "ac:librarian",
    }, depsFor(store, { sync: spy.sync }));

    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain("No matches");
    expect(text).toContain("ZRQPHX-ABSENT");
    expect(text).toContain("/tmp/proj-a");
    expect(text).toContain("2026-08-01T00:00:00.000Z");
    expect(text).toContain("role=user");
    expect(text).toContain("kind=prose");
    expect(text).toContain("subagent turns excluded");
    expect(text).toContain("agent_type=ac:librarian");
});

test("count mode states its zero totals and the filters behind them", async () => {
    const { store } = createFakeStore({ countRow: { matches: 0, sessions: 0, projects: 0 } });
    const spy = createSyncSpy();

    const text = await runSearch(
        { pattern: "ZRQPHX-ABSENT", output_mode: "count" },
        depsFor(store, { sync: spy.sync }),
    );

    expect(text).toContain("0 match(es)");
    expect(text).toContain("ZRQPHX-ABSENT");
});

test("every metadata filter reaches the statement as a bound parameter", async () => {
    const { store, state } = createFakeStore({
        contentRows: [contentRow()],
        countRow: { matches: 1, sessions: 1, projects: 1 },
    });
    const spy = createSyncSpy();

    await runSearch({
        pattern: "ZRQPHX",
        path: "proj-a",
        since: "2026-08-01T00:00:00.000Z",
        until: "2026-08-19T00:00:00.000Z",
        role: "assistant",
        kind: "tool_error",
        include_subagents: false,
        agent_type: "ac:librarian",
    }, depsFor(store, { sync: spy.sync }));

    const content = state.statements.find((statement) => statement.sql.includes("snippet("));
    expect(content?.params).toEqual([
        "\"ZRQPHX\"*",
        "%proj-a%",
        Date.parse("2026-08-01T00:00:00.000Z"),
        Date.parse("2026-08-19T00:00:00.000Z"),
        "assistant",
        "tool_error",
        "ac:librarian",
        20,
        0,
    ]);
    expect(content?.sql).toContain("t.is_sub = 0");
});

// `buildReadQuery` used to bind only the session id, so `include_subagents`, `role` and `kind` were
// silently inert in `read` while `validateArgs` still listed them among the applied filters. That
// mismatch is the defect: a tool that reports honouring a filter it ignored is worse than one that
// refuses the combination.
test("read mode binds the metadata filters it reports as applied", async () => {
    const { store, state } = createFakeStore({ readRows: [], readTotal: 0 });
    const spy = createSyncSpy();

    const text = await runSearch({
        output_mode: "read",
        session_id: "sess-1",
        role: "user",
        kind: "prose",
        include_subagents: false,
    }, depsFor(store, { sync: spy.sync }));

    // What the caller is told was applied.
    expect(text).toContain("role=user");
    expect(text).toContain("kind=prose");
    expect(text).toContain("subagent turns excluded");

    // What the statement actually applied, which has to be the same set.
    const read = state.statements.find((statement) => statement.sql.includes("t.body AS body"));
    expect(read?.sql).toContain("t.is_sub = 0");
    expect(read?.params).toEqual([
        "sess-1",
        "user",
        "prose",
        20,
        0,
    ]);
});

test("read mode counts its total over the same filtered rows the window is drawn from", async () => {
    const { store, state } = createFakeStore({
        readRows: [readRow(), readRow({ id: 2, uuid: "uuid-2", role: "assistant" })],
        readTotal: 2,
    });
    const spy = createSyncSpy();

    const text = await runSearch({
        output_mode: "read",
        session_id: "sess-1",
        include_subagents: false,
    }, depsFor(store, { sync: spy.sync }));

    expect(text).toContain("turns 1-2 of 2");
    const total = state.statements.find((statement) => statement.sql.includes("AS total_turns"));
    expect(total?.sql).toContain("t.is_sub = 0");
    expect(total?.params).toEqual(["sess-1"]);
});

test("a lock-contended sync says the search ran against the last committed snapshot", async () => {
    const { store } = createFakeStore({
        contentRows: [contentRow()],
        countRow: { matches: 1, sessions: 1, projects: 1 },
        busyOnIngest: true,
    });

    // The real syncArchive runs, over a single fake file, so the store's own `busy` flag is what
    // surfaces: `HistorySyncReport` carries no busy field, so the search observes it at the store.
    const text = await runSearch({ pattern: "ZRQPHX" }, {
        store,
        projectsRoot: PROJECTS_ROOT,
        now: 1_750_000_200_000,
        fs: {
            listSessionFiles: async (): Promise<readonly string[]> => [`${PROJECTS_ROOT}/-tmp-p/s.jsonl`],
            statFile: async (): Promise<{ size: number; mtimeMs: number }> => ({ size: 8, mtimeMs: 1 }),
            readFileRange: async (): Promise<Buffer> => Buffer.from("{\"a\":1}\n", "utf8"),
            readSubagentMeta: async (): Promise<undefined> => undefined,
        },
    });

    expect(text.split("\n")[0]).toContain("last committed snapshot");
    expect(text).toContain("session:sess-1");
});

test("an archive written by a newer build is searched without attempting a sync", async () => {
    const { store, state } = createFakeStore({
        contentRows: [contentRow()],
        countRow: { matches: 1, sessions: 1, projects: 1 },
        writable: false,
    });
    const spy = createSyncSpy();

    const text = await runSearch({ pattern: "ZRQPHX" }, depsFor(store, { sync: spy.sync }));

    expect(spy.calls.length).toBe(0);
    expect(state.ingestCalls).toBe(0);
    expect(text.split("\n")[0]).toContain("newer build");
    expect(text).toContain("session:sess-1");
});

test("a searching mode with no usable pattern is a caller error", async () => {
    const { store } = createFakeStore();
    const spy = createSyncSpy();
    const deps = depsFor(store, { sync: spy.sync });

    await expectInvalidParams(runSearch({}, deps), "pattern");
    await expectInvalidParams(runSearch({ pattern: "   " }, deps), "pattern");
    await expectInvalidParams(runSearch({ pattern: "ZRQPHX", output_mode: "counts" }, deps), "output_mode");
    expect(spy.calls.length).toBe(0);
});

test("read mode without a session_id is a caller error", async () => {
    const { store } = createFakeStore();
    const spy = createSyncSpy();

    await expectInvalidParams(
        runSearch({ output_mode: "read" }, depsFor(store, { sync: spy.sync })),
        "session_id",
    );
});

test("head_limit and offset are bounded, and since/until must parse", async () => {
    const { store } = createFakeStore();
    const spy = createSyncSpy();
    const deps = depsFor(store, { sync: spy.sync });

    await expectInvalidParams(runSearch({ pattern: "a", head_limit: 0 }, deps), "head_limit");
    await expectInvalidParams(
        runSearch({ pattern: "a", head_limit: HISTORY_HEAD_LIMIT_MAX + 1 }, deps),
        "head_limit",
    );
    await expectInvalidParams(runSearch({ pattern: "a", head_limit: 1.5 }, deps), "head_limit");
    await expectInvalidParams(runSearch({ pattern: "a", offset: -1 }, deps), "offset");
    await expectInvalidParams(runSearch({ pattern: "a", since: "yesterday" }, deps), "since");
    await expectInvalidParams(runSearch({ pattern: "a", until: "" }, deps), "until");
});

test("resolveProjectsRoot follows CLAUDE_CONFIG_DIR before the home directory", () => {
    expect(resolveProjectsRoot({ env: {}, home: "/home/anilcan" })).toBe("/home/anilcan/.claude/projects");
    expect(resolveProjectsRoot({ env: { CLAUDE_CONFIG_DIR: "/elsewhere/cc" }, home: "/home/anilcan" }))
        .toBe("/elsewhere/cc/projects");
});
