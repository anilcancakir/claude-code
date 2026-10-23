import { afterEach, describe, expect, setSystemTime, spyOn, test } from "bun:test"
import type { SessionRetry } from "@opencode/plugin/promise/session"
import type { ToolContext } from "@opencode/plugin/promise/tool"
import { loadConfig, type ModelConfig } from "../src/config.ts"
import { registerFallback } from "../src/fallback.ts"
import { createFakeCtx, type FakeCtx } from "./fake-ctx.ts"

/**
 * Fixture chains, independent of config/models.jsonc, so a preset edit cannot break the fallback mechanics.
 */
const MAIN = ["alpha/one#high", "beta/two#high", "gamma/three#high"]
const WORKER = ["alpha/code", "beta/two#high", "gamma/three#high"]

/** Attempt at which the default `rateLimitAttempts` lets the fallback act on a 429. */
const RATE_LIMIT_CAP = 7
/** Attempt at which the default `retryAttempts` lets the fallback act on any other retryable status. */
const RETRY_CAP = 3

/** `alpha` and `beta` share one rate-limit group; `gamma` is its own. */
const SHARED_GROUPS = { shared: ["alpha", "beta"] }

function fixtureConfig(groups: Record<string, string[]> = {}): ModelConfig {
    return loadConfig({
        env: {},
        options: { models: { groups, tiers: { main: MAIN, "plan-worker-junior": WORKER } } },
    })
}

function modelRef(ref: string): SessionRetry["model"] {
    const slash = ref.indexOf("/")
    const hash = ref.indexOf("#", slash + 1)
    return {
        providerID: ref.slice(0, slash),
        id: ref.slice(slash + 1, hash === -1 ? undefined : hash),
        ...(hash === -1 ? {} : { variant: ref.slice(hash + 1) }),
    } as SessionRetry["model"]
}

/** Every fixture model; `ctx.model.list()` answers with the models of connected providers only. */
const CONNECTED = [
    ...MAIN,
    ...WORKER,
    "openrouter/anthropic/claude-sonnet-5-5#max",
]

interface SetupOptions {
    /** Models `ctx.model.list()` returns; defaults to every fixture model. */
    connected?: readonly string[]
    /** The session's current model as `session.get` reports it; defaults to the last model switched to. */
    currentModel?: (sessionID: string) => string | undefined
}

/**
 * The Step 1 fake does not script `model.list`, so the connected model catalogue is attached here. `session.get`
 * reports the model the last switch selected, as the host does once it has applied `switchModel`.
 */
async function setup(config: ModelConfig = fixtureConfig(), options: SetupOptions = {}): Promise<FakeCtx> {
    const fake = createFakeCtx()
    const connected = options.connected ?? CONNECTED
    const lastSwitched = (sessionID: string): { providerID: string; id: string } | undefined =>
        fake.calls.switchModel.filter((call) => call.sessionID === sessionID).at(-1)?.model
    Object.assign(fake.ctx.session, {
        get: async (query: { sessionID: string }) => {
            const current = options.currentModel?.(query.sessionID)
            return {
                id: query.sessionID,
                model: current === undefined ? lastSwitched(query.sessionID) : modelRef(current),
            }
        },
    })
    Object.assign(fake.ctx, {
        model: {
            list: async () => ({
                data: connected.map((ref) => {
                    const { providerID, id } = modelRef(ref)
                    return { providerID, id }
                }),
            }),
        },
    })
    await registerFallback(fake.ctx, config)
    return fake
}

interface RetryInput {
    sessionID?: string
    agent?: string
    model: string
    status?: number
    attempt?: number
}

async function retry(fake: FakeCtx, input: RetryInput): Promise<SessionRetry> {
    return fake.fire.session("retry", {
        sessionID: input.sessionID ?? "ses_main",
        agent: input.agent ?? "build",
        model: modelRef(input.model),
        error: {
            type: "provider.rate-limit",
            message: "rate limited",
            status: input.status ?? 429,
        },
        attempt: input.attempt ?? (input.status === undefined || input.status === 429 ? RATE_LIMIT_CAP : RETRY_CAP),
        decision: {
            retry: true,
            delay: 2_000,
        },
    })
}

async function fallbackNext(
    fake: FakeCtx,
    input: { tier: string; tried: string[]; status?: number },
): Promise<unknown> {
    fake.applyTransforms()
    const tool = fake.tools.get("ac_fallback_next")
    if (!tool) throw new Error("ac_fallback_next is not registered")
    const result = await tool.execute(input, {} as ToolContext)
    return result.content
}

afterEach(() => {
    setSystemTime()
})

describe("main session fallback", () => {
    test("a failure at the attempt cap switches to chain[1] and leaves the retry going, with no replay", async () => {
        const fake = await setup()

        const event = await retry(fake, { model: MAIN[0] as string })

        expect(event.decision).toEqual({ retry: true, delay: 0 })
        expect(fake.calls.switchModel).toEqual([
            {
                sessionID: "ses_main",
                model: modelRef(MAIN[1] as string),
            },
        ] as unknown as typeof fake.calls.switchModel)
        expect(fake.calls.prompt).toHaveLength(0)
    })

    test("the replacement model gets its own retryAttempts before the next switch", async () => {
        const fake = await setup()

        await retry(fake, { model: MAIN[0] as string, status: 500, attempt: RETRY_CAP })
        await retry(fake, { model: MAIN[1] as string, status: 500, attempt: RETRY_CAP + 1 })
        expect(fake.calls.switchModel).toHaveLength(1)

        await retry(fake, { model: MAIN[1] as string, status: 500, attempt: RETRY_CAP + 2 })
        expect(fake.calls.switchModel.map((call) => call.model)).toEqual([
            modelRef(MAIN[1] as string),
            modelRef(MAIN[2] as string),
        ])
    })

    test("a new step restarts the attempt count on the switched model", async () => {
        const fake = await setup()

        await retry(fake, { model: MAIN[0] as string, status: 500, attempt: RETRY_CAP })
        await retry(fake, { model: MAIN[1] as string, status: 500, attempt: 2 })
        expect(fake.calls.switchModel).toHaveLength(1)

        await retry(fake, { model: MAIN[1] as string, status: 500, attempt: RETRY_CAP })
        expect(fake.calls.switchModel).toHaveLength(2)
    })

    test("a 502 right after a group-wide 429 still switches inside the cooling group", async () => {
        const fake = await setup(fixtureConfig(SHARED_GROUPS))

        await retry(fake, { model: MAIN[0] as string, attempt: RATE_LIMIT_CAP })
        await retry(fake, { model: MAIN[2] as string, status: 502, attempt: RATE_LIMIT_CAP + RETRY_CAP - 1 })

        expect(fake.calls.switchModel.map((call) => call.model)).toEqual([
            modelRef(MAIN[2] as string),
            modelRef(MAIN[1] as string),
        ])
    })

    test("from host attempt 10 a failure switches below the per-model cap, so later rungs get the last retries", async () => {
        const config = loadConfig({
            env: {},
            options: { models: { rateLimitAttempts: 10, tiers: { main: MAIN } } },
        })
        const fake = await setup(config)

        await retry(fake, { model: MAIN[0] as string, status: 500, attempt: RETRY_CAP })
        await retry(fake, { model: MAIN[1] as string, attempt: 9 })
        expect(fake.calls.switchModel).toHaveLength(1)

        const event = await retry(fake, { model: MAIN[1] as string, attempt: 10 })

        expect(event.decision).toEqual({ retry: true, delay: 0 })
        expect(fake.calls.switchModel.map((call) => call.model)).toEqual([
            modelRef(MAIN[1] as string),
            modelRef(MAIN[2] as string),
        ])
    })

    test("a second failure on the replacement moves to chain[2]", async () => {
        const fake = await setup()

        await retry(fake, { model: MAIN[0] as string })
        await retry(fake, { model: MAIN[1] as string })

        expect(fake.calls.switchModel.map((call) => call.model)).toEqual([
            modelRef(MAIN[1] as string),
            modelRef(MAIN[2] as string),
        ])
        expect(fake.calls.prompt).toHaveLength(0)
    })

    test("an exhausted chain switches no further and leaves the host decision alone", async () => {
        const fake = await setup()

        await retry(fake, { model: MAIN[0] as string })
        await retry(fake, { model: MAIN[1] as string })
        const last = await retry(fake, { model: MAIN[2] as string })

        expect(last.decision).toEqual({ retry: true, delay: 2_000 })
        expect(fake.calls.switchModel).toHaveLength(2)
        expect(fake.calls.prompt).toHaveLength(0)
    })

    test("a repeated observation of an already handled model is not acted on twice", async () => {
        const fake = await setup()

        await retry(fake, { model: MAIN[0] as string })
        const stale = await retry(fake, { model: MAIN[0] as string, attempt: RATE_LIMIT_CAP + 1 })

        expect(stale.decision).toEqual({ retry: true, delay: 2_000 })
        expect(fake.calls.switchModel).toHaveLength(1)
    })

    test("a cooled-down model is skipped within the cooldown and offered again after it", async () => {
        setSystemTime(new Date("2026-10-23T10:00:00Z"))
        const fake = await setup()

        await retry(fake, { sessionID: "ses_a", model: MAIN[0] as string })
        setSystemTime(new Date("2026-10-23T10:00:20Z"))
        await retry(fake, { sessionID: "ses_b", model: MAIN[2] as string })

        expect(fake.calls.switchModel.map((call) => call.model)).toEqual([
            modelRef(MAIN[1] as string),
            modelRef(MAIN[1] as string),
        ])

        setSystemTime(new Date("2026-10-23T10:00:31Z"))
        expect(await fallbackNext(fake, { tier: "main", tried: [] })).toBe(MAIN[0])
    })

    test("a new user turn starts a fresh descent", async () => {
        const fake = await setup()

        await retry(fake, { model: MAIN[0] as string })
        await retry(fake, { model: MAIN[1] as string })
        expect(fake.calls.switchModel).toHaveLength(2)

        await fake.fire.session("prompt", { sessionID: "ses_main" })
        setSystemTime(new Date(Date.now() + 60_000))
        await retry(fake, { model: MAIN[2] as string })

        expect(fake.calls.switchModel.map((call) => call.model)).toEqual([
            modelRef(MAIN[1] as string),
            modelRef(MAIN[2] as string),
            modelRef(MAIN[0] as string),
        ])
    })

    test("an ac/* session is left to the execute skill", async () => {
        const fake = await setup()

        const event = await retry(fake, { agent: "ac/plan-worker-junior", model: WORKER[0] as string })

        expect(event.decision).toEqual({ retry: true, delay: 2_000 })
        expect(fake.calls.switchModel).toHaveLength(0)
        expect(fake.calls.prompt).toHaveLength(0)
    })

    test("an advisory ac agent falls back in place on its own tier's chain", async () => {
        const config = loadConfig({ env: {}, options: { models: { tiers: { "plan-reviewer": MAIN } } } })
        const fake = await setup(config)

        const event = await retry(fake, { agent: "ac/plan-reviewer", model: MAIN[0] as string, status: 500 })

        expect(event.decision).toEqual({ retry: true, delay: 0 })
        expect(fake.calls.switchModel.map((call) => call.model)).toEqual([modelRef(MAIN[1] as string)])
    })

    test("a non-retryable 400 is untouched", async () => {
        const fake = await setup()

        const event = await retry(fake, { model: MAIN[0] as string, status: 400, attempt: 5 })

        expect(event.decision).toEqual({ retry: true, delay: 2_000 })
        expect(fake.calls.switchModel).toHaveLength(0)
    })

    test("a retryable status below the attempt cap keeps the host retrying", async () => {
        const fake = await setup()

        const event = await retry(fake, { model: MAIN[0] as string, attempt: 1 })

        expect(event.decision).toEqual({ retry: true, delay: 2_000 })
        expect(fake.calls.switchModel).toHaveLength(0)
    })

    test("a 429 below rateLimitAttempts is not vetoed, so the host keeps honouring retry-after", async () => {
        const fake = await setup()

        const atRetryCap = await retry(fake, { model: MAIN[0] as string, attempt: RETRY_CAP })
        const justBelow = await retry(fake, { model: MAIN[0] as string, attempt: RATE_LIMIT_CAP - 1 })

        expect(atRetryCap.decision).toEqual({ retry: true, delay: 2_000 })
        expect(justBelow.decision).toEqual({ retry: true, delay: 2_000 })
        expect(fake.calls.switchModel).toHaveLength(0)
        expect(fake.calls.prompt).toHaveLength(0)
    })

    test("a 429 at rateLimitAttempts switches past every same-group entry", async () => {
        const fake = await setup(fixtureConfig(SHARED_GROUPS))

        const event = await retry(fake, { model: MAIN[0] as string, attempt: RATE_LIMIT_CAP })

        expect(event.decision).toEqual({ retry: true, delay: 0 })
        expect(fake.calls.switchModel.map((call) => call.model)).toEqual([modelRef(MAIN[2] as string)])
        expect(fake.calls.prompt).toHaveLength(0)
    })

    test("a 500 at retryAttempts switches to the next entry even within the group", async () => {
        const fake = await setup(fixtureConfig(SHARED_GROUPS))

        const event = await retry(fake, { model: MAIN[0] as string, status: 500, attempt: RETRY_CAP })

        expect(event.decision).toEqual({ retry: true, delay: 0 })
        expect(fake.calls.switchModel.map((call) => call.model)).toEqual([modelRef(MAIN[1] as string)])
    })

    test("a 429 with only same-group entries left leaves the host decision alone", async () => {
        const fake = await setup(fixtureConfig({ all: ["alpha", "beta", "gamma"] }))

        const event = await retry(fake, { model: MAIN[0] as string })

        expect(event.decision).toEqual({ retry: true, delay: 2_000 })
        expect(fake.calls.switchModel).toHaveLength(0)
    })

    test("a model id containing slashes is split at the provider only", async () => {
        const config = loadConfig({
            env: {},
            options: {
                models: {
                    tiers: {
                        main: [
                            MAIN[0] as string,
                            "openrouter/anthropic/claude-sonnet-5-5#max",
                        ],
                    },
                },
            },
        })
        const fake = await setup(config)

        await retry(fake, { model: MAIN[0] as string })

        expect(fake.calls.switchModel[0]?.model).toEqual(modelRef("openrouter/anthropic/claude-sonnet-5-5#max"))
        expect(fake.calls.switchModel[0]?.model).toMatchObject({
            providerID: "openrouter",
            id: "anthropic/claude-sonnet-5-5",
            variant: "max",
        })
    })
})

describe("ac_fallback_next", () => {
    test("returns the next untried chain entry for a worker tier", async () => {
        const fake = await setup()

        const next = await fallbackNext(fake, {
            tier: "plan-worker-junior",
            tried: [WORKER[0] as string],
        })

        expect(next).toBe(WORKER[1])
    })

    test("skips a cooling group after a 429 and offers it again once the cooldown ends", async () => {
        setSystemTime(new Date("2026-10-23T10:00:00Z"))
        const fake = await setup(fixtureConfig(SHARED_GROUPS))

        await retry(fake, { model: MAIN[0] as string })

        expect(await fallbackNext(fake, { tier: "main", tried: [], status: 429 })).toBe(MAIN[2])

        setSystemTime(new Date("2026-10-23T10:00:31Z"))
        expect(await fallbackNext(fake, { tier: "main", tried: [], status: 429 })).toBe(MAIN[0])
    })

    test("a 500 cools down the model only, not its group", async () => {
        const fake = await setup(fixtureConfig(SHARED_GROUPS))

        await retry(fake, { model: MAIN[0] as string, status: 500 })

        expect(await fallbackNext(fake, { tier: "main", tried: [] })).toBe(MAIN[1])
    })

    test("returns none once every entry was tried", async () => {
        const fake = await setup()

        const next = await fallbackNext(fake, {
            tier: "plan-worker-junior",
            tried: WORKER,
        })

        expect(next).toBe("none")
    })
})

describe("ac_fallback_next with a worker's provider status", () => {
    test("a 429 skips every entry in the group of a tried model", async () => {
        const fake = await setup(fixtureConfig(SHARED_GROUPS))

        const next = await fallbackNext(fake, {
            tier: "plan-worker-junior",
            tried: [WORKER[0] as string],
            status: 429,
        })

        expect(next).toBe(WORKER[2])
    })

    test("a 429 cools the group down for the main session too, until the cooldown ends", async () => {
        setSystemTime(new Date("2026-10-23T10:00:00Z"))
        const fake = await setup(fixtureConfig(SHARED_GROUPS))

        await fallbackNext(fake, { tier: "plan-worker-junior", tried: [WORKER[0] as string], status: 429 })

        expect(await fallbackNext(fake, { tier: "main", tried: [], status: 429 })).toBe(MAIN[2])
        setSystemTime(new Date("2026-10-23T10:00:31Z"))
        expect(await fallbackNext(fake, { tier: "main", tried: [], status: 429 })).toBe(MAIN[0])
    })

    test("a 500 after a group-wide 429 still offers the cooling group's entries", async () => {
        const fake = await setup(fixtureConfig(SHARED_GROUPS))

        expect(await fallbackNext(fake, { tier: "plan-worker-junior", tried: [WORKER[0] as string], status: 429 }))
            .toBe(WORKER[2])
        const next = await fallbackNext(fake, {
            tier: "plan-worker-junior",
            tried: [
                WORKER[0] as string,
                WORKER[2] as string,
            ],
            status: 500,
        })

        expect(next).toBe(WORKER[1])
    })

    test("a 429 with only the failed group left answers wait for the cooldown", async () => {
        const fake = await setup(fixtureConfig({ all: ["alpha", "beta", "gamma"] }))

        const next = await fallbackNext(fake, { tier: "plan-worker-junior", tried: [WORKER[0] as string], status: 429 })

        expect(next).toBe("wait:30")
    })

    test("a 429 on an exhausted chain still answers none", async () => {
        const fake = await setup(fixtureConfig({ all: ["alpha", "beta", "gamma"] }))

        expect(await fallbackNext(fake, { tier: "plan-worker-junior", tried: WORKER, status: 429 })).toBe("none")
    })

    test("a 500 with only the failed group left answers the next entry, never wait", async () => {
        const fake = await setup(fixtureConfig({ all: ["alpha", "beta", "gamma"] }))

        expect(await fallbackNext(fake, { tier: "plan-worker-junior", tried: [WORKER[0] as string], status: 500 }))
            .toBe(WORKER[1])
    })

    test("the tool description names the wait verdict", async () => {
        const fake = await setup()
        fake.applyTransforms()

        expect(fake.tools.get("ac_fallback_next")?.description).toContain("wait:<seconds>")
    })

    test("another status keeps the group in play", async () => {
        const fake = await setup(fixtureConfig(SHARED_GROUPS))

        const next = await fallbackNext(fake, {
            tier: "plan-worker-junior",
            tried: [WORKER[0] as string],
            status: 500,
        })

        expect(next).toBe(WORKER[1])
    })

    test("the tool schema declares the optional status", async () => {
        const fake = await setup()
        fake.applyTransforms()

        const input = fake.tools.get("ac_fallback_next")?.input as {
            properties: Record<string, { type: string }>
            required: string[]
        }

        expect(input.properties.status?.type).toBe("number")
        expect(input.required).not.toContain("status")
    })
})

describe("providers without a credential", () => {
    test("ac_fallback_next skips an entry whose model is not connected", async () => {
        const fake = await setup(fixtureConfig(), {
            connected: [
                WORKER[0] as string,
                WORKER[2] as string,
            ],
        })

        const next = await fallbackNext(fake, { tier: "plan-worker-junior", tried: [WORKER[0] as string] })

        expect(next).toBe(WORKER[2])
    })

    test("ac_fallback_next returns none when only unconnected entries remain", async () => {
        const fake = await setup(fixtureConfig(), { connected: [WORKER[0] as string] })

        expect(await fallbackNext(fake, { tier: "plan-worker-junior", tried: [WORKER[0] as string] })).toBe("none")
    })

    test("the main session never switches onto an unconnected model", async () => {
        const fake = await setup(fixtureConfig(), {
            connected: [
                MAIN[0] as string,
                MAIN[2] as string,
            ],
        })

        await retry(fake, { model: MAIN[0] as string, status: 500 })

        expect(fake.calls.switchModel.map((call) => call.model)).toEqual([modelRef(MAIN[2] as string)])
    })

    test("a chain with no connected entry left leaves the host decision alone", async () => {
        const fake = await setup(fixtureConfig(), { connected: [MAIN[0] as string] })

        const event = await retry(fake, { model: MAIN[0] as string })

        expect(event.decision).toEqual({ retry: true, delay: 2_000 })
        expect(fake.calls.switchModel).toHaveLength(0)
    })
})

describe("switch back to the chain head", () => {
    test("the first user prompt after the head's cooldown switches the session back, once", async () => {
        setSystemTime(new Date("2026-10-23T10:00:00Z"))
        const fake = await setup()
        await retry(fake, { model: MAIN[0] as string })

        setSystemTime(new Date("2026-10-23T10:00:10Z"))
        await fake.fire.session("prompt", { sessionID: "ses_main" })
        expect(fake.calls.switchModel).toHaveLength(1)

        setSystemTime(new Date("2026-10-23T10:00:31Z"))
        await fake.fire.session("prompt", { sessionID: "ses_main" })
        await fake.fire.session("prompt", { sessionID: "ses_main" })

        expect(fake.calls.switchModel.map((call) => call.model)).toEqual([
            modelRef(MAIN[1] as string),
            modelRef(MAIN[0] as string),
        ])
    })

    test("a group still cooling down keeps the session on its fallback", async () => {
        setSystemTime(new Date("2026-10-23T10:00:00Z"))
        const fake = await setup(fixtureConfig(SHARED_GROUPS))
        await retry(fake, { model: MAIN[0] as string })
        setSystemTime(new Date("2026-10-23T10:00:20Z"))
        await fallbackNext(fake, { tier: "plan-worker-junior", tried: ["beta/two"], status: 429 })

        setSystemTime(new Date("2026-10-23T10:00:31Z"))
        await fake.fire.session("prompt", { sessionID: "ses_main" })

        expect(fake.calls.switchModel.map((call) => call.model)).toEqual([modelRef(MAIN[2] as string)])
    })

    test("a model the user picked after the fallback is left alone", async () => {
        setSystemTime(new Date("2026-10-23T10:00:00Z"))
        const fake = await setup(fixtureConfig(), { currentModel: () => "gamma/three#max" })
        await retry(fake, { model: MAIN[0] as string })

        setSystemTime(new Date("2026-10-23T10:00:31Z"))
        await fake.fire.session("prompt", { sessionID: "ses_main" })

        expect(fake.calls.switchModel).toHaveLength(1)
    })
})

describe("switch logging", () => {
    test("every switch logs one line naming both models, the status and the attempt", async () => {
        setSystemTime(new Date("2026-10-23T10:00:00Z"))
        const info = spyOn(console, "info").mockImplementation(() => {})
        try {
            const fake = await setup()

            await retry(fake, { model: MAIN[0] as string })
            setSystemTime(new Date("2026-10-23T10:00:31Z"))
            await fake.fire.session("prompt", { sessionID: "ses_main" })

            expect(info.mock.calls).toEqual([
                ["ac fallback: alpha/one#high -> beta/two#high (status 429, attempt 7)"],
                ["ac fallback: beta/two#high -> alpha/one#high (chain head available again)"],
            ])
        } finally {
            info.mockRestore()
        }
    })
})

describe("ac_models", () => {
    test("reports the merged chains, the groups and the caps the skills route by", async () => {
        const fake = await setup(fixtureConfig(SHARED_GROUPS))
        fake.applyTransforms()

        const result = await fake.tools.get("ac_models")?.execute({}, {} as ToolContext)
        const models = JSON.parse(String(result?.content))

        expect(models.tiers.main).toEqual(MAIN)
        expect(models.groups).toEqual(SHARED_GROUPS)
        expect(models).toMatchObject({ retryAttempts: 3, maxParallel: 3, maxLanes: 2 })
    })
})
