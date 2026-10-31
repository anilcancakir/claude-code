import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The hook is a shell script under the plugin, but CI only runs `bun test` here, and CI has neither
// dart nor php. Fake analyzers on the front of PATH stand in for them, so this pins the contract:
// silent for anything that is not a Dart or PHP file with a project around it, an additionalContext
// verdict per tool otherwise (clean, or the issue lines capped at 20), a readable timeout message,
// never `decision: block`, and always exit 0.
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
            AC_CLI_DIAGNOSTICS: "",
            AC_CLI_DIAGNOSTICS_TIMEOUT: "",
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
        tool_name: "Edit",
        tool_input: {
            file_path: filePath,
        },
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
