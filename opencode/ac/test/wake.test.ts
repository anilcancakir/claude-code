import { describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { createFakeCtx } from "./fake-ctx.ts"
import { registerBackgroundShells, wakes } from "../src/wake.ts"

const WAKE_COUNT = fileURLToPath(new URL("../../../plugins/ac/hooks/lib/wake-count.jq", import.meta.url))

/** The strict-mode answer of the Claude Code original for one background shell. */
function jqWakes(command: string): boolean {
    const payload = JSON.stringify({ background_tasks: [{ type: "shell", command }] })
    const result = Bun.spawnSync(["jq", "-r", "--arg", "mode", "strict", "-f", WAKE_COUNT], {
        stdin: new TextEncoder().encode(payload),
    })
    return result.stdout.toString().trim() === "1"
}

// The cases of cli/ac/src/wake-count-hook.test.ts, plus the shells the live coordinate runs started.
const counted = [
    "timeout 600 claude -p x > out 2>&1",
    "cd /tmp/a && timeout 300 npm run thing",
    "F=1 && timeout 60 sh -c 'while true; do sleep 5; done'",
    "export A=1 B=2 && timeout 60 npm run thing",
    "cd /tmp/a && F=1 && timeout 120 npm run thing 2>&1",
    "timeout 60 npm run thing &>log",
    "timeout 3600 npm run thing",
    "gh pr checks 108 --watch --interval 30",
    "gh run watch --exit-status 123",
    "cd /repo/.ac/worktrees/coord-x && bin/check; rc=$?; git checkout -- pubspec.lock; exit $rc",
    "php artisan test --parallel --compact",
    "vendor/bin/phpunit --filter Foo",
    "bun test",
]

const notCounted = [
    "cd /tmp/a && claude -p x",
    "timeout 0 npm run dev",
    "timeout 86400 npm run dev",
    "timeout 60 a; rm -rf x",
    "timeout 60 a &",
    "cd $(sleep infinity) && timeout 60 npm run thing",
    "timeout 3601 npm run thing",
    'F="$(yes)" && timeout 60 a',
    "cd x && watch -n 5 npm test",
    "for i in 1 2; do watch -n 5 npm test; done",
    "cd /repo/.ac/worktrees/coord-x && php artisan serve --port=9001 > /tmp/serve.log 2>&1",
    "npm run dev",
    "tail -f storage/logs/laravel.log",
    "until grep -q ready log; do sleep 1; done",
    "sleep 20",
]

describe("wakes", () => {
    test.each(counted)("counts a finite or bounded shell: %s", (command) => {
        expect(wakes(command)).toBe(true)
    })

    test.each(notCounted)("leaves out a long-lived, looping or unbounded shell: %s", (command) => {
        expect(wakes(command)).toBe(false)
    })

    test("a clipped command whose tail cannot be seen does not count", () => {
        expect(wakes("cd /tmp/a && timeout 60 npm run thing [+40 chars]")).toBe(false)
    })

    test.each([...counted, ...notCounted])("agrees with wake-count.jq in strict mode: %s", (command) => {
        expect(wakes(command)).toBe(jqWakes(command))
    })
})

/** An execute.after event as the host sends it for a shell call moved to the background. */
function backgroundShell(sessionID: string, shellID: string, command: string) {
    return {
        tool: "shell",
        sessionID,
        status: "completed",
        input: { command, background: true },
        result: { content: [], metadata: { status: "running", shellID } } as never,
    } as const
}

async function settle(): Promise<void> {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

describe("registerBackgroundShells", () => {
    test("a finite background shell is pending until its completion message arrives", async () => {
        const fake = createFakeCtx()
        const shells = await registerBackgroundShells(fake.ctx)

        await fake.fire.tool("execute.after", backgroundShell("ses_1", "sh_1", "bin/check"))
        await fake.fire.tool("execute.after", backgroundShell("ses_1", "sh_2", "php artisan serve --port=9001"))
        expect(shells.pending("ses_1")).toBe(1)
        expect(shells.pending("ses_2")).toBe(0)

        fake.pushEvent({
            type: "session.synthetic",
            data: { sessionID: "ses_1", text: "<shell>", metadata: { source: "shell", shellID: "sh_1" } },
        })
        await settle()

        expect(shells.pending("ses_1")).toBe(0)
        shells.stop()
    })

    test("a foreground shell and a failed call track nothing", async () => {
        const fake = createFakeCtx()
        const shells = await registerBackgroundShells(fake.ctx)

        await fake.fire.tool("execute.after", {
            ...backgroundShell("ses_1", "sh_1", "bun test"),
            result: { content: [], metadata: { status: "completed", exit: 0 } } as never,
        })
        await fake.fire.tool("execute.after", { tool: "shell", sessionID: "ses_1", status: "error", input: {} })

        expect(shells.pending("ses_1")).toBe(0)
        shells.stop()
    })
})
