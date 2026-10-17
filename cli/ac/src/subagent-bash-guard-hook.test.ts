import { afterEach, beforeEach, expect, test } from "bun:test";
import { closeSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The hook is a shell script under the plugin, not TypeScript, but CI only runs `bun test` here,
// so this is where its contract is pinned: an ac subagent gets a deny that carries the working
// recipe for an unbounded search, and everything else (the main thread, another agent, a bounded
// search, a command it cannot judge) passes silently.
const HOOK = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
    "plugins",
    "ac",
    "hooks",
    "pretooluse-subagent-bash-guard.sh",
);

const SPARSE_BYTES = 115_343_360;

let root: string;
let home: string;
let project: string;
let big: string;
let small: string;

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ac-subagent-bash-guard-"));
    home = join(root, "home");
    project = join(root, "project");
    mkdirSync(home, { recursive: true });
    mkdirSync(project, { recursive: true });

    // A sparse 110 MB file costs no disk space; wc -c reads its size from the inode.
    big = join(root, "big.bin");
    const fd = openSync(big, "w");
    ftruncateSync(fd, SPARSE_BYTES);
    closeSync(fd);

    small = join(root, "small.bin");
    writeFileSync(small, Buffer.alloc(1024, 0x61));
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

interface HookResult {
    exitCode: number;
    stdout: string;
}

function runHook(stdin: string): HookResult {
    const result = Bun.spawnSync(["sh", HOOK], {
        stdin: Buffer.from(stdin),
        env: {
            ...process.env,
            HOME: home,
            TMPDIR: root,
        },
    });

    return {
        exitCode: result.exitCode,
        stdout: result.stdout.toString(),
    };
}

function payload(command: string, agentType?: string, cwd?: string): string {
    return JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command },
        cwd: cwd ?? project,
        agent_type: agentType,
        agent_id: agentType === undefined ? undefined : "a1124775fb6dfdb02",
    });
}

function denyReason(result: HookResult): string {
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout) as {
        hookSpecificOutput?: { hookEventName?: string; permissionDecision?: string; permissionDecisionReason?: string };
    };
    expect(output.hookSpecificOutput?.hookEventName).toBe("PreToolUse");
    expect(output.hookSpecificOutput?.permissionDecision).toBe("deny");

    return output.hookSpecificOutput?.permissionDecisionReason ?? "";
}

const silent = { exitCode: 0, stdout: "" };

test("find from the filesystem root is denied with the Glob recipe", () => {
    const reason = denyReason(runHook(payload("find / -name x.py 2>/dev/null | head", "ac:oracle")));

    expect(reason).toContain("Glob");
    expect(reason).toContain("path");
});

test("a root find with -path and -prune is denied", () => {
    const command = "find / -path /System -prune -o -name 'arrays.xml' -path '*ivicar*' -print";

    expect(denyReason(runHook(payload(command, "ac:explore")))).toContain("Glob");
});

test("find over the home directory is denied in every spelling", () => {
    for (const root_ of ["~", "$HOME", '"$HOME"', "${HOME}", "~/", home]) {
        const reason = denyReason(runHook(payload(`find ${root_} -name '*.xcframework'`, "ac:oracle")));

        expect(reason).toContain("Glob");
    }
});

test("a home search with rg, fd or recursive grep is denied", () => {
    for (const command of ["rg -n foo ~", "rg --files /", "fd . /", "fd -e rs foo ~", "grep -rn foo ~", "grep -R foo /"]) {
        denyReason(runHook(payload(command, "ac:plan-worker-junior-high")));
    }
});

test("a root search behind a wrapper, an assignment or a path prefix is denied", () => {
    for (const command of [
        "timeout 60 find / -name x",
        "LC_ALL=C /usr/bin/find / -name x",
        "echo start && find / -name x",
        "files=$(find / -name x | head)",
    ]) {
        denyReason(runHook(payload(command, "ac:oracle")));
    }
});

test("a relative operand resolves against the payload cwd", () => {
    denyReason(runHook(payload("find . -name x", "ac:oracle", home)));
    denyReason(runHook(payload("grep -r foo ..", "ac:oracle", join(home, "one"))));
    expect(runHook(payload("find . -name x", "ac:oracle", project))).toEqual(silent);
});

test("a relative operand is not judged once the command changes directory", () => {
    expect(runHook(payload(`cd ${project} && find . -name x`, "ac:oracle", home))).toEqual(silent);
});

test("a transcript grep names search-history for the denylist agents", () => {
    for (const agent of ["ac:oracle", "ac:librarian", "ac:plan-reviewer", "ac:plan-code-review", "oracle"]) {
        const reason = denyReason(runHook(payload("grep -rl 4f11fdad-acdc ~/.claude/projects", agent)));

        expect(reason).toContain("mcp__plugin_ac_ac__search-history");
    }
});

test("a transcript grep names Grep with path for the other agents", () => {
    for (const agent of ["ac:explore", "ac:plan-worker-junior", "qa-tester"]) {
        const reason = denyReason(runHook(payload("grep -rl 4f11fdad-acdc ~/.claude/projects", agent)));

        expect(reason).toContain("Grep");
        expect(reason).toContain("path");
        expect(reason).not.toContain("mcp__plugin_ac_ac__search-history");
    }
});

test("rg and cat over a single transcript are denied too", () => {
    const transcript = `${home}/.claude/projects/-Users-x-app/abc.jsonl`;

    denyReason(runHook(payload(`rg 4f11 ${transcript}`, "ac:explore")));
    denyReason(runHook(payload(`cat ${transcript} | head`, "ac:explore")));
    denyReason(runHook(payload("rg -l 4f11 $HOME/.claude/projects", "ac:oracle")));
});

test("strings on a file over 100 MiB is denied with the mmap recipe", () => {
    const reason = denyReason(runHook(payload(`strings ${big} | grep foo`, "ac:oracle")));

    expect(reason).toContain("python3 -I -c");
    expect(reason).toContain("mmap.find");
});

test("a text-mode grep or rg on a file over 100 MiB is denied with the mmap recipe", () => {
    for (const command of [
        `LC_ALL=C grep -a -o 'x' ${big}`,
        `grep -ao x ${big}`,
        `grep --binary-files=text x ${big}`,
        `grep -a -E '.{0,255}X.{0,255}' "${big}"`,
        `rg -a x ${big}`,
        `rg --text x ${big}`,
    ]) {
        expect(denyReason(runHook(payload(command, "ac:librarian")))).toContain("mmap.find");
    }
});

test("a large file named through an earlier assignment is resolved", () => {
    const reason = denyReason(runHook(payload(`B=${big}; LC_ALL=C grep -a -o 'x' $B`, "ac:oracle")));

    expect(reason).toContain("mmap.find");
    expect(denyReason(runHook(payload(`B=${big}; strings "$B" | grep -oE x`, "ac:oracle")))).toContain("mmap.find");
});

test("bounded and ordinary searches pass silently", () => {
    for (const command of [
        "find . -name x",
        "find /Users/x/proj/src -name y",
        `find ${project} -name y`,
        "find ~/Code -name y",
        "grep -r foo src/",
        "grep -n foo /etc/hosts",
        'rg -n "find / -name" docs',
        "rg -n 'grep -rl x ~/.claude/projects' docs",
        'echo "find / -name x"',
        "rg foo",
        "fd -e rs",
        `strings ${small}`,
        `grep -a x ${small}`,
        `grep x ${big}`,
        `strings ${join(root, "missing.bin")}`,
        "ls ~/.claude",
        "grep -rn foo ~/Code/app",
    ]) {
        expect({ command, result: runHook(payload(command, "ac:oracle")) }).toEqual({ command, result: silent });
    }
});

test("an unresolvable operand fails open", () => {
    for (const command of ["find $ROOT -name x", "find `pwd` -name x", `grep -a x $UNSET`, "find ~other -name x"]) {
        expect({ command, result: runHook(payload(command, "ac:oracle")) }).toEqual({ command, result: silent });
    }
});

test("the same denied commands pass from the main thread and from another agent", () => {
    for (const command of ["find / -name x", "grep -rl 4f11 ~/.claude/projects", `strings ${big}`]) {
        expect(runHook(payload(command))).toEqual(silent);
        expect(runHook(payload(command, "general-purpose"))).toEqual(silent);
        expect(runHook(payload(command, "my-plugin:explore"))).toEqual(silent);
    }
});

test("all eleven bare ac agent names are in scope", () => {
    for (const agent of [
        "explore",
        "librarian",
        "oracle",
        "plan-worker-quick",
        "plan-worker-junior",
        "plan-worker-junior-high",
        "plan-worker-senior",
        "plan-reviewer",
        "plan-code-review",
        "auto-verifier",
        "qa-tester",
    ]) {
        denyReason(runHook(payload("find / -name x", agent)));
    }
});

test("an unparseable payload or an absent command fails open", () => {
    expect(runHook("not json")).toEqual(silent);
    expect(runHook("")).toEqual(silent);
    expect(runHook(JSON.stringify({ agent_type: "ac:oracle", tool_input: {} }))).toEqual(silent);
});
