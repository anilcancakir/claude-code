import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The hook is a shell script under the plugin, not TypeScript, but CI only runs `bun test` here,
// so this is where its contract is pinned: a read-only search passes silently, a write, an install
// or a secret read is denied, and a quoted `>` or `|` inside a search pattern counts as neither.
const HOOK_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "plugins", "ac", "hooks");
const HOOK = join(HOOK_DIR, "pretooluse-explore-budget.sh");

let scratch: string;

beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "ac-explore-budget-"));
});

afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
});

interface HookResult {
    exitCode: number;
    stdout: string;
}

function runHook(
    toolName: string,
    toolInput: Record<string, string>,
    options: { agentType?: string; env?: Record<string, string>; hook?: string } = {},
): HookResult {
    const { agentType = "ac:explore", env = {}, hook = HOOK } = options;
    const payload = {
        hook_event_name: "PreToolUse",
        ...(agentType === "" ? {} : { agent_type: agentType, agent_id: "a1124775fb6dfdb02" }),
        tool_name: toolName,
        tool_input: toolInput,
    };
    const result = Bun.spawnSync(["sh", hook], {
        stdin: Buffer.from(JSON.stringify(payload)),
        env: {
            ...process.env,
            TMPDIR: scratch,
            AC_EXPLORE_MAX_CALLS: "",
            ...env,
        },
    });

    return {
        exitCode: result.exitCode,
        stdout: result.stdout.toString(),
    };
}

function bash(command: string): HookResult {
    return runHook("Bash", { command });
}

function expectDenied(result: HookResult): void {
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout) as {
        hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
    };
    expect(output.hookSpecificOutput.permissionDecision).toBe("deny");
}

const SILENT: HookResult = { exitCode: 0, stdout: "" };

const denied = [
    "echo x > src/a.ts",
    "cat a >> notes.md",
    'echo "a > b" > src/out.txt',
    `echo "it's" > out.txt`,
    'cat a > "src/a b.txt"',
    "echo x > /tmpfoo/a",
    "echo x > /tmp/../etc/passwd",
    'echo x > "$HOME/a.log"',
    "git tag v1.2",
    "git tag -d v1",
    "git tag -a v1 -m x",
    "git tag -s v1",
    "git tag -f v1",
    "git tag --delete v1",
    "git tag --sort=-creatordate -a v1",
    "sed -i '' s/a/b/ f",
    "pint",
    "prettier --write x.js",
    "npm install",
    "tee out.txt",
    "cat .env",
    "git log | tee out.txt",
    'echo "$(git log -1 > src/x.ts)"',
    'echo "`date > src/y.ts`"',
    'sh -c "echo x > src/a.ts"',
    "bash -c 'echo; rm -rf src'",
    'perl -e "open F, q(>x)"',
    "eval 'echo x > src/a.ts'",
    'echo "$(bash -c \'echo x > src/a.ts\')"',
    "ls 2>err.txt",
    "ls 2>>err.txt",
    "cmd &>out.txt",
    "cmd &>>out.txt",
    "cmd 1>out.txt",
    "echo x > /var/folders/zz/other/T/a.log",
];

const allowed = [
    'rg -n "MonitorStatus::(Down)|=> MonitorStatus" app/X.php | head -40; sed -n 415,450p app/Y.php',
    'grep -n "toMail\\|->view(\\|black\\|pint" src/a.php',
    "awk 'NR>=150 && NR<=200' f.dart",
    "git -C /x tag --list | tail -20",
    "git tag -l",
    "git tag",
    "git tag -n",
    "git tag -n5 -l 'v1*'",
    "git tag --contains HEAD",
    "git tag --points-at HEAD",
    "git tag --merged",
    "git tag --no-merged main",
    "git tag --sort=-creatordate",
    "git log --oneline > /tmp/log.txt",
    "git log --oneline > /private/tmp/log.txt",
    'flutter analyze > "$TMPDIR/a.log" 2>&1',
    "flutter analyze > ${TMPDIR}/a.log 2>&1",
    'flutter analyze > "${TMPDIR:-/tmp}/a.log" 2>&1',
    "cmd 2>&1 | tail -3",
    "ls &>/dev/null",
    "ls 2>/dev/null",
    "echo x >&2",
    "sed -n '/ -i /p' f.txt",
    'rg -n "\\$(foo)" src',
    'echo "$(git rev-parse HEAD)"',
    'echo "$(git log 2>/dev/null)"',
    "cmd &>/dev/null",
    "cmd 2>>/dev/null",
    'cmd > "$TMPDIR/a.log" 2>&1',
    "bash -n script.sh",
    "perl -ne 'print if /a/' f.txt",
    "python3 -c 'print(1)'",
];

describe("Bash denials", () => {
    test.each(denied)("denies %s", (command) => {
        expectDenied(bash(command));
    });
});

describe("Bash read-only searches", () => {
    test.each(allowed)("allows %s", (command) => {
        expect(bash(command)).toEqual(SILENT);
    });
});

describe("a redirect to the expanded temp directory", () => {
    test.each([
        ["without a trailing slash", (dir: string) => `git log > ${dir}/a.log`],
        ["after the /private prefix", (dir: string) => `git log > /private${dir}/a.log`],
        ["when the target is quoted", (dir: string) => `git log > "${dir}/a.log" 2>&1`],
    ])("is allowed %s", (_name, build) => {
        expect(bash(build(scratch.replace(/^\/private/, "")))).toEqual(SILENT);
    });

    test("is allowed when TMPDIR carries a trailing slash", () => {
        const env = { TMPDIR: `${scratch}/` };

        expect(runHook("Bash", { command: `git log > ${scratch}/a.log` }, { env })).toEqual(SILENT);
    });

    test("is denied when it climbs out with ..", () => {
        expectDenied(bash(`git log > ${scratch}/../a.log`));
    });

    // The temp dir lives outside /tmp here on purpose: on Linux tmpdir() is /tmp, where every path is
    // already allowed by the /tmp rule, so the prefix test would prove nothing and pass for the wrong reason.
    test("is denied for a sibling directory sharing the prefix", () => {
        const outside = mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), ".explore-tmp-"));
        try {
            const env = { TMPDIR: outside };

            expect(runHook("Bash", { command: `git log > ${outside}/a.log` }, { env })).toEqual(SILENT);
            expectDenied(runHook("Bash", { command: `git log > ${outside}x/a.log` }, { env }));
        } finally {
            rmSync(outside, { recursive: true, force: true });
        }
    });
});

test("a Read of a secret-shaped file is denied", () => {
    expectDenied(runHook("Read", { file_path: "/app/.env" }));
});

test("a Read of a template stays allowed", () => {
    expect(runHook("Read", { file_path: "/app/.env.example" })).toEqual(SILENT);
});

test("a main-thread call is silent whatever it runs", () => {
    expect(runHook("Bash", { command: "echo x > src/a.ts" }, { agentType: "" })).toEqual(SILENT);
});

test("another agent is out of scope", () => {
    expect(runHook("Bash", { command: "echo x > src/a.ts" }, { agentType: "ac:librarian" })).toEqual(SILENT);
});

test("the call after the budget is denied", () => {
    const env = { AC_EXPLORE_MAX_CALLS: "2" };
    const grep = { pattern: "x", path: "src" };

    expect(runHook("Grep", grep, { env })).toEqual(SILENT);
    expect(runHook("Grep", grep, { env })).toEqual(SILENT);
    expectDenied(runHook("Grep", grep, { env }));
});

test("without the quote blanker the write checks fail open and the secret scan still denies", () => {
    const hooks = join(scratch, "hooks");
    mkdirSync(hooks);
    const copy = join(hooks, "pretooluse-explore-budget.sh");
    copyFileSync(HOOK, copy);

    expect(runHook("Bash", { command: "echo x > src/a.ts" }, { hook: copy })).toEqual(SILENT);
    expectDenied(runHook("Bash", { command: "cat .env" }, { hook: copy }));
});
