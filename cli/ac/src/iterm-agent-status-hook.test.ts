import { afterEach, beforeEach, expect, test } from "bun:test";
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    statSync,
    symlinkSync,
    utimesSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The hook forwards Claude Code's hook payloads to iTerm2's cc-status with a cached API cookie in
// ITERM2_COOKIE, so it2 never runs osascript (each osascript run leaks WindowServer Mach ports).
// These tests pin the contract with fake pgrep, ps, osascript, it2 and cc-status binaries: nothing
// runs outside iTerm2 or before the user opts in, a fresh cookie is forwarded without ITERM2_KEY,
// a stale one is replaced by one background request an hour, and a refused one is dropped.
const HOOK = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
    "plugins",
    "ac",
    "hooks",
    "iterm-agent-status.sh",
);

const ITERM_PID = "4242";
const ITERM_ID = `${ITERM_PID}@Wed_Nov_18_18:24:30_2026`;
const PAYLOAD = '{"hook_event_name":"PreToolUse","session_id":"s1"}';

let home: string;
let bin: string;
let itermDir: string;
let log: string;

beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ac-iterm-status-"));
    bin = join(home, "bin");
    itermDir = join(home, ".config", "iterm2");
    log = join(home, "log");
    mkdirSync(bin, { recursive: true });
    mkdirSync(itermDir, { recursive: true });
    mkdirSync(log);

    // Without -a, BSD pgrep never lists its own ancestors, and iTerm2 is an ancestor of every hook.
    writeExecutable(
        join(bin, "pgrep"),
        `[ "$*" = "-a -x -U $(id -u) iTerm2" ] && [ -n "$FAKE_ITERM_PID" ] || exit 1\necho "$FAKE_ITERM_PID"\n`,
    );
    writeExecutable(
        join(bin, "ps"),
        `[ "$*" = "-o lstart= -p ${ITERM_PID}" ] && [ "$LC_ALL" = C ] || exit 1\necho "Wed Nov 18 18:24:30 2026"\n`,
    );
    writeExecutable(
        join(bin, "osascript"),
        [
            `printf '%s\\n' "$@" >> "${log}/osascript"`,
            "sleep 0.3",
            `[ -f "${log}/deny" ] && exit 1`,
            `cat "${log}/issue" 2> /dev/null || echo "c0ffee11 0000-key"`,
            "",
        ].join("\n"),
    );
    writeExecutable(
        join(itermDir, "cc-status"),
        [
            `echo "cookie=\${ITERM2_COOKIE-unset} key=\${ITERM2_KEY-unset}" >> "${log}/cc-status"`,
            `cat >> "${log}/cc-status-stdin"`,
            "",
        ].join("\n"),
    );
    writeIt2(join(itermDir, "it2"));
});

afterEach(() => {
    rmSync(home, { recursive: true, force: true });
});

function writeExecutable(path: string, body: string): void {
    writeFileSync(path, `#!/bin/sh\n${body}`);
    chmodSync(path, 0o755);
}

// Accepts only c0ffee11, sent without a key; a cookie named in single-use passes once.
function writeIt2(path: string): void {
    writeExecutable(
        path,
        [
            '[ "$1 $2" = "session get-status" ] || exit 64',
            '[ -z "${ITERM2_KEY-}" ] || exit 1',
            `echo "$ITERM2_COOKIE" >> "${log}/it2-get-status"`,
            `if [ "$ITERM2_COOKIE" = "$(cat "${log}/single-use" 2> /dev/null)" ]; then`,
            `    [ "$(grep -c "^$ITERM2_COOKIE$" "${log}/it2-get-status")" -le 1 ]; exit`,
            "fi",
            '[ "$ITERM2_COOKIE" = c0ffee11 ]',
            "",
        ].join("\n"),
    );
}

function runHook(env: Record<string, string> = {}): number {
    const result = Bun.spawnSync(["sh", HOOK], {
        stdin: Buffer.from(PAYLOAD),
        env: {
            HOME: home,
            PATH: `${bin}:/usr/bin:/bin`,
            ITERM_SESSION_ID: "w0t0p0:SESSION-1",
            ITERM2_KEY: "inherited-key",
            FAKE_ITERM_PID: ITERM_PID,
            ...env,
        },
    });

    return result.exitCode;
}

function readLog(name: string): string {
    const path = join(log, name);

    return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function requests(): number {
    return readLog("osascript").split("\n").filter((line) => line.startsWith("with timeout")).length;
}

const cookieFile = (): string => join(itermDir, "ac-agent-cookie");
const readCache = (): string => readFileSync(cookieFile(), "utf8");

async function waitFor(condition: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 50 && !condition(); attempt++) {
        await Bun.sleep(40);
    }
}

function hoursAgo(path: string, hours: number): void {
    const then = new Date(Date.now() - hours * 3_600_000);
    utimesSync(path, then, then);
}

test("outside iTerm2 nothing runs", () => {
    writeFileSync(cookieFile(), `${ITERM_ID} c0ffee11\n`);

    expect(runHook({ ITERM_SESSION_ID: "" })).toBe(0);
    expect(readLog("cc-status")).toBe("");
});

test("without the opt-in file nothing runs, not even a cookie request", async () => {
    expect(runHook()).toBe(0);
    await Bun.sleep(200);

    expect(readLog("cc-status")).toBe("");
    expect(requests()).toBe(0);
});

test("when iTerm2 is not running nothing runs", async () => {
    writeFileSync(cookieFile(), "");

    expect(runHook({ FAKE_ITERM_PID: "" })).toBe(0);
    await Bun.sleep(200);

    expect(readLog("cc-status")).toBe("");
    expect(requests()).toBe(0);
});

test("a cookie issued to the running iTerm2 is forwarded with the payload and without ITERM2_KEY", () => {
    writeFileSync(cookieFile(), `${ITERM_ID} c0ffee11\n`);

    expect(runHook()).toBe(0);
    expect(readLog("cc-status")).toBe("cookie=c0ffee11 key=unset\n");
    expect(readLog("cc-status-stdin")).toBe(PAYLOAD);
    expect(requests()).toBe(0);
});

test("a cookie of an earlier iTerm2 with the same pid is stale", async () => {
    writeFileSync(cookieFile(), `${ITERM_PID}@Mon_Nov_16_09:00:00_2026 deadbeef\n`);

    expect(runHook()).toBe(0);
    await waitFor(() => readCache().startsWith(ITERM_ID));

    expect(readLog("cc-status")).toBe("");
    expect(readCache()).toBe(`${ITERM_ID} c0ffee11\n`);
});

test("a stale cookie is not forwarded; one background request with a long timeout replaces it", async () => {
    writeFileSync(cookieFile(), "1111@Mon_Nov_16_09:00:00_2026 deadbeef\n");

    expect(runHook()).toBe(0);
    expect(runHook()).toBe(0);
    await waitFor(() => readCache().startsWith(ITERM_ID));

    expect(readLog("cc-status")).toBe("");
    expect(requests()).toBe(1);
    expect(readLog("osascript")).toContain(
        'tell application "iTerm2" to request cookie and key for app named "it2" reusable true session id "w0t0p0:SESSION-1"',
    );
    expect(readLog("osascript")).toContain("with timeout of 3600 seconds");
    expect(readCache()).toBe(`${ITERM_ID} c0ffee11\n`);
    expect(statSync(cookieFile()).mode & 0o077).toBe(0);

    expect(runHook()).toBe(0);
    expect(readLog("cc-status")).toBe("cookie=c0ffee11 key=unset\n");
});

test("a session id that is not a plain token is left out of the AppleScript", async () => {
    writeFileSync(cookieFile(), "");

    expect(runHook({ ITERM_SESSION_ID: 'w0t0p0:x" & do shell script "id' })).toBe(0);
    await waitFor(() => requests() === 1);

    expect(readLog("osascript")).not.toContain("session id");
    expect(readLog("osascript")).not.toContain("do shell script");
});

test("a single-use cookie, which passes get-status once, is not cached", async () => {
    writeFileSync(cookieFile(), "");
    writeFileSync(join(log, "issue"), "5106e115 0000-key\n");
    writeFileSync(join(log, "single-use"), "5106e115");

    expect(runHook()).toBe(0);
    await waitFor(() => readLog("it2-get-status").split("\n").length > 2);
    await Bun.sleep(200);

    expect(readLog("it2-get-status")).toBe("5106e115\n5106e115\n");
    expect(readCache()).toBe("");
});

test("a denied request leaves the cookie stale and is not repeated within the hour", async () => {
    writeFileSync(cookieFile(), "");
    writeFileSync(join(log, "deny"), "");

    expect(runHook()).toBe(0);
    await waitFor(() => requests() === 1);
    await Bun.sleep(400);
    expect(runHook()).toBe(0);
    await Bun.sleep(400);

    expect(requests()).toBe(1);
    expect(readCache()).toBe("");
    expect(readLog("cc-status")).toBe("");
});

test("a lock older than an hour, or one left by an earlier iTerm2, no longer holds a request back", async () => {
    writeFileSync(cookieFile(), "");
    const lock = `${cookieFile()}.lock-${ITERM_PID}`;
    const earlier = `${cookieFile()}.lock-1111`;
    mkdirSync(lock);
    mkdirSync(earlier);
    hoursAgo(lock, 2);

    expect(runHook()).toBe(0);
    await waitFor(() => readCache().startsWith(ITERM_ID));

    expect(requests()).toBe(1);
    expect(existsSync(earlier)).toBe(false);
});

test("a cached cookie iTerm2 now refuses is dropped by the hourly probe, after this event is forwarded", async () => {
    writeFileSync(cookieFile(), `${ITERM_ID} expired1\n`);

    expect(runHook()).toBe(0);
    await waitFor(() => readCache() === "\n");

    expect(readLog("cc-status")).toBe("cookie=expired1 key=unset\n");
    expect(readCache()).toBe("\n");
    expect(requests()).toBe(0);
});

test("the probe runs at most once an hour", async () => {
    writeFileSync(cookieFile(), `${ITERM_ID} c0ffee11\n`);

    expect(runHook()).toBe(0);
    await waitFor(() => readLog("it2-get-status") !== "");
    await Bun.sleep(200);
    expect(runHook()).toBe(0);
    await Bun.sleep(200);

    expect(readLog("it2-get-status")).toBe("c0ffee11\nc0ffee11\n");
    expect(readLog("cc-status")).toBe("cookie=c0ffee11 key=unset\ncookie=c0ffee11 key=unset\n");
});

test("it2 is found next to the target of the installer's cc-status link", async () => {
    const utilities = join(home, "iTerm.app", "utilities");
    mkdirSync(utilities, { recursive: true });
    rmSync(join(itermDir, "it2"));
    writeIt2(join(utilities, "it2"));
    writeExecutable(join(utilities, "cc-status"), readFileSync(join(itermDir, "cc-status"), "utf8").slice(10));
    rmSync(join(itermDir, "cc-status"));
    symlinkSync(join(utilities, "cc-status"), join(itermDir, "cc-status"));
    writeFileSync(cookieFile(), "");

    expect(runHook()).toBe(0);
    await waitFor(() => readCache().startsWith(ITERM_ID));

    expect(readCache()).toBe(`${ITERM_ID} c0ffee11\n`);
});
