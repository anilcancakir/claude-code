import { expect, test } from "bun:test";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { isTransientRemoteError, withTransientRetry } from "./remote-retry.ts";

function outage(status: number): StreamableHTTPError {
    return new StreamableHTTPError(status, `Error POSTing to endpoint: {"message":"status ${status}"}`);
}

test("a restarting or overloaded host is transient", () => {
    for (const status of [502, 503, 504, 520, 521, 522, 524]) {
        expect(isTransientRemoteError(outage(status))).toBe(true);
    }
});

test("a request the host rejected on its merits is not transient", () => {
    for (const status of [400, 401, 403, 404, 429]) {
        expect(isTransientRemoteError(outage(status))).toBe(false);
    }
});

test("a dropped connection surfaced as undici's fetch failed is transient", () => {
    expect(isTransientRemoteError(new TypeError("fetch failed"))).toBe(true);
});

test("a connection cut after the headers arrived (undici's terminated) is transient", () => {
    expect(isTransientRemoteError(new TypeError("terminated"))).toBe(true);
});

test("a timeout, a protocol error and a plain Error are not transient", () => {
    expect(isTransientRemoteError(new McpError(ErrorCode.RequestTimeout, "Request timed out"))).toBe(false);
    expect(isTransientRemoteError(new TypeError("Invalid URL"))).toBe(false);
    expect(isTransientRemoteError(new Error("boom"))).toBe(false);
    expect(isTransientRemoteError("503")).toBe(false);
});

test("a call that succeeds first time never sleeps", async () => {
    const slept: number[] = [];

    const value = await withTransientRetry(
        async () => "ok",
        { delaysMs: [10, 20], sleep: async (ms) => { slept.push(ms); } },
    );

    expect(value).toBe("ok");
    expect(slept).toEqual([]);
});

test("transient failures are retried after each configured delay until the call succeeds", async () => {
    const slept: number[] = [];
    let attempts = 0;

    const value = await withTransientRetry(
        async () => {
            attempts++;
            if (attempts < 3) {
                throw outage(503);
            }

            return "recovered";
        },
        { delaysMs: [10, 20], sleep: async (ms) => { slept.push(ms); } },
    );

    expect(value).toBe("recovered");
    expect(attempts).toBe(3);
    expect(slept).toEqual([10, 20]);
});

test("a non-transient failure is thrown at once, without a retry", async () => {
    const slept: number[] = [];
    let attempts = 0;

    const attempt = withTransientRetry(
        async () => {
            attempts++;
            throw outage(404);
        },
        { delaysMs: [10, 20], sleep: async (ms) => { slept.push(ms); } },
    );

    await expect(attempt).rejects.toThrow("status 404");
    expect(attempts).toBe(1);
    expect(slept).toEqual([]);
});

test("the last transient error is thrown once every delay has been spent", async () => {
    let attempts = 0;

    const attempt = withTransientRetry(
        async () => {
            attempts++;
            throw outage(501 + attempts);
        },
        { delaysMs: [10, 20], sleep: async () => {} },
    );

    await expect(attempt).rejects.toThrow("status 504");
    expect(attempts).toBe(3);
});
