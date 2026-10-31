import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The hook is a shell script under the plugin, not TypeScript, but CI only runs `bun test` here,
// so this is where its contract is pinned: silent under budget and on any file it does not govern,
// `decision: block` naming the writer skill over it, and silent on anything it cannot read.
const HOOK = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
    "plugins",
    "ac",
    "hooks",
    "posttooluse-memory-file-budget.sh",
);

const ENV_KEYS = [
    "AC_MEMORY_FILE_BUDGET",
    "AC_CLAUDE_MD_MAX_LINES",
    "AC_CLAUDE_MD_MAX_BYTES",
    "AC_CLAUDE_LOCAL_MD_MAX_LINES",
    "AC_CLAUDE_LOCAL_MD_MAX_BYTES",
    "AC_RULE_MAX_LINES",
    "AC_RULE_MAX_BYTES",
    "AC_PROJECT_MD_MAX_LINES",
    "AC_DESIGN_MD_MAX_LINES",
];

let root: string;

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ac-memory-file-budget-"));
    mkdirSync(join(root, ".claude", "rules"), { recursive: true });
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

interface HookResult {
    exitCode: number;
    stdout: string;
}

function runHook(stdin: string, env: Record<string, string> = {}): HookResult {
    const result = Bun.spawnSync(["sh", HOOK], {
        stdin: Buffer.from(stdin),
        env: {
            ...process.env,
            ...Object.fromEntries(ENV_KEYS.map((key) => [key, ""])),
            ...env,
        },
    });

    return {
        exitCode: result.exitCode,
        stdout: result.stdout.toString(),
    };
}

function payload(filePath: string): string {
    return JSON.stringify({
        hook_event_name: "PostToolUse",
        tool_name: "Write",
        tool_input: {
            file_path: filePath,
        },
    });
}

function rows(count: number, width = 20): string {
    return Array.from({ length: count }, () => "x".repeat(width)).join("\n") + "\n";
}

function create(relative: string, content: string): string {
    const path = join(root, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);

    return path;
}

function blockReason(stdout: string): string {
    const output = JSON.parse(stdout) as { decision?: string; reason?: string };
    expect(output.decision).toBe("block");

    return output.reason ?? "";
}

const SILENT: HookResult = { exitCode: 0, stdout: "" };

test("a 130-line CLAUDE.md blocks with the counts, the path and the skill", () => {
    const file = create("CLAUDE.md", rows(130));

    const result = runHook(payload(file));
    const reason = blockReason(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(reason).toContain("130/120 lines");
    expect(reason).toContain(file);
    expect(reason).toContain("following ac:claude-md-rules-creator");
    expect(reason).toContain("Do not delete a fact you have not moved.");
});

test("each file kind over its line budget blocks naming its skill", () => {
    const cases: Array<[string, number, string, string]> = [
        ["CLAUDE.md", 121, "121/120 lines", "ac:claude-md-rules-creator"],
        ["AGENTS.md", 121, "121/120 lines", "ac:claude-md-rules-creator"],
        ["CLAUDE.local.md", 61, "61/60 lines", "ac:claude-md-rules-creator"],
        [".claude/rules/a.md", 121, "121/120 lines", "ac:claude-md-rules-creator"],
        ["PROJECT.md", 151, "151/150 lines", "ac:project-md-writer"],
        ["DESIGN.md", 301, "301/300 lines", "ac:design-md-writer"],
    ];

    for (const [relative, count, measured, skill] of cases) {
        const reason = blockReason(runHook(payload(create(relative, rows(count)))).stdout);

        expect(reason).toContain(measured);
        expect(reason).toContain(`following ${skill}`);
    }
});

test("a file at its line budget passes silently", () => {
    expect(runHook(payload(create("CLAUDE.md", rows(120))))).toEqual(SILENT);
    expect(runHook(payload(create("CLAUDE.local.md", rows(60))))).toEqual(SILENT);
    expect(runHook(payload(create("PROJECT.md", rows(150))))).toEqual(SILENT);
    expect(runHook(payload(create("DESIGN.md", rows(300))))).toEqual(SILENT);
});

test("a last line without a trailing newline still counts", () => {
    const file = create("CLAUDE.md", rows(121).trimEnd());

    expect(blockReason(runHook(payload(file)).stdout)).toContain("121/120 lines");
});

test("the byte budget blocks a short file with long lines", () => {
    // 50 lines of 300 bytes: under the line budget, 15,050 bytes in all.
    const file = create("CLAUDE.md", rows(50, 300));

    expect(blockReason(runHook(payload(file)).stdout)).toContain("50/120 lines, 15050/12288 bytes");
});

test("CLAUDE.local.md has its own, smaller byte budget", () => {
    const file = create("CLAUDE.local.md", rows(30, 250));

    expect(blockReason(runHook(payload(file)).stdout)).toContain("30/60 lines, 7530/6144 bytes");
});

test("PROJECT.md and DESIGN.md have no byte budget", () => {
    expect(runHook(payload(create("PROJECT.md", rows(100, 500))))).toEqual(SILENT);
    expect(runHook(payload(create("DESIGN.md", rows(100, 500))))).toEqual(SILENT);
});

test("an env override tightens a limit", () => {
    const file = create(".claude/rules/a.md", rows(10));

    expect(blockReason(runHook(payload(file), { AC_RULE_MAX_LINES: "5" }).stdout)).toContain("10/5 lines");
});

test("an env override of 0 turns that check off", () => {
    const file = create("CLAUDE.md", rows(300));

    expect(runHook(payload(file), { AC_CLAUDE_MD_MAX_LINES: "0" })).toEqual(SILENT);
    expect(blockReason(runHook(payload(file), { AC_CLAUDE_MD_MAX_BYTES: "100" }).stdout)).toContain("300/120 lines");

    const long = create("CLAUDE.md", rows(50, 300));
    expect(runHook(payload(long), { AC_CLAUDE_MD_MAX_BYTES: "0" })).toEqual(SILENT);
});

test("a non-numeric override falls back to the default", () => {
    const file = create("CLAUDE.md", rows(121));

    expect(blockReason(runHook(payload(file), { AC_CLAUDE_MD_MAX_LINES: "lots" }).stdout)).toContain("121/120 lines");
});

test("AC_MEMORY_FILE_BUDGET=0 turns the whole hook off", () => {
    const file = create("CLAUDE.md", rows(300));

    expect(runHook(payload(file), { AC_MEMORY_FILE_BUDGET: "0" })).toEqual(SILENT);
});

test("a file that is not a memory file passes silently, even when it is huge", () => {
    for (const relative of ["src/notes.md", "CLAUDE.template.md", ".claude/rules/a.txt", "README.md"]) {
        expect(runHook(payload(create(relative, rows(500))))).toEqual(SILENT);
    }
});

test("skipped paths pass silently, even when they are huge", () => {
    for (const relative of [
        ".claude/projects/-tmp-x/memory/CLAUDE.md",
        "node_modules/pkg/CLAUDE.md",
        "vendor/pkg/.claude/rules/a.md",
        "references/repo/CLAUDE.md",
        ".claude/plugins/cache/ac/CLAUDE.md",
        "plugins/ac/skills/claude-md-rules-creator/examples/CLAUDE.md",
    ]) {
        expect(runHook(payload(create(relative, rows(500))))).toEqual(SILENT);
    }
});

test("an unparseable payload fails open", () => {
    expect(runHook("not json")).toEqual(SILENT);
    expect(runHook("")).toEqual(SILENT);
});

test("a missing file fails open", () => {
    expect(runHook(payload(join(root, "CLAUDE.md")))).toEqual(SILENT);
});

test("an Edit that did not grow an over-budget file passes silently", () => {
    const file = create("CLAUDE.md", rows(130));
    const edit = JSON.stringify({
        hook_event_name: "PostToolUse",
        tool_name: "Edit",
        tool_input: { file_path: file, old_string: "a longer line", new_string: "short" },
    });

    expect(runHook(edit)).toEqual(SILENT);
});

test("an Edit that grew an over-budget file still blocks", () => {
    const file = create("CLAUDE.md", rows(130));
    const edit = JSON.stringify({
        hook_event_name: "PostToolUse",
        tool_name: "Edit",
        tool_input: { file_path: file, old_string: "x", new_string: "a longer line" },
    });

    expect(blockReason(runHook(edit).stdout)).toContain("130/120 lines");
});

test("init-project drafts and sessions are left to the init proposal", () => {
    const draft = create(".ac/init/proposed/CLAUDE.md", rows(130));
    expect(runHook(payload(draft))).toEqual(SILENT);

    const file = create("CLAUDE.md", rows(130));
    const transcript = join(root, "session.jsonl");
    writeFileSync(transcript, '{"type":"user","message":{"content":"<command-name>/ac:init-project</command-name>"}}\n');
    const withInit = JSON.stringify({ ...JSON.parse(payload(file)), transcript_path: transcript });

    expect(runHook(withInit)).toEqual(SILENT);
});
