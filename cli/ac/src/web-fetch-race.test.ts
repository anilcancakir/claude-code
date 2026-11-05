import { expect, test } from "bun:test";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Clock } from "./web-fetch-race.ts";
import { raceWebFetch } from "./web-fetch-race.ts";

// A controllable timer handle: just an incrementing id.
type FakeHandle = number;

// A manual-advance clock. Timers fire only when advance() crosses their fire time.
// Tracks clearTimer calls so tests can assert no timer leaks (every armed timer is cleared).
class FakeClock implements Clock<FakeHandle> {
    private now = 0;
    private nextId = 1;
    private readonly timers = new Map<FakeHandle, { fireAt: number; fn: () => void }>();
    public readonly cleared: FakeHandle[] = [];

    public setTimer(fn: () => void, ms: number): FakeHandle {
        const id = this.nextId++;
        this.timers.set(id, { fireAt: this.now + ms, fn });
        return id;
    }

    public clearTimer(handle: FakeHandle): void {
        this.cleared.push(handle);
        this.timers.delete(handle);
    }

    // Advance virtual time, firing every timer whose deadline is now reached, in deadline order.
    public advance(ms: number): void {
        this.now += ms;
        const due = Array.from(this.timers.entries())
            .filter(([, t]) => t.fireAt <= this.now)
            .sort(([, a], [, b]) => a.fireAt - b.fireAt);
        for (const [id, t] of due) {
            this.timers.delete(id);
            t.fn();
        }
    }

    // Number of timers still armed (not fired, not cleared).
    public get armedCount(): number {
        return this.timers.size;
    }
}

// A promise whose settlement the test drives manually.
function deferred<T>(): {
    promise: Promise<T>;
    resolve: (value: T) => void;
    reject: (reason: unknown) => void;
} {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

function remoteResult(): CallToolResult {
    return { content: [{ type: "text", text: "remote-body" }] };
}

function localResult(): CallToolResult {
    return { content: [{ type: "text", text: "local-body" }] };
}

const baseOpts = {
    triggerMs: 100,
    deadlineMs: 1000,
    remoteLabel: "REMOTE",
    localLabel: "LOCAL",
};

// Let any pending microtasks drain so .then/.catch continuations run.
function flush(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

test("scenario 1: remote resolves before trigger fires -> remote alone, localFetch never called", async () => {
    const clock = new FakeClock();
    const remote = deferred<CallToolResult>();
    let localCalls = 0;

    const promise = raceWebFetch({
        ...baseOpts,
        remoteCall: () => remote.promise,
        localFetch: () => {
            localCalls++;
            return Promise.resolve(localResult());
        },
        clock,
    });

    remote.resolve(remoteResult());
    const result = await promise;

    expect(localCalls).toBe(0);
    expect(result).toEqual(remoteResult());
    expect(clock.armedCount).toBe(0);
    expect(clock.cleared.length).toBeGreaterThanOrEqual(2);
});

test("scenario 2: remote rejects fast before trigger -> localFetch fires immediately, local alone", async () => {
    const clock = new FakeClock();
    const remote = deferred<CallToolResult>();
    const local = deferred<CallToolResult>();
    let localCalls = 0;

    const promise = raceWebFetch({
        ...baseOpts,
        remoteCall: () => remote.promise,
        localFetch: () => {
            localCalls++;
            return local.promise;
        },
        clock,
    });

    remote.reject(new Error("remote boom"));
    await flush();

    // localFetch fired immediately (not waiting for triggerMs), and the trigger timer was cleared.
    expect(localCalls).toBe(1);
    expect(clock.armedCount).toBe(1); // only the deadline timer remains armed

    local.resolve(localResult());
    const result = await promise;

    // Remote already rejected definitively, so local settles NOW without idling to the deadline.
    expect(result.content).toEqual([
        { type: "text", text: "LOCAL" },
        { type: "text", text: "local-body" },
    ]);
    // The deadline timer was torn down at settle; no clock advance was needed.
    expect(clock.armedCount).toBe(0);
});

test("scenario 2b: local held while remote pending, then remote rejects -> local settles immediately", async () => {
    const clock = new FakeClock();
    const remote = deferred<CallToolResult>();
    const local = deferred<CallToolResult>();

    const promise = raceWebFetch({
        ...baseOpts,
        remoteCall: () => remote.promise,
        localFetch: () => local.promise,
        clock,
    });

    clock.advance(100); // trigger fires, local invoked
    local.resolve(localResult()); // local succeeds first, held pending remote
    await flush();

    remote.reject(new Error("remote boom")); // remote then fails definitively
    const result = await promise;

    // Held local settles at the moment remote is known-rejected, not at the deadline.
    expect(result.content).toEqual([
        { type: "text", text: "LOCAL" },
        { type: "text", text: "local-body" },
    ]);
    expect(clock.armedCount).toBe(0);
});

test("scenario 3: trigger fires, local succeeds, then remote resolves -> combined result", async () => {
    const clock = new FakeClock();
    const remote = deferred<CallToolResult>();
    const local = deferred<CallToolResult>();
    let localCalls = 0;

    const promise = raceWebFetch({
        ...baseOpts,
        remoteCall: () => remote.promise,
        localFetch: () => {
            localCalls++;
            return local.promise;
        },
        clock,
    });

    clock.advance(100); // trigger fires
    expect(localCalls).toBe(1);

    local.resolve(localResult());
    await flush();

    // Local held, no settle yet.
    remote.resolve(remoteResult());
    const result = await promise;

    expect(result.content).toEqual([
        { type: "text", text: "REMOTE" },
        { type: "text", text: "remote-body" },
        { type: "text", text: "LOCAL" },
        { type: "text", text: "local-body" },
    ]);
    expect(result.isError).toBeFalsy();
    expect(clock.armedCount).toBe(0);
});

test("scenario 4: trigger fires, local succeeds, remote never resolves -> local alone at deadline", async () => {
    const clock = new FakeClock();
    const remote = deferred<CallToolResult>();
    const local = deferred<CallToolResult>();

    const promise = raceWebFetch({
        ...baseOpts,
        remoteCall: () => remote.promise,
        localFetch: () => local.promise,
        clock,
    });

    clock.advance(100); // trigger fires, local invoked
    local.resolve(localResult());
    await flush();

    clock.advance(900); // reach deadline at 1000
    const result = await promise;

    expect(result.content).toEqual([
        { type: "text", text: "LOCAL" },
        { type: "text", text: "local-body" },
    ]);
    expect(clock.armedCount).toBe(0);
});

test("scenario 5: both fail -> isError result", async () => {
    const clock = new FakeClock();
    const remote = deferred<CallToolResult>();
    const local = deferred<CallToolResult>();

    const promise = raceWebFetch({
        ...baseOpts,
        remoteCall: () => remote.promise,
        localFetch: () => local.promise,
        clock,
    });

    clock.advance(100); // trigger fires, local invoked
    local.reject(new Error("local boom"));
    await flush();
    remote.reject(new Error("remote boom"));
    await flush();

    clock.advance(900); // deadline
    const result = await promise;

    expect(result.isError).toBe(true);
    expect(result.content.length).toBeGreaterThanOrEqual(1);
    expect(clock.armedCount).toBe(0);
});

function textOf(result: CallToolResult): string {
    return result.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
}

test("scenario 6: a remote outage with no local fallback tells the model to retry after a wait", async () => {
    const clock = new FakeClock();
    const local = deferred<CallToolResult>();
    const outage = new StreamableHTTPError(503, 'Error POSTing to endpoint: {"message":"Service Unavailable."}');

    const promise = raceWebFetch({
        ...baseOpts,
        remoteCall: () => Promise.reject(outage),
        localFetch: () => local.promise,
        clock,
    });

    await flush(); // remote rejected fast, local started at once
    local.reject(new Error("local boom"));
    await flush();

    clock.advance(1000); // deadline
    const result = await promise;

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Service Unavailable");
    expect(textOf(result)).toContain("retry this exact call once after about 60 seconds");
});

test("scenario 7: a remote that refused the page for another reason is not worth a retry either", async () => {
    const clock = new FakeClock();
    const local = deferred<CallToolResult>();
    const refusal = new StreamableHTTPError(403, 'Error POSTing to endpoint: {"message":"Forbidden"}');

    const promise = raceWebFetch({
        ...baseOpts,
        remoteCall: () => Promise.reject(refusal),
        localFetch: () => local.promise,
        clock,
    });

    await flush(); // remote rejected fast, local started at once
    local.reject(new Error("local boom"));
    await flush();

    clock.advance(1000); // deadline
    const text = textOf(await promise);

    expect(text).toContain("Forbidden");
    expect(text).toContain("Do not repeat this call");
    expect(text).not.toContain("about 60 seconds");
});

test("scenario 8: a remote that never answers points the model at another fetch tool, not a repeat", async () => {
    const clock = new FakeClock();
    const remote = deferred<CallToolResult>();
    const local = deferred<CallToolResult>();

    const promise = raceWebFetch({
        ...baseOpts,
        remoteCall: () => remote.promise,
        localFetch: () => local.promise,
        clock,
    });

    clock.advance(100); // trigger fires, local invoked
    local.reject(new Error("local boom"));
    await flush();

    clock.advance(900); // deadline with the remote still pending
    const result = await promise;
    const text = textOf(result);

    expect(result.isError).toBe(true);
    expect(text).toContain("did not return before the deadline");
    expect(text).toContain("Do not repeat this call");
    expect(text).not.toContain("about 60 seconds");
});
