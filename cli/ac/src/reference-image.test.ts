import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
    asksForReference,
    declaresInlineReference,
    inlineReference,
    MAX_REFERENCE_BYTES,
    REFERENCE_TOOL_TEXT,
    ReferenceImageError,
    withLocalReference,
} from "./reference-image.ts";

// Real files in a temp directory: the proxy reads the user's disk, so the checks run against the disk.

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([1, 2, 3, 4]), Buffer.from("WEBP"), Buffer.from([5, 6])]);

let directory: string;

beforeAll(() => {
    directory = mkdtempSync(path.join(tmpdir(), "ac-reference-"));
    writeFileSync(path.join(directory, "a.png"), PNG);
    writeFileSync(path.join(directory, "b.jpg"), JPEG);
    writeFileSync(path.join(directory, "c.webp"), WEBP);
    writeFileSync(path.join(directory, "notes.png"), "plain text named like a picture");
    writeFileSync(path.join(directory, "huge.png"), Buffer.concat([PNG, Buffer.alloc(MAX_REFERENCE_BYTES)]));
    mkdirSync(path.join(directory, "folder.png"));
});

afterAll(() => {
    rmSync(directory, { recursive: true, force: true });
});

async function refusal(args: Record<string, unknown>): Promise<string> {
    try {
        await inlineReference(args);
    } catch (err) {
        expect(err).toBeInstanceOf(ReferenceImageError);

        return (err as Error).message;
    }

    throw new Error("expected the reference to be refused");
}

test("a local PNG, JPEG or WebP path becomes the remote's inline base64 and the path never leaves", async () => {
    for (const [file, bytes] of [["a.png", PNG], ["b.jpg", JPEG], ["c.webp", WEBP]] as const) {
        const out = await inlineReference({ prompt: "make it green", reference_image_path: path.join(directory, file) });

        expect(out).toEqual({ prompt: "make it green", reference_image_base64: bytes.toString("base64") });
    }
});

test("a call with no reference passes through, and base64 the model sent by itself is dropped", async () => {
    expect(await inlineReference({ prompt: "a lighthouse" })).toEqual({ prompt: "a lighthouse" });
    expect(await inlineReference(undefined)).toBeUndefined();
    expect(await inlineReference({ prompt: "x", reference_image_base64: "AAAA" })).toEqual({ prompt: "x" });
});

test("a link passes through untouched", async () => {
    const args = { prompt: "x", reference_image_url: "https://kodizm.test/social/media/a.png?signature=s" };

    expect(await inlineReference(args)).toEqual(args);
});

test("a path that is not a real PNG, JPEG or WebP file is refused with a sentence, never sent", async () => {
    expect(await refusal({ prompt: "x", reference_image_path: path.join(directory, "notes.png") }))
        .toContain("PNG, JPEG or WebP");
    expect(await refusal({ prompt: "x", reference_image_path: path.join(directory, "folder.png") }))
        .toContain("not a file");
    expect(await refusal({ prompt: "x", reference_image_path: path.join(directory, "missing.png") }))
        .toContain("cannot be read");
});

test("a picture above the inline ceiling is refused and the sentence names the limit", async () => {
    const message = await refusal({ prompt: "x", reference_image_path: path.join(directory, "huge.png") });

    expect(message).toContain(String(MAX_REFERENCE_BYTES));
});

test("a relative path is refused: only an absolute path or ~/ names one file", async () => {
    expect(await refusal({ prompt: "x", reference_image_path: "a.png" })).toContain("absolute");
});

test("a path and a link together are refused", async () => {
    const message = await refusal({
        prompt: "x",
        reference_image_path: path.join(directory, "a.png"),
        reference_image_url: "https://kodizm.test/social/media/a.png",
    });

    expect(message).toContain("either");
});

test("a null path or link counts as absent, and a path beside a null link is still read", async () => {
    expect(await inlineReference({ prompt: "x", reference_image_path: null })).toEqual({ prompt: "x" });

    const out = await inlineReference({
        prompt: "x",
        reference_image_path: path.join(directory, "a.png"),
        reference_image_url: null,
    });

    expect(out?.["reference_image_base64"]).toBe(PNG.toString("base64"));
});

test("~/ names a file under the home directory", async () => {
    const home = process.env["HOME"];

    process.env["HOME"] = directory;

    try {
        const out = await inlineReference({ prompt: "x", reference_image_path: "~/a.png" });

        expect(out?.["reference_image_base64"]).toBe(PNG.toString("base64"));
    } finally {
        if (home === undefined) {
            delete process.env["HOME"];
        } else {
            process.env["HOME"] = home;
        }
    }
});

test("a FIFO is refused as not a file instead of blocking the call", async () => {
    const fifo = path.join(directory, "pipe.png");

    execFileSync("mkfifo", [fifo]);

    expect(await refusal({ prompt: "x", reference_image_path: fifo })).toContain("not a file");
});

test("asksForReference sees a path, a link or inline bytes, and ignores null", () => {
    expect(asksForReference({ reference_image_path: "/a.png" })).toBe(true);
    expect(asksForReference({ reference_image_url: "https://k.test/a.png" })).toBe(true);
    expect(asksForReference({ reference_image_base64: "AAAA" })).toBe(true);
    expect(asksForReference({ prompt: "x", reference_image_path: null })).toBe(false);
    expect(asksForReference(undefined)).toBe(false);
});

test("declaresInlineReference reads the remote's own schema", () => {
    const withReference = { ...tool({ reference_image_base64: { type: "string" } }) };
    const without = { ...tool({ prompt: { type: "string" } }) };
    const other = { ...tool({ reference_image_base64: { type: "string" } }), name: "web-search" } as Tool;

    expect(declaresInlineReference([withReference])).toBe(true);
    expect(declaresInlineReference([without])).toBe(false);
    expect(declaresInlineReference([other])).toBe(false);
    expect(declaresInlineReference([])).toBe(false);
});

function tool(properties: Record<string, unknown>): Tool {
    return { name: "generate_image", inputSchema: { type: "object", properties } } as Tool;
}

test("withLocalReference swaps the remote's inline base64 for a local path parameter", () => {
    const out = withLocalReference(tool({
        prompt: { type: "string" },
        reference_image_url: { type: "string" },
        reference_image_base64: { type: "string" },
    }));
    const properties = out.inputSchema.properties as Record<string, { description?: string }>;

    expect(Object.keys(properties)).toEqual(["prompt", "reference_image_url", "reference_image_path"]);
    expect(properties["reference_image_path"]?.description).toContain("absolute");
    expect(out.description).toContain(REFERENCE_TOOL_TEXT);
});

test("withLocalReference leaves a remote that does not take a reference untouched", () => {
    const remote = tool({ prompt: { type: "string" } });

    expect(withLocalReference(remote)).toBe(remote);
});
