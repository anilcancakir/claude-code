import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { loadConfig, type ModelRef, parseJsonc } from "../src/config.ts"
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

const OPUS = "anthropic/claude-opus-5-5"
const SONNET = "anthropic/claude-sonnet-5-5"
const HAIKU = "anthropic/claude-haiku-5-5"
const CODEFAST = /^codefast-(glm\/glm-5\.3|kimi\/kimi-k3|deepseek\/deepseek-v4\.1-flash(-1017)?|qwen\/qwen3\.8-flash)#/

/** The Claude rung per tier, following the Claude Code ac mapping of agent to model and effort. */
const CLAUDE_RUNG: Record<string, ModelRef> = {
    main: `${OPUS}#high`,
    oracle: `${OPUS}#high`,
    "plan-reviewer": `${OPUS}#medium`,
    "design-director": `${OPUS}#medium`,
    "plan-code-review": `${OPUS}#high`,
    "plan-worker-senior": `${OPUS}#medium`,
    "plan-worker-junior-high": `${SONNET}#high`,
    "plan-worker-junior": `${SONNET}#high`,
    "plan-worker-quick": `${HAIKU}#medium`,
    explore: `${HAIKU}#medium`,
    librarian: `${SONNET}#high`,
    "qa-tester": `${SONNET}#high`,
    lane: `${OPUS}#high`,
    "auto-verifier": `${OPUS}#high`,
}

/** The two review gates and the design director: read-only advisors that lead with Opus and fall back to codefast. */
const REVIEW_GATES = [
    "oracle",
    "plan-reviewer",
    "design-director",
]

const PRESET_PATH = fileURLToPath(new URL("../config/presets/claude.jsonc", import.meta.url))

interface Preset {
    title: ModelRef
    tiers: Record<string, ModelRef[]>
}

const claudePreset = (): Preset => parseJsonc(readFileSync(PRESET_PATH, "utf8"), PRESET_PATH) as Preset

let dir: string

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ac-oc-config-"))
})

afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
})

describe("loadConfig defaults", () => {
    test("the review gates and the design director lead with Opus on the Claude API, then Kimi K3", () => {
        const config = loadConfig({ env: {} })

        for (const tier of REVIEW_GATES) {
            expect(config.chain(tier)[0]).toBe(CLAUDE_RUNG[tier] as string)
            expect(config.chain(tier)[1]).toStartWith("codefast-kimi/kimi-k3#")
        }
    })

    test("every other chain runs the four codefast families, then one Claude rung outside the codefast group", () => {
        const config = loadConfig({ env: {} })

        for (const tier of TIERS) {
            const chain = config.chain(tier)
            const codefast = REVIEW_GATES.includes(tier) ? chain.slice(1) : chain.slice(0, -1)
            for (const ref of codefast) expect(ref).toMatch(CODEFAST)
            expect(chain).toContain(CLAUDE_RUNG[tier] as string)
        }
        expect(Object.values(config.groups).flat()).not.toContain("anthropic")
    })

    test("every tier of the Balanced preset has a chain", () => {
        const config = loadConfig({ env: {} })

        expect(config.chain("main")).toEqual([
            "codefast-glm/glm-5.3#high",
            "codefast-deepseek/deepseek-v4.1-flash-1017#high",
            "codefast-kimi/kimi-k3#high",
            "anthropic/claude-opus-5-5#high",
        ])
        expect(config.chain("plan-code-review")).toEqual([
            "codefast-glm/glm-5.3#max",
            "codefast-kimi/kimi-k3#high",
            "codefast-deepseek/deepseek-v4.1-flash-1017#max",
            "anthropic/claude-opus-5-5#high",
        ])
        expect(config.chain("plan-worker-quick")).toEqual([
            "codefast-deepseek/deepseek-v4.1-flash-1017#low",
            "codefast-qwen/qwen3.8-flash#low",
            "codefast-deepseek/deepseek-v4.1-flash#low",
            "anthropic/claude-haiku-5-5#medium",
        ])
        for (const tier of TIERS) expect(config.chain(tier).length).toBe(4)
    })

    test("chain heads per tier", () => {
        const config = loadConfig({ env: {} })

        expect(Object.fromEntries(TIERS.map((tier) => [tier, config.chain(tier)[0]]))).toEqual({
            main: "codefast-glm/glm-5.3#high",
            oracle: "anthropic/claude-opus-5-5#high",
            "plan-reviewer": "anthropic/claude-opus-5-5#medium",
            "design-director": "anthropic/claude-opus-5-5#medium",
            "plan-code-review": "codefast-glm/glm-5.3#max",
            "plan-worker-senior": "codefast-glm/glm-5.3#max",
            "plan-worker-junior-high": "codefast-deepseek/deepseek-v4.1-flash-1017#high",
            "plan-worker-junior": "codefast-deepseek/deepseek-v4.1-flash-1017#high",
            "plan-worker-quick": "codefast-deepseek/deepseek-v4.1-flash-1017#low",
            explore: "codefast-deepseek/deepseek-v4.1-flash-1017#low",
            librarian: "codefast-deepseek/deepseek-v4.1-flash-1017#high",
            "qa-tester": "codefast-deepseek/deepseek-v4.1-flash-1017#high",
            lane: "codefast-glm/glm-5.3#high",
            "auto-verifier": "codefast-kimi/kimi-k3#max",
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

    test("rate limit policy: codefast endpoints share one group and a 429 is retried 30 times on the schedule", () => {
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
        expect(config.groups).toEqual({
            codefast: [
                "codefast-glm",
                "codefast-kimi",
                "codefast-deepseek",
                "codefast-qwen",
            ],
            "codefast-gpt-unlimited": ["codefast-gpt-unlimited"],
        })
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

describe("claude preset", () => {
    test("covers every tier, each chain led by its Claude rung and followed by codefast entries", () => {
        const { tiers } = claudePreset()

        expect(Object.keys(tiers).sort()).toEqual([...TIERS].sort())
        for (const tier of TIERS) {
            const chain = tiers[tier] as ModelRef[]
            expect(chain[0]).toBe(CLAUDE_RUNG[tier] as string)
            expect(chain.length).toBeGreaterThanOrEqual(3)
            for (const ref of chain.slice(1)) expect(ref).toMatch(CODEFAST)
        }
    })

    test("follows the Claude rung with the first two codefast entries of the default chain", () => {
        const { tiers } = claudePreset()
        const defaults = loadConfig({ env: {} })

        for (const tier of TIERS) {
            const codefast = defaults.chain(tier).filter((ref) => !ref.startsWith("anthropic/"))
            expect(tiers[tier]?.slice(1)).toEqual(codefast.slice(0, 2))
        }
    })

    test("loads as plugin options and replaces every default chain", () => {
        const { tiers } = claudePreset()

        const config = loadConfig({ env: {}, options: { models: { tiers } } })

        for (const tier of TIERS) expect(config.chain(tier)).toEqual(tiers[tier] as ModelRef[])
        expect(config.groups).toEqual(loadConfig({ env: {} }).groups)
        expect(config.retryAttempts).toBe(3)
    })

    test("names a fast low-effort Claude title model", () => {
        expect(claudePreset().title).toBe("anthropic/claude-haiku-5-5#low")
    })
})

describe("gpt presets", () => {
    const TEMPLATE_PATH = fileURLToPath(new URL("../templates/opencode.jsonc", import.meta.url))
    const template = parseJsonc(readFileSync(TEMPLATE_PATH, "utf8"), TEMPLATE_PATH) as {
        providers: Record<string, { models: Record<string, { capabilities: { reasoning: { effort: string[] } } }> }>
    }
    const preset = (name: string): Preset & { maxLanes?: number; maxParallel?: number } => {
        const path = fileURLToPath(new URL(`../config/presets/${name}.jsonc`, import.meta.url))
        return parseJsonc(readFileSync(path, "utf8"), path) as Preset
    }

    for (const [name, provider] of [["gpt", "codefast-gpt"], ["gpt-unlimited", "codefast-gpt-unlimited"]] as const) {
        test(`${name}: every tier leads with two ${provider} entries, then its default chain head`, () => {
            const { tiers } = preset(name)
            const defaults = loadConfig({ env: {} })

            expect(Object.keys(tiers).sort()).toEqual([...TIERS].sort())
            for (const tier of TIERS) {
                const chain = tiers[tier] as ModelRef[]
                expect(chain.slice(0, 2).every((ref) => ref.startsWith(`${provider}/`))).toBe(true)
                expect(chain[2]).toBe(defaults.chain(tier)[0] as string)
            }
        })

        test(`${name}: every GPT entry and the title name a model and a variant the template declares`, () => {
            const { tiers, title } = preset(name)
            const refs = [title, ...Object.values(tiers).flat()].filter((ref) => ref.startsWith(`${provider}/`))

            const undeclared = refs.filter((ref) => {
                const [model, variant] = ref.slice(provider.length + 1).split("#") as [string, string]
                const declared = template.providers[provider]?.models[model]
                return !declared?.capabilities.reasoning.effort.includes(variant)
            })
            expect(undeclared).toEqual([])
        })
    }

    test("gpt-unlimited stays within the endpoint's 4 concurrent requests: one lane, two workers", () => {
        expect(preset("gpt-unlimited")).toMatchObject({ maxLanes: 1, maxParallel: 2 })
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
