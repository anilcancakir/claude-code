import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The hook is a shell script under the plugin, but CI only runs `bun test` here, and CI has neither
// dart nor php. Fake analyzers on the front of PATH stand in for them, so this pins the contract of both
// modes. Sync mode (no argument) handles PHP only: `php -l` as additionalContext on stdout, exit 0, and
// never phpstan. Async mode (`--async`, registered with asyncRewake) handles Dart only: it stays silent
// and exits 0 unless dart analyze finds issues or the first clean run follows a report with issues, and
// then it writes the report to stderr, leaves stdout empty and exits 2 so the host wakes the model. It
// also pins what keeps the Dart run light when sessions work in parallel: main thread only, one dart run
// at a time per machine, a back-off after a timeout, and no process left behind by a timeout or a normal
// exit. TMPDIR points into the fixture so the slot and back-off files never touch the machine's.
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
const SYNTAX_ONLY = "php -l: clean (syntax only)";
const CURRENT = "These are current; fix them or say why not.";
const DART_ISSUES = { FAKE_DART_OUT: "  error - main.dart:1:1 - Undefined name 'x'", FAKE_DART_CODE: "3" };
const DART_CLEAN = { FAKE_DART_OUT: "No issues found!" };

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

interface AsyncResult extends HookResult {
    stderr: string;
}

function spawnHook(stdin: string, env: Record<string, string>, args: string[]): AsyncResult {
    const result = Bun.spawnSync(["sh", HOOK, ...args], {
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
        stderr: result.stderr.toString(),
    };
}

// Sync mode: the registration without an argument.
function runHook(stdin: string, env: Record<string, string> = {}): HookResult {
    const { exitCode, stdout } = spawnHook(stdin, env, []);

    return { exitCode, stdout };
}

// Async mode: the asyncRewake registration.
function runAsync(stdin: string, env: Record<string, string> = {}): AsyncResult {
    return spawnHook(stdin, env, ["--async"]);
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

// An async run that woke the model: exit 2, the report on stderr, nothing on stdout.
function wake(result: AsyncResult): string {
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");

    return result.stderr.trimEnd();
}

const SILENT: AsyncResult = { exitCode: 0, stdout: "", stderr: "" };

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

// A phpstan that records every call; sync mode must never make one.
function withPhpstanSpy(): string {
    writeFileSync(join(root, "site", "composer.json"), "{}\n");
    const ran = join(root, "phpstan-ran");
    const path = join(root, "site", "vendor", "bin", "phpstan");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, ["#!/bin/sh", `echo called >> "${ran}"`, "echo 'Thing.php:3:Call to undefined method'", "exit 1", ""].join("\n"));
    chmodSync(path, 0o755);

    return ran;
}

// ---- sync mode: PHP only, php -l only ----

test("a file that is neither Dart nor PHP passes silently", () => {
    const other = join(root, "app", "notes.md");
    writeFileSync(other, "# notes\n");

    expect(runHook(payload(other))).toEqual({ exitCode: 0, stdout: "" });
    expect(runAsync(payload(other))).toEqual(SILENT);
});

test("AC_CLI_DIAGNOSTICS=0 turns the hook off in both modes", () => {
    withDartProject();

    expect(runHook(payload(phpFile), { AC_CLI_DIAGNOSTICS: "0", FAKE_PHP_CODE: "255", FAKE_PHP_OUT: "boom" })).toEqual({
        exitCode: 0,
        stdout: "",
    });
    expect(runAsync(payload(dartFile), { AC_CLI_DIAGNOSTICS: "0", ...DART_ISSUES })).toEqual(SILENT);
});

test("a missing file passes silently", () => {
    withDartProject();

    expect(runHook(payload(join(root, "site", "src", "Gone.php")))).toEqual({ exitCode: 0, stdout: "" });
    expect(runAsync(payload(join(root, "app", "lib", "gone.dart")), DART_ISSUES)).toEqual(SILENT);
});

test("sync mode on a Dart file prints nothing and never runs dart", () => {
    withDartProject();

    expect(runHook(payload(dartFile, { session_id: "s1" }), DART_ISSUES)).toEqual({ exitCode: 0, stdout: "" });
    expect(existsSync(join(scratch, "ac-cli-diagnostics-dart.lock"))).toBe(false);
});

test("sync mode on PHP runs php -l only, even where vendor/bin/phpstan sits next to composer.json", () => {
    const ran = withPhpstanSpy();

    const text = context(runHook(payload(phpFile, { session_id: "s1" })));

    expect(text).toBe(`CLI check for ${phpFile}: ${SYNTAX_ONLY}`);
    expect(text).not.toContain("phpstan");
    expect(existsSync(ran)).toBe(false);
});

test("a php -l syntax error is reported synchronously and phpstan stays unused", () => {
    const ran = withPhpstanSpy();

    const text = context(
        runHook(payload(phpFile), {
            FAKE_PHP_OUT: "PHP Parse error: syntax error, unexpected end of file in Thing.php on line 3",
            FAKE_PHP_CODE: "255",
        }),
    );

    expect(text).toStartWith(`CLI check for ${phpFile}:`);
    expect(text).toContain("php -l: 1 issue line");
    expect(text).toContain("syntax error, unexpected end of file");
    expect(text).toEndWith(CURRENT);
    expect(existsSync(ran)).toBe(false);
});

test("a php -l only fix does not call LSP diagnostics stale, since php -l cannot judge types", () => {
    const edit = payload(phpFile, { session_id: "s1" });

    runHook(edit, { FAKE_PHP_OUT: "PHP Parse error: syntax error in Thing.php on line 3", FAKE_PHP_CODE: "255" });
    const text = context(runHook(edit));

    expect(text).toBe(`CLI check for ${phpFile}: ${SYNTAX_ONLY}`);
});

test("a php -l that outlives the timeout is reported as timed out", () => {
    const text = context(runHook(payload(phpFile), { FAKE_PHP_SLEEP: "5", AC_CLI_DIAGNOSTICS_TIMEOUT: "1" }));

    expect(text).toContain(
        "php -l: timed out after 1s; run it yourself before trusting or dismissing an LSP diagnostic on this file",
    );
});

test("sync mode: an unparseable payload fails open", () => {
    expect(runHook("not json")).toEqual({ exitCode: 0, stdout: "" });
    expect(runHook("")).toEqual({ exitCode: 0, stdout: "" });
});

test("sync mode: a subagent payload passes silently unless AC_CLI_DIAGNOSTICS_SUBAGENTS=1", () => {
    const worker = payload(phpFile, { agent_id: "a1b2c3", agent_type: "ac:plan-worker-junior" });

    expect(runHook(worker)).toEqual({ exitCode: 0, stdout: "" });

    const text = context(runHook(worker, { AC_CLI_DIAGNOSTICS_SUBAGENTS: "1" }));
    expect(text).toContain("php -l: clean");
});

test("a zero-padded number in a knob does not abort the sync hook", () => {
    const text = context(
        runHook(payload(phpFile), {
            AC_CLI_DIAGNOSTICS_TIMEOUT: "09",
            AC_CLI_DIAGNOSTICS_WAIT: "00",
            AC_CLI_DIAGNOSTICS_BACKOFF: "010",
        }),
    );

    expect(text).toContain("php -l: clean");
});

test("the hook resolves its runner from a relative invocation path", () => {
    const result = Bun.spawnSync(["sh", "hooks/posttooluse-cli-diagnostics.sh"], {
        cwd: join(dirname(HOOK), ".."),
        stdin: Buffer.from(payload(phpFile)),
        env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}`, TMPDIR: scratch },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("php -l: clean");
});

// ---- async mode: Dart only, wakes the model through exit 2 ----

test("async mode on PHP exits silently, syntax error or not", () => {
    expect(runAsync(payload(phpFile, { session_id: "s1" }), { FAKE_PHP_OUT: "boom", FAKE_PHP_CODE: "255" })).toEqual(
        SILENT,
    );
});

test("async mode with Dart issues writes the report to stderr, nothing to stdout, and exits 2", () => {
    withDartProject();

    const text = wake(
        runAsync(payload(dartFile, { session_id: "s1" }), {
            FAKE_DART_OUT: "Analyzing main.dart...\n\n  error - main.dart:1:1 - Undefined name 'x'\n  info - main.dart:2:1 - Unused",
            FAKE_DART_CODE: "3",
        }),
    );

    expect(text).toStartWith(`CLI check for ${dartFile}:`);
    expect(text).toContain("dart analyze --fatal-infos: 2 issue lines");
    expect(text).toContain("Undefined name 'x'");
    expect(text).not.toContain("Analyzing");
    expect(text).toEndWith(CURRENT);
    expect(text).not.toContain(STALE);
});

test("output over 20 issue lines is truncated with a count of the rest", () => {
    withDartProject();
    const lines = Array.from({ length: 25 }, (_, i) => `  error - main.dart:${i + 1}:1 - problem ${i + 1}`);

    const text = wake(runAsync(payload(dartFile), { FAKE_DART_OUT: lines.join("\n"), FAKE_DART_CODE: "3" }));

    expect(text).toContain("dart analyze --fatal-infos: 25 issue lines");
    expect(text).toContain("problem 20");
    expect(text).not.toContain("problem 21");
    expect(text).toContain("... (5 more)");
});

test("a clean Dart run with no earlier report exits 0 without a word", () => {
    withDartProject();

    expect(runAsync(payload(dartFile, { session_id: "s1" }), DART_CLEAN)).toEqual(SILENT);
});

test("the first clean run after a report with issues wakes the model once with the stale line", () => {
    withDartProject();
    const edit = payload(dartFile, { session_id: "s1" });

    expect(wake(runAsync(edit, DART_ISSUES))).toEndWith(CURRENT);

    const fixed = wake(runAsync(edit, DART_CLEAN));
    expect(fixed).toBe(`CLI check for ${dartFile}: dart analyze --fatal-infos: clean. ${STALE}`);

    expect(runAsync(edit, DART_CLEAN)).toEqual(SILENT);
});

test("issues in one session do not make a clean run in another session wake the model", () => {
    withDartProject();

    wake(runAsync(payload(dartFile, { session_id: "A" }), DART_ISSUES));

    expect(runAsync(payload(dartFile, { session_id: "B" }), DART_CLEAN)).toEqual(SILENT);
});

test("without a session id issues still wake the model but a clean run never does", () => {
    withDartProject();

    wake(runAsync(payload(dartFile), DART_ISSUES));

    expect(runAsync(payload(dartFile), DART_CLEAN)).toEqual(SILENT);
});

test("a timeout between an issues report and a clean run keeps the stale line for the clean run", () => {
    withDartProject();
    const edit = payload(dartFile, { session_id: "s1" });

    wake(runAsync(edit, DART_ISSUES));
    expect(runAsync(edit, { FAKE_DART_SLEEP: "5", AC_CLI_DIAGNOSTICS_TIMEOUT: "1" })).toEqual(SILENT);

    const text = wake(runAsync(edit, { AC_CLI_DIAGNOSTICS_BACKOFF: "0", ...DART_CLEAN }));
    expect(text).toEndWith(STALE);
});

test("a tool that outlives the timeout exits 0 silently", () => {
    withDartProject();

    expect(runAsync(payload(dartFile, { session_id: "s1" }), { FAKE_DART_SLEEP: "5", AC_CLI_DIAGNOSTICS_TIMEOUT: "1" })).toEqual(
        SILENT,
    );
});

test("a held slot exits 0 silently and stays held", () => {
    withDartProject();
    const lock = takeSlot("dart", process.pid);

    expect(runAsync(payload(dartFile, { session_id: "s1" }), { AC_CLI_DIAGNOSTICS_WAIT: "0", ...DART_ISSUES })).toEqual(
        SILENT,
    );
    expect(existsSync(lock)).toBe(true);
});

test("a slot whose owner is gone is taken over and given back", () => {
    withDartProject();
    const dead = Bun.spawnSync(["sh", "-c", "exit 0"]);
    const lock = takeSlot("dart", dead.pid ?? 999999);

    const text = wake(runAsync(payload(dartFile), { AC_CLI_DIAGNOSTICS_WAIT: "0", ...DART_ISSUES }));

    expect(text).toContain("dart analyze --fatal-infos: 1 issue line");
    expect(existsSync(lock)).toBe(false);
});

test("the slot is given back after a run and after a timeout", () => {
    withDartProject();
    const lock = join(scratch, "ac-cli-diagnostics-dart.lock");

    runAsync(payload(dartFile));
    expect(existsSync(lock)).toBe(false);

    runAsync(payload(dartFile), { FAKE_DART_SLEEP: "5", AC_CLI_DIAGNOSTICS_TIMEOUT: "1" });
    expect(existsSync(lock)).toBe(false);
});

test("a timeout pauses the project, and the next edit passes silently until the pause is over", () => {
    withDartProject();

    expect(runAsync(payload(dartFile), { FAKE_DART_SLEEP: "5", AC_CLI_DIAGNOSTICS_TIMEOUT: "1" })).toEqual(SILENT);

    // Issues would wake the model, so a silent exit here proves the paused project was not analysed.
    expect(runAsync(payload(dartFile), DART_ISSUES)).toEqual(SILENT);

    const afterPause = wake(runAsync(payload(dartFile), { AC_CLI_DIAGNOSTICS_BACKOFF: "0", ...DART_ISSUES }));
    expect(afterPause).toContain("dart analyze --fatal-infos: 1 issue line");
});

test("a clean run lifts the pause", () => {
    withDartProject();

    runAsync(payload(dartFile), { FAKE_DART_SLEEP: "5", AC_CLI_DIAGNOSTICS_TIMEOUT: "1" });
    expect(runAsync(payload(dartFile), DART_ISSUES)).toEqual(SILENT);

    // BACKOFF=0 ignores the pause for this run; the clean result it produces must retire the marker.
    expect(runAsync(payload(dartFile), { AC_CLI_DIAGNOSTICS_BACKOFF: "0", ...DART_CLEAN })).toEqual(SILENT);

    expect(wake(runAsync(payload(dartFile), DART_ISSUES))).toContain("dart analyze --fatal-infos: 1 issue line");
});

test("async mode: an unparseable payload fails open", () => {
    expect(runAsync("not json")).toEqual(SILENT);
    expect(runAsync("")).toEqual(SILENT);
});

test("async mode: a subagent payload passes silently unless AC_CLI_DIAGNOSTICS_SUBAGENTS=1", () => {
    withDartProject();
    const worker = payload(dartFile, { agent_id: "a1b2c3", agent_type: "ac:plan-worker-junior" });

    expect(runAsync(worker, DART_ISSUES)).toEqual(SILENT);

    expect(wake(runAsync(worker, { AC_CLI_DIAGNOSTICS_SUBAGENTS: "1", ...DART_ISSUES }))).toContain(
        "dart analyze --fatal-infos: 1 issue line",
    );
});

test("a Dart file with no pubspec.yaml above it passes silently", () => {
    expect(runAsync(payload(dartFile), DART_ISSUES)).toEqual(SILENT);
});

test("a Dart file whose packages are not resolved passes silently", () => {
    withDartProject();
    rmSync(join(root, "app", ".dart_tool"), { recursive: true });

    expect(runAsync(payload(dartFile), DART_ISSUES)).toEqual(SILENT);
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

    expect(runAsync(payload(edited), DART_ISSUES)).toEqual(SILENT);

    mkdirSync(join(tree, ".dart_tool"));
    writeFileSync(join(tree, ".dart_tool", "package_config.json"), "{}\n");

    expect(wake(runAsync(payload(edited), DART_ISSUES))).toContain("dart analyze --fatal-infos: 1 issue line");
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

    expect(wake(runAsync(payload(edited), DART_ISSUES))).toContain("dart analyze --fatal-infos: 1 issue line");
});

test("a package that is not a workspace member does not borrow its parent package's resolved config", () => {
    withDartProject();
    const example = join(root, "app", "example");
    mkdirSync(join(example, "lib"), { recursive: true });
    writeFileSync(join(example, "pubspec.yaml"), "name: example\n");
    const edited = join(example, "lib", "main.dart");
    writeFileSync(edited, "void main() {}\n");

    expect(runAsync(payload(edited), DART_ISSUES)).toEqual(SILENT);
});

test("the async hook resolves its runner from a relative invocation path", () => {
    withDartProject();
    const result = Bun.spawnSync(["sh", "hooks/posttooluse-cli-diagnostics.sh", "--async"], {
        cwd: join(dirname(HOOK), ".."),
        stdin: Buffer.from(payload(dartFile)),
        env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}`, TMPDIR: scratch, ...DART_ISSUES },
    });

    expect(result.exitCode).toBe(2);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).toContain("dart analyze --fatal-infos: 1 issue line");
});

test("a zero-padded number in a knob does not abort the async hook", () => {
    withDartProject();

    const text = wake(
        runAsync(payload(dartFile), {
            AC_CLI_DIAGNOSTICS_TIMEOUT: "09",
            AC_CLI_DIAGNOSTICS_WAIT: "00",
            AC_CLI_DIAGNOSTICS_BACKOFF: "010",
            ...DART_ISSUES,
        }),
    );

    expect(text).toContain("dart analyze --fatal-infos: 1 issue line");
});

test("a timeout ends the tool's helper process too, and returns without waiting for it", () => {
    withDartProject();
    const pidFile = join(root, "helper.pid");
    dartWithSleeper(pidFile, "hang");

    const started = Date.now();
    const result = runAsync(payload(dartFile), { AC_CLI_DIAGNOSTICS_TIMEOUT: "1" });

    expect(result).toEqual(SILENT);
    expect(Date.now() - started).toBeLessThan(15000);
    expect(gone(Number(readFileSync(pidFile, "utf8")))).toBe(true);
});

test("a helper the tool left behind after a normal exit is ended too", () => {
    withDartProject();
    const pidFile = join(root, "helper.pid");
    dartWithSleeper(pidFile, "exit");

    const started = Date.now();
    const result = runAsync(payload(dartFile));

    // Without the sweep the helper holds the output pipe open and the hook waits out its 60 s sleep.
    expect(Date.now() - started).toBeLessThan(15000);
    expect(result).toEqual(SILENT);
    expect(gone(Number(readFileSync(pidFile, "utf8")))).toBe(true);
});
