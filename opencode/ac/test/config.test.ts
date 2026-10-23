import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadConfig } from "../src/config.ts"
import { createFakeCtx } from "./fake-ctx.ts"

const TIERS = [
    "main",
    "oracle",
    "plan-reviewer",
    "plan-code-review",
    "plan-worker-senior",
    "plan-worker-junior-high",
    "plan-worker-junior",
    "plan-worker-quick",
    "explore",
    "librarian",
    "qa-tester",
]

let dir: string

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ac-oc-config-"))
})

afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
})

describe("loadConfig defaults", () => {
    test("oracle leads with Kimi K3 at max, a different family from the GLM-5.3 main session", () => {
        const config = loadConfig({ env: {} })

        expect(config.chain("oracle")[0]).toBe("codefast-kimi/kimi-k3#max")
    })

    test("every chain stays inside the four codefast families", () => {
        const config = loadConfig({ env: {} })
        const families = /^codefast-(glm\/glm-5\.3|kimi\/kimi-k3|deepseek\/deepseek-v4\.1-flash(-1017)?|qwen\/qwen3\.8-flash)#/

        for (const tier of TIERS) {
            for (const ref of config.chain(tier)) expect(ref).toMatch(families)
        }
    })

    test("every tier of the Balanced preset has a chain", () => {
        const config = loadConfig({ env: {} })

        expect(config.chain("main")).toEqual([
            "codefast-glm/glm-5.3#high",
            "codefast-deepseek/deepseek-v4.1-flash-1017#high",
            "codefast-kimi/kimi-k3#high",
        ])
        expect(config.chain("plan-code-review")).toEqual([
            "codefast-glm/glm-5.3#max",
            "codefast-kimi/kimi-k3#high",
            "codefast-deepseek/deepseek-v4.1-flash-1017#max",
        ])
        expect(config.chain("plan-worker-quick")).toEqual([
            "codefast-deepseek/deepseek-v4.1-flash-1017#low",
            "codefast-qwen/qwen3.8-flash#low",
            "codefast-deepseek/deepseek-v4.1-flash#low",
        ])
        for (const tier of TIERS) expect(config.chain(tier).length).toBe(3)
    })

    test("chain heads per tier", () => {
        const config = loadConfig({ env: {} })

        expect(Object.fromEntries(TIERS.map((tier) => [tier, config.chain(tier)[0]]))).toEqual({
            main: "codefast-glm/glm-5.3#high",
            oracle: "codefast-kimi/kimi-k3#max",
            "plan-reviewer": "codefast-kimi/kimi-k3#high",
            "plan-code-review": "codefast-glm/glm-5.3#max",
            "plan-worker-senior": "codefast-glm/glm-5.3#max",
            "plan-worker-junior-high": "codefast-deepseek/deepseek-v4.1-flash-1017#high",
            "plan-worker-junior": "codefast-deepseek/deepseek-v4.1-flash-1017#high",
            "plan-worker-quick": "codefast-deepseek/deepseek-v4.1-flash-1017#low",
            explore: "codefast-deepseek/deepseek-v4.1-flash-1017#low",
            librarian: "codefast-deepseek/deepseek-v4.1-flash-1017#high",
            "qa-tester": "codefast-deepseek/deepseek-v4.1-flash-1017#high",
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

    test("rate limit policy: codefast endpoints share one group and 429 waits ten attempts", () => {
        const config = loadConfig({ env: {} })

        expect(config.rateLimitAttempts).toBe(10)
        expect(config.groups).toEqual({
            codefast: [
                "codefast-glm",
                "codefast-kimi",
                "codefast-deepseek",
                "codefast-qwen",
            ],
        })
    })

    test("an unknown tier throws instead of returning an empty chain", () => {
        expect(() => loadConfig({ env: {} }).chain("nope")).toThrow("nope")
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

    test("groups and rateLimitAttempts merge like the other scalar fields", () => {
        const config = loadConfig({
            env: {},
            options: { models: { groups: { acme: ["acme-a", "acme-b"] }, rateLimitAttempts: 4 } },
        })

        expect(config.groups).toEqual({ acme: ["acme-a", "acme-b"] })
        expect(config.rateLimitAttempts).toBe(4)
        expect(config.retryAttempts).toBe(3)
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
