import { expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The hook is a shell script under the plugin; this pins its contract. A Bash command carrying the zsh-only
// expansions that Claude Code's bash parser cannot read is denied in every session (main thread and subagent
// alike), and everything else passes silently. The deny cases are the ones measured to raise the uncancellable
// "Dangerous rm operation not ruled out" prompt on 2.1.311; the allow cases were measured to run unprompted.
const HOOK = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
    "plugins",
    "ac",
    "hooks",
    "pretooluse-shell-syntax-guard.sh",
);

interface HookResult {
    exitCode: number;
    stdout: string;
}

function runHook(stdin: string, env: Record<string, string> = {}): HookResult {
    const result = Bun.spawnSync(["sh", HOOK], {
        stdin: Buffer.from(stdin),
        env: { ...process.env, ...env },
    });

    return {
        exitCode: result.exitCode,
        stdout: result.stdout.toString(),
    };
}

function payload(command: string, agentType?: string): string {
    return JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command },
        cwd: "/tmp",
        agent_type: agentType,
        agent_id: agentType === undefined ? undefined : "a1124775fb6dfdb02",
    });
}

function decision(stdout: string): string | undefined {
    if (stdout.trim() === "") return undefined;
    const parsed = JSON.parse(stdout) as { hookSpecificOutput?: { permissionDecision?: string } };

    return parsed.hookSpecificOutput?.permissionDecision;
}

const DENIED = [
    "x=a; echo ${(f)x}",
    'x=a; echo "${(f)x}"',
    "a=(x y); echo ${(j:,:)a}",
    "a=(x y); echo ${a[(i)y]}",
    "x=a; echo ${${x}}",
    "x=a; echo ${x:-${(L)x}}",
    `echo \${(f)"$(printf 'a\\nb')"}`,
    'echo "$(echo ${(U)x})"',
    "a=(x y); echo ${#a[(i)y]}",
    "a=(x y); echo ${!a[(i)y]}",
    "a=(x y); echo ${(s:,:)a}",
    "x=a; echo ${#${x}}",
    "x=a; echo `echo ${(f)x}`",
    'cat <<< "${(f)x}"',
    "echo $((1<<2)); for k in ${(f)x}; do :; done",
    "(true)# it's\necho ${(f)x}",
    "l=$(echo x | (cat)); echo $l",
    'l="$(echo x | (cat))"; echo $l',
    "l=$( (echo a)); echo $l",
    "l=$(echo a; (echo b)); echo $l",
    "for f in a b; do l=$(grep x $f | (cd test && xargs wc -l | tail -1 | awk '{print $1}')); echo $l; done",
];

const ALLOWED = [
    "echo $((1+2))",
    "x=abc; echo ${#x}",
    "a=(x y); echo ${a[@]}",
    "x=a; echo $x | grep '${('",
    'echo "\\${(f)x}"',
    'x=a; echo "$x" # ${(f)x}',
    "echo $'${(f)x}'",
    `echo "$(grep '\${(' notes.txt)"`,
    "x=a; echo ${x:-${y}}",
    "cat <<'EOF'\n${(f)x}\nEOF",
    "for f in a b; do echo $f; done",
    "a=(x y); i=0; echo ${a[(i+1)]}",
    'a=(x y); i=0; echo "${a[(i+1)%2]}"',
    "a=(x y); i=0; echo ${a[(i)]}",
    "a=(x y); echo $a[(i)y]",
    "echo \"`echo '${(f)lit}'`\"",
    "x=a; echo ${!x}",
    "echo $(( 16#ff )); x=foo; echo ${x/#f/b}",
    "l=$(echo x | (cat) ); echo $l",
    "l=$( (echo a) | cat ); echo $l",
    "l=$(echo $((1+2))); echo $l",
    "echo $((1+(2*3)))",
    "l=$(echo $(date)); echo $l",
    "l=`echo x | (cat)`; echo $l",
    "l=$(echo a | grep -c \"(\"); echo $l",
];

for (const command of DENIED) {
    test(`denies on the main thread: ${command}`, () => {
        const result = runHook(payload(command));

        expect(result.exitCode).toBe(0);
        expect(decision(result.stdout)).toBe("deny");
    });
}

test("denies inside a subagent too", () => {
    const result = runHook(payload("x=a; echo ${(f)x}", "ac:explore"));

    expect(decision(result.stdout)).toBe("deny");
});

test("the deny for a back-to-back close names the one-space fix", () => {
    const result = runHook(payload("l=$(echo x | (cat)); echo $l"));
    const reason = (JSON.parse(result.stdout) as { hookSpecificOutput: { permissionDecisionReason: string } })
        .hookSpecificOutput.permissionDecisionReason;

    expect(reason).toContain("))");
    expect(reason).toContain("space");
});

test("the deny names the construct and a bash rewrite", () => {
    const result = runHook(payload("for k in ${(f)keys}; do echo $k; done"));
    const reason = (JSON.parse(result.stdout) as { hookSpecificOutput: { permissionDecisionReason: string } })
        .hookSpecificOutput.permissionDecisionReason;

    expect(reason).toContain("(`${(f)keys}`)");
    expect(reason).toContain("while IFS= read -r");
    expect(reason).toContain("bash and zsh read alike");
});

for (const command of ALLOWED) {
    test(`allows: ${command}`, () => {
        const result = runHook(payload(command));

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("");
    });
}

// Claude Code 2.1.317 blocks a LEADING `sleep N` (N >= 25) itself and checks only the first segment, so the hook
// covers the later ones. A polling loop, a background sleep and a short sleep are the forms it must leave alone.
const SLEEP_DENIED = [
    "npm start; sleep 45",
    "make && sleep 30 && curl x",
    "echo a\nsleep 1m",
    "true || sleep 25",
    "cmd; sleep 25.5",
    "cmd; sleep 20 10",
    "cmd | sleep 30",
    "cmd; sleep 30 # wait",
    "while true; do sleep 60; done; sleep 30",
    "server & sleep 60; curl x",
    "cmd; sleep 0.5m",
];

const SLEEP_ALLOWED = [
    "sleep 45",
    "cmd; sleep 5",
    "cmd; sleep 24.9",
    "cmd; sleep 10 10",
    "until curl -s x; do sleep 30; done",
    "while true; do sleep 60; done",
    "for i in 1 2 3; do curl x; sleep 30; done",
    "while true; do\n  curl x\n  sleep 60\ndone",
    "server & sleep 3; curl x",
    "sleep 60 &",
    "cmd; sleep 60 &",
    'echo "a; sleep 45"',
    "echo 'a; sleep 45'",
    "cat <<'EOF'\nx; sleep 45\nEOF",
    "cmd # ; sleep 45",
    "x=$(cmd; sleep 45); echo $x",
    "x=`cmd; sleep 45`; echo $x",
    "cmd; sleep 45 arg",
    "cmd; echo sleep 45",
    "(x; sleep 30; kill $p) &",
    "{ x; sleep 30; y; } &",
    "x; sleep 30 && y &",
    "x; ( y; sleep 40 ) & z",
];

test("a run_in_background call is left alone, as Claude Code's own sleep check leaves it", () => {
    const input = JSON.parse(payload("./serve; sleep 30; ./e2e")) as { tool_input: Record<string, unknown> };
    input.tool_input.run_in_background = true;

    const result = runHook(JSON.stringify(input));

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
});

test("a sleep after a closed group is still judged", () => {
    expect(decision(runHook(payload("(cd x && make); sleep 30")).stdout)).toBe("deny");
});

for (const command of SLEEP_DENIED) {
    test(`denies a long mid-chain sleep: ${JSON.stringify(command)}`, () => {
        const result = runHook(payload(command));

        expect(result.exitCode).toBe(0);
        expect(decision(result.stdout)).toBe("deny");
    });
}

for (const command of SLEEP_ALLOWED) {
    test(`allows a sleep that is leading, short, looped or quoted: ${JSON.stringify(command)}`, () => {
        const result = runHook(payload(command));

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("");
    });
}

test("the sleep deny names the duration found and the two alternatives", () => {
    const result = runHook(payload("cmd; sleep 20 10"));
    const reason = (JSON.parse(result.stdout) as { hookSpecificOutput: { permissionDecisionReason: string } })
        .hookSpecificOutput.permissionDecisionReason;

    expect(reason).toContain("sleep 20 10");
    expect(reason).toContain("30 seconds");
    expect(reason).toContain("run_in_background");
    expect(reason).toContain("Monitor");
});

for (const command of SLEEP_DENIED) {
    test(`AC_SLEEP_GUARD=0 turns the sleep rule off: ${JSON.stringify(command)}`, () => {
        const result = runHook(payload(command), { AC_SLEEP_GUARD: "0" });

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("");
    });
}

test("AC_SLEEP_GUARD=0 leaves the zsh rule on", () => {
    const result = runHook(payload("x=a; sleep 1; echo ${(f)x}"), { AC_SLEEP_GUARD: "0" });

    expect(decision(result.stdout)).toBe("deny");
});

test("fails open on a payload it cannot read", () => {
    const result = runHook("not json");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
});

test("ignores a tool other than Bash", () => {
    const result = runHook(
        JSON.stringify({
            hook_event_name: "PreToolUse",
            tool_name: "Grep",
            tool_input: { pattern: "${(f)x}" },
        }),
    );

    expect(result.stdout).toBe("");
});
