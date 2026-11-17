import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/**
 * Wire name of kodizm's image tool.
 *
 * It is a custom Tool row on the operator's Mcp instance, bound to `google.generate_image` with the
 * path pinned to the Gemini web bridge. A Tool name allows underscores and no hyphens, so this is the one
 * proxied tool that is not kebab-case.
 */
export const IMAGE_TOOL_NAME = "generate_image";

/** Above kodizm's own 5 MiB staging cap, so a legitimate picture is never the thing refused. */
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Largest picture shown inline: Anthropic's API refuses an image above 5 MB, and an inline block that the
 * client rejects would take the saved-file path down with it, so a bigger picture is returned as a path only.
 */
const DEFAULT_INLINE_MAX_BYTES = 3_500_000;

/** The signed media link lives on the kodizm host the call just reached, so a slow answer is a fault. */
const DOWNLOAD_TIMEOUT_MS = 30_000;

const EXTENSIONS: Readonly<Record<string, string>> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
};

export interface DeliverImageOptions {
    /** Where the picture is written; created when missing. Defaults to `<tmpdir>/ac-images`. */
    directory?: string;
    /** Largest picture accepted, in bytes. */
    maxBytes?: number;
    /** Largest picture returned as an inline image block, in bytes; a bigger one is returned as a path only. */
    inlineMaxBytes?: number;
}

/**
 * Turn kodizm's `google.generate_image` answer into something the model can see and the operator can keep.
 *
 * The remote answers with text JSON whose `output.image_url` is a signed link valid for an hour, never the
 * bytes. This downloads the picture, saves it to a local file and returns the path beside an inline image
 * block. A result that carries no link (a refusal, an `isError` answer, text that is not JSON) is returned
 * untouched so the model reads the remote's own explanation; a failed download is an `isError` result that
 * names the cause.
 *
 * The link comes from the remote, so the download is held to a narrow shape: http or https only, no
 * redirects, an image content type and a byte cap. A link that points anywhere else yields no file and no
 * bytes for the model.
 */
export async function deliverImage(
    result: CallToolResult,
    options: DeliverImageOptions = {},
): Promise<CallToolResult> {
    const link = imageLinkOf(result);
    if (link === undefined) {
        return result;
    }

    try {
        return await saveImage(
            link,
            options.directory ?? path.join(tmpdir(), "ac-images"),
            options.maxBytes ?? DEFAULT_MAX_BYTES,
            options.inlineMaxBytes ?? DEFAULT_INLINE_MAX_BYTES,
        );
    } catch (err) {
        return { isError: true, content: [{ type: "text", text: `image download failed: ${describeFailure(err)}` }] };
    }
}

/**
 * The message of a failure with its cause appended.
 *
 * Under Node, undici reports a refused connection, a DNS failure and a rejected redirect all as
 * `TypeError("fetch failed")`, with the real reason on `cause`; without it the model cannot tell them apart.
 */
export function describeFailure(err: unknown): string {
    if (!(err instanceof Error)) {
        return String(err);
    }

    return err.cause instanceof Error ? `${err.message} (${err.cause.message})` : err.message;
}

/**
 * The `isError` result for a failed `generate_image` call.
 *
 * It carries no wait-and-retry instruction, unlike the read tools: a connection cut after kodizm has already
 * drawn and booked a picture looks the same as one cut before, so repeating the call can draw a second
 * picture from the shared quota. The model is told to ask the user first.
 */
export function imageErrorResult(err: unknown): CallToolResult {
    return {
        isError: true,
        content: [{
            type: "text",
            text: `remote tool call failed: ${describeFailure(err)}. A picture may already have been generated; `
                + "do not call generate_image again unless the user asks for another attempt.",
        }],
    };
}

/**
 * The `output.image_url` of a successful answer, or `undefined` when the result is not one.
 *
 * Text that does not parse as JSON is not the capability's answer, so it is passed through rather than
 * reported: the model should read what the remote actually said.
 */
function imageLinkOf(result: CallToolResult): string | undefined {
    if (result.isError === true) {
        return undefined;
    }

    const first = result.content.find((block) => block.type === "text");
    if (first === undefined || first.type !== "text") {
        return undefined;
    }

    let answer: unknown;
    try {
        answer = JSON.parse(first.text);
    } catch {
        return undefined;
    }

    const output = (answer as { output?: { image_url?: unknown } } | null)?.output;

    return typeof output?.image_url === "string" ? output.image_url : undefined;
}

async function saveImage(
    link: string,
    directory: string,
    maxBytes: number,
    inlineMaxBytes: number,
): Promise<CallToolResult> {
    // 1. Only a plain web link: the remote chose it, so file:, data: and the like never reach fetch.
    const url = new URL(link);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error(`refusing a ${url.protocol} link`);
    }

    // 2. A redirect would let the link bounce to a host the remote never named.
    const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!response.ok) {
        throw new Error(`the link answered ${response.status}`);
    }

    // 3. Only an image type is kept, which also stops a text answer from reaching the model as a picture.
    const mime = (response.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
    const extension = EXTENSIONS[mime];
    if (extension === undefined) {
        throw new Error(`the link answered ${mime === "" ? "no content type" : mime}, not an image`);
    }

    // 4. Write only a whole, capped picture, so a refusal leaves no file behind.
    const bytes = await readCapped(response, maxBytes);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, `${Date.now()}-${randomUUID().slice(0, 8)}.${extension}`);
    await writeFile(file, bytes, { mode: 0o600 });

    const saved = `Image saved to ${file} (${mime}, ${bytes.byteLength} bytes).`;

    // 5. A picture the client might refuse is not shown inline: the path alone still reaches the model.
    if (bytes.byteLength > inlineMaxBytes) {
        return { content: [{ type: "text", text: `${saved} It is too large to show inline.` }] };
    }

    return {
        content: [
            { type: "text", text: saved },
            { type: "image", data: bytes.toString("base64"), mimeType: mime },
        ],
    };
}

/** Read the body up to `maxBytes`; a longer body is cancelled mid-stream, whatever its declared length. */
async function readCapped(response: Response, maxBytes: number): Promise<Buffer> {
    if (response.body === null) {
        throw new Error("the link answered with no body");
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;

    for (;;) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }

        total += value.byteLength;
        if (total > maxBytes) {
            await reader.cancel();
            throw new Error(`the picture is larger than ${maxBytes} bytes`);
        }
        chunks.push(value);
    }

    return Buffer.concat(chunks);
}
