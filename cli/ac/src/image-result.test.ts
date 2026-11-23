import { afterAll, beforeAll, expect, test } from "bun:test";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
    declaresModel,
    deliverImage,
    IMAGE_TOOL_NAME,
    imageErrorResult,
    isTransientDownloadError,
    withDefaultModel,
} from "./image-result.ts";

// Bearer-free and deterministic: a local Bun server stands in for the signed media link that
// kodizm's google.generate_image answers with, so the download, the size cap and every refusal
// run without a kodizm bearer or the Gemini bridge.

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

let server: ReturnType<typeof Bun.serve>;
let directory: string;
const hits = new Map<string, number>();

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

            const seen = (hits.get(pathname) ?? 0) + 1;
            hits.set(pathname, seen);

            if (pathname === "/slow-once.png" && seen === 1) {
                return Bun.sleep(500).then(() => new Response(PNG_BYTES, { headers: { "content-type": "image/png" } }));
            }
            if (pathname === "/busy-once.png" && seen === 1) {
                return new Response("busy", { status: 503 });
            }
            if (pathname === "/slow-once.png" || pathname === "/busy-once.png") {
                return new Response(PNG_BYTES, { headers: { "content-type": "image/png" } });
            }
            if (pathname === "/busy.png" || pathname === "/busy-cancel.png") {
                return new Response("busy", { status: 503 });
            }
            if (pathname === "/broken.png") {
                return new Response("bug", { status: 500 });
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

test("deliverImage says when kodizm could not remove Gemini's watermark", async () => {
    const kept = await deliverImage(remoteResult({ image_url: linkTo("/ok.png"), marks_removed: false }), { directory });
    const clean = await deliverImage(remoteResult({ image_url: linkTo("/ok.png"), marks_removed: true }), { directory });

    expect(kept.isError).toBeUndefined();
    expect(textOf(kept)).toContain("watermark could not be removed");
    expect(textOf(clean)).not.toContain("watermark");
});

test("deliverImage tries a slow or busy link again and saves the picture", async () => {
    const retry = { downloadTimeoutMs: 100, retryDelaysMs: [0, 0] };

    const slow = await deliverImage(remoteResult({ image_url: linkTo("/slow-once.png") }), { directory, ...retry });
    const busy = await deliverImage(remoteResult({ image_url: linkTo("/busy-once.png") }), { directory, ...retry });

    expect(slow.isError).toBeUndefined();
    expect(busy.isError).toBeUndefined();
    expect(hits.get("/slow-once.png")).toBe(2);
    expect(hits.get("/busy-once.png")).toBe(2);
});

test("deliverImage hands back the link when every try fails in transit, and never retries a refusal", async () => {
    const retry = { downloadTimeoutMs: 100, retryDelaysMs: [0, 0] };

    const busy = await deliverImage(remoteResult({ image_url: linkTo("/busy.png") }), { directory, ...retry });
    expect(busy.isError).toBe(true);
    expect(hits.get("/busy.png")).toBe(3);
    expect(textOf(busy)).toContain("503");
    expect(textOf(busy)).toContain(linkTo("/busy.png"));
    expect(textOf(busy)).toContain("do not call generate_image again");

    const gone = await deliverImage(remoteResult({ image_url: linkTo("/missing.png") }), { directory, ...retry });
    expect(gone.isError).toBe(true);
    expect(hits.get("/missing.png")).toBe(1);
    expect(textOf(gone)).not.toContain(linkTo("/missing.png"));

    // A plain 500 is as likely a bug as a busy host, so it is not repeated.
    const broken = await deliverImage(remoteResult({ image_url: linkTo("/broken.png") }), { directory, ...retry });
    expect(broken.isError).toBe(true);
    expect(hits.get("/broken.png")).toBe(1);
});

test("isTransientDownloadError retries a dropped connection but not a certificate or DNS failure", () => {
    const failed = (code: string): TypeError => new TypeError("fetch failed", { cause: Object.assign(new Error(code), { code }) });

    expect(isTransientDownloadError(failed("UND_ERR_SOCKET"))).toBe(true);
    expect(isTransientDownloadError(failed("ECONNRESET"))).toBe(true);
    expect(isTransientDownloadError(new DOMException("timed out", "TimeoutError"))).toBe(true);
    expect(isTransientDownloadError(failed("CERT_HAS_EXPIRED"))).toBe(false);
    expect(isTransientDownloadError(failed("ENOTFOUND"))).toBe(false);
    expect(isTransientDownloadError(new TypeError("fetch failed", { cause: new Error("unexpected redirect") }))).toBe(false);
});

test("deliverImage stops trying once the call is cancelled", async () => {
    const cancel = new AbortController();
    const pending = deliverImage(
        remoteResult({ image_url: linkTo("/busy-cancel.png") }),
        { directory, retryDelaysMs: [60_000, 60_000], signal: cancel.signal },
    );
    setTimeout(() => cancel.abort(), 50);

    const result = await pending;

    expect(result.isError).toBe(true);
    expect(hits.get("/busy-cancel.png")).toBe(1);
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

test("deliverImage refuses a chat turn that returns any earlier picture again and keeps no copy", async () => {
    const chats = new Map<string, Set<string>>();
    chats.set("boat", new Set(["an-older-turn"]));
    const answer = remoteResult({ image_url: linkTo("/ok.png") });

    const first = await deliverImage(answer, { directory, chat: { id: "boat", seen: chats } });
    expect(first.isError).toBeUndefined();

    const before = readdirSync(directory).length;
    const repeat = await deliverImage(answer, { directory, chat: { id: "boat", seen: chats } });

    expect(repeat.isError).toBe(true);
    expect(textOf(repeat)).toContain("earlier picture");
    expect(textOf(repeat)).toContain("boat");
    expect(readdirSync(directory)).toHaveLength(before);
    // Turn 1's digest stays known after turn 2 lands, so a later stale turn returning turn 1 is caught too.
    expect(chats.get("boat")?.has("an-older-turn")).toBe(true);

    // Another conversation, or a call outside any, may legitimately draw the same bytes.
    expect((await deliverImage(answer, { directory, chat: { id: "other", seen: chats } })).isError).toBeUndefined();
    expect((await deliverImage(answer, { directory })).isError).toBeUndefined();
});

test("withDefaultModel sends neon when the remote takes a model and the call names none", () => {
    const takesModel: Tool = {
        name: IMAGE_TOOL_NAME,
        inputSchema: {
            type: "object",
            properties: {
                prompt: { type: "string" },
                model: { type: "string", enum: ["hydrogen", "neon"] },
            },
        },
    };
    const noModel: Tool = { name: IMAGE_TOOL_NAME, inputSchema: { type: "object", properties: { prompt: {} } } };

    expect(declaresModel([takesModel])).toBe(true);
    expect(declaresModel([noModel])).toBe(false);
    expect(withDefaultModel({ prompt: "x" }, true)).toEqual({ prompt: "x", model: "neon" });
    expect(withDefaultModel({ prompt: "x", model: "hydrogen" }, true)).toEqual({ prompt: "x", model: "hydrogen" });
    expect(withDefaultModel({ prompt: "x", model: null }, true)).toEqual({ prompt: "x", model: "neon" });
    // A remote that does not declare model would refuse it as an undeclared argument.
    expect(withDefaultModel({ prompt: "x" }, false)).toEqual({ prompt: "x" });
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
