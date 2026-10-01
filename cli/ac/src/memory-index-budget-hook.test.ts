import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The hook is a shell script under the plugin, not TypeScript, but CI only runs `bun test` here,
// so this is where its contract is pinned: silent under budget, `decision: block` over it, and
// silent on anything it cannot read.
const HOOK = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
    "plugins",
    "ac",
    "hooks",
    "posttooluse-memory-index-budget.sh",
);

let root: string;
let index: string;

beforeEach(() => {
    // The auto-memory layout: <config dir>/projects/<project>/memory/MEMORY.md.
    root = mkdtempSync(join(tmpdir(), "ac-memory-budget-"));
    mkdirSync(join(root, "projects", "-Users-me-app", "memory"), { recursive: true });
    index = join(root, "projects", "-Users-me-app", "memory", "MEMORY.md");
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
            AC_MEMORY_INDEX_MAX_LINES: "",
            AC_MEMORY_INDEX_MAX_BYTES: "",
            AC_MEMORY_INDEX_MAX_LINE_BYTES: "",
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

function pointers(count: number): string {
    return Array.from({ length: count }, (_, i) => `- [Topic ${i}](topic_${i}.md) - hook ${i}`).join("\n") + "\n";
}

function blockReason(stdout: string): string {
    const output = JSON.parse(stdout) as { decision?: string; reason?: string };
    expect(output.decision).toBe("block");

    return output.reason ?? "";
}

test("an index under budget passes silently", () => {
    writeFileSync(index, pointers(10));

    expect(runHook(payload(index))).toEqual({ exitCode: 0, stdout: "" });
});

test("a write to any other file passes silently, even when it is huge", () => {
    const other = join(dirname(index), "topic.md");
    writeFileSync(other, pointers(500));

    expect(runHook(payload(other))).toEqual({ exitCode: 0, stdout: "" });
});

test("a MEMORY.md outside the auto-memory layout passes silently", () => {
    // A repository's own memory/MEMORY.md is not the index Claude Code loads.
    mkdirSync(join(root, "repo", "memory"), { recursive: true });
    const repoFile = join(root, "repo", "memory", "MEMORY.md");
    writeFileSync(repoFile, pointers(500));

    expect(runHook(payload(repoFile))).toEqual({ exitCode: 0, stdout: "" });
});

test("a last line without a trailing newline still counts", () => {
    writeFileSync(index, pointers(81).trimEnd());

    expect(blockReason(runHook(payload(index)).stdout)).toContain("81/80 lines");
});

test("an index over the line budget blocks with the counts and the path", () => {
    writeFileSync(index, pointers(81));

    const result = runHook(payload(index));
    const reason = blockReason(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(reason).toContain("81/80 lines");
    expect(reason).toContain(index);
    expect(reason).toContain("_index-<theme>.md");
});

test("an index over the byte budget blocks", () => {
    // 78 lines of 135 bytes: under the line budget and every line under 150, 10,530 bytes in all.
    writeFileSync(index, `${"- [x](x.md) - " + "y".repeat(120)}\n`.repeat(78));

    expect(blockReason(runHook(payload(index)).stdout)).toContain("78/80 lines, 10530/10240 bytes");
});

test("line length is measured in bytes, so Turkish letters count twice", () => {
    // 80 two-byte letters are 80 characters but 160 bytes.
    writeFileSync(index, `- [a](a.md) - ok\n- [b](b.md) - ${"ş".repeat(80)}\n`);

    expect(blockReason(runHook(payload(index)).stdout)).toContain("lines over 150 bytes: 2");
});

test("an env override tightens a limit", () => {
    writeFileSync(index, pointers(10));

    const reason = blockReason(runHook(payload(index), { AC_MEMORY_INDEX_MAX_LINES: "5" }).stdout);

    expect(reason).toContain("10/5 lines");
});

test("an env override of 0 turns that check off", () => {
    writeFileSync(index, pointers(120));

    expect(runHook(payload(index), { AC_MEMORY_INDEX_MAX_LINES: "0" })).toEqual({ exitCode: 0, stdout: "" });
});

test("a non-numeric override falls back to the default", () => {
    writeFileSync(index, pointers(81));

    expect(blockReason(runHook(payload(index), { AC_MEMORY_INDEX_MAX_LINES: "lots" }).stdout)).toContain("81/80 lines");
});

test("an unparseable payload fails open", () => {
    expect(runHook("not json")).toEqual({ exitCode: 0, stdout: "" });
    expect(runHook("")).toEqual({ exitCode: 0, stdout: "" });
});

test("a missing index fails open", () => {
    expect(runHook(payload(index))).toEqual({ exitCode: 0, stdout: "" });
});
