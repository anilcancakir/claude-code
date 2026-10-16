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
        prompt: "Fix the session titles",
        source: "user",
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
// title seen, then the titles the hook set.
function seedState(count: number | "stopped", owned: string[] = []): void {
    writeFileSync(statePath(), [String(count), "0", "", ...owned].join("\n") + "\n");
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

test("its own title, with or without a collision suffix, keeps it running", () => {
    for (const recorded of ["session-title-refresh", "session-title-refresh-brave-otter"]) {
        writeFileSync(transcript, "");
        seedState(4, ["session-title-refresh"]);
        writeFileSync(pendingPath(), "hook-title-design\n");
        appendTranscript([customTitle(recorded)]);

        expect(sessionTitleOf(runHook(payload()).stdout)).toBe("hook-title-design");
    }
});

test("a prompt the user did not type is not counted", () => {
    seedState(2);

    const result = runHook(payload({ source: "system" }));

    expect(result.stdout).toBe("");
    expect(readState()[0]).toBe("2");
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

test("a generated title that is not 2 to 4 kebab-case words is dropped", async () => {
    stubGenerator("Fix Session Titles");
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
    for (const [title, pattern] of [["checkout-coupon\nrm-rf-home", ""], ["RYTC-1 \u001b[31mred", "^[A-Z]+-[0-9]+"]]) {
        rmSync(join(root, "generator-prompt.txt"), { force: true });
        rmSync(join(scratch, `ac-session-title-${SESSION}.lock`), { recursive: true, force: true });
        stubGenerator(title ?? "");
        writeFileSync(transcript, "");

        runHook(payload({ session_id: `${SESSION}-${pattern === "" ? "a" : "b"}` }), {
            AC_SESSION_TITLE_PATTERN: pattern ?? "",
        });

        expect(await waitFor(join(root, "generator-prompt.txt"))).toBe(true);
        await Bun.sleep(400);
        expect(existsSync(pendingPath(`${SESSION}-${pattern === "" ? "a" : "b"}`))).toBe(false);
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
