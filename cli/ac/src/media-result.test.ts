import { afterAll, beforeAll, expect, test } from "bun:test";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
    collectMedia,
    describeFailure,
    downloadMedia,
    generateMedia,
    MEDIA_RESULT_TOOL_NAME,
    MUSIC_TOOL_NAME,
    queuedHandleOf,
    VIDEO_TOOL_NAME,
} from "./media-result.ts";
import type { FinishedImage, MediaOptions, RemoteCall } from "./media-result.ts";

// Bearer-free and deterministic: a local Bun server stands in for the signed links kodizm's media_result answers
// with, and a scripted RemoteCall stands in for kodizm itself, so the polling runs on a fake clock.

const MP3_BYTES = new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0, 1, 2, 3]);
const MP4_BYTES = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);

let server: ReturnType<typeof Bun.serve>;
let directory: string;

beforeAll(() => {
    directory = mkdtempSync(path.join(tmpdir(), "ac-media-result-"));
    server = Bun.serve({
        port: 0,
        fetch(request) {
            const { pathname } = new URL(request.url);

            if (pathname === "/track.mp3") {
                return new Response(MP3_BYTES, { headers: { "content-type": "audio/mpeg" } });
            }
            if (pathname === "/clip.mp4") {
                return new Response(MP4_BYTES, { headers: { "content-type": "video/mp4" } });
            }
            if (pathname === "/page") {
                return new Response("<html></html>", { headers: { "content-type": "text/html" } });
            }
            if (pathname === "/redirect") {
                return new Response(null, { status: 302, headers: { location: "/track.mp3" } });
            }

            return new Response("gone", { status: 404 });
        },
    });
});

afterAll(async () => {
    await server.stop(true);
    rmSync(directory, { recursive: true, force: true });
});

function linkTo(route: string): string {
    return `http://127.0.0.1:${server.port}${route}`;
}

function textOf(result: CallToolResult): string {
    return result.content
        .map((block) => (block.type === "text" ? block.text : ""))
        .join("");
}

function text(value: string): CallToolResult {
    return { content: [{ type: "text", text: value }] };
}

function queued(handle: string): CallToolResult {
    return text(`The track is now generating in the background.\n\nhandle: ${handle}\n\nCall \`google.media_result\` `
        + "with it to collect the track.");
}

function state(fields: Record<string, unknown>): CallToolResult {
    return text(JSON.stringify(fields));
}

/**
 * A RemoteCall that answers from a script, one entry per call, and records what it was asked. An entry that is an
 * Error is thrown, the way the SDK client throws on a cut connection.
 */
function scripted(answers: Array<CallToolResult | Error>): RemoteCall & { calls: Array<[string, unknown]> } {
    const calls: Array<[string, unknown]> = [];
    const call: RemoteCall = async (name, args) => {
        calls.push([name, args]);
        const answer = answers.shift();
        if (answer === undefined) {
            throw new Error(`unscripted call to ${name}`);
        }
        if (answer instanceof Error) {
            throw answer;
        }

        return answer;
    };

    return Object.assign(call, { calls });
}

/** A fake clock: sleeping advances it, so a ten-minute wait runs in no time. */
function clock(): Pick<MediaOptions, "now" | "sleep"> & { slept: number[] } {
    let time = 0;
    const slept: number[] = [];

    return {
        slept,
        now: () => time,
        sleep: async (ms: number) => {
            slept.push(ms);
            time += ms;
        },
    };
}

test("the tool names are the underscore names kodizm's Tool rows carry", () => {
    expect(VIDEO_TOOL_NAME).toBe("generate_video");
    expect(MUSIC_TOOL_NAME).toBe("generate_music");
    expect(MEDIA_RESULT_TOOL_NAME).toBe("media_result");
});

test("generateMedia queues the track, polls media_result until done and saves the file", async () => {
    const remote = scripted([
        queued("0b7e-1"),
        state({ status: "pending", handle: "0b7e-1" }),
        state({ status: "done", handle: "0b7e-1", url: linkTo("/track.mp3"), mime: "audio/mpeg", bytes: 13 }),
    ]);
    const progress: string[] = [];
    const time = clock();

    const result = await generateMedia(remote, MUSIC_TOOL_NAME, { prompt: "a jazz loop" }, {
        directory,
        ...time,
        onProgress: (message) => {
            progress.push(message);
        },
    });

    expect(result.isError).toBeUndefined();
    expect(remote.calls).toEqual([
        [MUSIC_TOOL_NAME, { prompt: "a jazz loop" }],
        [MEDIA_RESULT_TOOL_NAME, { handle: "0b7e-1" }],
        [MEDIA_RESULT_TOOL_NAME, { handle: "0b7e-1" }],
    ]);
    expect(time.slept).toEqual([10_000]);
    expect(progress.length).toBeGreaterThan(0);

    const file = /saved to (\S+) \(/.exec(textOf(result))?.[1] ?? "";
    expect(file.endsWith(".mp3")).toBe(true);
    expect(textOf(result)).toContain("audio/mpeg");
    expect(new Uint8Array(readFileSync(file))).toEqual(MP3_BYTES);

    // The track is the operator's own work, so it is not left readable by other users of a shared /tmp.
    if (process.platform !== "win32") {
        expect(statSync(file).mode & 0o077).toBe(0);
    }
});

test("generateMedia waits longer between polls for a video than for a track", async () => {
    const remote = scripted([
        queued("v-1"),
        state({ status: "pending", handle: "v-1" }),
        state({ status: "done", handle: "v-1", url: linkTo("/clip.mp4"), mime: "video/mp4", bytes: 12 }),
    ]);
    const time = clock();

    const result = await generateMedia(remote, VIDEO_TOOL_NAME, { prompt: "a paper boat" }, { directory, ...time });

    expect(time.slept).toEqual([15_000]);
    expect(textOf(result)).toMatch(/saved to \S+\.mp4 \(video\/mp4, 12 bytes\)/);
});

test("generateMedia passes a refusal through and never polls", async () => {
    const refusal: CallToolResult = {
        isError: true,
        content: [{ type: "text", text: "Gemini web video calls are limited to 6 an hour and 20 a day." }],
    };
    const remote = scripted([refusal]);

    expect(await generateMedia(remote, VIDEO_TOOL_NAME, { prompt: "x" }, { directory, ...clock() })).toBe(refusal);
    expect(remote.calls).toHaveLength(1);
});

test("generateMedia passes an answer without a handle through untouched", async () => {
    const odd = text("something else");
    const remote = scripted([odd]);

    expect(await generateMedia(remote, MUSIC_TOOL_NAME, { prompt: "x" }, { directory, ...clock() })).toBe(odd);
    expect(remote.calls).toHaveLength(1);
});

test("generateMedia never repeats a submit that failed in transit, since a render may already be queued", async () => {
    const remote = scripted([new TypeError("fetch failed", { cause: new Error("terminated") })]);

    const result = await generateMedia(remote, VIDEO_TOOL_NAME, { prompt: "x" }, { directory, ...clock() });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("fetch failed (terminated)");
    expect(textOf(result)).toContain("may already be queued");
    expect(textOf(result)).not.toContain("retry this exact call");
    expect(remote.calls).toHaveLength(1);
});

test("collectMedia reports a failed render with its code and asks before another try", async () => {
    const remote = scripted([state({ status: "failed", handle: "h", code: "video_failed" })]);

    const result = await collectMedia(remote, "h", { directory, ...clock() });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("video_failed");
    expect(textOf(result)).toContain("ask the user");
});

test("collectMedia hands a finished picture to onImage with its link and watermark flag", async () => {
    const remote = scripted([
        state({ status: "pending", handle: "i-1" }),
        state({
            status: "done",
            handle: "i-1",
            url: "https://kodizm.test/p.png",
            mime: "image/png",
            bytes: 9,
            marks_removed: false,
        }),
    ]);
    const handed: FinishedImage[] = [];
    const delivered = text("delivered");
    const time = clock();

    const result = await collectMedia(remote, "i-1", {
        directory,
        ...time,
        onImage: async (image) => {
            handed.push(image);

            return delivered;
        },
    }, 3_000);

    expect(result).toBe(delivered);
    expect(handed).toEqual([{ link: "https://kodizm.test/p.png", marksRemoved: false }]);
    expect(time.slept).toEqual([3_000]);
});

test("collectMedia waits before its first poll and spaces later polls by the time already waited", async () => {
    const remote = scripted([
        state({ status: "pending", handle: "i-2" }),
        state({ status: "pending", handle: "i-2" }),
        state({ status: "done", handle: "i-2", url: "https://kodizm.test/q.png", mime: "image/png" }),
    ]);
    const time = clock();

    await collectMedia(remote, "i-2", {
        directory,
        ...time,
        firstPollAfterMs: 5_000,
        onImage: async () => text("delivered"),
    }, (elapsedMs) => (elapsedMs < 10_000 ? 5_000 : 10_000));

    expect(time.slept).toEqual([5_000, 5_000, 10_000]);
});

test("collectMedia names the handle when a finished picture fails to download, so it is not drawn again", async () => {
    const remote = scripted([state({ status: "done", handle: "i-3", url: "https://kodizm.test/r.png", mime: "image/png" })]);

    const result = await collectMedia(remote, "i-3", {
        directory,
        ...clock(),
        onImage: async () => ({ isError: true, content: [{ type: "text", text: "image download failed: the link answered 410" }] }),
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("the link answered 410");
    expect(textOf(result)).toContain("handle \"i-3\"");
    expect(textOf(result)).toContain("nothing new is generated");
});

test("collectMedia shows a failed render's own sentence beside its code", async () => {
    const remote = scripted([state({
        status: "failed",
        handle: "h",
        code: "no_image_returned",
        message: "Gemini answered with text and drew nothing.",
    })]);

    const result = await collectMedia(remote, "h", { directory, ...clock() });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("no_image_returned");
    expect(textOf(result)).toContain("Gemini answered with text and drew nothing.");
});

test("queuedHandleOf reads the handle line of a queued answer and nothing else", () => {
    expect(queuedHandleOf(queued("9f1c-7"))).toBe("9f1c-7");
    expect(queuedHandleOf(text(JSON.stringify({ path: "web", status: "succeeded" })))).toBeUndefined();
});

test("collectMedia says an expired file cannot be collected any more", async () => {
    const remote = scripted([state({ status: "failed", handle: "h", code: "media_expired" })]);

    const result = await collectMedia(remote, "h", { directory, ...clock() });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("media_expired");
    expect(textOf(result)).toContain("expired");
});

test("collectMedia reports an unknown handle as an error", async () => {
    const remote = scripted([state({ status: "unknown", handle: "nope" })]);

    const result = await collectMedia(remote, "nope", { directory, ...clock() });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("nope");
});

test("collectMedia stops at its deadline and hands back the handle without an error", async () => {
    const answers = Array.from({ length: 100 }, () => state({ status: "pending", handle: "slow" }));
    const remote = scripted(answers);

    const result = await collectMedia(remote, "slow", { directory, ...clock(), deadlineMs: 60_000 });

    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain("slow");
    expect(textOf(result)).toContain(MEDIA_RESULT_TOOL_NAME);
    expect(remote.calls.length).toBeLessThan(10);
});

test("collectMedia rides out a poll that fails in transit and still delivers", async () => {
    const remote = scripted([
        new TypeError("fetch failed"),
        state({ status: "done", handle: "h", url: linkTo("/track.mp3"), mime: "audio/mpeg", bytes: 13 }),
    ]);

    const result = await collectMedia(remote, "h", { directory, ...clock() });

    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain("saved to");
});

test("collectMedia gives up after three polls in a row fail and names the handle to collect later", async () => {
    const remote = scripted([new Error("down"), new Error("down"), new Error("down")]);

    const result = await collectMedia(remote, "h-9", { directory, ...clock() });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("down");
    expect(textOf(result)).toContain("h-9");
    expect(remote.calls).toHaveLength(3);
});

test("collectMedia keeps the handle when a poll is refused, so the model never renders it again", async () => {
    const refused: CallToolResult = {
        isError: true,
        content: [{ type: "text", text: "This tool's daily quota is used up; try again later." }],
    };
    const remote = scripted([queued("v-7"), refused]);

    const result = await generateMedia(remote, VIDEO_TOOL_NAME, { prompt: "x" }, { directory, ...clock() });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("quota is used up");
    expect(textOf(result)).toContain("v-7");
    expect(textOf(result)).toContain("do not generate it again");
});

test("collectMedia stops polling once the caller cancels and passes the signal to each poll", async () => {
    const controller = new AbortController();
    const signals: Array<AbortSignal | undefined> = [];
    const call: RemoteCall = async (_name, _args, signal) => {
        signals.push(signal);
        controller.abort();

        return state({ status: "pending", handle: "h" });
    };

    const result = await collectMedia(call, "h", { directory, ...clock(), signal: controller.signal });

    expect(signals).toEqual([controller.signal]);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("cancelled");
});

test("collectMedia holds a wait whose polls keep failing to its deadline", async () => {
    const remote = scripted([new Error("down"), new Error("down")]);

    const result = await collectMedia(remote, "h", { directory, ...clock(), deadlineMs: 15_000 });

    expect(remote.calls).toHaveLength(2);
    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain("Still rendering");
});

test("collectMedia passes an answer it cannot read through untouched", async () => {
    const odd = text("not json");
    const remote = scripted([odd]);

    expect(await collectMedia(remote, "h", { directory, ...clock() })).toBe(odd);
});

test("collectMedia reports a failed download as safe to collect again", async () => {
    const remote = scripted([state({ status: "done", handle: "h", url: linkTo("/gone"), mime: "audio/mpeg" })]);

    const result = await collectMedia(remote, "h", { directory, ...clock() });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("404");
    expect(textOf(result)).toContain("nothing new is generated");
});

test("describeFailure appends the cause that undici hides behind 'fetch failed'", () => {
    const err = new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED 127.0.0.1:1") });

    expect(describeFailure(err)).toBe("fetch failed (connect ECONNREFUSED 127.0.0.1:1)");
    expect(describeFailure(new Error("plain"))).toBe("plain");
    expect(describeFailure("boom")).toBe("boom");
});

test("downloadMedia refuses a type it was not asked for, a redirect and a non-web link", async () => {
    const accept = { "audio/mpeg": { extension: "mp3", maxBytes: 1024 } };

    await expect(downloadMedia(linkTo("/page"), { directory, accept })).rejects.toThrow("text/html");
    await expect(downloadMedia(linkTo("/clip.mp4"), { directory, accept })).rejects.toThrow("video/mp4");
    await expect(downloadMedia(linkTo("/redirect"), { directory, accept })).rejects.toThrow();
    await expect(downloadMedia("file:///etc/hosts", { directory, accept })).rejects.toThrow("file:");
});

test("downloadMedia holds each type to its own size cap and writes nothing for a refused file", async () => {
    const before = readdirSync(directory).length;
    const accept = { "audio/mpeg": { extension: "mp3", maxBytes: 4 } };

    await expect(downloadMedia(linkTo("/track.mp3"), { directory, accept })).rejects.toThrow("4 bytes");
    expect(readdirSync(directory)).toHaveLength(before);
});
