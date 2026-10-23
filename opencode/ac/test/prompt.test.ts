import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import type { SessionContext } from "@opencode/plugin/promise/session"
import { registerPrompt } from "../src/prompt.ts"
import { createFakeCtx } from "./fake-ctx.ts"

const PROMPTS_DIR = fileURLToPath(new URL("../src/prompts/", import.meta.url))
const DEFAULT_SYSTEM = "You are an AI agent running in OpenCode, a coding agent harness."
const INSTRUCTIONS = "Instructions from: /repo/AGENTS.md"
const UPSTREAM_MODEL_DESCRIPTION = "NEVER set this unless the user explicitly asks for a particular model or variant."

const prompt = (name: string): string => readFileSync(`${PROMPTS_DIR}${name}.md`, "utf8").trim()
const expected = (overlay?: string): string =>
    overlay ? `${prompt("core")}\n\n${prompt(overlay)}` : prompt("core")

function subagentTool(): SessionContext["tools"][string] {
    return {
        description: "Spawns an agent in a child session to work on the specified task.",
        input: {
            type: "object",
            properties: {
                agent: { type: "string", description: "The type of specialized agent." },
                model: { type: "string", description: UPSTREAM_MODEL_DESCRIPTION },
            },
        },
    }
}

function contextEvent(agent: string, modelID: string, sessionID = "ses_1") {
    return {
        sessionID,
        agent,
        model: { providerID: "opencode-go", id: modelID } as SessionContext["model"],
        system: [
            { type: "text" as const, text: DEFAULT_SYSTEM, cache: { type: "ephemeral" } },
            { type: "text" as const, text: INSTRUCTIONS },
        ] as SessionContext["system"],
        messages: [],
        options: {},
        tools: { subagent: subagentTool() },
    }
}

async function setup() {
    const fake = createFakeCtx()
    await registerPrompt(fake.ctx)
    return fake
}

describe("registerPrompt system[0]", () => {
    test.each([
        ["glm-5.3", "glm"],
        ["kimi-k3", "kimi"],
        ["gpt-6-luna", "gpt"],
        ["deepseek-v4-pro", "deepseek"],
    ])("build on %s gets the core plus the %s overlay", async (modelID, overlay) => {
        const fake = await setup()

        const event = await fake.fire.session("context", contextEvent("build", modelID))

        expect(event.system[0]?.text).toBe(expected(overlay))
    })

    test("an unknown family gets the core alone", async () => {
        const fake = await setup()

        const event = await fake.fire.session("context", contextEvent("build", "qwen-4-coder"))

        expect(event.system[0]?.text).toBe(expected())
    })

    test("keeps the part's cache hint and every later system part", async () => {
        const fake = await setup()

        const event = await fake.fire.session("context", contextEvent("build", "glm-5.3"))

        expect(event.system[0]?.cache).toEqual({ type: "ephemeral" })
        expect(event.system[1]?.text).toBe(INSTRUCTIONS)
        expect(event.system).toHaveLength(2)
    })

    test("an ac subagent keeps its own system text", async () => {
        const fake = await setup()

        const event = await fake.fire.session("context", contextEvent("ac/oracle", "glm-5.3"))

        expect(event.system[0]?.text).toBe(DEFAULT_SYSTEM)
    })

    test("two context events in one session yield byte-identical system[0]", async () => {
        const fake = await setup()

        const first = await fake.fire.session("context", contextEvent("build", "kimi-k3"))
        const second = await fake.fire.session("context", contextEvent("build", "kimi-k3"))

        expect(second.system[0]?.text).toBe(first.system[0]?.text as string)
    })

    test.each(["compaction", "generate"] as const)("the %s request gets the same text", async (hook) => {
        const fake = await setup()

        const event = await fake.fire.session(hook, contextEvent("build", "glm-5.3"))

        expect(event.system[0]?.text).toBe(expected("glm"))
    })
})

describe("registerPrompt subagent tool", () => {
    test("rewrites the model parameter so an ac flow may pass a fallback model", async () => {
        const fake = await setup()
        const event = contextEvent("build", "glm-5.3")
        const original = event.tools.subagent
        const originalProperties = original.input.properties as Record<string, { description: string }>

        const fired = await fake.fire.session("context", event)

        // opencode maps a hooked definition back to its tool by object identity, and the input schema it
        // hands out is a shallow copy of the tool's own, so the rewrite keeps the definition and copies down.
        const properties = fired.tools.subagent?.input.properties as Record<string, { description: string }>
        expect(properties.model?.description).not.toContain("NEVER set this")
        expect(properties.model?.description).toContain("fallback")
        expect(properties.agent?.description).toBe("The type of specialized agent.")
        expect(fired.tools.subagent).toBe(original)
        expect(originalProperties.model?.description).toBe(UPSTREAM_MODEL_DESCRIPTION)
    })

    test("leaves a request without the subagent tool alone", async () => {
        const fake = await setup()
        const event = { ...contextEvent("build", "glm-5.3"), tools: {} }

        const fired = await fake.fire.session("context", event)

        expect(fired.tools).toEqual({})
    })
})

describe("prompt files", () => {
    test("name no Claude Code tool and carry no dash characters or personal language", () => {
        for (const file of readdirSync(PROMPTS_DIR)) {
            const text = readFileSync(`${PROMPTS_DIR}${file}`, "utf8")
            expect(text).not.toMatch(/[–—]|AskUserQuestion|\bAgent\(|\bBash\b|TodoWrite|Turkish/)
        }
    })

    test("stay inside their size budget", () => {
        expect(prompt("core").length).toBeLessThanOrEqual(6200)
        for (const overlay of ["gpt", "glm", "kimi", "deepseek"]) {
            expect(prompt(overlay).length).toBeLessThanOrEqual(2700)
        }
    })
})
