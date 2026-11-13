import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The CI gate in `plugins/ac/references/verification.md` leans on this script for the three things
// `gh pr checks --watch` gets wrong: a stale head right after a push, a queue nobody serves, and a
// cancelled check that exits 0. A fake `gh` answers from fixture files, so no network is involved.
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "plugins", "ac", "scripts", "ci-watch.sh");
const HEAD = "a".repeat(40);

const FAKE_GH = `#!/bin/sh
case "$1 $2" in
  "pr view") cat "$FAKE_GH_DIR/head" ;;
  "pr checks")
    case "$*" in
      *--json*)
        n=$(cat "$FAKE_GH_DIR/count" 2>/dev/null || echo 0)
        n=$((n + 1))
        echo "$n" > "$FAKE_GH_DIR/count"
        f="$FAKE_GH_DIR/checks.$n"
        [ -f "$f" ] || f="$FAKE_GH_DIR/checks.last"
        cat "$f" 2>/dev/null ;;
      *) echo "CHECK TABLE" ;;
    esac ;;
esac
`;

let scratch: string;

beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "ac-ci-watch-"));
    writeFileSync(join(scratch, "gh"), FAKE_GH);
    chmodSync(join(scratch, "gh"), 0o755);
    writeFileSync(join(scratch, "head"), HEAD);
});

afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
});

// A fixture line is "<bucket> <state> [check name]", written the way the script's `gh --jq` leaves it:
// tab separated, the name last so it may hold spaces. A line without a name is the check called "ci".
function tsv(lines: string): string {
    return lines
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => {
            const [bucket, state, ...name] = line.split(" ");
            return [bucket, state, name.join(" ") || "ci"].join("\t");
        })
        .map((line) => `${line}\n`)
        .join("");
}

function checks(...snapshots: string[]): void {
    snapshots.forEach((lines, index) => {
        const name = index === snapshots.length - 1 ? "checks.last" : `checks.${index + 1}`;
        writeFileSync(join(scratch, name), tsv(lines));
    });
}

function watch(env: Record<string, string> = {}, args: string[] = ["42", HEAD]) {
    // The fake gh answers with the rows it was given; the script's own awk does the name filtering.
    const result = Bun.spawnSync(["sh", SCRIPT, ...args], {
        env: {
            ...process.env,
            PATH: `${scratch}:${process.env.PATH ?? ""}`,
            FAKE_GH_DIR: scratch,
            CI_WATCH_INTERVAL: "0",
            ...env,
        },
    });
    return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
}

test("the opencode port carries the same script, byte for byte", () => {
    const port = join(dirname(SCRIPT), "..", "..", "..", "opencode", "ac", "skills", "execute", "references", "ci-watch.sh");

    expect(readFileSync(port, "utf8")).toBe(readFileSync(SCRIPT, "utf8"));
});

describe("ci-watch.sh", () => {
    test("exits 0 when every check passed, a skipped one included", () => {
        checks("pass SUCCESS\nskipping SKIPPED\n");

        expect(watch().code).toBe(0);
    });

    test("keeps polling while a check runs, then exits 0 once it passes", () => {
        checks("pending IN_PROGRESS\npass SUCCESS\n", "pass SUCCESS\npass SUCCESS\n");

        expect(watch().code).toBe(0);
        expect(readFileSync(join(scratch, "count"), "utf8").trim()).toBe("2");
    });

    test("exits 1 on the first failed check without waiting for the rest", () => {
        checks("fail FAILURE\npending IN_PROGRESS\n");
        const result = watch();

        expect(result.code).toBe(1);
        expect(result.out).toContain("CHECK TABLE");
    });

    test("treats a cancelled check as red, which gh pr checks exits 0 for", () => {
        checks("cancel CANCELLED\npass SUCCESS\n");

        expect(watch().code).toBe(1);
    });

    test("exits 2 when the PR never shows the head commit", () => {
        writeFileSync(join(scratch, "head"), "b".repeat(40));
        checks("pass SUCCESS\n");
        const result = watch({ CI_WATCH_START_WAIT: "0" });

        expect(result.code).toBe(2);
        expect(result.err).toContain("showed no checks");
    });

    test("never reads a green result off a previous head", () => {
        writeFileSync(join(scratch, "head"), "b".repeat(40));
        checks("pass SUCCESS\n");

        expect(watch({ CI_WATCH_START_WAIT: "0" }).code).not.toBe(0);
    });

    test("exits 2 when no check ever appears", () => {
        checks("");

        expect(watch({ CI_WATCH_START_WAIT: "0" }).code).toBe(2);
    });

    test("exits 2 when every check sits queued past the limit", () => {
        checks("pending QUEUED\npending WAITING\n");
        const result = watch({ CI_WATCH_QUEUE_LIMIT: "0" });

        expect(result.code).toBe(2);
        expect(result.err).toContain("no runner");
    });

    test("does not call a queue dead while one check is running", () => {
        checks("pending IN_PROGRESS\npending QUEUED\n", "pass SUCCESS\npass SUCCESS\n");

        expect(watch({ CI_WATCH_QUEUE_LIMIT: "0" }).code).toBe(0);
    });

    test("a failed poll after the first check is transient, not a dead CI", () => {
        checks("pending IN_PROGRESS\n", "", "pass SUCCESS\n");

        expect(watch({ CI_WATCH_START_WAIT: "0" }).code).toBe(0);
    });

    test("--ignore drops a red check whose name matches, such as a review bot", () => {
        checks("fail FAILURE CodeRabbit\npass SUCCESS Kodizm CI\n");

        expect(watch({}, ["--ignore", "CodeRabbit", "42", HEAD]).code).toBe(0);
        expect(watch().code).toBe(1);
    });

    test("--ignore stops a slow bot from holding the watch", () => {
        checks("pending IN_PROGRESS CodeRabbit\npass SUCCESS Kodizm CI\n");

        expect(watch({}, ["--ignore", "CodeRabbit", "42", HEAD]).code).toBe(0);
    });

    test("--ignore keeps a check whose name does not match", () => {
        checks("fail FAILURE Kodizm CI\n");

        expect(watch({}, ["--ignore", "CodeRabbit", "42", HEAD]).code).toBe(1);
    });

    test("--ignore that leaves no check behind counts as CI that never started", () => {
        checks("pass SUCCESS CodeRabbit\n");

        expect(watch({ CI_WATCH_START_WAIT: "0" }, ["--ignore", "CodeRabbit", "42", HEAD]).code).toBe(2);
    });

    test("--ignore without a regex is a usage error", () => {
        expect(watch({}, ["--ignore"]).code).toBe(64);
    });

    test("exits 64 without a pull request number", () => {
        expect(watch({}, []).code).toBe(64);
    });
});
