import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadConfig, type ModelRef } from "../src/config.ts"
import { createFakeCtx } from "./fake-ctx.ts"

const TIERS = [
    "main",
    "oracle",
    "plan-reviewer",
    "design-director",
    "plan-code-review",
    "plan-worker-senior",
    "plan-worker-junior-high",
    "plan-worker-junior",
    "plan-worker-quick",
    "explore",
    "librarian",
    "qa-tester",
    "lane",
    "auto-verifier",
]

const SOL = "apimaster/gpt-6.1-sol"
const ASTRA = "apimaster/gpt-6-astra"
const LUNA = "apimaster/gpt-6-luna"

let dir: string

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ac-oc-config-"))
})

afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
})

describe("loadConfig defaults", () => {
    test("apimaster is the one provider of every chain, on sol, astra and luna, never above high effort", () => {
        const config = loadConfig({ env: {} })

        for (const tier of TIERS) {
            for (const ref of config.chain(tier)) expect(ref).toMatch(/^apimaster\/(gpt-6\.1-sol|gpt-6-astra|gpt-6-luna)#(low|medium|high)$/)
        }
        expect(config.groups).toEqual({})
        expect(config.rateLimits).toEqual({})
    })

    test("every tier has two rungs and astra, five times the sol price, is never the first", () => {
        const config = loadConfig({ env: {} })

        for (const tier of TIERS) {
            const [head, fallback] = config.chain(tier) as [ModelRef, ModelRef]
            expect(config.chain(tier)).toHaveLength(2)
            expect(head.startsWith(ASTRA)).toBe(false)
            expect(fallback.split("#")[0]).not.toBe(head.split("#")[0])
        }
        expect(config.chain("main")).toEqual([`${SOL}#high`, `${ASTRA}#medium`])
        expect(config.chain("explore")).toEqual([`${LUNA}#low`, `${SOL}#low`])
    })

    test("chain heads per tier follow the Claude Code ac shapes: sol high, sol medium, luna", () => {
        const config = loadConfig({ env: {} })

        expect(Object.fromEntries(TIERS.map((tier) => [tier, config.chain(tier)[0]]))).toEqual({
            main: `${SOL}#high`,
            oracle: `${SOL}#high`,
            "plan-reviewer": `${SOL}#medium`,
            "design-director": `${SOL}#medium`,
            "plan-code-review": `${SOL}#high`,
            "plan-worker-senior": `${SOL}#high`,
            "plan-worker-junior-high": `${SOL}#medium`,
            "plan-worker-junior": `${SOL}#medium`,
            "plan-worker-quick": `${LUNA}#medium`,
            explore: `${LUNA}#low`,
            librarian: `${SOL}#medium`,
            "qa-tester": `${SOL}#medium`,
            lane: `${SOL}#medium`,
            "auto-verifier": `${SOL}#high`,
        })
    })

    test("no title tier: the title model is set in templates/opencode.jsonc, nothing routes a chain for it", () => {
        expect(() => loadConfig({ env: {} }).chain("title")).toThrow("title")
    })

    test("retry policy", () => {
        const config = loadConfig({ env: {} })

        expect(config.retryAttempts).toBe(3)
        expect(config.cooldownSeconds).toBe(30)
        expect(config.retryOn).toEqual([429, 500, 502, 503, 504])
    })

    test("rate limit policy: no provider group, and a 429 is retried 30 times on the schedule", () => {
        const config = loadConfig({ env: {} })

        expect(config.rateLimitRetries).toBe(30)
        expect([1, 3, 4, 5, 6, 10, 11, 15, 16, 20, 21, 30].map((retry) => config.rateLimitDelayMs(retry))).toEqual([
            1_000,
            1_000,
            2_000,
            2_000,
            3_000,
            3_000,
            5_000,
            5_000,
            10_000,
            10_000,
            15_000,
            15_000,
        ])
        expect(config.rateLimitDelayMs(31)).toBe(15_000)
        expect(config.groups).toEqual({})
    })

    test("an unknown tier throws instead of returning an empty chain", () => {
        expect(() => loadConfig({ env: {} }).chain("nope")).toThrow("nope")
    })

    test("a malformed chain entry fails the load, naming the tier", () => {
        expect(() => loadConfig({ env: {}, options: { models: { tiers: { oracle: ["no-slash"] } } } })).toThrow(
            'Invalid model reference "no-slash" in tier "oracle"',
        )
    })

    test("a lane or worker cap below one fails the load", () => {
        expect(() => loadConfig({ env: {}, options: { models: { maxLanes: 0 } } })).toThrow("maxLanes")
        expect(() => loadConfig({ env: {}, options: { models: { maxParallel: 1.5 } } })).toThrow("maxParallel")
    })

    test("tiers lists the tiers that have a chain", () => {
        const config = loadConfig({ env: {}, options: { models: { tiers: { oracle: [] } } } })

        expect(config.tiers()).toContain("main")
        expect(config.tiers()).not.toContain("oracle")
    })

    test("hasChain answers for configured, unknown and emptied tiers without throwing", () => {
        const config = loadConfig({ env: {}, options: { models: { tiers: { oracle: [] } } } })

        expect(config.hasChain("main")).toBe(true)
        expect(config.hasChain("nope")).toBe(false)
        expect(config.hasChain("oracle")).toBe(false)
    })
})

describe("loadConfig overrides", () => {
    test("plugin options replace one tier and leave the others", () => {
        const config = loadConfig({
            env: {},
            options: { models: { tiers: { oracle: ["acme/big#max"] } } },
        })

        expect(config.chain("oracle")).toEqual(["acme/big#max"])
        expect(config.chain("main")).toEqual(loadConfig({ env: {} }).chain("main"))
    })

    test("AC_OPENCODE_MODELS file replaces a tier, tolerating comments and trailing commas", () => {
        const file = join(dir, "models.jsonc")
        writeFileSync(
            file,
            `{
                // custom provider for the explorer
                "tiers": {
                    "explore": ["acme/fast#low",],
                },
                "retryAttempts": 4,
            }`,
        )

        const config = loadConfig({ env: { AC_OPENCODE_MODELS: file } })

        expect(config.chain("explore")).toEqual(["acme/fast#low"])
        expect(config.chain("oracle")).toEqual(loadConfig({ env: {} }).chain("oracle"))
        expect(config.retryAttempts).toBe(4)
        expect(config.cooldownSeconds).toBe(30)
    })

    test("groups and rateLimitBackoff replace the defaults like the other scalar fields", () => {
        const config = loadConfig({
            env: {},
            options: {
                models: {
                    groups: { acme: ["acme-a", "acme-b"] },
                    rateLimitBackoff: [{ through: 4, seconds: 2 }],
                },
            },
        })

        expect(config.groups).toEqual({ acme: ["acme-a", "acme-b"] })
        expect(config.rateLimitRetries).toBe(4)
        expect(config.rateLimitDelayMs(1)).toBe(2_000)
        expect(config.retryAttempts).toBe(3)
    })

    test("a rateLimitBackoff that is empty or out of order is rejected", () => {
        for (const rateLimitBackoff of [[], [{ through: 5, seconds: 1 }, { through: 5, seconds: 2 }]]) {
            expect(() => loadConfig({ env: {}, options: { models: { rateLimitBackoff } } })).toThrow(/rateLimitBackoff/)
        }
    })

    test("maxParallel defaults to 3, the worker cap under one shared 25 RPM group, and is overridable", () => {
        expect(loadConfig({ env: {} }).maxParallel).toBe(3)
        expect(loadConfig({ env: {}, options: { models: { maxParallel: 6 } } }).maxParallel).toBe(6)
    })

    test("prepend puts a custom provider in front of the default chain", () => {
        const config = loadConfig({
            env: {},
            options: { models: { tiers: { librarian: { prepend: ["acme/docs#high"] } } } },
        })

        expect(config.chain("librarian")).toEqual(["acme/docs#high", ...loadConfig({ env: {} }).chain("librarian")])
    })

    test("the env file wins over plugin options", () => {
        const file = join(dir, "models.jsonc")
        writeFileSync(file, `{ "tiers": { "oracle": ["env/model"] } }`)

        const config = loadConfig({
            env: { AC_OPENCODE_MODELS: file },
            options: { models: { tiers: { oracle: ["options/model"] } } },
        })

        expect(config.chain("oracle")).toEqual(["env/model"])
    })

    test("a missing AC_OPENCODE_MODELS file propagates the error", () => {
        expect(() => loadConfig({ env: { AC_OPENCODE_MODELS: join(dir, "absent.jsonc") } })).toThrow("absent.jsonc")
    })
})

describe("fake ctx", () => {
    test("fires a context hook and records the session.synthetic call it makes", async () => {
        const fake = createFakeCtx({ sessions: { s1: { id: "s1", parentID: "root" } } })

        await fake.ctx.session.hook("context", async (input) => {
            const info = await fake.ctx.session.get({ sessionID: input.sessionID })
            if (info.parentID === undefined) return
            await fake.ctx.session.synthetic({ sessionID: input.sessionID, text: "nudge" } as never)
        })
        await fake.fire.session("context", { sessionID: "s1" })

        expect(fake.calls.get).toEqual([{ sessionID: "s1" }])
        expect(fake.calls.synthetic).toEqual([{ sessionID: "s1", text: "nudge" }])
    })

    test("event.subscribe yields what the test pushes", async () => {
        const fake = createFakeCtx()
        const seen: string[] = []
        const done = (async () => {
            for await (const event of fake.ctx.event.subscribe()) {
                seen.push(event.type)
                if (seen.length === 2) return
            }
        })()

        fake.pushEvent({ type: "a" })
        fake.pushEvent({ type: "b" })
        await done

        expect(seen).toEqual(["a", "b"])
    })

    test("tool and command transforms receive an editor and expose what was added", async () => {
        const fake = createFakeCtx()

        await fake.ctx.command.transform((editor) => {
            editor.add({ name: "ac/plan", description: "plan", execute: async () => {} })
        })
        await fake.ctx.tool.transform((editor) => {
            expect(editor.get("missing")).toBeUndefined()
        })
        fake.applyTransforms()

        expect(fake.commands.map((c) => c.name)).toEqual(["ac/plan"])
    })
})
