import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadConfig } from "../src/config.ts"
import { createFakeCtx } from "./fake-ctx.ts"

let dir: string

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ac-oc-config-"))
})

afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
})

describe("loadConfig defaults", () => {
    test("oracle leads with codefast glm-5.3 at max", () => {
        const config = loadConfig({ env: {} })

        expect(config.chain("oracle")[0]).toBe("codefast-glm/glm-5.3#max")
    })

    test("opencode-go is the last resort of the main chain", () => {
        const config = loadConfig({ env: {} })

        expect(config.chain("main").at(-1)).toBe("opencode-go/glm-5.3#high")
    })

    test("every tier of the Balanced preset has a chain", () => {
        const config = loadConfig({ env: {} })

        expect(config.chain("main")).toEqual([
            "codefast-glm/glm-5.3#high",
            "codefast-kimi/kimi-k3#high",
            "codefast-deepseek/deepseek-v4-pro-0813#high",
            "opencode-go/glm-5.3#high",
        ])
        expect(config.chain("plan-worker-quick")).toEqual([
            "codefast-deepseek/deepseek-v4-pro-0813#low",
            "codefast-qwen/qwen3.8-max#low",
            "codefast-glm/glm-5.3#low",
            "opencode-go/glm-5.3-flash",
        ])
        expect(config.chain("title")).toEqual([
            "codefast-qwen/qwen3.8-max#low",
            "codefast-glm/glm-5.3#low",
            "opencode-go/glm-5.3-flash#low",
        ])
        for (const tier of [
            "plan-reviewer",
            "plan-code-review",
            "plan-worker-senior",
            "plan-worker-junior-high",
            "plan-worker-junior",
            "explore",
            "librarian",
            "qa-tester",
        ]) {
            expect(config.chain(tier).length).toBe(4)
        }
    })

    test("retry policy", () => {
        const config = loadConfig({ env: {} })

        expect(config.retryAttempts).toBe(2)
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
        expect(config.retryAttempts).toBe(2)
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
