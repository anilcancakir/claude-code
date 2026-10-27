import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectRunCost, formatRunCost, priceTurn } from "./run-cost.ts";

const roots: string[] = [];

afterEach(() => {
    while (roots.length > 0) {
        const root = roots.pop();
        if (root !== undefined) {
            rmSync(root, { force: true, recursive: true });
        }
    }
});

interface TurnSpec {
    id: string;
    model: string;
    at: string;
    effort?: string;
    input?: number;
    cacheRead?: number;
    cacheWrite5m?: number;
    cacheWrite1h?: number;
    output?: number;
}

function line(turn: TurnSpec): string {
    const cw5 = turn.cacheWrite5m ?? 0;
    const cw1 = turn.cacheWrite1h ?? 0;
    return JSON.stringify({
        type: "assistant",
        timestamp: turn.at,
        ...(turn.effort === undefined ? {} : { effort: turn.effort }),
        message: {
            id: turn.id,
            model: turn.model,
            content: [],
            usage: {
                input_tokens: turn.input ?? 0,
                cache_read_input_tokens: turn.cacheRead ?? 0,
                cache_creation_input_tokens: cw5 + cw1,
                cache_creation: {
                    ephemeral_5m_input_tokens: cw5,
                    ephemeral_1h_input_tokens: cw1,
                },
                output_tokens: turn.output ?? 0,
            },
        },
    });
}

/** Writes `<root>/<project>/<session>.jsonl` plus one subagent per entry, the real layout. */
function writeSession(
    root: string,
    project: string,
    session: string,
    main: readonly TurnSpec[],
    subagents: readonly { id: string; agentType: string; turns: readonly TurnSpec[] }[],
): void {
    const projectDir = join(root, project);
    mkdirSync(join(projectDir, session, "subagents"), { recursive: true });
    writeFileSync(join(projectDir, `${session}.jsonl`), main.map(line).join("\n") + "\n");
    for (const agent of subagents) {
        const base = join(projectDir, session, "subagents", `agent-${agent.id}`);
        writeFileSync(`${base}.jsonl`, agent.turns.map(line).join("\n") + "\n");
        writeFileSync(`${base}.meta.json`, JSON.stringify({ agentType: agent.agentType }));
    }
}

function freshRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "ac-run-cost-"));
    roots.push(root);
    return root;
}

const OPUS = "claude-opus-5-5";
const SONNET = "claude-sonnet-5-5";
const HAIKU = "claude-haiku-5-5";

describe("priceTurn", () => {
    test("prices each token class at the model's published rate, one-hour writes above five-minute ones", () => {
        const cost = priceTurn(OPUS, {
            cacheRead: 1_000_000,
            cacheWrite1h: 1_000_000,
            cacheWrite5m: 1_000_000,
            input: 1_000_000,
            output: 1_000_000,
        });

        // $4 input + $0.20 read + $5 five-minute write + $8 one-hour write + $20 output.
        expect(cost).toBeCloseTo(37.2, 6);
    });

    test("moves a Haiku 5.5 request whose whole prompt passes 100k tokens to the higher tier", () => {
        const small = priceTurn(HAIKU, { cacheRead: 90_000, cacheWrite1h: 0, cacheWrite5m: 0, input: 0, output: 0 });
        const large = priceTurn(HAIKU, { cacheRead: 110_000, cacheWrite1h: 0, cacheWrite5m: 0, input: 0, output: 0 });

        expect(small).toBeCloseTo(90_000 * 0.01 / 1e6, 9);
        expect(large).toBeCloseTo(110_000 * 0.05 / 1e6, 9);
    });

    test("prices an older model at its own rate, not its family's newest", () => {
        const usage = { cacheRead: 1_000_000, cacheWrite1h: 0, cacheWrite5m: 0, input: 0, output: 1_000_000 };

        expect(priceTurn("claude-opus-5", usage)).toBeCloseTo(25.5, 6);
        expect(priceTurn("claude-opus-4-8", usage)).toBeCloseTo(25.5, 6);
        expect(priceTurn("claude-sonnet-5", usage)).toBeCloseTo(10.2, 6);
        expect(priceTurn("claude-sonnet-5-5", usage)).toBeCloseTo(10.1, 6);
    });

    test("prices a model it does not know at zero instead of guessing", () => {
        const usage = { cacheRead: 1, cacheWrite1h: 0, cacheWrite5m: 0, input: 1, output: 1 };

        expect(priceTurn("<synthetic>", usage)).toBe(0);
    });
});

describe("collectRunCost", () => {
    test("rolls subagents up by type and counts only sessions that ran an ac agent", () => {
        const root = freshRoot();
        writeSession(root, "-Users-me-app", "s1", [
            { id: "m1", model: OPUS, at: "2026-10-20T10:00:00Z", cacheRead: 100_000, output: 1_000 },
        ], [
            {
                id: "w1",
                agentType: "ac:plan-worker-junior",
                turns: [{ id: "a1", model: SONNET, at: "2026-10-20T10:01:00Z", cacheRead: 50_000, output: 2_000 }],
            },
            {
                id: "w2",
                agentType: "ac:plan-worker-junior",
                turns: [{ id: "a2", model: SONNET, at: "2026-10-20T10:02:00Z", cacheRead: 30_000, output: 1_000 }],
            },
        ]);
        writeSession(root, "-Users-me-other", "s2", [
            { id: "m9", model: OPUS, at: "2026-10-20T10:00:00Z", cacheRead: 900_000, output: 9_000 },
        ], [
            {
                id: "g1",
                agentType: "general-purpose",
                turns: [{ id: "g1t", model: OPUS, at: "2026-10-20T10:01:00Z", output: 10 }],
            },
        ]);

        const report = collectRunCost({ root, since: "2026-10-01" });

        expect(report.sessions).toBe(1);
        const junior = report.rows.find((row) => row.name === "ac:plan-worker-junior");
        expect(junior?.runs).toBe(2);
        expect(junior?.turns).toBe(2);
        expect(junior?.usage.output).toBe(3_000);
        expect(report.rows.find((row) => row.name === "general-purpose")).toBeUndefined();
        expect(report.main.usage.cacheRead).toBe(100_000);
    });

    test("includes every session with allSessions, and drops turns and runs before the cut-off", () => {
        const root = freshRoot();
        writeSession(root, "-Users-me-app", "s1", [
            { id: "old", model: OPUS, at: "2026-09-01T10:00:00Z", output: 7_000 },
            { id: "new", model: OPUS, at: "2026-10-20T10:00:00Z", output: 1_000 },
        ], [
            {
                id: "o1",
                agentType: "general-purpose",
                turns: [{ id: "x", model: OPUS, at: "2026-09-01T10:01:00Z", output: 5 }],
            },
        ]);

        const report = collectRunCost({ allSessions: true, root, since: "2026-10-01" });

        expect(report.sessions).toBe(1);
        expect(report.main.usage.output).toBe(1_000);
        expect(report.rows).toEqual([]);
    });

    test("filters by a project path substring", () => {
        const root = freshRoot();
        const lane = [{
            id: "l1",
            agentType: "ac:lane",
            turns: [{ id: "l1t", model: OPUS, at: "2026-10-20T10:01:00Z", output: 10 }],
        }];
        writeSession(root, "-Users-me-app", "s1", [{ id: "m", model: OPUS, at: "2026-10-20T10:00:00Z" }], lane);
        writeSession(root, "-Users-me-web", "s2", [{ id: "n", model: OPUS, at: "2026-10-20T10:00:00Z" }], lane);

        expect(collectRunCost({ project: "web", root, since: "2026-10-01" }).sessions).toBe(1);
    });

    test("counts a cache rebuild after an idle gap past the five-minute TTL", () => {
        const root = freshRoot();
        writeSession(root, "-Users-me-app", "s1", [], [{
            id: "l1",
            agentType: "ac:lane",
            turns: [
                { id: "t1", model: OPUS, at: "2026-10-20T10:00:00Z", cacheWrite5m: 100_000 },
                { id: "t2", model: OPUS, at: "2026-10-20T10:01:00Z", cacheRead: 100_000, cacheWrite5m: 2_000 },
                // Nine idle minutes: the cache expired and the whole context is written again.
                { id: "t3", model: OPUS, at: "2026-10-20T10:10:00Z", cacheRead: 0, cacheWrite5m: 102_000 },
            ],
        }]);

        const lane = collectRunCost({ root, since: "2026-10-01" }).rows.find((row) => row.name === "ac:lane");

        expect(lane?.idleRebuildTokens).toBe(102_000);
        // Active minutes: the nine idle minutes are waiting, not work.
        expect(lane?.minutes).toBe(1);
    });

    test("splits the main thread by the model and effort each turn ran on", () => {
        const root = freshRoot();
        const lane = {
            agentType: "ac:lane",
            id: "l1",
            turns: [{ at: "2026-10-20T10:01:00Z", id: "l1t", model: OPUS, output: 1 }],
        };
        writeSession(root, "-Users-me-app", "s1", [
            { at: "2026-10-20T10:00:00Z", effort: "high", id: "o1", model: OPUS, output: 100 },
            { at: "2026-10-20T10:01:00Z", effort: "xhigh", id: "s1", model: SONNET, output: 200 },
            { at: "2026-10-20T10:02:00Z", effort: "xhigh", id: "s2", model: SONNET, output: 300 },
        ], [lane]);

        const report = collectRunCost({ root, since: "2026-10-01" });
        const rows = report.mainByModel.map((row) => `${row.name}:${row.turns}:${row.usage.output}`);

        expect(rows.sort()).toEqual(["main [opus-5-5 high]:1:100", "main [sonnet-5-5 xhigh]:2:500"]);
        expect(report.main.usage.output).toBe(600);
        expect(formatRunCost(report)).toContain("main [sonnet-5-5 xhigh]");
    });

    test("splits an agent type by the effort its runs used", () => {
        const root = freshRoot();
        const oracle = (id: string, effort: string): { id: string; agentType: string; turns: TurnSpec[] } => ({
            agentType: "ac:oracle",
            id,
            turns: [{ at: "2026-10-20T10:01:00Z", effort, id: `${id}t`, model: OPUS, output: 10 }],
        });
        const runs = [
            oracle("o1", "medium"),
            oracle("o2", "high"),
            oracle("o3", "high"),
        ];
        writeSession(root, "-Users-me-app", "s1", [], runs);

        const names = collectRunCost({ root, since: "2026-10-01" }).rows.map((row) => `${row.name}:${row.runs}`);

        expect(names.sort()).toEqual(["ac:oracle [high]:2", "ac:oracle [medium]:1"]);
    });

    test("counts a message id once even when a resumed session copied it into a second transcript", () => {
        const root = freshRoot();
        const turn = { at: "2026-10-20T10:00:00Z", id: "shared", model: OPUS, output: 1_000 };
        const lane = {
            agentType: "ac:lane",
            id: "l1",
            turns: [{ at: "2026-10-20T10:01:00Z", id: "l1t", model: OPUS, output: 1 }],
        };
        writeSession(root, "-Users-me-app", "s1", [turn], [lane]);
        writeSession(root, "-Users-me-app", "s2", [turn, { ...turn, id: "own" }], [{ ...lane, id: "l2" }]);

        expect(collectRunCost({ root, since: "2026-10-01" }).main.usage.output).toBe(2_000);
    });
});

describe("formatRunCost", () => {
    test("leads with the totals and the main-thread share, then one row per agent type by cost", () => {
        const root = freshRoot();
        writeSession(root, "-Users-me-app", "s1", [
            { id: "m1", model: OPUS, at: "2026-10-20T10:00:00Z", output: 100_000 },
        ], [{
            id: "e1",
            agentType: "ac:explore",
            turns: [{ id: "e1t", model: HAIKU, at: "2026-10-20T10:01:00Z", output: 1_000 }],
        }]);

        const text = formatRunCost(collectRunCost({ root, since: "2026-10-01" }));

        expect(text).toContain("Sessions: 1");
        expect(text).toContain("main thread");
        expect(text).toContain("ac:explore");
        expect(text.indexOf("main thread")).toBeLessThan(text.indexOf("ac:explore"));
    });
});
