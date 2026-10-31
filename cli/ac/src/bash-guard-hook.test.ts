import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The Bash guard of an ac:auto away run: an outward verb runs only when the marker's allowed_outward
// names it, an irreversible local verb never runs, and a session that owns no away marker is untouched.
const HOOK = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
    "plugins",
    "ac",
    "hooks",
    "pretooluse-bash-guard.sh",
);

const SESSION = "sess-bg-1";

let root: string;
let project: string;

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ac-bash-guard-"));
    project = join(root, "project");
    mkdirSync(project, { recursive: true });
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

interface HookResult {
    exitCode: number;
    stdout: string;
}

function runHook(command: string, session: string = SESSION): HookResult {
    return runTool("Bash", { command }, session);
}

function runTool(toolName: string, toolInput: Record<string, unknown>, session: string = SESSION): HookResult {
    const stdin = JSON.stringify({
        session_id: session,
        cwd: project,
        hook_event_name: "PreToolUse",
        tool_name: toolName,
        tool_input: toolInput,
    });
    const result = Bun.spawnSync(["sh", HOOK], {
        stdin: Buffer.from(stdin),
        env: {
            ...process.env,
            CLAUDE_PROJECT_DIR: "",
        },
    });

    return {
        exitCode: result.exitCode,
        stdout: result.stdout.toString(),
    };
}

function isoAgo(hours: number): string {
    return new Date(Date.now() - hours * 3600 * 1000).toISOString().replace(/\.\d+Z$/, "Z");
}

function seedAwayRun(
    allowedOutward: string[],
    session: string = SESSION,
    overrides: { startedAt?: string; source?: string } = {},
): void {
    mkdirSync(join(project, ".ac", "state"), { recursive: true });
    writeFileSync(
        join(project, ".ac", "state", "active-auto.json"),
        JSON.stringify({
            slug: "demo",
            session_id: session,
            started_at: overrides.startedAt ?? isoAgo(0),
            phase: "executing",
            source: overrides.source ?? "coordinate",
            source_ref: "demo",
            allowed_outward: allowedOutward,
            decisions: ".ac/away/demo/decisions.md",
        }),
    );
}

function denyReason(result: HookResult): string {
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout) as {
        hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
    };
    expect(output.hookSpecificOutput?.permissionDecision).toBe("deny");

    return output.hookSpecificOutput?.permissionDecisionReason ?? "";
}

function expectAllow(result: HookResult): void {
    expect(result).toEqual({
        exitCode: 0,
        stdout: "",
    });
}

const ALWAYS_DENIED = [
    "git push --force origin main",
    "git push -f",
    "git push --force-with-lease",
    "git push --force-with-lease=main origin main",
    "git push origin +main",
    "git reset --hard HEAD~1",
    "git clean -fd",
    "git checkout -- .",
    "git checkout .",
    "git restore .",
    "rm -rf build",
    "rm -fr build",
    "rm -r -f build",
    "sed -i s/a/b/ file.txt",
    "perl -pi -e s/a/b/ file.txt",
    'git push origin "+feat"',
    "git push -fu origin main",
    "git push --mirror",
    "git push --delete origin feat",
    "git push -d origin feat",
    "git push origin :feat",
    "git -C ../wt push --force",
    "git push origin main \\\n--force",
    "/bin/rm -rf build",
    "FOO=1 timeout 30 git reset --hard",
];

test("without a marker every command passes, destructive ones included", () => {
    for (const command of ["git push", "gh pr merge 3", ...ALWAYS_DENIED]) {
        expectAllow(runHook(command));
    }
});

test("a marker owned by another session leaves this session untouched", () => {
    seedAwayRun([], "sess-other");

    for (const command of ["git push", "gh release create v1", ...ALWAYS_DENIED]) {
        expectAllow(runHook(command));
    }
});

test("git push is allowed when allowed_outward lists push and denied when it does not", () => {
    seedAwayRun(["push"]);
    expectAllow(runHook("git push -u origin coord/demo"));

    seedAwayRun(["deploy"]);
    const reason = denyReason(runHook("git push -u origin coord/demo"));
    expect(reason).toContain("'git push'");
    expect(reason).toContain("does not name 'push'");
    expect(reason).toContain("## Blocked in .ac/away/demo/decisions.md");
});

test("each outward verb maps to its own allowed_outward value", () => {
    const cases: [string, string][] = [
        ["gh pr merge 12 --squash", "merge"],
        ["gh pr create --head coord/demo --title x", "pr"],
        ["gh release create v1.2.0", "release"],
    ];

    for (const [command, value] of cases) {
        seedAwayRun([value]);
        expectAllow(runHook(command));

        seedAwayRun(["push"]);
        expect(denyReason(runHook(command))).toContain(`does not name '${value}'`);
    }
});

test("a force push and the other irreversible verbs are denied even with every outward value allowed", () => {
    seedAwayRun(["push", "merge", "pr", "release", "deploy"]);

    for (const command of ALWAYS_DENIED) {
        expect(denyReason(runHook(command))).toContain("stays denied under any away run");
    }
});

test("a force push chained after an allowed push is still denied", () => {
    seedAwayRun(["push"]);

    expect(denyReason(runHook("git push && git push --force"))).toContain("'git push --force'");
});

test("a force flag in another segment does not turn an allowed push into a force push", () => {
    seedAwayRun(["push"]);

    expectAllow(runHook("rm -f notes.tmp; git push origin main"));
});

test("read-only git, look-alike tokens and a verb outside the command position pass under a live marker", () => {
    seedAwayRun([]);

    for (const command of [
        "git status",
        "git log --oneline -5",
        "echo git push",
        'git commit -m "docs: never git push here"',
        "gh release list",
        "gh release view v1",
        "git clean -n",
        "git clean -nd",
        "git clean --dry-run",
        "xrm -rf",
        "git pushx",
        "rm -f notes.tmp",
    ]) {
        expectAllow(runHook(command));
    }
});

test("git global options and a line continuation do not hide a push", () => {
    seedAwayRun([]);

    expect(denyReason(runHook("git -C ../wt push origin main"))).toContain("does not name 'push'");
    expect(denyReason(runHook("git -c core.x=1 --git-dir=.git push"))).toContain("does not name 'push'");
    expect(denyReason(runHook("git push origin \\\nmain"))).toContain("does not name 'push'");
});

test("merge allows the push and the PR it needs", () => {
    seedAwayRun(["merge"]);

    for (const command of ["git push -u origin feat", "gh pr create --fill", "gh pr merge --squash"]) {
        expectAllow(runHook(command));
    }
    expect(denyReason(runHook("gh release create v1"))).toContain("does not name 'release'");
});

test("pr allows the push its branch needs but not a merge", () => {
    seedAwayRun(["pr"]);

    expectAllow(runHook("git push -u origin feat"));
    expectAllow(runHook("gh pr create --fill"));
    expect(denyReason(runHook("gh pr merge 3"))).toContain("does not name 'merge'");
});

test("a command-position wrapper does not hide an outward verb", () => {
    seedAwayRun([]);

    for (const command of ["env GH_TOKEN=x gh pr merge 3", "timeout 60 git push", "command git push", "if git push; then :; fi"]) {
        expect(denyReason(runHook(command))).toContain("allowed_outward");
    }
});

test("AskUserQuestion is denied under a live owned marker with the Recommended-and-log instruction", () => {
    seedAwayRun([]);

    const reason = denyReason(runTool("AskUserQuestion", { questions: [] }));

    expect(reason).toContain("Recommended");
    expect(reason).toContain("## Decisions in .ac/away/demo/decisions.md");
});

test("AskUserQuestion passes without a marker, under another session's marker, and under a stale one", () => {
    expectAllow(runTool("AskUserQuestion", { questions: [] }));

    seedAwayRun([], "sess-other");
    expectAllow(runTool("AskUserQuestion", { questions: [] }));

    seedAwayRun([], SESSION, { source: "execute", startedAt: isoAgo(25) });
    expectAllow(runTool("AskUserQuestion", { questions: [] }));
});

test("over a coordinator run the AskUserQuestion deny lasts 72 hours", () => {
    seedAwayRun([], SESSION, { source: "coordinate", startedAt: isoAgo(48) });
    denyReason(runTool("AskUserQuestion", { questions: [] }));

    seedAwayRun([], SESSION, { source: "coordinate", startedAt: isoAgo(73) });
    expectAllow(runTool("AskUserQuestion", { questions: [] }));
});

test("another tool passes untouched under a live marker", () => {
    seedAwayRun([]);

    expectAllow(runTool("Read", { file_path: "/etc/hosts" }));
});
