import { describe, expect, test } from "bun:test"
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
