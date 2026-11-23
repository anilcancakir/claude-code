import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/**
 * Wire names of kodizm's video, music and collection tools: custom Tool rows on the operator's Mcp instance, bound
 * to `google.generate_video`, `google.generate_music` and `google.media_result`. A Tool name allows underscores and
 * no hyphens, like `generate_image`.
 */
export const VIDEO_TOOL_NAME = "generate_video";
export const MUSIC_TOOL_NAME = "generate_music";
export const MEDIA_RESULT_TOOL_NAME = "media_result";

/** A media type the proxy keeps: the file extension it is saved under and the largest file accepted, in bytes. */
export interface AcceptedType {
    extension: string;
    maxBytes: number;
}

export interface DownloadOptions {
    /** Where the file is written; created when missing. */
    directory: string;
    /** The content types kept, keyed by MIME type; any other answer is refused. */
    accept: Readonly<Record<string, AcceptedType>>;
    /** How long the whole download may take, in milliseconds. */
    timeoutMs?: number;
    /** Aborts the download when the caller gives up. */
    signal?: AbortSignal;
}

/** A downloaded file: where it was written, its MIME type and its bytes. */
export interface SavedMedia {
    file: string;
    mime: string;
    bytes: Buffer;
}

/** Calls one tool on the remote; the SDK client throws when the call fails in transit or `signal` aborts it. */
export type RemoteCall = (
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
) => Promise<CallToolResult>;

/** Milliseconds between polls: fixed, or chosen from the milliseconds already waited. */
export type PollInterval = number | ((elapsedMs: number) => number);

/**
 * A finished picture as `media_result` reports it: the signed link and kodizm's `marks_removed`, `false` when its
 * watermark pass failed and `undefined` from a remote that does not report it.
 */
export interface FinishedImage {
    link: string;
    marksRemoved: boolean | undefined;
}

export interface MediaOptions {
    /** Where finished files are written. Defaults to `<tmpdir>/ac-media`. */
    directory?: string;
    /**
     * Delivers a finished picture. A picture is shown to the model as well as saved, which a video or track is not,
     * so it is handed over instead of downloaded here; without this a picture is refused as an unaccepted type.
     */
    onImage?: (image: FinishedImage) => Promise<CallToolResult>;
    /** A wait before the first poll, for a handle just queued that cannot be ready yet. */
    firstPollAfterMs?: number;
    /** How long to keep polling before handing the handle back, in milliseconds. */
    deadlineMs?: number;
    /** Told about each poll that is still pending, so a client can show the wait and keep its idle timer alive. */
    onProgress?: (message: string) => Promise<void> | void;
    /**
     * The client's cancellation. Polling stops once it aborts: a wait nobody reads would keep spending the
     * media_result Tool's quota and save a file nobody is told about.
     */
    signal?: AbortSignal;
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
    now?: () => number;
}

/**
 * Above kodizm's own staging caps (50 MiB for a video, 15 MiB for a track), so a legitimate file is never the thing
 * refused.
 */
const MEDIA_TYPES: Readonly<Record<string, AcceptedType>> = {
    "video/mp4": {
        extension: "mp4",
        maxBytes: 64 * 1024 * 1024,
    },
    "audio/mpeg": {
        extension: "mp3",
        maxBytes: 24 * 1024 * 1024,
    },
};

/** Lets a 50 MiB video through a line of about 2 Mbit/s while still bounding a stalled body. */
const MEDIA_DOWNLOAD_TIMEOUT_MS = 300_000;

const DEFAULT_DOWNLOAD_TIMEOUT_MS = 30_000;

/**
 * Kodizm gives a video up to 420 seconds on the bridge and a queued job may wait for a worker first, so ten minutes
 * covers a slow render without holding a dead one open for long.
 */
const DEFAULT_DEADLINE_MS = 10 * 60 * 1000;

/** Polls in a row that may fail in transit before the wait is given up; the render itself is unaffected. */
const POLL_FAILURE_LIMIT = 3;

/**
 * Seconds between polls, after kodizm's own advice: a track is usually ready within a minute, a video takes a few.
 * Each poll spends a slot of the media_result Tool's own quota (60 a minute, 500 a day).
 */
const POLL_INTERVAL_MS: Readonly<Record<string, number>> = {
    [VIDEO_TOOL_NAME]: 15_000,
    [MUSIC_TOOL_NAME]: 10_000,
    [MEDIA_RESULT_TOOL_NAME]: 10_000,
};

const MEDIA_STATUSES = ["pending", "done", "failed", "unknown"] as const;

type MediaStatus = typeof MEDIA_STATUSES[number];

/** The JSON `google.media_result` answers with. */
interface MediaState {
    status: MediaStatus;
    url?: string;
    mime?: string;
    code?: string;
    /** A failed render's sentence for the caller, written by kodizm. */
    message?: string;
    marksRemoved?: boolean;
}

/** A media link that answered with an HTTP error status, kept apart so a caller can tell a busy host from a refusal. */
export class LinkStatusError extends Error {
    readonly status: number;

    constructor(status: number) {
        super(`the link answered ${status}`);
        this.status = status;
    }
}

/**
 * Download a signed link the remote chose and write it to a new file.
 *
 * The link is held to a narrow shape because it came from the remote: http or https only, no redirects, one of the
 * accepted content types and that type's byte cap. A refused download leaves no file behind.
 *
 * @throws Error naming the refusal or the transport failure
 */
export async function downloadMedia(link: string, options: DownloadOptions): Promise<SavedMedia> {
    // 1. Only a plain web link: file:, data: and the like never reach fetch.
    const url = new URL(link);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error(`refusing a ${url.protocol} link`);
    }

    // 2. A redirect would let the link bounce to a host the remote never named.
    const timeout = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS);
    const response = await fetch(url, {
        redirect: "error",
        signal: options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout]),
    });
    if (!response.ok) {
        throw new LinkStatusError(response.status);
    }

    // 3. Only an accepted type is kept, which also stops an error page from being saved as media.
    const mime = (response.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
    const type = options.accept[mime];
    if (type === undefined) {
        const wanted = Object.keys(options.accept).join(", ");

        throw new Error(`the link answered ${mime === "" ? "no content type" : mime}, not ${wanted}`);
    }

    // 4. Write only a whole, capped file.
    const bytes = await readCapped(response, type.maxBytes);
    await mkdir(options.directory, { recursive: true, mode: 0o700 });
    const file = path.join(options.directory, `${Date.now()}-${randomUUID().slice(0, 8)}.${type.extension}`);
    await writeFile(file, bytes, { mode: 0o600 });

    return { file, mime, bytes };
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
 * Run one `generate_video` or `generate_music` call to a saved file.
 *
 * Kodizm queues the render and answers at once with prose carrying a `handle:` line; this collects the handle
 * through `media_result` until the file is ready, so the model makes one call. The submit is sent once: a render
 * draws on a small shared quota and a failed one counts, so a call cut in transit is reported, never repeated. A
 * refusal and an answer without a handle are returned untouched so the model reads the remote's own words.
 */
export async function generateMedia(
    call: RemoteCall,
    toolName: string,
    args: Record<string, unknown>,
    options: MediaOptions = {},
): Promise<CallToolResult> {
    let queued: CallToolResult;
    try {
        queued = await call(toolName, args);
    } catch (err) {
        return {
            isError: true,
            content: [{
                type: "text",
                text: `remote tool call failed: ${describeFailure(err)}. A render may already be queued; do not call `
                    + `${toolName} again unless the user asks for another attempt.`,
            }],
        };
    }

    if (queued.isError === true) {
        return queued;
    }

    const handle = queuedHandleOf(queued);

    return handle === undefined ? queued : collectMedia(call, handle, options, POLL_INTERVAL_MS[toolName]);
}

/**
 * Wait for a queued render and save it, polling `media_result` with its handle.
 *
 * Polling never generates anything, so a wait that runs out or loses the connection hands the handle back to be
 * collected later instead of failing the render. An answer that is not the capability's JSON is returned untouched.
 */
export async function collectMedia(
    call: RemoteCall,
    handle: string,
    options: MediaOptions = {},
    interval: PollInterval = POLL_INTERVAL_MS[MEDIA_RESULT_TOOL_NAME] ?? 10_000,
): Promise<CallToolResult> {
    const now = options.now ?? Date.now;
    const sleep = options.sleep ?? pause;
    const signal = options.signal;
    const started = now();
    const deadline = started + (options.deadlineMs ?? DEFAULT_DEADLINE_MS);
    const intervalAfter = typeof interval === "number" ? () => interval : interval;
    let failures = 0;

    if (options.firstPollAfterMs !== undefined) {
        await sleep(options.firstPollAfterMs, signal);
    }

    for (;;) {
        if (isAborted(signal)) {
            return cancelled(handle);
        }

        // 1. Poll; a failure in transit is ridden out a few times, since the render goes on regardless.
        let answer: CallToolResult | undefined;
        try {
            answer = await call(MEDIA_RESULT_TOOL_NAME, { handle }, signal);
            failures = 0;
        } catch (err) {
            if (isAborted(signal)) {
                return cancelled(handle);
            }

            failures++;
            if (failures >= POLL_FAILURE_LIMIT) {
                return failure(`Could not check on the render: ${describeFailure(err)}. It may still finish; `
                    + `${collectLater(handle)}`);
            }
        }

        // 2. A refused poll (the Tool's own quota, say) leaves the render running, so the handle goes back with it
        //    and the model is not tempted to queue a second render.
        if (answer?.isError === true) {
            return failure(`${textOf(answer)} The render itself is unaffected, so do not generate it again. `
                + `${collectLater(handle)}`);
        }

        if (answer !== undefined) {
            const state = stateOf(answer);
            if (state === undefined) {
                return answer;
            }

            if (state.status !== "pending") {
                return finish(state, handle, options);
            }
        }

        // 3. Wait for the next poll only while it still fits the deadline.
        const waited = Math.round((now() - started) / 1000);
        const intervalMs = intervalAfter(now() - started);
        if (now() + intervalMs > deadline) {
            return {
                content: [{
                    type: "text",
                    text: `Still rendering after ${waited} seconds; nothing is lost. ${collectLater(handle)}`,
                }],
            };
        }

        if (answer !== undefined) {
            await options.onProgress?.(`Rendering, ${waited} seconds so far.`);
        }
        await sleep(intervalMs, signal);
    }
}

/** The result for a render that is no longer pending. */
async function finish(state: MediaState, handle: string, options: MediaOptions): Promise<CallToolResult> {
    if (state.status === "unknown") {
        return failure(`No render is known under handle "${handle}": it is mistyped, belongs to another key or was `
            + "never queued.");
    }

    if (state.status === "failed") {
        const code = state.code ?? "no code";
        const said = state.message === undefined ? "" : ` ${state.message}`;

        return failure(code === "media_expired"
            ? `The render failed (${code}): its file has expired on kodizm and cannot be collected any more.`
            : `The render failed (${code}).${said} A failed render still counts against the shared quota, so ask the `
                + "user before generating again.");
    }

    if (state.url === undefined) {
        return failure(`The render is done but its answer carries no link. ${collectLater(handle)}`);
    }

    // A picture's own delivery reports a failed download without the handle, which is what keeps the model from
    // drawing it again.
    if (state.mime?.startsWith("image/") === true && options.onImage !== undefined) {
        const delivered = await options.onImage({ link: state.url, marksRemoved: state.marksRemoved });

        return delivered.isError === true
            ? failure(`${textOf(delivered)} Call ${MEDIA_RESULT_TOOL_NAME} with handle "${handle}" for a fresh link; `
                + "nothing new is generated.")
            : delivered;
    }

    try {
        const saved = await downloadMedia(state.url, {
            directory: options.directory ?? path.join(tmpdir(), "ac-media"),
            accept: MEDIA_TYPES,
            timeoutMs: MEDIA_DOWNLOAD_TIMEOUT_MS,
            signal: options.signal,
        });
        const kind = saved.mime.startsWith("video/") ? "Video" : "Track";

        return {
            content: [{
                type: "text",
                text: `${kind} saved to ${saved.file} (${saved.mime}, ${saved.bytes.byteLength} bytes).`,
            }],
        };
    } catch (err) {
        return failure(`The render is done but its download failed: ${describeFailure(err)}. Call `
            + `${MEDIA_RESULT_TOOL_NAME} with handle "${handle}" for a fresh link; nothing new is generated.`);
    }
}

/**
 * The handle from a submit answer.
 *
 * Kodizm answers a queued render with prose rather than JSON (the capability sets its own text), with the handle
 * on a line of its own: `handle: <uuid>`. `undefined` for any other answer, such as an inline picture's JSON.
 */
export function queuedHandleOf(result: CallToolResult): string | undefined {
    for (const block of result.content) {
        if (block.type !== "text") {
            continue;
        }

        const match = /^handle:\s*`?([\w-]+)`?\s*$/m.exec(block.text);
        if (match?.[1] !== undefined) {
            return match[1];
        }
    }

    return undefined;
}

/** The media_result JSON, or `undefined` when the answer is not one. */
function stateOf(result: CallToolResult): MediaState | undefined {
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

    const fields = answer as Record<string, unknown> | null;
    const status = MEDIA_STATUSES.find((known) => known === fields?.["status"]);
    if (fields === null || status === undefined) {
        return undefined;
    }

    return {
        status,
        url: typeof fields["url"] === "string" ? fields["url"] : undefined,
        mime: typeof fields["mime"] === "string" ? fields["mime"] : undefined,
        code: typeof fields["code"] === "string" ? fields["code"] : undefined,
        message: typeof fields["message"] === "string" ? fields["message"] : undefined,
        marksRemoved: typeof fields["marks_removed"] === "boolean" ? fields["marks_removed"] : undefined,
    };
}

function collectLater(handle: string): string {
    return `Call ${MEDIA_RESULT_TOOL_NAME} with handle "${handle}" to collect it.`;
}

/** The client drops the answer to a cancelled call, but the result still names the handle for any log. */
function cancelled(handle: string): CallToolResult {
    return failure(`The wait was cancelled; the render goes on. ${collectLater(handle)}`);
}

function textOf(result: CallToolResult): string {
    return result.content
        .map((block) => (block.type === "text" ? block.text : ""))
        .join(" ")
        .trim();
}

/** Read through a call, so the check after an await is not narrowed away by the one before it. */
function isAborted(signal: AbortSignal | undefined): boolean {
    return signal?.aborted === true;
}

/** Sleep that ends early when `signal` aborts; the loop then sees the abort and stops. */
export function pause(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            resolve();
        }, { once: true });
    });
}

function failure(text: string): CallToolResult {
    return { isError: true, content: [{ type: "text", text }] };
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
            throw new Error(`the file is larger than ${maxBytes} bytes`);
        }
        chunks.push(value);
    }

    return Buffer.concat(chunks);
}
