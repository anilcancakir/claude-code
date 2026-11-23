import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { describeFailure, downloadMedia, LinkStatusError, pause } from "./media-result.ts";
import type { AcceptedType, DownloadOptions, FinishedImage } from "./media-result.ts";
import { isTransientStatus, withTransientRetry } from "./remote-retry.ts";

/**
 * Wire name of kodizm's image tool.
 *
 * It is a custom Tool row on the operator's Mcp instance, bound to `google.generate_image` with the
 * path pinned to the Gemini web bridge. A Tool name allows underscores and no hyphens, so this is the one
 * proxied tool that is not kebab-case.
 */
export const IMAGE_TOOL_NAME = "generate_image";

/**
 * The model a call gets when it names none. A Tool row parameter cannot carry a default, and an omitted model
 * leaves Gemini's own Auto pick, so the proxy sends the operator's choice itself.
 */
const DEFAULT_IMAGE_MODEL = "neon";

/** Above kodizm's own 5 MiB staging cap, so a legitimate picture is never the thing refused. */
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Largest picture shown inline: Anthropic's API refuses an image above 5 MB, and an inline block that the
 * client rejects would take the saved-file path down with it, so a bigger picture is returned as a path only.
 */
const DEFAULT_INLINE_MAX_BYTES = 3_500_000;

/**
 * Limit on one try at the signed link. The link is served by the shared kodizm host, which has answered a finished
 * picture in over 30 seconds under load, so this leaves room beyond a healthy answer.
 */
const DOWNLOAD_TIMEOUT_MS = 45_000;

/**
 * Waits before the second and third try at the link. A retry is safe because it only fetches a picture already made
 * and booked, and the link stays valid for an hour.
 */
const DOWNLOAD_RETRY_DELAYS_MS: readonly number[] = [2_000, 5_000];

/** A queued picture takes 10 to 30 seconds, so the first `media_result` poll waits this long. */
export const IMAGE_FIRST_POLL_AFTER_MS = 5_000;

/**
 * Milliseconds between `media_result` polls for a queued picture: 5 s while one is usually due, 10 s after.
 *
 * Each poll spends a slot of that Tool's quota (60 a minute, 500 a day, shared with video and music), so four
 * pictures in parallel stay near 48 a minute and a picture that runs to the deadline costs about 40.
 */
export function imagePollIntervalMs(elapsedMs: number): number {
    return elapsedMs < 30_000 ? 5_000 : 10_000;
}

/**
 * How long a queued picture is waited for before its handle is handed back: kodizm's worker gives up on a picture
 * after 300 seconds, and this leaves a minute for the queue in front of it.
 */
export const IMAGE_DEADLINE_MS = 6 * 60 * 1000;

/**
 * Codes undici and Node put on the cause of a connection that was refused, reset, dropped or timed out. A certificate
 * or DNS failure carries another code and is not one a later try outlasts.
 */
const CONNECTION_FAILURE_CODES: ReadonlySet<string> = new Set([
    "UND_ERR_SOCKET",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_BODY_TIMEOUT",
    "ECONNRESET",
    "ECONNREFUSED",
    "ETIMEDOUT",
    "EPIPE",
    "EAI_AGAIN",
]);

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
    /** The conversation this call continues, when it passed a `chat_id`. */
    chat?: ChatTurn;
    /** Limit on one try at the link, in milliseconds. */
    downloadTimeoutMs?: number;
    /** Waits before each further try at the link, in milliseconds; one entry per retry. */
    retryDelaysMs?: readonly number[];
    /** The client's cancellation: it ends the current try and any wait for the next one. */
    signal?: AbortSignal;
}

/**
 * A `chat_id` call and the pictures each conversation already returned, as SHA-1 digests keyed by `chat_id`.
 *
 * The Gemini web bridge has been seen to answer a follow-up turn with text and still return one of the
 * conversation's earlier pictures as a success, so a turn whose picture is already known is reported as drawing
 * nothing. The map covers only turns made through this proxy process: kodizm scopes a `chat_id` to the key, which
 * other sessions may share, so the bridge's own check stays the real guard.
 */
export interface ChatTurn {
    id: string;
    seen: Map<string, Set<string>>;
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
    const answer = imageAnswerOf(result);

    return answer === undefined ? result : deliverFinishedImage(answer, options);
}

/**
 * Download a finished picture's signed link and present it, for an inline answer and a collected handle alike.
 *
 * A failed download is an `isError` result naming the cause; one that failed in transit on every try also hands
 * back the link, since the picture exists and is already booked against the quota.
 */
export async function deliverFinishedImage(
    answer: FinishedImage,
    options: DeliverImageOptions = {},
): Promise<CallToolResult> {
    try {
        return await saveImage(answer, options);
    } catch (err) {
        if (!isTransientDownloadError(err)) {
            return { isError: true, content: [{ type: "text", text: `image download failed: ${describeFailure(err)}` }] };
        }

        // The picture exists and is booked, so the model gets its link rather than a reason to draw another.
        const tries = (options.retryDelaysMs ?? DOWNLOAD_RETRY_DELAYS_MS).length + 1;

        return {
            isError: true,
            content: [{
                type: "text",
                text: `image download failed after ${tries} tries: ${describeFailure(err)}. The picture was made and `
                    + `its link stays valid for an hour: ${answer.link} Fetch that link to get it; do not call `
                    + "generate_image again, which would draw a new picture from the quota.",
            }],
        };
    }
}

/** Whether the remote's image tool takes a `model`, read off its own schema. */
export function declaresModel(remoteTools: readonly Tool[]): boolean {
    const properties = remoteTools.find((tool) => tool.name === IMAGE_TOOL_NAME)?.inputSchema.properties;

    return properties !== undefined && "model" in properties;
}

/**
 * The call's arguments with the default model filled in when the call names none (`null` counts as none).
 *
 * Only for a remote that declares `model`: one that does not refuses any argument it did not declare.
 */
export function withDefaultModel(args: Record<string, unknown>, takesModel: boolean): Record<string, unknown> {
    if (!takesModel || (args["model"] !== undefined && args["model"] !== null)) {
        return args;
    }

    return { ...args, model: DEFAULT_IMAGE_MODEL };
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
 * The answer of a successful call, or `undefined` when the result is not one.
 *
 * Text that does not parse as JSON is not the capability's answer, so it is passed through rather than
 * reported: the model should read what the remote actually said.
 */
function imageAnswerOf(result: CallToolResult): FinishedImage | undefined {
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

    const output = (answer as { output?: { image_url?: unknown; marks_removed?: unknown } } | null)?.output;
    if (typeof output?.image_url !== "string") {
        return undefined;
    }

    return {
        link: output.image_url,
        marksRemoved: typeof output.marks_removed === "boolean" ? output.marks_removed : undefined,
    };
}

/**
 * Whether a download failure is the host being slow or busy rather than a refusal.
 *
 * A timeout, a 429 and the restart statuses `isTransientStatus` names qualify, and so does a connection Node reports
 * as `TypeError("fetch failed")` or `"terminated"` with one of `CONNECTION_FAILURE_CODES` on its cause. A rejected
 * redirect, a bad certificate and an unknown host share that outer shape with another cause, so they stay refusals.
 */
export function isTransientDownloadError(err: unknown): boolean {
    if (err instanceof LinkStatusError) {
        return err.status === 429 || isTransientStatus(err.status);
    }

    if (err instanceof Error && err.name === "TimeoutError") {
        return true;
    }

    const code: unknown = err instanceof TypeError ? (err.cause as { code?: unknown } | undefined)?.code : undefined;

    return typeof code === "string" && CONNECTION_FAILURE_CODES.has(code);
}

async function saveImage(answer: FinishedImage, options: DeliverImageOptions): Promise<CallToolResult> {
    // 1. Only an image type is kept, which also stops a text answer from reaching the model as a picture.
    const accept: Record<string, AcceptedType> = {};
    for (const [mime, extension] of Object.entries(EXTENSIONS)) {
        accept[mime] = { extension, maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES };
    }

    const download: DownloadOptions = {
        directory: options.directory ?? path.join(tmpdir(), "ac-images"),
        accept,
        timeoutMs: options.downloadTimeoutMs ?? DOWNLOAD_TIMEOUT_MS,
        signal: options.signal,
    };
    const { file, mime, bytes } = await withTransientRetry(() => downloadMedia(answer.link, download), {
        delaysMs: options.retryDelaysMs ?? DOWNLOAD_RETRY_DELAYS_MS,
        sleep: (ms) => pause(ms, options.signal),
        isTransient: isTransientDownloadError,
    });

    // 2. A follow-up turn that hands back one of the conversation's earlier pictures drew nothing: say so, keep no
    //    copy.
    if (options.chat !== undefined) {
        const digest = createHash("sha1").update(bytes).digest("hex");
        const seen = options.chat.seen.get(options.chat.id) ?? new Set<string>();

        if (seen.has(digest)) {
            await rm(file, { force: true });

            return {
                isError: true,
                content: [{
                    type: "text",
                    text: `This turn of chat_id "${options.chat.id}" returned an earlier picture unchanged, so `
                        + "nothing was drawn (Gemini most likely answered with text). The call still counts against "
                        + "the image quota. Check with the user before asking again; a retry with the same chat_id "
                        + "works best worded plainly as an image request (\"Generate an image: ...\").",
                }],
            };
        }

        seen.add(digest);
        options.chat.seen.set(options.chat.id, seen);
    }

    // 3. The user should hear that the picture still carries Gemini's watermark before they use it.
    const marks = answer.marksRemoved === false ? " Gemini's watermark could not be removed from it." : "";
    const saved = `Image saved to ${file} (${mime}, ${bytes.byteLength} bytes).${marks}`;

    // 4. A picture the client might refuse is not shown inline: the path alone still reaches the model.
    if (bytes.byteLength > (options.inlineMaxBytes ?? DEFAULT_INLINE_MAX_BYTES)) {
        return { content: [{ type: "text", text: `${saved} It is too large to show inline.` }] };
    }

    return {
        content: [
            { type: "text", text: saved },
            { type: "image", data: bytes.toString("base64"), mimeType: mime },
        ],
    };
}
