import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { distillLine, resolveSessionMeta } from "./history-distill.ts";
import type { DistillContext, DistillOutcome } from "./history-distill.ts";
import { buildFixtureCorpus, CONTROL_TYPES, FUTURE_CONTROL_TYPE } from "./history-fixtures.ts";
import type { FixtureCounts } from "./history-fixtures.ts";

const roots: string[] = [];

function freshRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "ac-history-distill-"));
    roots.push(root);
    return root;
}

afterEach(() => {
    while (roots.length > 0) {
        const root = roots.pop();
        if (root !== undefined) {
            rmSync(root, { force: true, recursive: true });
        }
    }
});

const CTX: DistillContext = { projectPath: "/tmp/proj-a", isSubagent: false };

/**
 * Reads a fixture file's complete lines, dropping the trailing torn fragment when the file has no
 * final newline. A real byte cursor (Step 4) never hands that fragment to the distiller, so a test
 * driving the distiller over a whole file must not either.
 */
function readWellFormedLines(path: string): string[] {
    const raw = readFileSync(path, "utf8");
    const endsWithNewline = raw.endsWith("\n");
    const lines = raw.split("\n").filter((line: string) => line.length > 0);
    if (!endsWithNewline && lines.length > 0) {
        lines.pop();
    }
    return lines;
}

/** Tallies every outcome a set of well-formed lines produces, matching {@link FixtureCounts}'s shape. */
function tallyOutcomes(lines: readonly string[], ctx: DistillContext): FixtureCounts {
    let proseRows = 0;
    let toolUseRows = 0;
    let errorRows = 0;
    let quarantineRows = 0;
    let skippedLines = 0;
    let controlLinesSkipped = 0;

    for (const line of lines) {
        const outcome: DistillOutcome = distillLine(line, ctx);
        if (outcome.outcome === "control") {
            controlLinesSkipped++;
            continue;
        }
        if (outcome.outcome === "skipped") {
            skippedLines++;
            continue;
        }
        if (outcome.outcome === "quarantine") {
            quarantineRows++;
            continue;
        }
        for (const row of outcome.rows) {
            if (row.kind === "prose") {
                proseRows++;
            } else if (row.kind === "tool_use") {
                toolUseRows++;
            } else {
                errorRows++;
            }
        }
    }

    return { proseRows, toolUseRows, errorRows, quarantineRows, skippedLines, controlLinesSkipped };
}

// 1. The full corpus, exercised end to end (this is the step's QA).

test("distilling the whole fixture corpus reproduces buildFixtureCorpus's declared expected counts", () => {
    const corpus = buildFixtureCorpus(freshRoot());

    const totals: FixtureCounts = {
        proseRows: 0,
        toolUseRows: 0,
        errorRows: 0,
        quarantineRows: 0,
        skippedLines: 0,
        controlLinesSkipped: 0,
    };

    const files: ReadonlyArray<{ path: string; ctx: DistillContext }> = [
        { path: corpus.mainSessionPath, ctx: { projectPath: "/tmp/proj-a", isSubagent: false } },
        { path: corpus.projectBSessionPath, ctx: { projectPath: "/tmp/proj-b", isSubagent: false } },
        {
            path: corpus.subagentTranscriptPath,
            ctx: { projectPath: "/tmp/proj-a", isSubagent: true, agentType: "ac:librarian" },
        },
    ];

    for (const file of files) {
        const partial = tallyOutcomes(readWellFormedLines(file.path), file.ctx);
        totals.proseRows += partial.proseRows;
        totals.toolUseRows += partial.toolUseRows;
        totals.errorRows += partial.errorRows;
        totals.quarantineRows += partial.quarantineRows;
        totals.skippedLines += partial.skippedLines;
        totals.controlLinesSkipped += partial.controlLinesSkipped;
    }

    expect(totals).toEqual(corpus.expected);
});

// 2. tool_use rows render every string/number/boolean input key, not a fixed list.

test("a tool_use row renders every string, number and boolean key from input, not a fixed list", () => {
    const line = JSON.stringify({
        type: "assistant",
        uuid: "line-tool-use-unusual",
        sessionId: "sess-1",
        timestamp: "2026-08-01T00:00:00.000Z",
        message: {
            role: "assistant",
            content: [
                {
                    type: "tool_use",
                    id: "toolu_unusual",
                    name: "WeirdTool",
                    input: {
                        zqxUnlikelyFieldName: "zqx-value",
                        retryCount: 3,
                        dryRun: true,
                        nestedObject: { skip: "me" },
                        listValue: ["skip", "me", "too"],
                    },
                },
            ],
        },
    });

    const outcome = distillLine(line, CTX);
    expect(outcome.outcome).toBe("rows");
    if (outcome.outcome !== "rows") {
        throw new Error("unreachable: asserted above");
    }

    const toolUseRow = outcome.rows.find((row) => row.kind === "tool_use");
    expect(toolUseRow).toBeDefined();
    expect(toolUseRow?.body).toContain("zqxUnlikelyFieldName=zqx-value");
    expect(toolUseRow?.body).toContain("retryCount=3");
    expect(toolUseRow?.body).toContain("dryRun=true");
    expect(toolUseRow?.body).not.toContain("skip");
});

// 3. tool_result rows: is_error true produces a row, is_error absent produces nothing.

test("an array tool_result with is_error true produces a tool_error row and one with is_error absent produces nothing", () => {
    const errorLine = JSON.stringify({
        type: "user",
        uuid: "line-tool-result-error",
        sessionId: "sess-1",
        timestamp: "2026-08-01T00:00:00.000Z",
        message: {
            role: "user",
            content: [
                { type: "text", text: "ZQX-KEEP-PROSE-ERROR-CASE" },
                { type: "tool_result", tool_use_id: "t1", is_error: true, content: "ZQX-ERROR-BODY" },
            ],
        },
    });
    const successLine = JSON.stringify({
        type: "user",
        uuid: "line-tool-result-success",
        sessionId: "sess-1",
        timestamp: "2026-08-01T00:00:00.000Z",
        message: {
            role: "user",
            content: [
                { type: "text", text: "ZQX-KEEP-PROSE-SUCCESS-CASE" },
                { type: "tool_result", tool_use_id: "t2", content: "ZQX-SUCCESS-BODY" },
            ],
        },
    });

    const errorOutcome = distillLine(errorLine, CTX);
    expect(errorOutcome.outcome).toBe("rows");
    if (errorOutcome.outcome !== "rows") {
        throw new Error("unreachable: asserted above");
    }
    expect(errorOutcome.rows.some((row) => row.kind === "tool_error")).toBe(true);

    const successOutcome = distillLine(successLine, CTX);
    expect(successOutcome.outcome).toBe("rows");
    if (successOutcome.outcome !== "rows") {
        throw new Error("unreachable: asserted above");
    }
    expect(successOutcome.rows.some((row) => row.kind === "tool_error")).toBe(false);
    expect(successOutcome.rows).toHaveLength(1);
});

// 4. An image-only line yields zero rows and is skipped, not quarantined: `image` is a block
//    type the distiller KNOWS and deliberately does not index, using the Step 1 fixture directly.

test("a line holding only an image block produces a skipped outcome, not quarantine", () => {
    const corpus = buildFixtureCorpus(freshRoot());
    const lines = readWellFormedLines(corpus.mainSessionPath);
    const imageOnlyLine = lines.find((line) => line.includes("ZRQPHX-IMAGE-DATA"));
    if (imageOnlyLine === undefined) {
        throw new Error("fixture image-only line not found");
    }

    const outcome = distillLine(imageOnlyLine, CTX);
    expect(outcome.outcome).toBe("skipped");
});

// 4b. A line holding only a SUCCESSFUL tool_result also skips rather than quarantines: this is
//     the single most common textless shape in the real corpus, and quarantining it is what
//     produced a 1.53 GB quarantine table against a 145 MB `turns` body.

test("a line holding only a successful tool_result produces a skipped outcome", () => {
    const corpus = buildFixtureCorpus(freshRoot());
    const lines = readWellFormedLines(corpus.mainSessionPath);
    const successfulToolResultLine = lines.find((line) => line.includes("ZRQPHX-SUCCESSFUL-TOOLRESULT"));
    if (successfulToolResultLine === undefined) {
        throw new Error("fixture successful-tool-result-only line not found");
    }

    const outcome = distillLine(successfulToolResultLine, CTX);
    expect(outcome.outcome).toBe("skipped");
});

// 4c. A line holding a block type the distiller does not know at all (`document`, which really
//     occurs) quarantines rather than skips: this is the shape the quarantine arm exists for.

test("a line holding an unknown block type (document) produces a quarantine outcome", () => {
    const corpus = buildFixtureCorpus(freshRoot());
    const lines = readWellFormedLines(corpus.mainSessionPath);
    const unknownBlockLine = lines.find((line) => line.includes("ZRQPHX-DOCUMENT-DATA"));
    if (unknownBlockLine === undefined) {
        throw new Error("fixture unknown-block-type line not found");
    }

    const outcome = distillLine(unknownBlockLine, CTX);
    expect(outcome.outcome).toBe("quarantine");
});

// 4d. A conversational line lacking a uuid or sessionId still quarantines, unaffected by the
//     skipped/quarantine split above.

test("a user line lacking a uuid quarantines", () => {
    const line = JSON.stringify({
        type: "user",
        sessionId: "sess-1",
        message: { role: "user", content: "ZQX-NO-UUID" },
    });
    const outcome = distillLine(line, CTX);
    expect(outcome.outcome).toBe("quarantine");
});

test("a user line lacking a sessionId quarantines", () => {
    const line = JSON.stringify({
        type: "user",
        uuid: "line-no-session-id",
        message: { role: "user", content: "ZQX-NO-SESSION-ID" },
    });
    const outcome = distillLine(line, CTX);
    expect(outcome.outcome).toBe("quarantine");
});

// 5. Every allowlisted control type returns control, never quarantine.

test("every type in the control allowlist returns control", () => {
    for (const controlType of CONTROL_TYPES) {
        const line = JSON.stringify({ type: controlType, uuid: "u", sessionId: "s" });
        const outcome = distillLine(line, CTX);
        expect(outcome.outcome).toBe("control");
    }
});

// 6. An unrecognized future type also returns control, so a new record type cannot flood quarantine.

test("an unknown future type string returns control, not quarantine", () => {
    const line = JSON.stringify({ type: FUTURE_CONTROL_TYPE, uuid: "u", sessionId: "s" });
    const outcome = distillLine(line, CTX);
    expect(outcome.outcome).toBe("control");
});

// 7. The malformed-JSON fixture line quarantines with the raw line preserved byte-for-byte.

test("the malformed-JSON fixture line returns quarantine with the raw line preserved byte-for-byte", () => {
    const corpus = buildFixtureCorpus(freshRoot());
    const lines = readWellFormedLines(corpus.mainSessionPath);
    const malformedLine = lines.find((line) => line.includes("ZRQPHX-MALFORMED-JSON"));
    if (malformedLine === undefined) {
        throw new Error("fixture malformed-JSON line not found");
    }

    const outcome = distillLine(malformedLine, CTX);
    expect(outcome.outcome).toBe("quarantine");
    if (outcome.outcome !== "quarantine") {
        throw new Error("unreachable: asserted above");
    }
    expect(outcome.raw).toBe(malformedLine);
});

// 8. resolveSessionMeta's title chain: customTitle beats aiTitle, per the source's `??` chain.

test("resolveSessionMeta's title chain prefers customTitle over aiTitle when both are present in the tail", () => {
    const tail =
        '{"type":"custom-title","customTitle":"ZQX Custom Title"}\n' +
        '{"type":"ai-title","aiTitle":"ZQX AI Title"}\n';

    const meta = resolveSessionMeta("", tail);
    expect(meta.title).toBe("ZQX Custom Title");
});

// 9. resolveSessionMeta reads projectPath from the first cwd seen in the head.

test("resolveSessionMeta reads projectPath from the first cwd seen in the head", () => {
    const head = '{"type":"user","cwd":"/tmp/zqx-project","message":{"role":"user","content":"hi"}}\n';
    const meta = resolveSessionMeta(head, "");
    expect(meta.projectPath).toBe("/tmp/zqx-project");
});

// 10. resolveSessionMeta's first-prompt chain: the tail's lastPrompt wins over the head's own content.

test("resolveSessionMeta's first-prompt chain prefers the tail's lastPrompt over the head's own content", () => {
    const head = '{"type":"user","message":{"role":"user","content":"ZQX head prompt, should lose"}}\n';
    const tail = '{"type":"last-prompt","lastPrompt":"ZQX tail last prompt, should win"}\n';

    const meta = resolveSessionMeta(head, tail);
    expect(meta.firstPrompt).toBe("ZQX tail last prompt, should win");
});

// 11. With no lastPrompt in the tail, the chain falls back to scanning the head's first user message.

test("resolveSessionMeta's first-prompt chain falls back to the head's first user message when the tail has no lastPrompt", () => {
    const head =
        '{"type":"user","uuid":"u1","sessionId":"s1","message":{"role":"user","content":"ZQX head fallback prompt"}}\n';

    const meta = resolveSessionMeta(head, "");
    expect(meta.firstPrompt).toBe("ZQX head fallback prompt");
});

// 8. The archive declines to index its own search calls, so the tool does not pollute the corpus
// it searches. Measured live before the fix: two `count` calls for one word thirty seconds apart
// returned 1,896 then 1,899 hits, the three new rows being the searches themselves.

/** One assistant line carrying a single `tool_use` block with the given tool name. */
function toolUseLine(name: string, uuid: string): string {
    return JSON.stringify({
        type: "assistant",
        uuid,
        sessionId: "sess-1",
        timestamp: "2026-08-01T00:00:00.000Z",
        message: {
            role: "assistant",
            content: [
                {
                    type: "tool_use",
                    id: `toolu_${uuid}`,
                    name,
                    input: { pattern: "zqxSearchTerm", output_mode: "count" },
                },
            ],
        },
    });
}

test("a search-history tool_use is skipped rather than indexed, under both its bare and MCP names", () => {
    for (const name of ["search-history", "mcp__plugin_ac_ac__search-history"]) {
        const outcome = distillLine(toolUseLine(name, `line-${name}`), CTX);

        // `skipped`, never `quarantine`: the block is well-formed and understood, it is simply not
        // wanted. Quarantining it would refill the table the quarantine rule was narrowed to empty.
        expect(outcome.outcome).toBe("skipped");
    }
});

test("a tool whose name merely contains search-history is still indexed", () => {
    // The guard matches the exact name or an MCP-namespaced one, so a user's own similarly-named
    // tool keeps its rows instead of silently vanishing from the archive.
    const outcome = distillLine(toolUseLine("my-search-history-viewer", "line-lookalike"), CTX);

    expect(outcome.outcome).toBe("rows");
    if (outcome.outcome !== "rows") {
        throw new Error("unreachable: asserted above");
    }
    expect(outcome.rows.some((row) => row.kind === "tool_use")).toBe(true);
});

test("a skipped search call does not suppress the other blocks on its line", () => {
    const line = JSON.stringify({
        type: "assistant",
        uuid: "line-mixed",
        sessionId: "sess-1",
        timestamp: "2026-08-01T00:00:00.000Z",
        message: {
            role: "assistant",
            content: [
                { type: "text", text: "zqxProseAlongside the search" },
                {
                    type: "tool_use",
                    id: "toolu_mixed",
                    name: "mcp__plugin_ac_ac__search-history",
                    input: { pattern: "zqxSearchTerm" },
                },
            ],
        },
    });

    const outcome = distillLine(line, CTX);
    expect(outcome.outcome).toBe("rows");
    if (outcome.outcome !== "rows") {
        throw new Error("unreachable: asserted above");
    }

    expect(outcome.rows.some((row) => row.kind === "prose")).toBe(true);
    expect(outcome.rows.some((row) => row.kind === "tool_use")).toBe(false);
});
