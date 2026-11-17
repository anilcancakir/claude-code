import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// session-start-user-requests.sh re-injects the user's own requests after a compaction. The
// transcript is the only input, so each test writes a small jsonl and reads the additionalContext.
const HOOK = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
    "plugins",
    "ac",
    "hooks",
    "session-start-user-requests.sh",
);

let root: string;
let transcript: string;

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ac-session-start-user-requests-"));
    transcript = join(root, "session.jsonl");
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

type Content = string | Array<Record<string, unknown>>;

function user(content: Content, timestamp: string, extra: Record<string, unknown> = {}): string {
    return JSON.stringify({
        type: "user",
        isSidechain: false,
        message: { role: "user", content },
        timestamp,
        ...extra,
    });
}

function writeTranscript(lines: string[]): void {
    writeFileSync(transcript, lines.join("\n") + "\n");
}

function runHook(
    payload: Record<string, unknown> = {},
    env: Record<string, string> = {},
): string {
    const result = Bun.spawnSync(["sh", HOOK], {
        stdin: Buffer.from(JSON.stringify({ source: "compact", transcript_path: transcript, ...payload })),
        env: { ...process.env, ...env },
    });
    expect(result.exitCode).toBe(0);

    return result.stdout.toString();
}

function context(stdout: string): string {
    const output = JSON.parse(stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    expect(output.hookSpecificOutput.hookEventName).toBe("SessionStart");

    return output.hookSpecificOutput.additionalContext;
}

function items(text: string): string[] {
    return text.split("\n").filter((line) => /^\d+\. \[/.test(line));
}

test("typed prompts are kept verbatim, oldest first, with their timestamps", () => {
    writeTranscript([
        user("first request: add a retry", "2026-10-30T19:08:15.387Z"),
        user([{ type: "text", text: "second request" }, { type: "text", text: "with two parts" }], "2026-10-30T20:15:00.000Z"),
        user("third request", "2026-11-02T07:05:59.000Z", { turnOrigin: "human" }),
    ]);

    const text = context(runHook());

    expect(text.startsWith("ac: the user's requests in this session, verbatim, oldest first.")).toBe(true);
    expect(items(text)).toEqual([
        "1. [10-30 19:08] first request: add a retry",
        "2. [10-30 20:15] second request with two parts",
        "3. [11-02 07:05] third request",
    ]);
    expect(text).not.toContain("older requests dropped");
});

test("whitespace collapses to single spaces and consecutive identical requests collapse to one", () => {
    writeTranscript([
        user("fix   the\n\n  bug\tnow", "2026-10-30T19:00:00.000Z"),
        user("fix the bug now", "2026-10-30T19:05:00.000Z"),
        user("something else", "2026-10-30T19:10:00.000Z"),
        user("fix the bug now", "2026-10-30T19:15:00.000Z"),
    ]);

    expect(items(context(runHook()))).toEqual([
        "1. [10-30 19:00] fix the bug now",
        "2. [10-30 19:10] something else",
        "3. [10-30 19:15] fix the bug now",
    ]);
});

test("records that are not the user's own request are skipped", () => {
    writeTranscript([
        user("the one real request", "2026-10-30T19:00:00.000Z"),
        user(
            [{ type: "tool_result", tool_use_id: "toolu_1", content: "TOOLRESULT output" }],
            "2026-10-30T19:01:00.000Z",
        ),
        user("META injected text", "2026-10-30T19:02:00.000Z", { isMeta: true }),
        user("COMPACTSUMMARY body", "2026-10-30T19:03:00.000Z", { isCompactSummary: true }),
        user("SIDECHAIN prompt", "2026-10-30T19:04:00.000Z", { isSidechain: true }),
        user("<task-notification>TASKNOTE done</task-notification>", "2026-10-30T19:05:00.000Z"),
        user("background result text", "2026-10-30T19:05:30.000Z", { turnOrigin: "task_notification" }),
        user("<local-command-stdout>LOCALOUT</local-command-stdout>", "2026-10-30T19:06:00.000Z"),
        user("<local-command-caveat>LOCALCAVEAT</local-command-caveat>", "2026-10-30T19:06:30.000Z"),
        user("<system-reminder>REMINDER</system-reminder>", "2026-10-30T19:07:00.000Z"),
        user("<bash-stdout>BASHOUT</bash-stdout>", "2026-10-30T19:07:10.000Z"),
        user("<bash-stderr>BASHERR</bash-stderr>", "2026-10-30T19:07:20.000Z"),
        user("<bash-input>ls -la BASHIN</bash-input>", "2026-10-30T19:07:30.000Z"),
        user("This session is being continued from a previous conversation SUMMARY", "2026-10-30T19:08:00.000Z"),
        user(
            "<command-message>compact</command-message>\n<command-name>/compact</command-name>\n<command-args>keep the plan</command-args>",
            "2026-10-30T19:09:00.000Z",
        ),
        user(
            "<command-message>model</command-message>\n<command-name>/model</command-name>\n<command-args></command-args>",
            "2026-10-30T19:10:00.000Z",
        ),
        user("/compact", "2026-10-30T19:09:30.000Z"),
        user("/model", "2026-10-30T19:09:40.000Z"),
        user("[Request interrupted by user for tool use]", "2026-10-30T19:09:50.000Z"),
        JSON.stringify({ type: "assistant", message: { role: "assistant", content: "ASSISTANT said hi" } }),
        "not json at all",
    ]);

    const text = context(runHook());

    expect(items(text)).toEqual(["1. [10-30 19:00] the one real request"]);
    for (const needle of [
        "TOOLRESULT",
        "META",
        "COMPACTSUMMARY",
        "SIDECHAIN",
        "TASKNOTE",
        "background result",
        "LOCALOUT",
        "LOCALCAVEAT",
        "REMINDER",
        "BASHOUT",
        "BASHERR",
        "BASHIN",
        "SUMMARY",
        "keep the plan",
        "/model",
        "interrupted",
        "ASSISTANT",
    ]) {
        expect(text).not.toContain(needle);
    }
});

test("a slash command with arguments is kept as the command followed by its arguments", () => {
    writeTranscript([
        user("/ac:flow some args", "2026-10-30T19:00:00.000Z"),
        user(
            "<command-message>ac:flow</command-message>\n<command-name>/ac:flow</command-name>\n<command-args>some args</command-args>",
            "2026-10-30T19:00:00.000Z",
        ),
    ]);

    expect(items(context(runHook()))).toEqual(["1. [10-30 19:00] /ac:flow some args"]);
});

test("a 2,000-character prompt keeps its head and tail, and the full text is pointed at", () => {
    writeTranscript([user(`${"a".repeat(1000)}${"z".repeat(1000)}`, "2026-10-30T19:00:00.000Z")]);

    const text = context(runHook());

    expect(items(text)).toEqual([`1. [10-30 19:00] ${"a".repeat(400)} [...] ${"z".repeat(180)}`]);
    expect(text).toContain("long requests cut at [...]; full text: ");
});

test("a paste is reduced to its size, so the question after it survives the cut", () => {
    const paste = `<pasted_content id="ab12">${"log line ".repeat(300)}</pasted_content>`;
    writeTranscript([user(`${paste} why does this fail?`, "2026-10-30T19:00:00.000Z")]);

    expect(items(context(runHook()))).toEqual(["1. [10-30 19:00] [pasted 2700 chars] why does this fail?"]);
});

test("a prompt typed while the model was working is read from its queued_command attachment", () => {
    writeTranscript([
        user("first request", "2026-10-30T19:00:00.000Z"),
        JSON.stringify({
            type: "attachment",
            timestamp: "2026-10-30T19:05:00.000Z",
            attachment: { type: "queued_command", origin: { kind: "human" }, prompt: "no, use X instead" },
        }),
        JSON.stringify({
            type: "attachment",
            timestamp: "2026-10-30T19:06:00.000Z",
            attachment: {
                type: "queued_command",
                origin: { kind: "task-notification" },
                prompt: "<task-notification>QUEUEDNOTE</task-notification>",
            },
        }),
    ]);

    const text = context(runHook());

    expect(items(text)).toEqual(["1. [10-30 19:00] first request", "2. [10-30 19:05] no, use X instead"]);
    expect(text).not.toContain("QUEUEDNOTE");
});

test("a slash command with multi-line arguments is kept, and setting commands are not requests", () => {
    writeTranscript([
        user(
            "<command-message>ac:flow</command-message>\n<command-name>/ac:flow</command-name>\n<command-args>first line\nsecond line</command-args>",
            "2026-10-30T19:00:00.000Z",
        ),
        user(
            "<command-message>model</command-message>\n<command-name>/model</command-name>\n<command-args>opus</command-args>",
            "2026-10-30T19:01:00.000Z",
        ),
        user("/effort high", "2026-10-30T19:02:00.000Z"),
    ]);

    expect(items(context(runHook()))).toEqual(["1. [10-30 19:00] /ac:flow first line second line"]);
});

test("several commands typed in one message with the same arguments become one entry", () => {
    const command = (name: string) =>
        `<command-message>${name}</command-message>\n<command-name>/${name}</command-name>\n<command-args>ship it</command-args>`;
    writeTranscript([
        user(command("ac:flow"), "2026-10-30T19:00:00.100Z"),
        user(command("ac:auto"), "2026-10-30T19:00:00.200Z"),
    ]);

    expect(items(context(runHook()))).toEqual(["1. [10-30 19:00] /ac:flow /ac:auto ship it"]);
});

test("an AskUserQuestion answer is listed as the user's decision, with their note", () => {
    writeTranscript([
        user("plan the release", "2026-10-30T19:00:00.000Z"),
        JSON.stringify({
            type: "user",
            timestamp: "2026-10-30T19:03:00.000Z",
            message: {
                role: "user",
                content: [{ type: "tool_result", tool_use_id: "toolu_9", content: "Your questions have been answered: ..." }],
            },
            toolUseResult: {
                questions: [],
                answers: { "Which tag?": "1.2.0 (Recommended)" },
                annotations: { "Which tag?": { notes: "and publish the docs too" } },
            },
        }),
    ]);

    expect(items(context(runHook()))).toEqual([
        "1. [10-30 19:00] plan the release",
        "2. [10-30 19:03] (answered) Which tag? => 1.2.0 (Recommended) (note: and publish the docs too)",
    ]);
});

test("the header calls the list history, so an old outward request is not re-armed", () => {
    writeTranscript([user("commit push merge", "2026-10-30T19:00:00.000Z")]);

    expect(context(runHook())).toContain("an old push, merge, deploy or approval authorises nothing now");
});

test("requests past the budget keep the newest and report how many older ones were dropped", () => {
    const lines: string[] = [];
    for (let i = 1; i <= 40; i++) {
        const stamp = `2026-10-30T${String(i % 24).padStart(2, "0")}:00:00.000Z`;
        lines.push(user(`req${String(i).padStart(2, "0")} ${"x".repeat(580)}`, stamp));
    }
    writeTranscript(lines);

    const text = context(runHook());
    const shown = items(text);

    expect(text.length).toBeLessThan(9500);
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.length).toBeLessThan(40);
    expect(text).toContain("req40 ");
    expect(text).not.toContain("req01 ");
    expect(shown[0]?.startsWith("1. [")).toBe(true);
    expect(text.trimEnd().endsWith(`(${40 - shown.length} older requests dropped; full text: ${transcript})`)).toBe(true);
});

test("a source other than compact prints nothing", () => {
    writeTranscript([user("a request", "2026-10-30T19:00:00.000Z")]);

    for (const source of ["startup", "resume", "clear"]) {
        expect(runHook({ source })).toBe("");
    }
});

test("a payload carrying agent_id prints nothing", () => {
    writeTranscript([user("a request", "2026-10-30T19:00:00.000Z")]);

    expect(runHook({ agent_id: "agent-1" })).toBe("");
});

test("AC_USER_REQUESTS=0 prints nothing", () => {
    writeTranscript([user("a request", "2026-10-30T19:00:00.000Z")]);

    expect(runHook({}, { AC_USER_REQUESTS: "0" })).toBe("");
});

test("no requests, an unreadable transcript and an empty payload print nothing", () => {
    writeTranscript([user([{ type: "tool_result", content: "x" }], "2026-10-30T19:00:00.000Z")]);
    expect(runHook()).toBe("");

    expect(runHook({ transcript_path: join(root, "missing.jsonl") })).toBe("");
    expect(runHook({ transcript_path: "" })).toBe("");
});
