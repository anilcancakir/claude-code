import { describe, expect, test } from "bun:test"
import type { CommandDefinition } from "@opencode/plugin/promise/command"
import { registerCommands } from "../src/commands.ts"
import { createFakeCtx } from "./fake-ctx.ts"

type Invocation = Parameters<CommandDefinition["execute"]>[0]

async function registered() {
    const fake = createFakeCtx()
    await registerCommands(fake.ctx)
    fake.applyTransforms()

    return fake
}

function invocation(text: string): Invocation {
    return { sessionID: "ses_test", prompt: { text }, delivery: "queue" } as unknown as Invocation
}

describe("registerCommands", () => {
    test("registers the five ac commands, each with a description", async () => {
        const { commands } = await registered()

        expect(commands.map((command) => command.name)).toEqual([
            "ac/plan",
            "ac/execute",
            "ac/coordinate",
            "ac/commit",
            "ac/qa",
        ])
        for (const command of commands) expect(command.description).toBeTruthy()
    })

    test("ac/plan forwards the argument text and attaches the plan skill", async () => {
        const { commands, calls } = await registered()

        await commands.find((command) => command.name === "ac/plan")?.execute(invocation("add x"))

        expect(calls.prompt).toHaveLength(1)
        expect(calls.prompt[0]).toMatchObject({
            sessionID: "ses_test",
            text: "add x",
            skills: [{ id: "plan" }],
            delivery: "queue",
        })
    })

    test.each(["execute", "commit", "qa"])("ac/%s attaches the skill of the same id", async (id) => {
        const { commands, calls } = await registered()

        await commands.find((command) => command.name === `ac/${id}`)?.execute(invocation("arg"))

        expect(calls.prompt[0]).toMatchObject({ text: "arg", skills: [{ id }] })
    })

    test("no command pins an agent", async () => {
        const { commands, calls } = await registered()

        for (const command of commands) await command.execute(invocation("arg"))

        expect(calls.prompt).toHaveLength(5)
        for (const call of calls.prompt) expect(call).not.toHaveProperty("agent")
        for (const command of commands) expect(command).not.toHaveProperty("agent")
    })
})
