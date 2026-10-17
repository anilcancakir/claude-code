import { afterEach, beforeEach, expect, test } from "bun:test";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    statSync,
    symlinkSync,
    utimesSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The hook is a shell script under the plugin, not TypeScript, but CI only runs `bun test` here,
// so this is where its contract is pinned: exactly one copy of the working rules per main-thread
// context. It emits the rules, stays silent whenever another copy exists, and never goes silent
// because a tool is missing.
const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "plugins", "ac");
const HOOK = join(PLUGIN, "hooks", "session-start-working-rules.sh");
const RULES = join(PLUGIN, "references", "working-rules.md");

const START = "<!-- ac:working-rules:start -->";
const END = "<!-- ac:working-rules:end -->";
const FIRST_LINE = "# Working rules (ac plugin)";
const ROOT_TOKEN = "${CLAUDE_PLUGIN_ROOT}";

let root: string;
let stableDir: string;
let stableCopy: string;
let claudeMd: string;

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ac-working-rules-"));
    stableDir = join(root, "stable");
    stableCopy = join(stableDir, "working-rules.md");
    claudeMd = join(root, "CLAUDE.md");
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

interface HookResult {
    exitCode: number;
    stdout: string;
}

function expectedRules(): string {
    const lines = readFileSync(RULES, "utf8").split("\n");
    const from = lines.indexOf(START);
    const to = lines.indexOf(END);

    return lines.slice(from + 1, to).join("\n").replaceAll(ROOT_TOKEN, PLUGIN);
}

function runHook(source: string, env: Record<string, string> = {}, extra: Record<string, string> = {}): HookResult {
    const result = Bun.spawnSync([Bun.which("sh") ?? "sh", HOOK], {
        stdin: Buffer.from(JSON.stringify({ hook_event_name: "SessionStart", source, ...extra })),
        env: {
            ...process.env,
            HOME: root,
            AC_WORKING_RULES: "",
            AC_WORKING_RULES_APPENDED: "",
            AC_WORKING_RULES_DIR: stableDir,
            AC_GLOBAL_CLAUDE_MD: claudeMd,
            ...env,
        },
    });

    return {
        exitCode: result.exitCode,
        stdout: result.stdout.toString(),
    };
}

function additionalContext(stdout: string): string {
    const output = JSON.parse(stdout) as {
        hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    expect(output.hookSpecificOutput.hookEventName).toBe("SessionStart");

    return output.hookSpecificOutput.additionalContext;
}

test("the fixture rules file carries the markers and the first line", () => {
    expect(expectedRules().split("\n")[0]).toBe(FIRST_LINE);
});

test("a startup emits JSON whose additionalContext equals the extracted text", () => {
    const result = runHook("startup");

    expect(result.exitCode).toBe(0);
    expect(additionalContext(result.stdout)).toBe(expectedRules());
});

test("the plugin root token is resolved in the emitted text and the stable copy", () => {
    const result = runHook("startup");
    const emitted = additionalContext(result.stdout);

    expect(emitted).toContain(`node "${PLUGIN}/cli/ac.js" lease add`);
    expect(emitted).not.toContain(ROOT_TOKEN);
    expect(readFileSync(stableCopy, "utf8")).not.toContain(ROOT_TOKEN);
});

test("clear and compact sources emit", () => {
    for (const source of ["clear", "compact"]) {
        const result = runHook(source);

        expect(result.exitCode).toBe(0);
        expect(additionalContext(result.stdout)).toBe(expectedRules());
    }
});

test("AC_WORKING_RULES=0 is silent", () => {
    const result = runHook("startup", { AC_WORKING_RULES: "0" });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
});

test("AC_WORKING_RULES_APPENDED=1 is silent while the stable copy is still written", () => {
    const result = runHook("startup", fakePs("claude --append-system-prompt-file /x/.claude/ac/working-rules.md"));

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(readFileSync(stableCopy, "utf8")).toBe(`${expectedRules()}\n`);
});

test("a startup writes the stable copy that a wrapper appends", () => {
    runHook("startup");

    expect(readFileSync(stableCopy, "utf8")).toBe(`${expectedRules()}\n`);
});

test("a stale stable copy is replaced", () => {
    mkdirSync(stableDir, { recursive: true });
    writeFileSync(stableCopy, "old text\n");

    runHook("startup");

    expect(readFileSync(stableCopy, "utf8")).toBe(`${expectedRules()}\n`);
});

test("an unchanged stable copy keeps its mtime", () => {
    runHook("startup");
    const past = new Date(Date.now() - 3_600_000);
    utimesSync(stableCopy, past, past);

    runHook("startup");

    expect(Math.floor(statSync(stableCopy).mtimeMs / 1000)).toBe(Math.floor(past.getTime() / 1000));
});

test("no temp file is left beside the stable copy", () => {
    runHook("startup");

    expect(existsSync(stableCopy)).toBe(true);
    expect(Bun.spawnSync(["ls", stableDir]).stdout.toString().trim()).toBe("working-rules.md");
});

test("an old-layout CLAUDE.md with two moved headings is silent", () => {
    writeFileSync(claudeMd, "# Role\n\n## Grounding\n\nSome rule text.\n\n## Run to completion\n\nMore.\n");

    const result = runHook("startup");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
});

test("a single generic heading the user wrote does not silence the rules", () => {
    writeFileSync(claudeMd, "# My notes\n\n## Decisions\n\nPrefer Postgres.\n");

    const result = runHook("startup");

    expect(additionalContext(result.stdout)).toBe(expectedRules());
});

test("a CLAUDE.md without a whole-line moved heading still emits", () => {
    writeFileSync(
        claudeMd,
        [
            "# Role",
            "",
            "### Grounding",
            "## Grounding and more",
            "See the Run to completion section.",
            " ## Decisions",
            "## Core principles",
            "",
        ].join("\n"),
    );

    const result = runHook("startup");

    expect(additionalContext(result.stdout)).toBe(expectedRules());
});

test("a missing CLAUDE.md still emits", () => {
    const result = runHook("startup", { AC_GLOBAL_CLAUDE_MD: join(root, "absent.md") });

    expect(additionalContext(result.stdout)).toBe(expectedRules());
});

test("a resume whose transcript already holds the rules is silent", () => {
    const transcript = join(root, "session.jsonl");
    writeFileSync(
        transcript,
        [
            JSON.stringify({ type: "user", message: "hello" }),
            JSON.stringify({
                type: "attachment",
                attachment: { type: "hook_additional_context", content: [`${FIRST_LINE}\nbody`] },
            }),
            "",
        ].join("\n"),
    );

    const result = runHook("resume", {}, { transcript_path: transcript });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
});

test("a resume after a plain-stdout delivery is silent too", () => {
    const transcript = join(root, "session.jsonl");
    writeFileSync(
        transcript,
        `${JSON.stringify({
            type: "attachment",
            attachment: { type: "hook_success", content: `${FIRST_LINE}\nbody` },
        })}\n`,
    );

    const result = runHook("resume", {}, { transcript_path: transcript });

    expect(result.stdout).toBe("");
});

test("a resume whose transcript lacks the rules emits", () => {
    const transcript = join(root, "session.jsonl");
    writeFileSync(
        transcript,
        [
            JSON.stringify({ type: "user", message: `quoting ${FIRST_LINE} in prose` }),
            JSON.stringify({ type: "attachment", attachment: { type: "hook_additional_context", content: ["other"] } }),
            "",
        ].join("\n"),
    );

    const result = runHook("resume", {}, { transcript_path: transcript });

    expect(additionalContext(result.stdout)).toBe(expectedRules());
});

test("a resume with a missing transcript emits", () => {
    const result = runHook("resume", {}, { transcript_path: join(root, "absent.jsonl") });

    expect(additionalContext(result.stdout)).toBe(expectedRules());
});

test("a startup ignores a transcript that holds the rules", () => {
    const transcript = join(root, "session.jsonl");
    writeFileSync(transcript, `${JSON.stringify({ type: "hook_additional_context", content: FIRST_LINE })}\n`);

    const result = runHook("startup", {}, { transcript_path: transcript });

    expect(additionalContext(result.stdout)).toBe(expectedRules());
});

// A fake `ps` stands in for the process table: every ancestor query answers with FAKE_PS_ARGS, so the
// first ancestor already reads as the claude process the hook looks for.
function fakePs(args: string | null): Record<string, string> {
    const bin = join(root, "ps-bin");
    mkdirSync(bin, { recursive: true });
    const script = args === null
        ? "#!/bin/sh\nexit 1\n"
        : `#!/bin/sh\ncase "$*" in\n  *ppid=*) echo 1 ;;\n  *) printf '%s\\n' "${args}" ;;\nesac\n`;
    writeFileSync(join(bin, "ps"), script, { mode: 0o755 });

    return { PATH: `${bin}:${process.env.PATH ?? ""}`, AC_WORKING_RULES_APPENDED: "1" };
}

test("APPENDED=1 stays silent when the claude ancestor passed the append file", () => {
    const result = runHook("startup", fakePs("claude --append-system-prompt-file /x/.claude/ac/working-rules.md"));

    expect(result.stdout).toBe("");
});

test("APPENDED=1 inherited by a nested claude without the append file still emits", () => {
    const result = runHook("startup", fakePs("claude -p hello"));

    expect(additionalContext(result.stdout)).toBe(expectedRules());
});

// On --resume and -c, Claude Code restores the session's first system prompt from its prompt_snapshot
// record and ignores the new launch's append flags, so the snapshot, not the wrapper, says whether
// the rules are in the system prompt.
function snapshotTranscript(systemText: string): string {
    const transcript = join(root, "session.jsonl");
    writeFileSync(
        transcript,
        `${JSON.stringify({ type: "attachment", attachment: { type: "prompt_snapshot", system: [systemText] } })}\n`,
    );

    return transcript;
}

test("a resume whose restored system prompt lacks the rules emits even behind the wrapper", () => {
    const transcript = snapshotTranscript("You are Claude Code. The organization policy line.");
    const env = fakePs("claude --append-system-prompt-file /x/.claude/ac/working-rules.md -c");

    const result = runHook("resume", env, { transcript_path: transcript });

    expect(additionalContext(result.stdout)).toBe(expectedRules());
});

test("a resume whose restored system prompt carries the rules is silent", () => {
    const transcript = snapshotTranscript(`You are Claude Code.\n${FIRST_LINE}\nbody`);

    const result = runHook("resume", {}, { transcript_path: transcript });

    expect(result.stdout).toBe("");
});

test("a resume ignores a non-hook attachment that only quotes the first line", () => {
    const transcript = snapshotTranscript("You are Claude Code. No rules here.");
    writeFileSync(
        transcript,
        `${JSON.stringify({ type: "attachment", attachment: { type: "queued_command", prompt: `result quotes ${FIRST_LINE}` } })}\n`,
        { flag: "a" },
    );

    const result = runHook("resume", {}, { transcript_path: transcript });

    expect(additionalContext(result.stdout)).toBe(expectedRules());
});

test("a resume ignores a hook copy from before the last compaction", () => {
    const transcript = snapshotTranscript("You are Claude Code. No rules here.");
    writeFileSync(
        transcript,
        [
            JSON.stringify({ type: "attachment", attachment: { type: "hook_additional_context", content: [FIRST_LINE] } }),
            JSON.stringify({ type: "system", subtype: "compact_boundary" }),
            "",
        ].join("\n"),
        { flag: "a" },
    );

    const result = runHook("resume", {}, { transcript_path: transcript });

    expect(additionalContext(result.stdout)).toBe(expectedRules());
});

test("a compact whose snapshot lacks the rules emits behind the wrapper", () => {
    const transcript = snapshotTranscript("You are Claude Code. No rules here.");
    const env = fakePs("claude --append-system-prompt-file /x/.claude/ac/working-rules.md");

    const result = runHook("compact", env, { transcript_path: transcript });

    expect(additionalContext(result.stdout)).toBe(expectedRules());
});

test("a startup ignores a snapshot and trusts the wrapper", () => {
    const transcript = snapshotTranscript("You are Claude Code. No rules here.");
    const env = fakePs("claude --append-system-prompt-file /x/.claude/ac/working-rules.md");

    const result = runHook("startup", env, { transcript_path: transcript });

    expect(result.stdout).toBe("");
});

test("a compact is decided by the session's snapshot too", () => {
    const transcript = snapshotTranscript(`You are Claude Code.\n${FIRST_LINE}\nbody`);

    const result = runHook("compact", {}, { transcript_path: transcript });

    expect(result.stdout).toBe("");
});

test("APPENDED=1 is trusted when the process table cannot be read", () => {
    const result = runHook("startup", fakePs(null));

    expect(result.stdout).toBe("");
});

test("without jq the rules go out as plain stdout", () => {
    const bin = join(root, "bin");
    mkdirSync(bin);
    for (const tool of ["sh", "awk", "grep", "cmp", "mkdir", "dirname", "cat", "cp", "mv", "rm"]) {
        const path = Bun.which(tool);
        expect(path).not.toBeNull();
        symlinkSync(path as string, join(bin, tool));
    }

    const result = runHook("startup", { PATH: bin });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`${expectedRules()}\n`);
    expect(result.stdout).not.toContain(ROOT_TOKEN);
    expect(readFileSync(stableCopy, "utf8")).toBe(`${expectedRules()}\n`);
});
