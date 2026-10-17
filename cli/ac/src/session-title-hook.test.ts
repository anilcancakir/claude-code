import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The hook is a shell script under the plugin, so this is where its contract is pinned: it is off
// unless AC_SESSION_TITLE=1, counts the user's own prompts, generates a kebab-case title in the
// background on the first prompt and every Nth one, applies a generated title on the next prompt, and
// stops for good once the transcript shows a title it did not set.
const HOOK = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
    "plugins",
    "ac",
    "hooks",
    "userpromptsubmit-session-title.sh",
);

const SESSION = "sess-title-1";

let root: string;
let scratch: string;
let bin: string;
let transcript: string;

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ac-session-title-"));
    scratch = join(root, "tmp");
    bin = join(root, "bin");
    transcript = join(root, "transcript.jsonl");
    mkdirSync(scratch, { recursive: true });
    mkdirSync(bin, { recursive: true });
    writeFileSync(transcript, "");
    stubGenerator("session-title-refresh");
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

interface HookResult {
    exitCode: number;
    stdout: string;
}

// The stub stands in for the isolated `claude -p` call: it records that it ran and what it was asked,
// then prints the json result shape the hook parses.
function stubGenerator(title: string): void {
    const result = JSON.stringify({
        type: "result",
        structured_output: {
            title,
        },
    });
    writeFileSync(
        join(bin, "claude"),
        `#!/bin/sh\ncat > "${join(root, "generator-prompt.txt")}"\nprintf '%s\\n' '${result}'\n`,
        {
            mode: 0o755,
        },
    );
}

function runHook(stdin: string, env: Record<string, string> = {}): HookResult {
    const result = Bun.spawnSync(["sh", HOOK], {
        stdin: Buffer.from(stdin),
        env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH ?? ""}`,
            TMPDIR: scratch,
            AC_SESSION_TITLE: "1",
            AC_SESSION_TITLE_EVERY: "",
            AC_SESSION_TITLE_CHILD: "",
            AC_SESSION_TITLE_PROMPT: "",
            AC_SESSION_TITLE_PATTERN: "",
            CLAUDE_CONFIG_DIR: join(root, "no-config"),
            CLAUDE_CODE_ENTRYPOINT: "cli",
            ...env,
        },
    });

    return {
        exitCode: result.exitCode,
        stdout: result.stdout.toString(),
    };
}

function payload(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
        session_id: SESSION,
        transcript_path: transcript,
        cwd: root,
        hook_event_name: "UserPromptSubmit",
        // Shaped like the 2.1.302 payload: no `source` field, `session_title` only once a custom title exists.
        prompt: "Fix the session titles",
        session_title: "",
        ...overrides,
    });
}

function statePath(session: string = SESSION): string {
    return join(scratch, `ac-session-title-${session}`);
}

function pendingPath(session: string = SESSION): string {
    return join(scratch, `ac-session-title-${session}.pending`);
}

// The state file holds the count (or `stopped`), the transcript offset scanned so far, the last custom
// title seen, the name applied since the last scan, then the titles the hook set.
function seedState(count: number | "stopped", owned: string[] = [], fresh: string = ""): void {
    writeFileSync(statePath(), [String(count), "0", "", fresh, ...owned].join("\n") + "\n");
}

function readState(): string[] {
    return readFileSync(statePath(), "utf8").trim().split("\n");
}

function appendTranscript(records: object[]): void {
    writeFileSync(transcript, records.map((record) => JSON.stringify(record)).join("\n") + "\n", { flag: "a" });
}

function userTurn(text: string): object {
    return {
        type: "user",
        message: {
            role: "user",
            content: text,
        },
    };
}

function customTitle(title: string): object {
    return {
        type: "custom-title",
        customTitle: title,
        sessionId: SESSION,
    };
}

async function waitFor(path: string, timeoutMs: number = 4000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (existsSync(path)) {
            return true;
        }
        await Bun.sleep(50);
    }

    return existsSync(path);
}

function sessionTitleOf(stdout: string): string | undefined {
    if (stdout.trim() === "") {
        return undefined;
    }

    return JSON.parse(stdout).hookSpecificOutput?.sessionTitle;
}

test("is silent and writes nothing unless AC_SESSION_TITLE is 1", () => {
    const result = runHook(payload(), { AC_SESSION_TITLE: "" });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(existsSync(statePath())).toBe(false);
});

// The hook fires before its prompt reaches the transcript, so on the first prompt the transcript holds
// no user turn and the prompt has to reach the generator from the payload.
test("the first prompt generates a title in the background from the prompt itself", async () => {
    const result = runHook(payload());

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(readState()[0]).toBe("1");
    expect(await waitFor(pendingPath())).toBe(true);
    expect(readFileSync(pendingPath(), "utf8").trim()).toBe("session-title-refresh");
    expect(readFileSync(join(root, "generator-prompt.txt"), "utf8")).toContain("Fix the session titles");
});

// The payload's session_title stays empty while the session has only Claude Code's own ai-title, so
// the generator falls back to the transcript for the name the session list shows.
test("the current name sent to the model falls back to Claude Code's own ai-title", async () => {
    appendTranscript([
        userTurn("Explain Bloom filters"),
        {
            type: "ai-title",
            aiTitle: "Bloom filter explanation",
            sessionId: SESSION,
        },
    ]);
    writeFileSync(join(root, "prompt.md"), "CURRENT={{CURRENT}}\n{{CONVERSATION}}\n");

    runHook(payload(), { AC_SESSION_TITLE_PROMPT: join(root, "prompt.md") });

    expect(await waitFor(join(root, "generator-prompt.txt"))).toBe(true);
    expect(readFileSync(join(root, "generator-prompt.txt"), "utf8")).toContain("CURRENT=Bloom filter explanation");
});

test("the generator reads the active context: the latest summary, then tool calls and turns after it", async () => {
    appendTranscript([
        userTurn("An old topic from before the compaction"),
        userTurn("This session is being continued from a previous conversation. Summary: built the title hook."),
        {
            type: "assistant",
            message: {
                content: [
                    {
                        type: "text",
                        text: "Editing the hook now.",
                    },
                    {
                        type: "tool_use",
                        name: "Edit",
                        input: {
                            file_path: "plugins/ac/hooks/userpromptsubmit-session-title.sh",
                        },
                    },
                    {
                        type: "tool_use",
                        name: "Read",
                        input: {
                            file_path: "README.md",
                        },
                    },
                ],
            },
        },
    ]);
    seedState(9);

    runHook(payload({ prompt: "Now test it live" }), { AC_SESSION_TITLE_EVERY: "10" });

    expect(await waitFor(join(root, "generator-prompt.txt"))).toBe(true);
    const sent = readFileSync(join(root, "generator-prompt.txt"), "utf8");
    expect(sent).toContain("Earlier in this session (summary): This session is being continued");
    expect(sent).toContain("Tool: Edit plugins/ac/hooks/userpromptsubmit-session-title.sh");
    expect(sent).toContain("User: Now test it live");
    expect(sent).not.toContain("An old topic");
    expect(sent).not.toContain("README.md");
});

test("a pending title is applied on the next prompt and remembered as the hook's own", () => {
    seedState(1);
    writeFileSync(pendingPath(), "session-title-refresh\n");

    const result = runHook(payload());

    expect(sessionTitleOf(result.stdout)).toBe("session-title-refresh");
    expect(existsSync(pendingPath())).toBe(false);
    const state = readState();
    expect(state[0]).toBe("2");
    expect(state.at(-1)).toBe("session-title-refresh");
});

test("a title the hook did not set stops it for good", async () => {
    seedState(3, ["session-title-refresh"]);
    writeFileSync(pendingPath(), "another-title\n");
    appendTranscript([
        customTitle("session-title-refresh"),
        customTitle("my-own-name"),
    ]);

    const result = runHook(payload());

    expect(result.stdout).toBe("");
    expect(existsSync(pendingPath())).toBe(false);
    expect(readState()[0]).toBe("stopped");

    seedState("stopped", ["session-title-refresh"]);
    writeFileSync(pendingPath(), "another-title\n");
    expect(runHook(payload(), { AC_SESSION_TITLE_EVERY: "1" }).stdout).toBe("");
    await Bun.sleep(500);
    expect(existsSync(join(root, "generator-prompt.txt"))).toBe(false);
});

test("a user rename that extends the hook's title is still the user's", () => {
    seedState(4, ["payment-retry"]);
    writeFileSync(pendingPath(), "hook-title-design\n");
    appendTranscript([customTitle("payment-retry-v2")]);

    expect(runHook(payload()).stdout).toBe("");
    expect(readState()[0]).toBe("stopped");
});

test("a rename between due prompts is caught by the next scan, which reads only new bytes", () => {
    seedState(1, ["session-title-refresh"]);
    writeFileSync(pendingPath(), "session-title-refresh\n");
    appendTranscript([userTurn("Fix the session titles")]);
    expect(sessionTitleOf(runHook(payload()).stdout)).toBe("session-title-refresh");
    const offset = Number(readState()[1]);
    expect(offset).toBeGreaterThan(0);

    appendTranscript([
        customTitle("session-title-refresh"),
        customTitle("chosen-by-me"),
    ]);
    writeFileSync(pendingPath(), "hook-title-design\n");

    expect(runHook(payload()).stdout).toBe("");
    expect(readState()[0]).toBe("stopped");
});

test("a name given before the hook ever titled the session is left alone", () => {
    seedState(0);
    writeFileSync(pendingPath(), "another-title\n");
    appendTranscript([customTitle("payment")]);

    expect(runHook(payload()).stdout).toBe("");
});

test("its own title, and a collision suffix on the first scan after applying it, keep it running", () => {
    for (const recorded of ["session-title-refresh", "session-title-refresh-brave-otter"]) {
        writeFileSync(transcript, "");
        seedState(4, ["session-title-refresh"], "session-title-refresh");
        writeFileSync(pendingPath(), "hook-title-design\n");
        appendTranscript([customTitle(recorded)]);

        expect(sessionTitleOf(runHook(payload()).stdout)).toBe("hook-title-design");
    }
    expect(readState()).toContain("session-title-refresh-brave-otter");
});

// A state file from before the `fresh` line: count, offset, seen, then the owned titles from line 4.
test("a state file in the earlier layout keeps the hook's own title as its own", () => {
    writeFileSync(statePath(), ["4", "0", "", "raft-leader-election"].join("\n") + "\n");
    writeFileSync(pendingPath(), "crdt-merge-semantics\n");
    appendTranscript([customTitle("raft-leader-election")]);

    expect(sessionTitleOf(runHook(payload()).stdout)).toBe("crdt-merge-semantics");
    expect(readState()).toContain("raft-leader-election");
    expect(readState()[0]).toBe("5");
});

test("a suffix-shaped name seen later than the first scan after an apply is the user's", () => {
    seedState(4, ["raft-leader"]);
    writeFileSync(pendingPath(), "hook-title-design\n");
    appendTranscript([customTitle("raft-leader-election-notes")]);

    expect(runHook(payload()).stdout).toBe("");
    expect(readState()[0]).toBe("stopped");
});

test("a prompt the user did not type is not counted, whether `source` says so or the text does", () => {
    seedState(2);

    for (const prompt of [
        "<task-notification>\n<task-id>a1</task-id>",
        "Another Claude session sent a message:\nhello",
        "<system-reminder>x</system-reminder>",
    ]) {
        expect(runHook(payload({ prompt })).stdout).toBe("");
    }
    expect(runHook(payload({ source: "system" })).stdout).toBe("");
    expect(readState()[0]).toBe("2");
});

test("a prompt typed while the model was busy reaches the excerpt; a queued notification does not", async () => {
    appendTranscript([
        userTurn("Fix the session titles"),
        {
            type: "attachment",
            attachment: {
                type: "queued_command",
                commandMode: "prompt",
                prompt: "Also rename the CRDT module",
            },
        },
        {
            type: "attachment",
            attachment: {
                type: "queued_command",
                commandMode: "task-notification",
                prompt: "<task-notification>done</task-notification>",
            },
        },
    ]);
    seedState(9);

    runHook(payload(), { AC_SESSION_TITLE_EVERY: "10" });

    expect(await waitFor(join(root, "generator-prompt.txt"))).toBe(true);
    const sent = readFileSync(join(root, "generator-prompt.txt"), "utf8");
    expect(sent).toContain("User: Also rename the CRDT module");
    expect(sent).not.toContain("task-notification");
});

test("with the built-in prompt, Claude Code's sentence-case ai-title reaches the model kebab-cased", async () => {
    appendTranscript([
        userTurn("Explain Bloom filters"),
        {
            type: "ai-title",
            aiTitle: "Bloom filter açıklaması",
            sessionId: SESSION,
        },
    ]);

    runHook(payload());

    expect(await waitFor(join(root, "generator-prompt.txt"))).toBe(true);
    expect(readFileSync(join(root, "generator-prompt.txt"), "utf8")).toContain("Current name: bloom-filter-aciklamasi");
});

// The session list shows the ai-title until a custom title exists, so the model keeping that name in
// kebab case is still a rename worth applying.
test("an answer equal to the kebab-cased ai-title is still written as a pending title", async () => {
    stubGenerator("bloom-filter-explanation");
    appendTranscript([
        userTurn("Explain Bloom filters"),
        {
            type: "ai-title",
            aiTitle: "Bloom filter explanation",
            sessionId: SESSION,
        },
    ]);

    runHook(payload());

    expect(await waitFor(pendingPath())).toBe(true);
    expect(readFileSync(pendingPath(), "utf8").trim()).toBe("bloom-filter-explanation");
});

test("generation fires on every Nth prompt and not between", async () => {
    appendTranscript([userTurn("Fix the session titles")]);
    seedState(4);
    runHook(payload(), { AC_SESSION_TITLE_EVERY: "10" });
    await Bun.sleep(700);
    expect(existsSync(join(root, "generator-prompt.txt"))).toBe(false);

    seedState(9);
    runHook(payload(), { AC_SESSION_TITLE_EVERY: "10" });
    expect(await waitFor(pendingPath())).toBe(true);
});

test("with the built-in prompt, a long or sentence-case answer is kebab-cased and cut to four words", async () => {
    for (const [answer, expected] of [
        ["bloom-filter-false-positive-rate", "bloom-filter-false-positive"],
        ["Fix Session Titles", "fix-session-titles"],
    ]) {
        rmSync(join(scratch, `ac-session-title-${SESSION}.lock`), { recursive: true, force: true });
        rmSync(pendingPath(), { force: true });
        stubGenerator(answer ?? "");

        runHook(payload());

        expect(await waitFor(pendingPath())).toBe(true);
        expect(readFileSync(pendingPath(), "utf8").trim()).toBe(expected ?? "");
        rmSync(statePath(), { force: true });
    }
});

test("a generated title that is not 2 to 4 kebab-case words is dropped", async () => {
    stubGenerator("fix");
    appendTranscript([userTurn("Fix the session titles")]);

    runHook(payload());

    expect(await waitFor(join(root, "generator-prompt.txt"))).toBe(true);
    await Bun.sleep(500);
    expect(existsSync(pendingPath())).toBe(false);
});

test("a prompt file named by AC_SESSION_TITLE_PROMPT replaces the built-in one, with its own pattern", async () => {
    const prompt = join(root, "task-keys.md");
    writeFileSync(prompt, "TASK KEY PROMPT {{CURRENT}}\n{{CONVERSATION}}\n");
    stubGenerator("RYTC-123 login fix");
    appendTranscript([userTurn("RYTC-123: the login button is broken")]);

    runHook(payload(), {
        AC_SESSION_TITLE_PROMPT: prompt,
        AC_SESSION_TITLE_PATTERN: "^[A-Z]+-[0-9]+( .+)?$",
    });

    expect(await waitFor(pendingPath())).toBe(true);
    expect(readFileSync(pendingPath(), "utf8").trim()).toBe("RYTC-123 login fix");
    const sent = readFileSync(join(root, "generator-prompt.txt"), "utf8");
    expect(sent).toContain("TASK KEY PROMPT");
    expect(sent).toContain("RYTC-123: the login button is broken");
});

test("a user prompt file under the config dir is picked up, and a custom prompt accepts any one-line title", async () => {
    const config = join(root, "config");
    mkdirSync(join(config, "ac"), { recursive: true });
    writeFileSync(join(config, "ac", "session-title.md"), "USER LEVEL PROMPT\n{{CONVERSATION}}\n");
    stubGenerator('RYTC-7 "quoted" title');
    appendTranscript([userTurn("RYTC-7 work")]);

    runHook(payload(), { CLAUDE_CONFIG_DIR: config });

    expect(await waitFor(pendingPath())).toBe(true);
    expect(readFileSync(join(root, "generator-prompt.txt"), "utf8")).toContain("USER LEVEL PROMPT");

    const applied = runHook(payload(), { CLAUDE_CONFIG_DIR: config });
    expect(sessionTitleOf(applied.stdout)).toBe('RYTC-7 "quoted" title');
});

test("a multi-line title, or one with a control character under an unanchored pattern, is dropped", async () => {
    // A custom pattern skips the built-in kebab normalisation, so both reach the line and control guards.
    for (const [title, pattern] of [["checkout-coupon\nrm-rf-home", "."], ["RYTC-1 \u001b[31mred", "^[A-Z]+-[0-9]+"]]) {
        rmSync(join(root, "generator-prompt.txt"), { force: true });
        rmSync(join(scratch, `ac-session-title-${SESSION}.lock`), { recursive: true, force: true });
        stubGenerator(title ?? "");
        writeFileSync(transcript, "");

        runHook(payload({ session_id: `${SESSION}-${pattern === "." ? "a" : "b"}` }), {
            AC_SESSION_TITLE_PATTERN: pattern ?? "",
        });

        expect(await waitFor(join(root, "generator-prompt.txt"))).toBe(true);
        await Bun.sleep(400);
        expect(existsSync(pendingPath(`${SESSION}-${pattern === "." ? "a" : "b"}`))).toBe(false);
    }
});

test("AC_SESSION_TITLE_PATTERN overrides the built-in pattern and drops a title it does not match", async () => {
    stubGenerator("login fix");
    appendTranscript([userTurn("RYTC-9 work")]);

    runHook(payload(), { AC_SESSION_TITLE_PATTERN: "^[A-Z]+-[0-9]+" });

    expect(await waitFor(join(root, "generator-prompt.txt"))).toBe(true);
    await Bun.sleep(500);
    expect(existsSync(pendingPath())).toBe(false);
});

test("the generator's own session and headless runs are skipped", () => {
    expect(runHook(payload(), { AC_SESSION_TITLE_CHILD: "1" }).stdout).toBe("");
    expect(runHook(payload(), { CLAUDE_CODE_ENTRYPOINT: "sdk-cli" }).stdout).toBe("");
    expect(existsSync(statePath())).toBe(false);
});

test("an unsafe session id or a symlinked state file is refused", () => {
    expect(runHook(payload({ session_id: "../escape" })).stdout).toBe("");

    const target = join(root, "elsewhere");
    writeFileSync(target, "7\n");
    symlinkSync(target, statePath());
    writeFileSync(pendingPath(), "session-title-refresh\n");

    expect(runHook(payload()).stdout).toBe("");
    expect(readFileSync(target, "utf8")).toBe("7\n");
});
