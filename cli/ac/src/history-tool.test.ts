import { expect, test } from "bun:test";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { HISTORY_TOOL_DEFINITION, runHistoryTool } from "./history-tool.ts";
import type { HistorySearchDeps } from "./history-search.ts";
import type { SqlStatement } from "./history-query.ts";
import type { HistorySyncReport } from "./history-sync.ts";
import type {
    HistoryForgetResult,
    HistoryIngestResult,
    HistoryResultRow,
    HistorySessionRecord,
    HistoryStore,
} from "./history-store.ts";

/**
 * Every assertion here runs against an injected fake store and a no-op sync, never against real
 * sqlite: `bun test` cannot load `node:sqlite` at all. `runHistoryTool`'s default,
 * store-opening path is reached only in production, when a caller supplies no
 * `overrides.store`; every test below supplies one, so that path is never exercised here.
 */

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
        body: "ZRQPHX read body",
        ...overrides,
    };
}

interface FakeStoreOptions {
    readonly readRows?: readonly HistoryResultRow[];
    readonly readTotal?: number;
    readonly selectImpl?: (statement: SqlStatement) => readonly HistoryResultRow[];
}

/** A minimal `HistoryStore` stand-in, routing `select` by the shape of the statement it is handed. */
function createFakeStore(options: FakeStoreOptions = {}): HistoryStore {
    return {
        databasePath: ":fake:",
        schemaVersion: 1,
        writable: true,
        getManifestEntry: (): undefined => undefined,
        ingest: (): HistoryIngestResult => ({
            rowsAdded: 0,
            rowsIgnored: 0,
            quarantined: 0,
            redactions: {},
            skipped: false,
            busy: false,
        }),
        upsertSession: (): void => undefined,
        lookupSessions: (): Map<string, HistorySessionRecord> => new Map(),
        select: (statement: SqlStatement): readonly HistoryResultRow[] => {
            if (options.selectImpl) {
                return options.selectImpl(statement);
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
}

/** A no-op sync, so a test never performs real filesystem IO against the projects root. */
async function noopSync(): Promise<HistorySyncReport> {
    return {
        filesScanned: 0,
        filesVanished: 0,
        rowsAdded: 0,
        quarantined: 0,
        redactions: 0,
        elapsedMillis: 0,
        changed: false,
    };
}

function overridesWith(store: HistoryStore, extra: Partial<HistorySearchDeps> = {}): Partial<HistorySearchDeps> {
    return { store, sync: noopSync, ...extra };
}

function joinText(result: CallToolResult): string {
    return result.content.map((c) => (c as { text?: string }).text ?? "").join("");
}

async function expectInvalidParams(promise: Promise<CallToolResult>, fragment?: string): Promise<McpError> {
    try {
        await promise;
    } catch (error) {
        expect(error).toBeInstanceOf(McpError);
        const mcpError = error as McpError;
        expect(mcpError.code).toBe(ErrorCode.InvalidParams);
        if (fragment !== undefined) {
            expect(mcpError.message).toContain(fragment);
        }
        return mcpError;
    }

    throw new Error("expected an McpError(InvalidParams)");
}

const EXPECTED_PARAM_NAMES = [
    "pattern",
    "path",
    "output_mode",
    "head_limit",
    "offset",
    "-i",
    "since",
    "until",
    "role",
    "kind",
    "include_subagents",
    "agent_type",
    "session_id",
];

test("the schema declares every parameter named in the description", () => {
    const schema = HISTORY_TOOL_DEFINITION.inputSchema as { properties: Record<string, unknown> };
    for (const name of EXPECTED_PARAM_NAMES) {
        expect(name in schema.properties).toBe(true);
    }
});

test("the description disambiguates the borrowed pattern name from a regex", () => {
    const description = HISTORY_TOOL_DEFINITION.description ?? "";
    expect(description).toContain("NOT a regular expression");
    expect(description).toContain("TOKENIZED FULL-TEXT");
});

test("output_mode read with a session_id and no pattern validates and returns a window", async () => {
    const store = createFakeStore({ readRows: [readRow()], readTotal: 1 });

    const result = await runHistoryTool(
        { output_mode: "read", session_id: "sess-1" },
        overridesWith(store),
    );

    expect(result.isError).toBeUndefined();
    expect(joinText(result)).toContain("turns 1-1 of 1");
});

test("output_mode content with no pattern throws McpError InvalidParams", async () => {
    const store = createFakeStore();

    await expectInvalidParams(
        runHistoryTool({ output_mode: "content" }, overridesWith(store)),
        "pattern",
    );
});

test("output_mode read without session_id throws McpError InvalidParams", async () => {
    const store = createFakeStore();

    await expectInvalidParams(
        runHistoryTool({ output_mode: "read" }, overridesWith(store)),
        "session_id",
    );
});

test("an out-of-range head_limit throws McpError InvalidParams", async () => {
    const store = createFakeStore();

    await expectInvalidParams(
        runHistoryTool({ pattern: "ZRQPHX", head_limit: 0 }, overridesWith(store)),
        "head_limit",
    );
});

test("a non-object argument is rejected as InvalidParams rather than crashing", async () => {
    const store = createFakeStore();

    await expectInvalidParams(runHistoryTool(null, overridesWith(store)));
    await expectInvalidParams(runHistoryTool("not an object", overridesWith(store)));
});

test("a thrown McpError propagates unchanged rather than becoming an isError result", async () => {
    const store = createFakeStore();

    let thrown: unknown;
    try {
        await runHistoryTool({}, overridesWith(store));
    } catch (error) {
        thrown = error;
    }

    expect(thrown).toBeInstanceOf(McpError);
    expect((thrown as McpError).code).toBe(ErrorCode.InvalidParams);
});

test("a plain Error from execution becomes an isError result, not a thrown error", async () => {
    const store = createFakeStore({
        selectImpl: (): never => {
            throw new Error("archive is corrupt");
        },
    });

    const result = await runHistoryTool({ pattern: "ZRQPHX" }, overridesWith(store));

    expect(result.isError).toBe(true);
    expect(joinText(result)).toContain("archive is corrupt");
});
