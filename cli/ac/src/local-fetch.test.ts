import { expect, test } from "bun:test";
import type { LookupAddress } from "node:dns";
import { runLocalFetch, LOCAL_WEB_FETCH_TOOL_DEFINITION } from "./local-fetch.ts";
import type { LocalFetchDeps } from "./local-fetch.ts";

// A lookup fake that always returns the given records, ignoring the hostname.
function fakeLookup(records: readonly LookupAddress[]): LocalFetchDeps["lookup"] {
    return async (): Promise<readonly LookupAddress[]> => records;
}

// A fetch fake that returns a Response built from the given status + HTML body.
function fakeFetch(status: number, html: string): LocalFetchDeps["fetch"] {
    return async (): Promise<Response> =>
        new Response(status >= 300 && status < 400 ? null : html, { status });
}

// Narrows the first content block to its text payload; CallToolResult.content is a union that
// includes image blocks, so a guard is needed before reading `.text`.
function firstText(result: { content: ReadonlyArray<{ type: string }> }): string {
    const block = result.content[0];
    if (block === undefined || block.type !== "text") {
        throw new Error("expected a text content block");
    }
    return (block as unknown as { text: string }).text;
}

const PUBLIC_V4: readonly LookupAddress[] = [
    {
        address: "8.8.8.8",
        family: 4,
    },
];

// (1) Non-http(s) scheme is rejected before any network work.

test("rejects file:// scheme", async () => {
    await expect(
        runLocalFetch("file:///etc/passwd", { lookup: fakeLookup(PUBLIC_V4), fetch: fakeFetch(200, "") }),
    ).rejects.toThrow();
});

test("rejects ftp:// scheme", async () => {
    await expect(
        runLocalFetch("ftp://example.com/x", { lookup: fakeLookup(PUBLIC_V4), fetch: fakeFetch(200, "") }),
    ).rejects.toThrow();
});

// (2) A single private resolved IP is rejected (SSRF guard).

test("rejects when lookup resolves to a private IP", async () => {
    const lookup = fakeLookup([
        {
            address: "10.0.0.1",
            family: 4,
        },
    ]);
    await expect(
        runLocalFetch("http://intranet.example.com/", { lookup, fetch: fakeFetch(200, "<html></html>") }),
    ).rejects.toThrow();
});

// (3) ANY private record in a multi-record answer rejects, even alongside a public one.

test("rejects when one of several resolved IPs is private", async () => {
    const lookup = fakeLookup([
        {
            address: "8.8.8.8",
            family: 4,
        },
        {
            address: "10.0.0.1",
            family: 4,
        },
    ]);
    await expect(
        runLocalFetch("http://mixed.example.com/", { lookup, fetch: fakeFetch(200, "<html></html>") }),
    ).rejects.toThrow();
});

// (4) A 3xx response is surfaced as "redirect not followed"; the race layer keeps waiting.

test("throws 'redirect not followed' on 3xx", async () => {
    await expect(
        runLocalFetch("http://example.com/", { lookup: fakeLookup(PUBLIC_V4), fetch: fakeFetch(302, "") }),
    ).rejects.toThrow("redirect not followed");
});

// (5) A body exceeding the 5MB cap aborts and throws.

test("throws when the body exceeds the 5MB cap", async () => {
    const oversizedFetch: LocalFetchDeps["fetch"] = async (): Promise<Response> => {
        const chunk = new Uint8Array(1024 * 1024).fill(65);
        const stream = new ReadableStream<Uint8Array>({
            // Emit 6 x 1MB chunks (6MB total) to cross the 5MB ceiling.
            start(controller): void {
                for (let i = 0; i < 6; i++) {
                    controller.enqueue(chunk);
                }
                controller.close();
            },
        });
        return new Response(stream, { status: 200 });
    };
    await expect(
        runLocalFetch("http://big.example.com/", { lookup: fakeLookup(PUBLIC_V4), fetch: oversizedFetch }),
    ).rejects.toThrow();
});

// (6) Happy path: public IP + 200 + simple HTML yields markdown carrying the content.

test("returns markdown for a public 200 response", async () => {
    const html = "<html><body><h1>Hi</h1><p>Text</p></body></html>";
    const result = await runLocalFetch("http://example.com/", {
        lookup: fakeLookup(PUBLIC_V4),
        fetch: fakeFetch(200, html),
    });
    expect(result.content).toHaveLength(1);
    expect(result.content[0]?.type).toBe("text");
    const text = firstText(result);
    expect(text).toContain("Hi");
    expect(text).toContain("Text");
});

// (7) javascript: hrefs are sanitised out before markdown is emitted.

test("sanitises javascript: hrefs out of the markdown", async () => {
    const html = "<html><body><p><a href=\"javascript:alert(1)\">x</a> and more text here to satisfy extraction.</p></body></html>";
    const result = await runLocalFetch("http://example.com/", {
        lookup: fakeLookup(PUBLIC_V4),
        fetch: fakeFetch(200, html),
    });
    const text = firstText(result);
    expect(text).not.toContain("javascript:");
});

// Tool definition shape parity with the remote web-fetch surface.

test("LOCAL_WEB_FETCH_TOOL_DEFINITION exposes name and url schema", () => {
    expect(LOCAL_WEB_FETCH_TOOL_DEFINITION.name).toBe("web-fetch");
    const schema = LOCAL_WEB_FETCH_TOOL_DEFINITION.inputSchema as {
        properties?: Record<string, unknown>;
        required?: readonly string[];
    };
    expect(schema.properties).toHaveProperty("url");
    expect(schema.properties).toHaveProperty("format");
    expect(schema.required).toContain("url");
});
