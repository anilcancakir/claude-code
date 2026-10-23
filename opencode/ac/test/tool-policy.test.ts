import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import type { PermissionHooks } from "@opencode/plugin/promise/permission"
import { registerToolPolicy } from "../src/tool-policy.ts"
import { createFakeCtx } from "./fake-ctx.ts"

const BUDGET = 3

type AgentId = NonNullable<PermissionHooks["evaluate"]["agent"]>

async function setup(options: Parameters<typeof registerToolPolicy>[1] = { exploreMaxCalls: BUDGET }) {
    const fake = createFakeCtx()
    await registerToolPolicy(fake.ctx, options)
    return fake
}

function evaluate(fake: Awaited<ReturnType<typeof setup>>, agent: string, action: string, sessionID = "ses_a") {
    return fake.fire.permission("evaluate", { sessionID, agent: agent as AgentId, action, resources: ["*"], effect: "allow" })
}

async function shellInput(fake: Awaited<ReturnType<typeof setup>>, input: Record<string, unknown>) {
    const event = await fake.fire.tool("execute.before", { tool: "shell", input })
    return event.input as Record<string, unknown>
}

describe("explore budget", () => {
    test("allows calls up to the budget and denies the next one with the partial-findings message", async () => {
        const fake = await setup()

        for (let call = 0; call < BUDGET; call++) {
            expect((await evaluate(fake, "ac/explore", "read")).effect).toBe("allow")
        }
        const over = await evaluate(fake, "ac/explore", "grep")

        expect(over.effect).toBe("deny")
        expect(over.message).toContain(`${BUDGET} of ${BUDGET}`)
        expect(over.message).toContain("Report the findings you already have")
        expect(over.message).toContain("name the angle you did not finish")
    })

    test("counts read, grep, glob and shell together", async () => {
        const fake = await setup()

        await evaluate(fake, "ac/explore", "read")
        await evaluate(fake, "ac/explore", "grep")
        await evaluate(fake, "ac/explore", "glob")

        expect((await evaluate(fake, "ac/explore", "shell")).effect).toBe("deny")
    })

    test("ignores other actions", async () => {
        const fake = await setup()

        for (let call = 0; call < BUDGET * 3; call++) await evaluate(fake, "ac/explore", "external_directory")

        expect((await evaluate(fake, "ac/explore", "read")).effect).toBe("allow")
    })

    test("keeps a separate count per explore session", async () => {
        const fake = await setup()
        for (let call = 0; call < BUDGET; call++) await evaluate(fake, "ac/explore", "read", "ses_a")

        expect((await evaluate(fake, "ac/explore", "read", "ses_a")).effect).toBe("deny")
        expect((await evaluate(fake, "ac/explore", "read", "ses_b")).effect).toBe("allow")
    })

    test("a denied call does not advance the count", async () => {
        const fake = await setup()
        for (let call = 0; call < BUDGET + 5; call++) await evaluate(fake, "ac/explore", "read")

        expect((await evaluate(fake, "ac/explore", "read")).effect).toBe("deny")
    })

    test("leaves every other agent unlimited", async () => {
        const fake = await setup()

        for (const agent of ["build", "ac/oracle", "ac/librarian"]) {
            for (let call = 0; call < BUDGET * 3; call++) {
                expect((await evaluate(fake, agent, "read")).effect).toBe("allow")
            }
        }
    })

    test("defaults to the 60 call budget of the CC hook", async () => {
        const fake = await setup({})

        for (let call = 0; call < 60; call++) await evaluate(fake, "ac/explore", "read")

        expect((await evaluate(fake, "ac/explore", "read")).effect).toBe("deny")
    })
})

describe("explore read-only shell guard", () => {
    function shell(fake: Awaited<ReturnType<typeof setup>>, agent: string, ...resources: string[]) {
        return fake.fire.permission("evaluate", {
            sessionID: "ses_a",
            agent: agent as AgentId,
            action: "shell",
            resources,
            effect: "allow",
        })
    }

    test.each([
        "cat .env",
        'cat "backend/.env.local"',
        "git show HEAD:.env",
        "jq . credentials.json",
        "head -5 config/id_rsa",
    ])("denies the secret read %p with the report-the-path reason", async (command) => {
        const fake = await setup({})

        const event = await shell(fake, "ac/explore", command)

        expect(event.effect).toBe("deny")
        expect(event.message).toContain("does not open secret-shaped files")
    })

    test.each([
        "prettier --write x",
        "pint",
        "pint app/Models",
        "rm -rf x",
        "git commit -m x",
        "git -C repo push",
        "npm install",
        "sed -i s/a/b/ file.ts",
        "echo hi > notes.txt",
        "git log 2>&1 >> out.log",
        'sh -c "echo x > f"',
    ])("denies the write-mode command %p with the read-only reason", async (command) => {
        const fake = await setup({})

        const event = await shell(fake, "ac/explore", command)

        expect(event.effect).toBe("deny")
        expect(event.message).toContain("is read-only")
    })

    test.each([
        "rg foo",
        "pint --test x",
        "git log",
        "git status",
        "ls -la .env",
        "test -f .env",
        "cat .env.example",
        'rg -n "a > b" src',
        "rg -n pint composer.json",
        "git log 2>/dev/null",
        "rg foo > /tmp/scratch.txt",
        "git tag --list",
        "prettier --check x",
    ])("allows the read-only command %p", async (command) => {
        const fake = await setup({})

        expect((await shell(fake, "ac/explore", command)).effect).toBe("allow")
    })

    test("judges every parsed command of one call", async () => {
        const fake = await setup({})

        expect((await shell(fake, "ac/explore", "rg foo", "rm x")).effect).toBe("deny")
    })

    test("leaves other agents' shell calls to their own permissions", async () => {
        const fake = await setup({})

        expect((await shell(fake, "ac/plan-worker-junior", "rm -rf x")).effect).toBe("allow")
    })

    test("a guarded call does not spend the budget", async () => {
        const fake = await setup()
        for (let call = 0; call < BUDGET + 2; call++) await shell(fake, "ac/explore", "rm x")

        expect((await evaluate(fake, "ac/explore", "read")).effect).toBe("allow")
    })
})

describe("read-only reviewer shell guard", () => {
    const REVIEWERS = ["ac/oracle", "ac/plan-reviewer", "ac/plan-code-review", "ac/librarian"]

    function shell(fake: Awaited<ReturnType<typeof setup>>, agent: string, ...resources: string[]) {
        return fake.fire.permission("evaluate", {
            sessionID: "ses_a",
            agent: agent as AgentId,
            action: "shell",
            resources,
            effect: "allow",
        })
    }

    test.each(REVIEWERS)("%s is denied sed -i, prettier --write and a redirect with the read-only reason", async (agent) => {
        const fake = await setup({})

        for (const command of ["sed -i x f", "prettier --write f", "echo a > f"]) {
            const event = await shell(fake, agent, command)

            expect(event.effect).toBe("deny")
            expect(event.message).toContain(`${agent} is read-only`)
        }
    })

    test.each(REVIEWERS)("%s may still run rg, git log and bun test", async (agent) => {
        const fake = await setup({})

        for (const command of ["rg foo", "git log", "bun test"]) {
            expect((await shell(fake, agent, command)).effect).toBe("allow")
        }
    })

    test.each(REVIEWERS)("%s may run artisan test and read-only artisan subcommands", async (agent) => {
        const fake = await setup({})

        for (const command of [
            "php artisan test --parallel --filter='McpHitRateTest'",
            "php artisan test",
            "php artisan route:list --path=api",
            "php artisan migrate:status",
        ]) {
            expect((await shell(fake, agent, command)).effect).toBe("allow")
        }
    })

    test.each(REVIEWERS)("%s is still denied artisan commands that write or print secrets", async (agent) => {
        const fake = await setup({})

        for (const command of [
            "php artisan config:clear",
            "php artisan config:show database",
            "php artisan migrate",
            "php artisan test:custom-writer",
        ]) {
            expect((await shell(fake, agent, command)).effect).toBe("deny")
        }
    })

    test("ac/explore keeps the CC rule: an artisan test run is no search", async () => {
        const fake = await setup({})

        for (const command of ["php artisan test", "APP_ENV=testing php artisan test --filter X", "php artisan db:show"]) {
            expect((await shell(fake, "ac/explore", command)).effect).toBe("deny")
        }
        expect((await shell(fake, "ac/explore", "php artisan route:list")).effect).toBe("allow")
    })

    test("a reviewer reading a secret-shaped file is left to the agent's own permission rules", async () => {
        const fake = await setup({})

        expect((await shell(fake, "ac/oracle", "cat .env")).effect).toBe("allow")
    })

    test("a reviewer's shell calls spend no budget", async () => {
        const fake = await setup()
        for (let call = 0; call < BUDGET * 3; call++) await shell(fake, "ac/oracle", "rg foo")

        expect((await shell(fake, "ac/oracle", "rg foo")).effect).toBe("allow")
    })

    test("workers and the primary agent are unaffected", async () => {
        const fake = await setup({})

        for (const agent of ["ac/plan-worker-junior", "ac/plan-worker-senior", "build"]) {
            expect((await shell(fake, agent, "sed -i x f")).effect).toBe("allow")
        }
    })

    test("a reviewer's non-shell actions are untouched", async () => {
        const fake = await setup({})

        expect((await evaluate(fake, "ac/oracle", "edit")).effect).toBe("allow")
    })
})

describe("shell default timeout", () => {
    test("adds 180000 when the call carries no timeout", async () => {
        const fake = await setup()

        expect(await shellInput(fake, { command: "bun test" })).toEqual({ command: "bun test", timeout: 180000 })
    })

    test("keeps an explicit timeout", async () => {
        const fake = await setup()

        expect(await shellInput(fake, { command: "bun test", timeout: 5000 })).toEqual({
            command: "bun test",
            timeout: 5000,
        })
    })

    test("keeps an explicit 0, which disables the timeout", async () => {
        const fake = await setup()

        expect((await shellInput(fake, { command: "bun test", timeout: 0 })).timeout).toBe(0)
    })

    test("leaves background commands without a timeout", async () => {
        const fake = await setup()

        expect(await shellInput(fake, { command: "bun dev", background: true })).toEqual({
            command: "bun dev",
            background: true,
        })
    })

    test("leaves other tools untouched", async () => {
        const fake = await setup()

        const event = await fake.fire.tool("execute.before", { tool: "read", input: { path: "a.ts" } })

        expect(event.input).toEqual({ path: "a.ts" })
    })
})

describe("shell environment", () => {
    function created(env: Record<string, string | undefined> = {}) {
        return { command: "git rebase --continue", cwd: "/repo", timeout: 0, shell: "/bin/zsh", env }
    }

    test("every shell gets a non-interactive git and the path of the ac CLI beside this package", async () => {
        const fake = await setup()

        const event = await fake.fire.shell("create.before", created())

        expect(event.env).toMatchObject({
            GIT_EDITOR: "true",
            GIT_SEQUENCE_EDITOR: "true",
            GIT_MERGE_AUTOEDIT: "no",
            GIT_TERMINAL_PROMPT: "0",
        })
        expect(event.env.AC_CLI).toEndWith("/plugins/ac/cli/ac.js")
        expect(existsSync(event.env.AC_CLI as string)).toBe(true)
    })

    test("a value already in the environment is kept", async () => {
        const fake = await setup()

        const event = await fake.fire.shell("create.before", created({ GIT_EDITOR: "vim" }))

        expect(event.env.GIT_EDITOR).toBe("vim")
    })
})
