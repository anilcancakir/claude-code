import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeRunStats, formatRunStats, resolveTranscriptPath } from "./run-stats.ts";

const roots: string[] = [];

function freshRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "ac-run-stats-"));
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

/** Builds one transcript line for an assistant record carrying `blocks` content entries. */
function assistantLine(
    id: string,
    usage: { cacheRead: number; output: number } | null,
    blocks: readonly unknown[],
): string {
    return JSON.stringify({
        type: "assistant",
        message: {
            id,
            content: blocks,
            ...(usage === null
                ? {}
                : {
                    usage: {
                        output_tokens: usage.output,
                        cache_read_input_tokens: usage.cacheRead,
                    },
                }),
        },
    });
}

function toolUse(name: string, input: Record<string, unknown> = {}): unknown {
    return { type: "tool_use", name, input };
}

describe("computeRunStats", () => {
    test("counts one turn per message id even when the record spans many lines", () => {
        // Claude Code writes one transcript line per streamed content block, repeating the same
        // message id and the same usage object on each. Summing without deduping multiplies every
        // token total by the block count.
        const lines = [
            assistantLine("m1", { cacheRead: 1000, output: 10 }, [toolUse("Bash")]),
            assistantLine("m1", { cacheRead: 1000, output: 10 }, [toolUse("Bash")]),
            assistantLine("m2", { cacheRead: 2000, output: 20 }, [toolUse("Read")]),
        ];

        const stats = computeRunStats(lines);

        expect(stats.turns).toBe(2);
        expect(stats.outputTokens).toBe(30);
        expect(stats.cacheReadTokens).toBe(3000);
    });

    test("counts every tool_use block, including repeats inside one message", () => {
        // The mirror of the rule above: tool calls must NOT be deduped. Two Bash calls issued in
        // one assistant turn are two calls, and a dedupe keyed on the message collapses them.
        const lines = [
            assistantLine("m1", { cacheRead: 100, output: 1 }, [
                toolUse("Bash"),
                toolUse("Bash"),
                toolUse("Edit", { file_path: "/tmp/a.ts" }),
            ]),
        ];

        const stats = computeRunStats(lines);

        expect(stats.toolCalls).toEqual([
            { count: 2, name: "Bash" },
            { count: 1, name: "Edit" },
        ]);
        expect(stats.totalToolCalls).toBe(3);
    });

    test("reports average and peak resident context", () => {
        const lines = [
            assistantLine("m1", { cacheRead: 100, output: 1 }, []),
            assistantLine("m2", { cacheRead: 500, output: 1 }, []),
            assistantLine("m3", { cacheRead: 300, output: 1 }, []),
        ];

        const stats = computeRunStats(lines);

        expect(stats.peakContext).toBe(500);
        expect(stats.avgContext).toBe(300);
    });

    test("counts a compaction when resident context collapses", () => {
        // Auto-compaction shows up as the cache read falling off a cliff rather than drifting down.
        // Counting them matters because a run that never compacts holds its peak for every turn.
        const lines = [
            assistantLine("m1", { cacheRead: 800_000, output: 1 }, []),
            assistantLine("m2", { cacheRead: 838_505, output: 1 }, []),
            assistantLine("m3", { cacheRead: 0, output: 1 }, []),
            assistantLine("m4", { cacheRead: 40_000, output: 1 }, []),
        ];

        const stats = computeRunStats(lines);

        expect(stats.compactions).toBe(1);
    });

    test("ignores a one-turn dip that the next turns recover from", () => {
        // A single turn reporting zero cache read is a fresh cache segment, not a compaction. On one
        // 389-turn run the naive drop test flagged 13 of these where exactly one was real.
        const lines = [
            assistantLine("m1", { cacheRead: 600_000, output: 1 }, []),
            assistantLine("m2", { cacheRead: 0, output: 1 }, []),
            assistantLine("m3", { cacheRead: 624_075, output: 1 }, []),
            assistantLine("m4", { cacheRead: 640_000, output: 1 }, []),
        ];

        const stats = computeRunStats(lines);

        expect(stats.compactions).toBe(0);
    });

    test("rolls agent spawns up by subagent type", () => {
        const lines = [
            assistantLine("m1", { cacheRead: 1, output: 1 }, [
                toolUse("Agent", { subagent_type: "ac:plan-worker-senior" }),
                toolUse("Agent", { subagent_type: "ac:plan-worker-junior" }),
            ]),
            assistantLine("m2", { cacheRead: 1, output: 1 }, [
                toolUse("Agent", { subagent_type: "ac:plan-worker-senior" }),
            ]),
        ];

        const stats = computeRunStats(lines);

        expect(stats.agentSpawns).toEqual([
            { count: 2, name: "ac:plan-worker-senior" },
            { count: 1, name: "ac:plan-worker-junior" },
        ]);
    });

    test("skips records that are not assistant turns, and lines that do not parse", () => {
        const lines = [
            JSON.stringify({ type: "mode", mode: "normal" }),
            JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }),
            "{ not json",
            "",
            assistantLine("m1", { cacheRead: 10, output: 2 }, [toolUse("Read")]),
        ];

        const stats = computeRunStats(lines);

        expect(stats.turns).toBe(1);
        expect(stats.totalToolCalls).toBe(1);
    });

    test("tolerates an assistant record with no usage block", () => {
        const lines = [
            assistantLine("m1", null, [toolUse("Bash")]),
            assistantLine("m2", { cacheRead: 100, output: 5 }, []),
        ];

        const stats = computeRunStats(lines);

        expect(stats.turns).toBe(2);
        expect(stats.outputTokens).toBe(5);
        expect(stats.avgContext).toBe(50);
    });
});

describe("resolveTranscriptPath", () => {
    test("passes a path straight through without touching the filesystem", () => {
        expect(resolveTranscriptPath("/nowhere/at/all.jsonl", "/also/nowhere"))
            .toBe("/nowhere/at/all.jsonl");
    });

    test("finds a bare session id under whichever project holds it", () => {
        const root = freshRoot();
        mkdirSync(join(root, "-Users-someone-project-a"), { recursive: true });
        mkdirSync(join(root, "-Users-someone-project-b"), { recursive: true });
        const wanted = join(root, "-Users-someone-project-b", "abc-123.jsonl");
        writeFileSync(wanted, "");

        expect(resolveTranscriptPath("abc-123", root)).toBe(wanted);
    });

    test("throws a named error when no project holds the session", () => {
        const root = freshRoot();
        mkdirSync(join(root, "-Users-someone-project-a"), { recursive: true });

        expect(() => resolveTranscriptPath("missing-id", root)).toThrow(/No transcript found/);
    });
});

describe("formatRunStats", () => {
    test("renders the headline numbers and the tool mix", () => {
        const lines = [
            assistantLine("m1", { cacheRead: 1000, output: 10 }, [toolUse("Bash")]),
        ];

        const rendered = formatRunStats(computeRunStats(lines));

        expect(rendered).toContain("Turns: 1");
        expect(rendered).toContain("Output tokens: 10");
        expect(rendered).toContain("Bash");
    });
});
