import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// End to end through `src/index.ts`: a fake `gh` answers from fixture files in a scratch directory, so
// the command runs its real polling loop with no network, no git and (with `--interval 0`) no waiting.
const INDEX = join(dirname(fileURLToPath(import.meta.url)), "index.ts");
const HEAD = "a".repeat(40);

const FAKE_GH = `#!/bin/sh
fixture() { cat "$FAKE_GH_DIR/$1" 2>/dev/null || echo "\${2:-[]}"; }
case "$1 $2" in
  "pr checks")
    if [ -f "$FAKE_GH_DIR/checks.json" ]; then
      cat "$FAKE_GH_DIR/checks.json"
    else
      echo "no checks reported on the 'x' branch" >&2
      exit 1
    fi ;;
  "api -i")
    for path; do :; done
    printf 'HTTP/2.0 200 OK\\nEtag: W/"x"\\n\\r\\n'
    case "$path" in
      */issues/*/comments*) fixture comments.json ;;
      */pulls/*/comments*) fixture inline.json ;;
      */pulls/*/reviews*) fixture reviews.json ;;
      */pulls/*) echo '{"head":{"sha":"${HEAD}"}}' ;;
    esac ;;
esac
`;

let scratch: string;

beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "ac-pr-watch-"));
    writeFileSync(join(scratch, "gh"), FAKE_GH);
    chmodSync(join(scratch, "gh"), 0o755);
});

afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
});

function fixture(name: string, value: unknown): void {
    writeFileSync(join(scratch, name), JSON.stringify(value));
}

function run(args: string[], path = `${scratch}:${process.env.PATH ?? ""}`) {
    const result = Bun.spawnSync([process.execPath, INDEX, "pr-watch", ...args], {
        env: { ...process.env, PATH: path, FAKE_GH_DIR: scratch },
    });
    const out = result.stdout.toString();

    return {
        code: result.exitCode,
        out,
        lines: out.split("\n").filter((line) => line !== ""),
        err: result.stderr.toString(),
    };
}

function watch(...extra: string[]) {
    return run(["42", "--head", HEAD, "--interval", "0", ...extra]);
}

describe("ac pr-watch", () => {
    test("exits 0 and ends in a green verdict when every check passed", () => {
        fixture("checks.json", [{ name: "ci", bucket: "pass", state: "SUCCESS" }]);
        const result = watch();

        expect(result.code).toBe(0);
        expect(result.lines[0]).toBe("WATCH pr=42 head=aaaaaaa");
        expect(result.lines.at(-1)).toBe("VERDICT green head=aaaaaaa");
    });

    test("compares an upper case --head against the lower case head the API reports", () => {
        fixture("checks.json", [{ name: "ci", bucket: "pass", state: "SUCCESS" }]);
        const result = run(["42", "--head", HEAD.toUpperCase(), "--interval", "0"]);

        expect(result.code).toBe(0);
        expect(result.lines.at(-1)).toBe("VERDICT green head=aaaaaaa");
    });

    test("exits 1 and ends in a red verdict when a check failed", () => {
        fixture("checks.json", [{ name: "ci", bucket: "fail", state: "FAILURE" }]);
        const result = watch();

        expect(result.code).toBe(1);
        expect(result.lines).toContain("CHECK ci: fail");
        expect(result.lines.at(-1)).toStartWith("VERDICT red ");
    });

    test("exits 2 when the pull request shows no checks", () => {
        const result = watch("--start-wait", "0");

        expect(result.code).toBe(2);
        expect(result.lines.at(-1)).toBe("VERDICT stuck head=aaaaaaa reason=no-checks");
    });

    test("--ignore turns a red check into a report, not a gate", () => {
        fixture("checks.json", [
            { name: "bot", bucket: "fail", state: "FAILURE" },
            { name: "ci", bucket: "pass", state: "SUCCESS" },
        ]);
        const result = watch("--ignore", "^bot$");

        expect(result.code).toBe(0);
        expect(result.lines).toContain("CHECK bot: fail (not a gate)");
    });

    test("--include-existing shows a comment that predates the watch before the verdict", () => {
        fixture("checks.json", [{ name: "ci", bucket: "pass", state: "SUCCESS" }]);
        fixture("comments.json", [{ id: 7, user: { login: "reviewer" }, body: "please rename this" }]);
        const result = watch("--include-existing");
        const comment = result.lines.indexOf("COMMENT 7 reviewer: please rename this");

        expect(result.code).toBe(0);
        expect(comment).toBeGreaterThan(0);
        expect(comment).toBeLessThan(result.lines.length - 1);
    });

    test("records existing comments as a baseline by default", () => {
        fixture("checks.json", [{ name: "ci", bucket: "pass", state: "SUCCESS" }]);
        fixture("comments.json", [{ id: 7, user: { login: "reviewer" }, body: "please rename this" }]);
        const result = watch();

        expect(result.lines).toContain("BASELINE comments=1 inline=0 reviews=0");
        expect(result.out).not.toContain("COMMENT 7");
    });

    test("exits 2 with gh-unavailable when gh is not on PATH", () => {
        const empty = join(scratch, "empty");
        mkdirSync(empty);
        const result = run(["42", "--head", HEAD, "--interval", "0"], empty);

        expect(result.code).toBe(2);
        expect(result.lines.at(-1)).toBe("VERDICT stuck head=aaaaaaa reason=gh-unavailable");
    });

    describe("usage errors", () => {
        test.each([
            ["a pull request that is not a number", ["abc"]],
            ["a pull request number with a leading zero", ["042"]],
            ["an --ignore that does not compile", ["5", "--ignore", "(", "--head", HEAD]],
            ["a --head that is not a full SHA", ["5", "--head", "abc"]],
            ["an --interval that is not a number", ["5", "--head", HEAD, "--interval", "soon"]],
        ])("exit 64 with one stderr line and no stdout for %s", (_name, args) => {
            const result = run(args);

            expect(result.code).toBe(64);
            expect(result.out).toBe("");
            expect(result.err.trimEnd().split("\n")).toHaveLength(1);
            expect(result.err).toStartWith("ac pr-watch: ");
        });
    });
});
