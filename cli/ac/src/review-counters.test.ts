import { expect, test } from "bun:test";
import { computeCounters, formatCounters, MISSING_LOG_LINE } from "./review-counters.ts";

const OPTS = { cap: 3, iterPrefix: "## Phase 3d Iteration", runPrefix: "## Run " };

// A log that was never created means a first pass with nothing behind it. The awk this
// replaces emitted the same fallback via `|| echo`, and two skill bodies parse that line.

test("missing log falls back to a first-pass line", () => {
    expect(MISSING_LOG_LINE).toBe("ITER=1 PREV=none GATE=OK NEW=none");
});

test("empty log reads as a first pass", () => {
    expect(formatCounters(computeCounters("", OPTS))).toBe("ITER=1 PREV=none GATE=OK NEW=none");
});

// Single run, one logged pass: the pass about to run is the second, and PREV is the
// issue count the logged pass recorded.

test("single run with one pass reports ITER=2 and that pass's issue count", () => {
    const log = [
        "## Run 2026-07-31T23:28:50Z",
        "",
        "## Phase 3d Iteration 1",
        "",
        "- Issue count: 4",
    ].join("\n");
    expect(formatCounters(computeCounters(log, OPTS))).toBe("ITER=2 PREV=4 GATE=OK NEW=none");
});

// The run header is what scopes the counters. Without the reset, a second /ac:execute on
// the same slug would count the previous run's passes and land past the cap on pass one.

test("an older run does not leak into the newer one", () => {
    const log = [
        "## Run 2026-07-01T00:00:00Z",
        "## Phase 3d Iteration 1",
        "- Issue count: 9",
        "## Phase 3d Iteration 2",
        "- Issue count: 8",
        "## Phase 3d Iteration 3",
        "- Issue count: 7",
        "## Run 2026-07-31T23:28:50Z",
        "## Phase 3d Iteration 1",
        "- Issue count: 2",
    ].join("\n");
    expect(formatCounters(computeCounters(log, OPTS))).toBe("ITER=2 PREV=2 GATE=OK NEW=none");
});

// NEW counts fingerprints the latest pass introduced. An identical set means the reviewer
// returned the same findings again, which is the stall signal the count alone cannot see.

test("a repeated fingerprint set reports NEW=0", () => {
    const log = [
        "## Run 2026-07-31T23:28:50Z",
        "## Phase 3d Iteration 1",
        "- Issue count: 2",
        "- Fingerprints: compliance|S3,quality|S7",
        "## Phase 3d Iteration 2",
        "- Issue count: 2",
        "- Fingerprints: quality|S7,compliance|S3",
    ].join("\n");
    expect(formatCounters(computeCounters(log, OPTS))).toBe("ITER=3 PREV=2 GATE=OK NEW=0");
});

test("a changed fingerprint set counts only the additions", () => {
    const log = [
        "## Run 2026-07-31T23:28:50Z",
        "## Phase 3d Iteration 1",
        "- Fingerprints: compliance|S3,quality|S7",
        "## Phase 3d Iteration 2",
        "- Fingerprints: compliance|S3,spec|S1,reuse|S9",
    ].join("\n");
    expect(computeCounters(log, OPTS).newCount).toBe("2");
});

test("one fingerprint line is not enough to compare", () => {
    const log = [
        "## Run 2026-07-31T23:28:50Z",
        "## Phase 3d Iteration 1",
        "- Fingerprints: compliance|S3",
    ].join("\n");
    expect(computeCounters(log, OPTS).newCount).toBe("none");
});

// The cap gates on the pass about to run, not the passes already logged.

test("the pass after the cap reports MAX_ITER", () => {
    const log = [
        "## Run 2026-07-31T23:28:50Z",
        "## Phase 3d Iteration 1",
        "## Phase 3d Iteration 2",
        "## Phase 3d Iteration 3",
    ].join("\n");
    expect(computeCounters(log, OPTS).gate).toBe("MAX_ITER");
});

test("the pass at the cap is still OK", () => {
    const log = [
        "## Run 2026-07-31T23:28:50Z",
        "## Phase 3d Iteration 1",
        "## Phase 3d Iteration 2",
    ].join("\n");
    expect(computeCounters(log, OPTS).gate).toBe("OK");
});

// Log templates render indented inside numbered lists, so the headings arrive with leading
// whitespace. The awk this replaces matched `^[[:space:]]*` for exactly that reason.

test("indented headings still count", () => {
    const log = [
        "   ## Run 2026-07-31T23:28:50Z",
        "   ## Phase 3d Iteration 1",
        "   - Issue count: 6",
    ].join("\n");
    expect(formatCounters(computeCounters(log, OPTS))).toBe("ITER=2 PREV=6 GATE=OK NEW=none");
});

// The plan side uses different heading names against the same contract.

test("the plan-side heading prefixes work against the same contract", () => {
    const log = [
        "## Stage 5.5 Run 2026-07-31T23:28:50Z",
        "## Stage 5.5 Iteration 1",
        "- Issue count: 5",
    ].join("\n");
    const planOpts = { cap: 3, iterPrefix: "## Stage 5.5 Iteration", runPrefix: "## Stage 5.5 Run " };
    expect(formatCounters(computeCounters(log, planOpts))).toBe("ITER=2 PREV=5 GATE=OK NEW=none");
});

// `## Stage 5.5 Run ` also matches `## Stage 5.5 Iteration` under a naive prefix test, so the
// run check has to win only on the run prefix and not swallow iteration headings.

test("a run prefix that shares a stem with the iteration prefix does not swallow it", () => {
    const log = [
        "## Stage 5.5 Run 2026-07-31T23:28:50Z",
        "## Stage 5.5 Iteration 1",
        "## Stage 5.5 Iteration 2",
        "- Issue count: 3",
    ].join("\n");
    const planOpts = { cap: 3, iterPrefix: "## Stage 5.5 Iteration", runPrefix: "## Stage 5.5 Run " };
    expect(formatCounters(computeCounters(log, planOpts))).toBe("ITER=3 PREV=3 GATE=OK NEW=none");
});

// An empty `- Fingerprints:` line means the pass logged no fingerprints, not that it introduced
// nothing. Treating it as zero fires the stall gate while real findings sit unaddressed, which is
// how a run with a malformed or inconclusive pass silently stops revising.

test("an empty latest set is not the same as introducing nothing", () => {
    const log = [
        "## Run 2026-08-01T00:00:00Z",
        "## Phase 3d Iteration 1",
        "- Fingerprints: a|1,b|2",
        "## Phase 3d Iteration 2",
        "- Fingerprints:",
    ].join("\n");
    expect(computeCounters(log, OPTS).newCount).toBe("none");
});

test("an empty earlier set does not make the next pass look unchanged", () => {
    const log = [
        "## Run 2026-08-01T00:00:00Z",
        "## Phase 3d Iteration 1",
        "- Fingerprints:",
        "## Phase 3d Iteration 2",
        "- Fingerprints: c|3,d|4",
    ].join("\n");
    expect(computeCounters(log, OPTS).newCount).toBe("2");
});

// Producers render the fingerprint inside markdown tables, where the pipe has to be escaped and the
// value is usually wrapped in backticks. The consumer has to see through both, or the same finding
// logged from a table and from a bullet reads as two different findings.

test("table-rendered and bare fingerprints collapse to one key", () => {
    const log = [
        "## Run 2026-08-01T00:00:00Z",
        "## Phase 3d Iteration 1",
        "- Fingerprints: `compliance\\|S2`, `quality\\|foo.ts:12`",
        "## Phase 3d Iteration 2",
        "- Fingerprints: compliance|S2, quality|foo.ts:12",
    ].join("\n");
    expect(computeCounters(log, OPTS).newCount).toBe("0");
});
