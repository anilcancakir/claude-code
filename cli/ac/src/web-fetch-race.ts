import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/**
 * Pluggable timer source. Defaults to real setTimeout/clearTimeout, but tests inject a
 * manual-advance fake so the race is deterministic and free of open handles.
 *
 * @template T The opaque handle type returned by setTimer and accepted by clearTimer.
 */
export type Clock<T = ReturnType<typeof setTimeout>> = {
    setTimer(fn: () => void, ms: number): T;
    clearTimer(handle: T): void;
};

/**
 * Inputs to a single web-fetch race. The race never cancels remoteCall; it only stops
 * WAITING for it. remoteCall and localFetch are injected so callers wire real fetchers
 * and tests wire controllable promises.
 *
 * @template T The clock handle type, inferred from the injected clock.
 */
export type RaceWebFetchOptions<T = ReturnType<typeof setTimeout>> = {
    /** Starts immediately; its promise is never aborted, only un-awaited past the deadline. */
    remoteCall: () => Promise<CallToolResult>;
    /** Invoked when the trigger fires while remote is pending, or immediately on fast remote rejection. */
    localFetch: () => Promise<CallToolResult>;
    /** Delay before local fetch is triggered when remote is still pending. */
    triggerMs: number;
    /** Hard ceiling after which a held local result (or an error) settles the race. */
    deadlineMs: number;
    /** Prefix label block for remote content in combined or local-alone results. */
    remoteLabel: string;
    /** Prefix label block for local content in combined or local-alone results. */
    localLabel: string;
    /** Timer source; defaults to real timers. */
    clock?: Clock<T>;
};

/** The real-timer clock used when no clock is injected. */
const realClock: Clock = {
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (handle) => clearTimeout(handle),
};

/** Builds a text content block carrying a section label. */
function labelBlock(text: string): { type: "text"; text: string } {
    return { type: "text", text };
}

/** Internal tri-state for the remote outcome, distinct from the held local result. */
type RemoteState =
    | { status: "pending" }
    | { status: "resolved"; result: CallToolResult }
    | { status: "rejected"; error: unknown };

/**
 * Races a remote web-fetch tool call against a local fallback fetch.
 *
 * Behavior contract:
 * 1. remoteCall starts immediately and is never aborted (the race only stops waiting).
 * 2. A trigger timer at triggerMs invokes localFetch if remote is still pending.
 * 3. A fast remote rejection (before the trigger) invokes localFetch immediately and disarms the trigger.
 * 4. Remote success settles remote alone, or a combined result if a local result is already held.
 * 5. A local success while remote is pending is HELD, not settled, until remote arrives or the deadline.
 * 6. The deadline settles the held local alone, or an error result if nothing usable arrived.
 *
 * Concurrency safety: a single `done` latch guards `settle`; the first settle wins and re-entry
 * no-ops. Both timers are torn down in one place (inside settle), so no path leaks a timer and no
 * path double-settles. The un-awaited remote promise gets a `.catch` at creation so a late
 * rejection after settle cannot escalate to an unhandledRejection.
 *
 * @template T The clock handle type, inferred from opts.clock.
 * @param opts Injected fetchers, timing, labels, and optional clock.
 * @returns The single winning CallToolResult.
 */
export function raceWebFetch<T = ReturnType<typeof setTimeout>>(
    opts: RaceWebFetchOptions<T>,
): Promise<CallToolResult> {
    const {
        remoteCall,
        localFetch,
        triggerMs,
        deadlineMs,
        remoteLabel,
        localLabel,
    } = opts;
    const clock = (opts.clock ?? (realClock as unknown as Clock<T>)) as Clock<T>;

    return new Promise<CallToolResult>((resolve) => {
        let done = false;
        let triggerHandle: T | undefined;
        let deadlineHandle: T | undefined;
        let remoteState: RemoteState = { status: "pending" };
        let localResult: CallToolResult | undefined;
        let localStarted = false;

        // Single latch + centralized teardown. First call wins; re-entry no-ops.
        // Both timers are cleared here and only here, so no branch can leak a timer.
        const settle = (result: CallToolResult): void => {
            if (done) return;
            done = true;
            if (triggerHandle !== undefined) clock.clearTimer(triggerHandle);
            if (deadlineHandle !== undefined) clock.clearTimer(deadlineHandle);
            resolve(result);
        };

        // Idempotent local kick-off: triggered by the timer or by a fast remote rejection.
        const startLocal = (): void => {
            if (localStarted) return;
            localStarted = true;
            localFetch().then(
                (result) => {
                    if (done) return;
                    if (remoteState.status === "resolved") {
                        // Remote already in: settle combined now (remote-after-local edge through this path).
                        settle(combine(remoteState.result, result));
                        return;
                    }
                    // Hold local; wait for remote or the deadline.
                    localResult = result;
                },
                () => {
                    // Local failed: ignore it, keep waiting for remote until the deadline.
                },
            );
        };

        const combine = (remote: CallToolResult, local: CallToolResult): CallToolResult => ({
            content: [
                labelBlock(remoteLabel),
                ...remote.content,
                labelBlock(localLabel),
                ...local.content,
            ],
            isError: Boolean(remote.isError) || Boolean(local.isError),
        });

        const localAlone = (local: CallToolResult): CallToolResult => ({
            content: [labelBlock(localLabel), ...local.content],
            isError: local.isError,
        });

        // 1. Start remote immediately. Attach .catch AT CREATION so a late rejection past settle
        //    never becomes an unhandledRejection (which would crash the bundled Node process).
        remoteCall().then(
            (result) => {
                remoteState = { status: "resolved", result };
                if (done) return;
                if (localResult !== undefined) {
                    settle(combine(result, localResult));
                    return;
                }
                // No local yet: remote alone (covers remote-before-trigger and remote-while-local-pending).
                settle(result);
            },
            (error) => {
                remoteState = { status: "rejected", error };
                if (done) return;
                // Fast-rejection path: kick local now and disarm the trigger; do not idle to triggerMs.
                if (triggerHandle !== undefined) {
                    clock.clearTimer(triggerHandle);
                    triggerHandle = undefined;
                }
                startLocal();
            },
        );

        // 2. Trigger timer: if remote still pending when it fires, start the local fallback.
        triggerHandle = clock.setTimer(() => {
            triggerHandle = undefined;
            if (done) return;
            if (remoteState.status === "pending") startLocal();
        }, triggerMs);

        // 3. Deadline timer: settle the held local alone, else an error result naming the remote failure.
        deadlineHandle = clock.setTimer(() => {
            deadlineHandle = undefined;
            if (done) return;
            if (localResult !== undefined) {
                settle(localAlone(localResult));
                return;
            }
            settle(deadlineError(remoteState));
        }, deadlineMs);
    });
}

/** Builds the error result for the deadline path, surfacing the remote error when present. */
function deadlineError(remoteState: RemoteState): CallToolResult {
    const reason = remoteState.status === "rejected"
        ? `remote fetch failed: ${errorMessage(remoteState.error)}`
        : "remote fetch did not return before the deadline";
    return {
        isError: true,
        content: [labelBlock(`web fetch failed and local fallback was unavailable (${reason})`)],
    };
}

/** Extracts a readable message from an unknown thrown value. */
function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
