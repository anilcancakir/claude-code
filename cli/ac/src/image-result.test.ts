import { afterAll, beforeAll, expect, test } from "bun:test";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { deliverImage, describeFailure, IMAGE_TOOL_NAME, imageErrorResult } from "./image-result.ts";

// Bearer-free and deterministic: a local Bun server stands in for the signed media link that
// kodizm's google.generate_image answers with, so the download, the size cap and every refusal
// run without a kodizm bearer or the Gemini bridge.

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

let server: ReturnType<typeof Bun.serve>;
let directory: string;

beforeAll(() => {
    directory = mkdtempSync(path.join(tmpdir(), "ac-image-result-"));
    server = Bun.serve({
        port: 0,
        fetch(request) {
            const { pathname } = new URL(request.url);

            if (pathname === "/ok.png") {
                return new Response(PNG_BYTES, { headers: { "content-type": "image/png" } });
            }
            if (pathname === "/page") {
                return new Response("<html></html>", { headers: { "content-type": "text/html" } });
            }
            if (pathname === "/redirect") {
                return new Response(null, { status: 302, headers: { location: "/ok.png" } });
            }
            if (pathname === "/big.png") {
                return new Response(new Uint8Array(2048), { headers: { "content-type": "image/png" } });
            }

            return new Response("gone", { status: 404 });
        },
    });
});

afterAll(async () => {
    await server.stop(true);
    rmSync(directory, { recursive: true, force: true });
});

function remoteResult(output: Record<string, unknown>): CallToolResult {
    return {
        content: [{ type: "text", text: JSON.stringify({ path: "web", status: "succeeded", output }) }],
    };
}

function linkTo(route: string): string {
    return `http://127.0.0.1:${server.port}${route}`;
}

function textOf(result: CallToolResult): string {
    return result.content
        .map((block) => (block.type === "text" ? block.text : ""))
        .join("");
}

test("IMAGE_TOOL_NAME is the underscore name a kodizm Tool row can carry", () => {
    expect(IMAGE_TOOL_NAME).toBe("generate_image");
});

test("deliverImage saves the picture and returns its path with an inline image block", async () => {
    const result = await deliverImage(
        remoteResult({ image_url: linkTo("/ok.png"), image_mime: "image/png", image_bytes: PNG_BYTES.length }),
        { directory },
    );

    expect(result.isError).toBeUndefined();
    expect(result.content).toHaveLength(2);

    const [text, image] = result.content;
    expect(text?.type).toBe("text");
    expect(image).toEqual({
        type: "image",
        data: Buffer.from(PNG_BYTES).toString("base64"),
        mimeType: "image/png",
    });

    const saved = readdirSync(directory).filter((name) => name.endsWith(".png"));
    expect(saved).toHaveLength(1);
    expect(textOf(result)).toContain(path.join(directory, saved[0] ?? ""));
    expect(new Uint8Array(readFileSync(path.join(directory, saved[0] ?? "")))).toEqual(PNG_BYTES);

    // A picture is the operator's own work, so it is not left readable by other users of a shared /tmp.
    if (process.platform !== "win32") {
        expect(statSync(path.join(directory, saved[0] ?? "")).mode & 0o077).toBe(0);
    }
});

test("deliverImage returns only the path for a picture above the inline limit", async () => {
    const result = await deliverImage(
        remoteResult({ image_url: linkTo("/ok.png") }),
        { directory, inlineMaxBytes: PNG_BYTES.length - 1 },
    );

    expect(result.isError).toBeUndefined();
    expect(result.content).toHaveLength(1);
    expect(result.content[0]?.type).toBe("text");
    expect(textOf(result)).toContain("too large to show inline");
});

test("describeFailure appends the cause that undici hides behind 'fetch failed'", () => {
    const err = new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED 127.0.0.1:1") });

    expect(describeFailure(err)).toBe("fetch failed (connect ECONNREFUSED 127.0.0.1:1)");
    expect(describeFailure(new Error("plain"))).toBe("plain");
    expect(describeFailure("boom")).toBe("boom");
});

test("imageErrorResult warns that a picture may exist and never invites a retry", () => {
    const result = imageErrorResult(new TypeError("fetch failed", { cause: new Error("terminated") }));

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("remote tool call failed: fetch failed (terminated)");
    expect(textOf(result)).toContain("may already have been generated");
    expect(textOf(result)).not.toContain("retry this exact call");
});

test("deliverImage leaves a result without an image link untouched", async () => {
    const refused: CallToolResult = {
        content: [{ type: "text", text: JSON.stringify({ path: "web", status: "failed", error_code: "image_rate_limited" }) }],
    };

    expect(await deliverImage(refused, { directory })).toBe(refused);
});

test("deliverImage leaves an isError result and a non-JSON answer untouched", async () => {
    const failed: CallToolResult = { isError: true, content: [{ type: "text", text: "tool_not_granted" }] };
    const plain: CallToolResult = { content: [{ type: "text", text: "not json" }] };

    expect(await deliverImage(failed, { directory })).toBe(failed);
    expect(await deliverImage(plain, { directory })).toBe(plain);
});

test("deliverImage refuses a link that does not answer with an image", async () => {
    const result = await deliverImage(remoteResult({ image_url: linkTo("/page") }), { directory });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("text/html");
});

test("deliverImage reports the status of a link that no longer resolves", async () => {
    const result = await deliverImage(remoteResult({ image_url: linkTo("/gone") }), { directory });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("404");
});

test("deliverImage never follows a redirect", async () => {
    const result = await deliverImage(remoteResult({ image_url: linkTo("/redirect") }), { directory });

    expect(result.isError).toBe(true);
});

test("deliverImage refuses a picture above the size cap and writes nothing for it", async () => {
    const before = readdirSync(directory).length;
    const result = await deliverImage(remoteResult({ image_url: linkTo("/big.png") }), { directory, maxBytes: 1024 });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("1024");
    expect(readdirSync(directory)).toHaveLength(before);
});

test("deliverImage fetches only http and https links", async () => {
    const result = await deliverImage(remoteResult({ image_url: "file:///etc/hosts" }), { directory });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("file:");
});

test("deliverImage creates its directory when it is missing", async () => {
    const nested = path.join(directory, "nested", "images");

    await deliverImage(remoteResult({ image_url: linkTo("/ok.png") }), { directory: nested });

    expect(existsSync(nested)).toBe(true);
});
