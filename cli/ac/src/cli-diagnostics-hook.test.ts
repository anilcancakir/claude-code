import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The hook is a shell script under the plugin, but CI only runs `bun test` here, and CI has neither
// dart nor php. Fake analyzers on the front of PATH stand in for them, so this pins the contract:
// silent for anything that is not a Dart or PHP file with a project around it, an additionalContext
// verdict per tool otherwise (clean, or the issue lines capped at 20), a readable timeout message,
// never `decision: block`, and always exit 0. It also pins what keeps the hook light when sessions run
// in parallel: main thread only, one dart or phpstan run at a time per machine, a back-off after a
// timeout, and no process left behind by a timeout or a normal exit. TMPDIR points into the fixture so
// the slot and back-off files never touch the machine's.
const HOOK = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
    "plugins",
    "ac",
    "hooks",
    "posttooluse-cli-diagnostics.sh",
);

const STALE = "LSP diagnostics on this file that disagree with this are stale.";
const SYNTAX_ONLY =
    "php -l checks syntax only; it cannot confirm or refute a type or symbol diagnostic, so read the code such a diagnostic names before you fix or dismiss it.";
const CURRENT = "These are current; fix them or say why not.";

let root: string;
let fakeBin: string;
let scratch: string;
let dartFile: string;
let phpFile: string;

// A canned analyzer: sleeps when FAKE_<NAME>_SLEEP is set (exec, so the alarm kills the sleep itself),
// otherwise prints FAKE_<NAME>_OUT and exits with FAKE_<NAME>_CODE.
function fakeTool(path: string, name: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
        path,
        [
            "#!/bin/sh",
            `[ -n "\${FAKE_${name}_SLEEP:-}" ] && exec sleep "$FAKE_${name}_SLEEP"`,
            `[ -n "\${FAKE_${name}_OUT:-}" ] && printf '%s\\n' "$FAKE_${name}_OUT"`,
            `exit "\${FAKE_${name}_CODE:-0}"`,
            "",
        ].join("\n"),
    );
    chmodSync(path, 0o755);
}

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ac-cli-diagnostics-"));
    fakeBin = join(root, "bin");
    fakeTool(join(fakeBin, "dart"), "DART");
    fakeTool(join(fakeBin, "php"), "PHP");
    scratch = join(root, "tmp");
    mkdirSync(scratch);

    mkdirSync(join(root, "app", "lib"), { recursive: true });
    dartFile = join(root, "app", "lib", "main.dart");
    writeFileSync(dartFile, "void main() {}\n");

    mkdirSync(join(root, "site", "src"), { recursive: true });
    phpFile = join(root, "site", "src", "Thing.php");
    writeFileSync(phpFile, "<?php\n");
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
            PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
            TMPDIR: scratch,
            AC_CLI_DIAGNOSTICS: "",
            AC_CLI_DIAGNOSTICS_TIMEOUT: "",
            AC_CLI_DIAGNOSTICS_WAIT: "",
            AC_CLI_DIAGNOSTICS_BACKOFF: "",
            AC_CLI_DIAGNOSTICS_SUBAGENTS: "",
            ...env,
        },
    });

    return {
        exitCode: result.exitCode,
        stdout: result.stdout.toString(),
    };
}

function payload(filePath: string, extra: Record<string, string> = {}): string {
    return JSON.stringify({
        hook_event_name: "PostToolUse",
        tool_name: "Edit",
        tool_input: {
            file_path: filePath,
        },
        ...extra,
    });
}

function context(result: HookResult): string {
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout) as {
        decision?: string;
        hookSpecificOutput?: { hookEventName?: string; additionalContext?: string };
    };
    expect(output.decision).toBeUndefined();
    expect(output.hookSpecificOutput?.hookEventName).toBe("PostToolUse");

    return output.hookSpecificOutput?.additionalContext ?? "";
}

function withDartProject(): void {
    writeFileSync(join(root, "app", "pubspec.yaml"), "name: app\n");
    mkdirSync(join(root, "app", ".dart_tool"));
    writeFileSync(join(root, "app", ".dart_tool", "package_config.json"), "{}\n");
}

// A fake dart that leaves a background sleeper in its process group, then either hangs or exits.
function dartWithSleeper(pidFile: string, then: "hang" | "exit"): void {
    const path = join(fakeBin, "dart");
    writeFileSync(
        path,
        ["#!/bin/sh", `sleep 60 &`, `echo $! > "${pidFile}"`, then === "hang" ? "exec sleep 60" : "exit 0", ""].join("\n"),
    );
    chmodSync(path, 0o755);
}

function alive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

// The sweep runs inside the hook, but the kernel reaps the victim a moment later.
function gone(pid: number): boolean {
    for (let i = 0; i < 20; i++) {
        if (!alive(pid)) return true;
        Bun.sleepSync(100);
    }
    return false;
}

function takeSlot(name: string, pid: number): string {
    const lock = join(scratch, `ac-cli-diagnostics-${name}.lock`);
    mkdirSync(lock);
    writeFileSync(join(lock, "pid"), String(pid));

    return lock;
}

function withComposer(): void {
    writeFileSync(join(root, "site", "composer.json"), "{}\n");
}

test("a file that is neither Dart nor PHP passes silently", () => {
    const other = join(root, "app", "notes.md");
    writeFileSync(other, "# notes\n");

    expect(runHook(payload(other))).toEqual({ exitCode: 0, stdout: "" });
});

test("AC_CLI_DIAGNOSTICS=0 turns the hook off", () => {
    withDartProject();

    expect(runHook(payload(dartFile), { AC_CLI_DIAGNOSTICS: "0" })).toEqual({ exitCode: 0, stdout: "" });
});

test("a Dart file with no pubspec.yaml above it passes silently", () => {
    expect(runHook(payload(dartFile))).toEqual({ exitCode: 0, stdout: "" });
});

test("a missing file passes silently", () => {
    withDartProject();

    expect(runHook(payload(join(root, "app", "lib", "gone.dart")))).toEqual({ exitCode: 0, stdout: "" });
});

test("a clean Dart run says so and calls stale LSP diagnostics stale", () => {
    withDartProject();

    const text = context(runHook(payload(dartFile), { FAKE_DART_OUT: "Analyzing main.dart...\nNo issues found!" }));

    expect(text).toStartWith(`CLI check for ${dartFile}:`);
    expect(text).toContain("dart analyze --fatal-infos: clean");
    expect(text).toEndWith(STALE);
});

test("a Dart run with issues lists them without the progress line and ends on the current sentence", () => {
    withDartProject();

    const text = context(
        runHook(payload(dartFile), {
            FAKE_DART_OUT: "Analyzing main.dart...\n\n  error - main.dart:1:1 - Undefined name 'x'\n  info - main.dart:2:1 - Unused",
            FAKE_DART_CODE: "3",
        }),
    );

    expect(text).toContain("dart analyze --fatal-infos: 2 issue lines");
    expect(text).toContain("Undefined name 'x'");
    expect(text).not.toContain("Analyzing");
    expect(text).toEndWith(CURRENT);
    expect(text).not.toContain(STALE);
});

test("output over 20 issue lines is truncated with a count of the rest", () => {
    withDartProject();
    const lines = Array.from({ length: 25 }, (_, i) => `  error - main.dart:${i + 1}:1 - problem ${i + 1}`);

    const text = context(runHook(payload(dartFile), { FAKE_DART_OUT: lines.join("\n"), FAKE_DART_CODE: "3" }));

    expect(text).toContain("dart analyze --fatal-infos: 25 issue lines");
    expect(text).toContain("problem 20");
    expect(text).not.toContain("problem 21");
    expect(text).toContain("... (5 more)");
});

test("a php -l syntax error is reported", () => {
    const text = context(
        runHook(payload(phpFile), {
            FAKE_PHP_OUT: "PHP Parse error: syntax error, unexpected end of file in Thing.php on line 3",
            FAKE_PHP_CODE: "255",
        }),
    );

    expect(text).toContain("php -l: 1 issue line");
    expect(text).toContain("syntax error, unexpected end of file");
    expect(text).toEndWith(CURRENT);
});

test("phpstan runs only when vendor/bin/phpstan sits next to composer.json", () => {
    withComposer();
    const env = { FAKE_PHPSTAN_OUT: "Thing.php:3:Call to undefined method", FAKE_PHPSTAN_CODE: "1" };

    const without = context(runHook(payload(phpFile), env));
    expect(without).toContain("php -l: clean");
    expect(without).not.toContain("phpstan");
    expect(without).toEndWith(SYNTAX_ONLY);

    fakeTool(join(root, "site", "vendor", "bin", "phpstan"), "PHPSTAN");

    const withStan = context(runHook(payload(phpFile), env));
    expect(withStan).toContain("php -l: clean");
    expect(withStan).toContain("vendor/bin/phpstan analyse: 1 issue line");
    expect(withStan).toContain("Call to undefined method");
    expect(withStan).toEndWith(CURRENT);
});

test("a clean phpstan run makes the verdict semantic and drops its configuration note", () => {
    withComposer();
    fakeTool(join(root, "site", "vendor", "bin", "phpstan"), "PHPSTAN");

    const text = context(
        runHook(payload(phpFile), {
            FAKE_PHPSTAN_OUT: "Note: Using configuration file /tmp/phpstan.neon.",
            FAKE_PHPSTAN_CODE: "0",
            AC_CLI_DIAGNOSTICS_TIMEOUT: "0",
        }),
    );
    expect(text).toContain("vendor/bin/phpstan analyse: clean");
    expect(text).not.toContain("Note: Using configuration file");
    expect(text).toEndWith(STALE);
});

test("a tool that outlives the timeout is reported as timed out", () => {
    withDartProject();

    const text = context(runHook(payload(dartFile), { FAKE_DART_SLEEP: "5", AC_CLI_DIAGNOSTICS_TIMEOUT: "1" }));

    expect(text).toContain(
        "dart analyze --fatal-infos: timed out after 1s; run it yourself before trusting or dismissing an LSP diagnostic on this file",
    );
    expect(text).not.toContain(STALE);
});

test("an unparseable payload fails open", () => {
    expect(runHook("not json")).toEqual({ exitCode: 0, stdout: "" });
    expect(runHook("")).toEqual({ exitCode: 0, stdout: "" });
});

test("a subagent payload passes silently unless AC_CLI_DIAGNOSTICS_SUBAGENTS=1", () => {
    withDartProject();
    const worker = payload(dartFile, { agent_id: "a1b2c3", agent_type: "ac:plan-worker-junior" });

    expect(runHook(worker)).toEqual({ exitCode: 0, stdout: "" });

    const text = context(runHook(worker, { AC_CLI_DIAGNOSTICS_SUBAGENTS: "1" }));
    expect(text).toContain("dart analyze --fatal-infos: clean");
});

test("a Dart file whose packages are not resolved passes silently", () => {
    withDartProject();
    rmSync(join(root, "app", ".dart_tool"), { recursive: true });

    expect(runHook(payload(dartFile))).toEqual({ exitCode: 0, stdout: "" });
});

test("a nested worktree does not borrow the main checkout's resolved packages", () => {
    const main = join(root, "main");
    mkdirSync(join(main, ".git"), { recursive: true });
    mkdirSync(join(main, ".dart_tool"));
    writeFileSync(join(main, ".dart_tool", "package_config.json"), "{}\n");
    writeFileSync(join(main, "pubspec.yaml"), "name: main\n");

    const tree = join(main, ".claude", "worktrees", "w");
    mkdirSync(join(tree, "lib"), { recursive: true });
    writeFileSync(join(tree, ".git"), "gitdir: ../../../.git/worktrees/w\n");
    writeFileSync(join(tree, "pubspec.yaml"), "name: w\n");
    const edited = join(tree, "lib", "a.dart");
    writeFileSync(edited, "void main() {}\n");

    expect(runHook(payload(edited), { FAKE_DART_OUT: "No issues found!" })).toEqual({ exitCode: 0, stdout: "" });

    mkdirSync(join(tree, ".dart_tool"));
    writeFileSync(join(tree, ".dart_tool", "package_config.json"), "{}\n");

    const text = context(runHook(payload(edited), { FAKE_DART_OUT: "No issues found!" }));
    expect(text).toContain("dart analyze --fatal-infos: clean");
});

test("a pub workspace member finds the config at the workspace root inside the same checkout", () => {
    const ws = join(root, "ws");
    mkdirSync(join(ws, ".git"), { recursive: true });
    mkdirSync(join(ws, ".dart_tool"));
    writeFileSync(join(ws, ".dart_tool", "package_config.json"), "{}\n");
    const member = join(ws, "packages", "m");
    mkdirSync(join(member, "lib"), { recursive: true });
    writeFileSync(join(member, "pubspec.yaml"), "name: m\nresolution: workspace\n");
    const edited = join(member, "lib", "m.dart");
    writeFileSync(edited, "void main() {}\n");

    const text = context(runHook(payload(edited), { FAKE_DART_OUT: "No issues found!" }));
    expect(text).toContain("dart analyze --fatal-infos: clean");
});

test("a package that is not a workspace member does not borrow its parent package's resolved config", () => {
    withDartProject();
    const example = join(root, "app", "example");
    mkdirSync(join(example, "lib"), { recursive: true });
    writeFileSync(join(example, "pubspec.yaml"), "name: example\n");
    const edited = join(example, "lib", "main.dart");
    writeFileSync(edited, "void main() {}\n");

    expect(runHook(payload(edited), { FAKE_DART_OUT: "No issues found!" })).toEqual({ exitCode: 0, stdout: "" });
});

test("the hook resolves its runner from a relative invocation path", () => {
    withDartProject();
    const result = Bun.spawnSync(["sh", "hooks/posttooluse-cli-diagnostics.sh"], {
        cwd: join(dirname(HOOK), ".."),
        stdin: Buffer.from(payload(dartFile)),
        env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}`, TMPDIR: scratch, FAKE_DART_OUT: "No issues found!" },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("dart analyze --fatal-infos: clean");
});

test("a zero-padded number in a knob does not abort the hook", () => {
    withDartProject();

    const text = context(
        runHook(payload(dartFile), {
            AC_CLI_DIAGNOSTICS_TIMEOUT: "09",
            AC_CLI_DIAGNOSTICS_WAIT: "00",
            AC_CLI_DIAGNOSTICS_BACKOFF: "010",
            FAKE_DART_OUT: "No issues found!",
        }),
    );

    expect(text).toContain("dart analyze --fatal-infos: clean");
});

test("a held slot makes the run skip with a note instead of waiting or claiming a verdict", () => {
    withDartProject();
    const lock = takeSlot("dart", process.pid);

    const text = context(runHook(payload(dartFile), { AC_CLI_DIAGNOSTICS_WAIT: "0", FAKE_DART_OUT: "No issues found!" }));

    expect(text).toContain("dart analyze --fatal-infos: skipped, another check holds the machine-wide slot");
    expect(text).not.toContain("clean");
    expect(text).not.toContain(STALE);
    expect(existsSync(lock)).toBe(true);
});

test("a slot whose owner is gone is taken over and given back", () => {
    withDartProject();
    const dead = Bun.spawnSync(["sh", "-c", "exit 0"]);
    const lock = takeSlot("dart", dead.pid ?? 999999);

    const text = context(runHook(payload(dartFile), { AC_CLI_DIAGNOSTICS_WAIT: "0", FAKE_DART_OUT: "No issues found!" }));

    expect(text).toContain("dart analyze --fatal-infos: clean");
    expect(existsSync(lock)).toBe(false);
});

test("the slot is given back after a run and after a timeout", () => {
    withDartProject();
    const lock = join(scratch, "ac-cli-diagnostics-dart.lock");

    runHook(payload(dartFile));
    expect(existsSync(lock)).toBe(false);

    runHook(payload(dartFile), { FAKE_DART_SLEEP: "5", AC_CLI_DIAGNOSTICS_TIMEOUT: "1" });
    expect(existsSync(lock)).toBe(false);
});

test("phpstan skips on a held slot but php -l still answers", () => {
    withComposer();
    fakeTool(join(root, "site", "vendor", "bin", "phpstan"), "PHPSTAN");
    takeSlot("phpstan", process.pid);

    const text = context(runHook(payload(phpFile), { AC_CLI_DIAGNOSTICS_WAIT: "0", FAKE_PHPSTAN_CODE: "1" }));

    expect(text).toContain("php -l: clean");
    expect(text).toContain("vendor/bin/phpstan analyse: skipped, another check holds the machine-wide slot");
    expect(text).not.toContain(STALE);
});

test("a timeout pauses the project, and the next edit passes silently until the pause is over", () => {
    withDartProject();

    const first = context(runHook(payload(dartFile), { FAKE_DART_SLEEP: "5", AC_CLI_DIAGNOSTICS_TIMEOUT: "1" }));
    expect(first).toContain("timed out after 1s");
    expect(first).toContain("Checks of this project are paused for 180s.");

    expect(runHook(payload(dartFile), { FAKE_DART_OUT: "No issues found!" })).toEqual({ exitCode: 0, stdout: "" });

    const afterPause = context(runHook(payload(dartFile), { AC_CLI_DIAGNOSTICS_BACKOFF: "0", FAKE_DART_OUT: "No issues found!" }));
    expect(afterPause).toContain("dart analyze --fatal-infos: clean");
});

test("a clean run lifts the pause", () => {
    withDartProject();

    runHook(payload(dartFile), { FAKE_DART_SLEEP: "5", AC_CLI_DIAGNOSTICS_TIMEOUT: "1" });
    expect(runHook(payload(dartFile), { FAKE_DART_OUT: "No issues found!" }).stdout).toBe("");

    // BACKOFF=0 ignores the pause for this run; the clean result it produces must retire the marker.
    const forced = context(runHook(payload(dartFile), { AC_CLI_DIAGNOSTICS_BACKOFF: "0", FAKE_DART_OUT: "No issues found!" }));
    expect(forced).toContain("dart analyze --fatal-infos: clean");

    const after = context(runHook(payload(dartFile), { FAKE_DART_OUT: "No issues found!" }));
    expect(after).toContain("dart analyze --fatal-infos: clean");
});

test("a timeout ends the tool's helper process too, and returns without waiting for it", () => {
    withDartProject();
    const pidFile = join(root, "helper.pid");
    dartWithSleeper(pidFile, "hang");

    const started = Date.now();
    const text = context(runHook(payload(dartFile), { AC_CLI_DIAGNOSTICS_TIMEOUT: "1" }));

    expect(text).toContain("timed out after 1s");
    expect(Date.now() - started).toBeLessThan(15000);
    expect(gone(Number(readFileSync(pidFile, "utf8")))).toBe(true);
});

test("a helper the tool left behind after a normal exit is ended too", () => {
    withDartProject();
    const pidFile = join(root, "helper.pid");
    dartWithSleeper(pidFile, "exit");

    const started = Date.now();
    const text = context(runHook(payload(dartFile)));

    // Without the sweep the helper holds the output pipe open and the hook waits out its 60 s sleep.
    expect(Date.now() - started).toBeLessThan(15000);
    expect(text).toContain("dart analyze --fatal-infos: clean");
    expect(gone(Number(readFileSync(pidFile, "utf8")))).toBe(true);
});
