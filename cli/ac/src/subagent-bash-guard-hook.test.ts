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

test("rg over the projects directory or one project directory is denied", () => {
    denyReason(runHook(payload("rg -l 4f11 $HOME/.claude/projects", "ac:oracle")));
    denyReason(runHook(payload("rg x ~/.claude/projects/p", "ac:explore")));
    denyReason(runHook(payload("grep -R x ~/.claude/projects/-Users-x-app", "ac:explore")));
});

test("cat of the projects directory itself is denied", () => {
    mkdirSync(join(home, ".claude", "projects", "p"), { recursive: true });

    denyReason(runHook(payload("cat ~/.claude/projects", "ac:explore")));
    denyReason(runHook(payload("cat ~/.claude/projects/p", "ac:explore")));
});

test("a regular file under the projects directory is readable", () => {
    const project_ = join(home, ".claude", "projects", "p");
    mkdirSync(join(project_, "memory"), { recursive: true });
    writeFileSync(join(project_, "memory", "MEMORY.md"), "- note\n");
    writeFileSync(join(project_, "s.jsonl"), "{}\n");

    for (const command of [
        "cat ~/.claude/projects/p/memory/MEMORY.md",
        "rg -n foo ~/.claude/projects/p/s.jsonl",
        "grep -n foo $HOME/.claude/projects/p/s.jsonl",
        `cat ${project_}/s.jsonl | head`,
        "grep -rn foo ~/.claude/projects/p/memory",
    ]) {
        expect({ command, result: runHook(payload(command, "ac:explore")) }).toEqual({ command, result: silent });
    }
});

test("a find or search shallower than three levels from the home directory is allowed", () => {
    for (const command of [
        "find ~ -maxdepth 1 -name .zshrc",
        "find ~ -maxdepth 2 -name x",
        "find / -maxdepth 1 -name x",
        "rg --max-depth 1 x ~",
        "rg -d 2 x ~",
        "fd --max-depth=1 foo ~",
        "fd -d 1 foo /",
    ]) {
        expect({ command, result: runHook(payload(command, "ac:explore")) }).toEqual({ command, result: silent });
    }
});

test("a find or search of depth three or more from the home directory is still denied", () => {
    for (const command of ["find ~ -maxdepth 3 -name x", "rg --max-depth 3 x ~", "fd -d 4 foo ~", "find ~ -mindepth 1 -name x"]) {
        denyReason(runHook(payload(command, "ac:explore")));
    }
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

test("a recursive grep from a repository root is denied with the rg recipe", () => {
    mkdirSync(join(project, ".git"));
    mkdirSync(join(project, "src"));

    for (const command of ['grep -ril "rockalpha" . 2>/dev/null | head -20', `grep -rn foo ${project}`, "grep -R foo"]) {
        const reason = denyReason(runHook(payload(command, "ac:plan-worker-junior-high")));
        expect(reason).toContain("rg");
        expect(reason).toContain(".gitignore");
    }
});

test("a recursive grep below the root, rg from the root, or a repo-less tree pass", () => {
    mkdirSync(join(project, ".git"));
    mkdirSync(join(project, "src"));

    for (const command of [
        "grep -rn foo src",
        "rg -n foo .",
        "grep -n foo README.md",
        "cd src && grep -r foo .",
        "grep -rn foo src/*.ts",
        'grep -rn foo "$DIR"',
        "grep -rn foo $(git ls-files)",
    ]) {
        expect(runHook(payload(command, "ac:plan-worker-junior-high"))).toEqual(silent);
    }
    expect(runHook(payload("grep -r foo .", "ac:explore", root))).toEqual(silent);
    expect(runHook(payload("grep -r foo .", undefined))).toEqual(silent);
});

test("an unparseable payload or an absent command fails open", () => {
    expect(runHook("not json")).toEqual(silent);
    expect(runHook("")).toEqual(silent);
    expect(runHook(JSON.stringify({ agent_type: "ac:oracle", tool_input: {} }))).toEqual(silent);
});
