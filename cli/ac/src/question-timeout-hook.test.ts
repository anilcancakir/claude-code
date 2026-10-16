import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The hook is a shell script under the plugin, so this is where its contract is pinned: the idle
// timeout of an AskUserQuestion answers with the wait text unless the session owns a live ac:auto
// run, and the wait text is also what every parse failure falls back to.
const HOOK = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
    "plugins",
    "ac",
    "hooks",
    "posttooluse-question-timeout.sh",
);

const SESSION = "sess-qt-1";
const SLUG = "demo";
const WAIT_MARK = "End the turn with one line";
const CONTINUE_MARK = "not user-approved";

let root: string;
let project: string;
let scratch: string;

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ac-question-timeout-"));
    project = join(root, "project");
    scratch = join(root, "tmp");
    mkdirSync(project, { recursive: true });
    mkdirSync(scratch, { recursive: true });
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
            TMPDIR: scratch,
            CLAUDE_PROJECT_DIR: "",
            AC_QUESTION_TIMEOUT: "",
            AC_QUESTION_TIMEOUT_SHAPE: "",
            ...env,
        },
    });

    return { exitCode: result.exitCode, stdout: result.stdout.toString() };
}

interface Question {
    question: string;
    header: string;
    options: { label: string; description: string }[];
}

function question(header: string = "Scope?"): Question {
    return {
        question: "Which scope should the plan take?",
        header,
        options: [
            { label: "Narrow (Recommended)", description: "One file." },
            { label: "Wide", description: "Every file." },
        ],
    };
}

// Shaped like the payload verified against the binary: the idle-timeout path is the only one that
// sets afkTimeoutMs, and it comes with empty answers.
function payload(questions: Question[] = [question()], timedOut: boolean = true, session: string = SESSION): string {
    return JSON.stringify({
        session_id: session,
        cwd: project,
        hook_event_name: "PostToolUse",
        tool_name: "AskUserQuestion",
        tool_input: { questions },
        tool_response: timedOut
            ? { questions, answers: {}, annotations: {}, afkTimeoutMs: 180000 }
            : { questions, answers: { [questions[0]?.question ?? ""]: "Wide" }, annotations: {} },
    });
}

function latchPath(session: string = SESSION): string {
    return join(scratch, `ac-question-wait-${session}`);
}

function critPath(): string {
    return join(scratch, `ac-question-crit-${SESSION}-${SLUG}`);
}

function isoAgo(hours: number): string {
    return new Date(Date.now() - hours * 3600 * 1000).toISOString().replace(/\.\d+Z$/, "Z");
}

function seedAutoRun(overrides: { session?: string; startedAt?: string } = {}): void {
    mkdirSync(join(project, ".ac", "state"), { recursive: true });
    mkdirSync(join(project, ".ac", "auto", SLUG), { recursive: true });
    writeFileSync(
        join(project, ".ac", "state", "active-auto.json"),
        JSON.stringify({
            session_id: overrides.session ?? SESSION,
            slug: SLUG,
            started_at: overrides.startedAt ?? isoAgo(0),
            phase: "planning",
            pid: 0,
        }),
    );
}

function seedExecuteMarker(session: string = SESSION): void {
    writeFileSync(
        join(project, ".ac", "state", "active-execution.json"),
        JSON.stringify({ session_id: session, slug: SLUG, started_at: isoAgo(0), current_wave: 1, pid: 0 }),
    );
}

function additionalContext(stdout: string): string {
    const output = JSON.parse(stdout) as {
        hookSpecificOutput?: { hookEventName?: string; additionalContext?: string };
    };
    expect(output.hookSpecificOutput?.hookEventName).toBe("PostToolUse");

    return output.hookSpecificOutput?.additionalContext ?? "";
}

function expectText(text: string, mark: string): void {
    expect(text).toContain(mark);
    expect(text.length).toBeLessThan(600);
    expect(/^[\x20-\x7e]*$/.test(text)).toBe(true);
}

function expectWait(result: HookResult): void {
    expect(result.exitCode).toBe(0);
    const text = additionalContext(result.stdout);
    expectText(text, WAIT_MARK);
    expect(text).not.toContain(CONTINUE_MARK);
}

function expectContinue(result: HookResult): void {
    expect(result.exitCode).toBe(0);
    const text = additionalContext(result.stdout);
    expectText(text, CONTINUE_MARK);
    expect(text).not.toContain(WAIT_MARK);
}

test("a payload without afkTimeoutMs prints nothing and retires an old latch", () => {
    writeFileSync(latchPath(), `${Math.floor(Date.now() / 1000)}\n`);

    expect(runHook(payload([question()], false))).toEqual({ exitCode: 0, stdout: "" });
    expect(existsSync(latchPath())).toBe(false);
});

test("AC_QUESTION_TIMEOUT=0 prints nothing and leaves the latch alone", () => {
    writeFileSync(latchPath(), `${Math.floor(Date.now() / 1000)}\n`);

    expect(runHook(payload(), { AC_QUESTION_TIMEOUT: "0" })).toEqual({ exitCode: 0, stdout: "" });
    expect(existsSync(latchPath())).toBe(true);
});

test("a supervised session (no marker) waits and arms the latch", () => {
    expectWait(runHook(payload()));

    expect(existsSync(latchPath())).toBe(true);
});

test("without jq the fixed wait text is valid JSON and the latch is armed", () => {
    const bin = join(root, "bin");
    mkdirSync(bin);
    for (const tool of ["sh", "cat", "awk", "dirname", "date", "rm"]) {
        const path = Bun.which(tool);
        expect(path).not.toBeNull();
        symlinkSync(path as string, join(bin, tool));
    }
    seedAutoRun();

    expectWait(runHook(payload(), { PATH: bin }));
    expect(existsSync(latchPath())).toBe(true);
});

test("a marker owned by another session waits", () => {
    seedAutoRun({ session: "sess-other" });

    expectWait(runHook(payload()));
    expect(existsSync(latchPath())).toBe(true);
});

test("a marker started more than 24 hours ago waits", () => {
    seedAutoRun({ startedAt: isoAgo(25) });

    expectWait(runHook(payload()));
});

test("a verdict on disk waits", () => {
    seedAutoRun();
    writeFileSync(join(project, ".ac", "auto", SLUG, "verdict.md"), "# Verdict\n");

    expectWait(runHook(payload()));
});

test("a marker whose run directory is missing waits", () => {
    seedAutoRun();
    rmSync(join(project, ".ac", "auto", SLUG), { recursive: true });

    expectWait(runHook(payload()));
});

test("a payload with no questions waits even with an owned marker", () => {
    seedAutoRun();

    expectWait(runHook(payload([])));
});

test("an owned fresh marker continues and leaves no latch", () => {
    seedAutoRun();
    writeFileSync(latchPath(), `${Math.floor(Date.now() / 1000)}\n`);

    expectContinue(runHook(payload()));
    expect(existsSync(latchPath())).toBe(false);
});

test("an owned execute marker beside the auto marker waits", () => {
    seedAutoRun();
    seedExecuteMarker();

    expectWait(runHook(payload()));
    expect(existsSync(latchPath())).toBe(true);
});

test("an execute marker owned by another session does not stop the continue", () => {
    seedAutoRun();
    seedExecuteMarker("sess-other");

    expectContinue(runHook(payload()));
});

test("blocker headers wait even with an owned marker", () => {
    seedAutoRun();

    for (const header of ["Topic?", "Agent fail?", "Write fail?", "Dep failed?", "Halted?"]) {
        expectWait(runHook(payload([question(header)])));
    }
});

test("one blocker header among several questions makes the whole prompt wait", () => {
    seedAutoRun();

    expectWait(runHook(payload([question("Scope?"), question("Halted?")])));
});

test("Oracle CRIT? continues once per run and waits the second time", () => {
    seedAutoRun();
    const crit = payload([question("Oracle CRIT?")]);

    expectContinue(runHook(crit));
    expect(existsSync(critPath())).toBe(true);

    expectWait(runHook(crit));
});

test("a wait for another reason does not spend the Oracle CRIT? allowance", () => {
    seedAutoRun();
    seedExecuteMarker();

    expectWait(runHook(payload([question("Oracle CRIT?")])));
    expect(existsSync(critPath())).toBe(false);
});

test("a symlinked Oracle CRIT? counter is refused", () => {
    seedAutoRun();
    symlinkSync(join(root, "missing"), critPath());

    expectWait(runHook(payload([question("Oracle CRIT?")])));
    expect(readdirSync(root)).not.toContain("missing");
});

test("SHAPE=block prints a decision block carrying the wait reason", () => {
    const result = runHook(payload(), { AC_QUESTION_TIMEOUT_SHAPE: "block" });

    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout) as { decision?: string; reason?: string };
    expect(output.decision).toBe("block");
    expectText(output.reason ?? "", WAIT_MARK);
});
