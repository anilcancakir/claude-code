import { readFileSync } from "node:fs";

export type CounterOptions = {
    cap: number;
    iterPrefix: string;
    runPrefix: string;
};

export type Counters = {
    gate: "MAX_ITER" | "OK";
    iter: number;
    newCount: string;
    prev: string;
};

// Emitted when the log does not exist yet. The awk this replaces produced the same line via
// its `|| echo` fallback, and two skill bodies parse the field order, so it is fixed.
export const MISSING_LOG_LINE = "ITER=1 PREV=none GATE=OK NEW=none";

const ISSUE_COUNT_PREFIX = "- Issue count:";
const FINGERPRINTS_PREFIX = "- Fingerprints:";

function parseFingerprints(line: string): Set<string> {
    const payload = line.slice(FINGERPRINTS_PREFIX.length);
    const parts = payload.split(",");
    const out = new Set<string>();
    for (const part of parts) {
        // Producers render fingerprints inside markdown tables, where the pipe must be escaped and
        // the value is usually wrapped in backticks. Without normalizing both, the same finding
        // logged from a table and from a bullet reads as two different findings and NEW never settles.
        const trimmed = part.trim().replace(/[`\\]/g, "");
        if (trimmed !== "") {
            out.add(trimmed);
        }
    }
    return out;
}

/**
 * Derives the review-loop counters from an append-only log.
 *
 * Counters reset at every run heading, which is what keeps a second run of the same slug from
 * inheriting the previous run's pass count and landing past the cap on its first pass.
 */
export function computeCounters(text: string, opts: CounterOptions): Counters {
    let iter = 0;
    let prev = "";
    let fingerprintSets: Set<string>[] = [];

    for (const rawLine of text.split("\n")) {
        const line = rawLine.trimStart();
        if (line.startsWith(opts.runPrefix)) {
            iter = 0;
            prev = "";
            fingerprintSets = [];
        } else if (line.startsWith(opts.iterPrefix)) {
            iter += 1;
        } else if (line.startsWith(ISSUE_COUNT_PREFIX)) {
            // Matches the awk's `$4` against the whitespace-split line: "-", "Issue", "count:", N.
            const field = line.split(/\s+/)[3];
            prev = field ?? "";
        } else if (line.startsWith(FINGERPRINTS_PREFIX)) {
            fingerprintSets.push(parseFingerprints(line));
        }
    }

    const next = iter + 1;
    return {
        gate: next > opts.cap ? "MAX_ITER" : "OK",
        iter: next,
        newCount: countNewFingerprints(fingerprintSets),
        prev: prev === "" ? "none" : prev,
    };
}

// Fewer than two logged sets means there is nothing to diff against, which is not the same as
// a pass that introduced nothing. The two cases stay distinguishable: "none" versus "0".
//
// An EMPTY latest set is the same kind of unknown. A pass that logged no fingerprints (a malformed
// verdict, an inconclusive pass, a producer that skipped the line) has not told us it introduced
// nothing; it has told us nothing. Reporting 0 there fires the stall gate while that pass's real
// findings sit unaddressed, and under auto mode that ships.
function countNewFingerprints(sets: Set<string>[]): string {
    if (sets.length < 2) {
        return "none";
    }
    const latest = sets[sets.length - 1];
    const previous = sets[sets.length - 2];
    if (latest === undefined || previous === undefined || latest.size === 0) {
        return "none";
    }
    let added = 0;
    for (const item of latest) {
        if (!previous.has(item)) {
            added += 1;
        }
    }
    return String(added);
}

export function formatCounters(counters: Counters): string {
    return `ITER=${counters.iter} PREV=${counters.prev} GATE=${counters.gate} NEW=${counters.newCount}`;
}

export function runReviewCounters(logPath: string, opts: CounterOptions): string {
    let text: string;
    try {
        text = readFileSync(logPath, "utf8");
    } catch {
        // An absent or unreadable log is the first-pass case, not an error: the caller is asking
        // what pass to run next, and the answer is the first one.
        return MISSING_LOG_LINE;
    }
    return formatCounters(computeCounters(text, opts));
}
