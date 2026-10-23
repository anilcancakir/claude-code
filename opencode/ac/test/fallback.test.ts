import { afterEach, describe, expect, setSystemTime, spyOn, test } from "bun:test"
import type { SessionRetry } from "@opencode/plugin/promise/session"
import type { ToolContext } from "@opencode/plugin/promise/tool"
import { loadConfig, type ModelConfig } from "../src/config.ts"
import { type RateLimitResume, registerFallback } from "../src/fallback.ts"
import { createFakeCtx, type FakeCtx } from "./fake-ctx.ts"

/**
 * Fixture chains, independent of config/models.jsonc, so a preset edit cannot break the fallback mechanics.
 */
const MAIN = ["alpha/one#high", "beta/two#high", "gamma/three#high"]
const WORKER = ["alpha/code", "beta/two#high", "gamma/three#high"]

/** Attempt at which the default `retryAttempts` lets the fallback act on a retryable status other than 429. */
const RETRY_CAP = 3

/** A two-retry rate-limit schedule with no waits, so a test reaches the end of it in three observations. */
const SHORT_BACKOFF = [{ through: 2, seconds: 0 }]

/** `alpha` and `beta` share one rate-limit group; `gamma` is its own. */
const SHARED_GROUPS = { shared: ["alpha", "beta"] }

function fixtureConfig(
    groups: Record<string, string[]> = {},
    rateLimitBackoff?: { through: number; seconds: number }[],
): ModelConfig {
    return loadConfig({
        env: {},
        options: {
            models: {
                groups,
                tiers: { main: MAIN, "plan-worker-junior": WORKER },
                ...(rateLimitBackoff === undefined ? {} : { rateLimitBackoff }),
            },
        },
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
    /** Sessions `session.get` reports with a parent, as a subagent's is. */
    subagents?: readonly string[]
}

/**
 * The Step 1 fake does not script `model.list`, so the connected model catalogue is attached here. `session.get`
 * reports the model the last switch selected, as the host does once it has applied `switchModel`.
 */
async function setup(
    config: ModelConfig = fixtureConfig(),
    options: SetupOptions = {},
): Promise<FakeCtx & { fallback: RateLimitResume & { stop(): void } }> {
    const fake = createFakeCtx()
    const connected = options.connected ?? CONNECTED
    const lastSwitched = (sessionID: string): { providerID: string; id: string } | undefined =>
        fake.calls.switchModel.filter((call) => call.sessionID === sessionID).at(-1)?.model
    Object.assign(fake.ctx.session, {
        get: async (query: { sessionID: string }) => {
            const current = options.currentModel?.(query.sessionID)
            return {
                id: query.sessionID,
                ...(options.subagents?.includes(query.sessionID) ? { parentID: "ses_parent" } : {}),
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
    return Object.assign(fake, { fallback: await registerFallback(fake.ctx, config) })
}

interface RetryInput {
    sessionID?: string
    agent?: string
    model: string
    status?: number
    attempt?: number
    /** The structured error's type and message; a provider error by default. */
    type?: string
    message?: string
    /** Whether the host proposed a retry; a non-retryable failure arrives with `retry: false`. */
    retryable?: boolean
}

async function retry(fake: FakeCtx, input: RetryInput): Promise<SessionRetry> {
    return fake.fire.session("retry", {
        sessionID: input.sessionID ?? "ses_main",
        agent: input.agent ?? "build",
        model: modelRef(input.model),
        error: {
            type: input.type ?? ((input.status ?? 500) === 429 ? "provider.rate-limit" : "provider.internal"),
            message: input.message ?? "provider failure",
            status: input.status ?? 500,
        },
        attempt: input.attempt ?? RETRY_CAP,
        decision: input.retryable === false ? { retry: false } : { retry: true, delay: 2_000 },
    })
}

async function fallbackNext(
    fake: FakeCtx,
    input: { tier: string; tried: string[]; status?: number; session_id?: string },
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

    test("a 429 past the schedule switches to the next entry in chain order, inside its group too", async () => {
        const fake = await setup(fixtureConfig(SHARED_GROUPS, SHORT_BACKOFF))

        await retry(fake, { model: MAIN[0] as string, status: 429, attempt: 2 })
        await retry(fake, { model: MAIN[0] as string, status: 429, attempt: 3 })
        expect(fake.calls.switchModel).toHaveLength(0)

        const event = await retry(fake, { model: MAIN[0] as string, status: 429, attempt: 4 })

        expect(event.decision).toEqual({ retry: true, delay: 0 })
        expect(fake.calls.switchModel.map((call) => call.model)).toEqual([modelRef(MAIN[1] as string)])
    })

    test("the next entry starts the schedule again", async () => {
        const fake = await setup(fixtureConfig(SHARED_GROUPS, SHORT_BACKOFF))

        for (const attempt of [2, 3, 4]) await retry(fake, { model: MAIN[0] as string, status: 429, attempt })
        await retry(fake, { model: MAIN[1] as string, status: 429, attempt: 5 })
        await retry(fake, { model: MAIN[1] as string, status: 429, attempt: 6 })
        expect(fake.calls.switchModel).toHaveLength(1)

        await retry(fake, { model: MAIN[1] as string, status: 429, attempt: 7 })
        expect(fake.calls.switchModel.map((call) => call.model)).toEqual([
            modelRef(MAIN[1] as string),
            modelRef(MAIN[2] as string),
        ])
    })

    test("from host attempt 10 a failure switches below the per-model cap, so later rungs get the last retries", async () => {
        const config = loadConfig({
            env: {},
            options: { models: { retryAttempts: 10, tiers: { main: MAIN } } },
        })
        const fake = await setup(config)

        await retry(fake, { model: MAIN[0] as string, status: 500, attempt: 10 })
        await retry(fake, { model: MAIN[1] as string, attempt: 2 })
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
        const stale = await retry(fake, { model: MAIN[0] as string, attempt: RETRY_CAP + 1 })

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

    test("a 429 waits the shipped schedule's delay in place of the host's, without a switch", async () => {
        const fake = await setup()

        const delays: unknown[] = []
        for (let attempt = 2; attempt <= 11; attempt++) {
            delays.push((await retry(fake, { model: MAIN[0] as string, status: 429, attempt })).decision)
        }

        expect(delays.map((decision) => (decision as { delay: number }).delay)).toEqual([
            1_000,
            1_000,
            1_000,
            2_000,
            2_000,
            3_000,
            3_000,
            3_000,
            3_000,
            3_000,
        ])
        expect(fake.calls.switchModel).toHaveLength(0)
    })

    test("a 429 schedule carries across the host's steps and closes when a step ends cleanly", async () => {
        const fake = await setup(fixtureConfig({}, [
            { through: 2, seconds: 1 },
            { through: 4, seconds: 7 },
        ]))

        await retry(fake, { model: MAIN[0] as string, status: 429, attempt: 2 })
        await retry(fake, { model: MAIN[0] as string, status: 429, attempt: 3 })
        const nextStep = await retry(fake, { model: MAIN[0] as string, status: 429, attempt: 2 })
        expect(nextStep.decision).toEqual({ retry: true, delay: 7_000 })

        fake.pushEvent({ type: "session.step.ended", data: { sessionID: "ses_main", finish: "stop" } })
        await Bun.sleep(5)
        const fresh = await retry(fake, { model: MAIN[0] as string, status: 429, attempt: 2 })
        expect(fresh.decision).toEqual({ retry: true, delay: 1_000 })
    })

    test("a worker's 429 follows the schedule, then stops retrying so the execute skill re-spawns it", async () => {
        const fake = await setup(fixtureConfig({}, SHORT_BACKOFF))
        const worker = { sessionID: "ses_worker", agent: "ac/plan-worker-junior", model: WORKER[0] as string }

        const first = await retry(fake, { ...worker, status: 429, attempt: 2 })
        await retry(fake, { ...worker, status: 429, attempt: 3 })
        const spent = await retry(fake, { ...worker, status: 429, attempt: 4 })

        expect(first.decision).toEqual({ retry: true, delay: 0 })
        expect(spent.decision).toEqual({ retry: false })
        expect(fake.calls.switchModel).toHaveLength(0)
    })

    test("a 500 at retryAttempts switches to the next entry even within the group", async () => {
        const fake = await setup(fixtureConfig(SHARED_GROUPS))

        const event = await retry(fake, { model: MAIN[0] as string, status: 500, attempt: RETRY_CAP })

        expect(event.decision).toEqual({ retry: true, delay: 0 })
        expect(fake.calls.switchModel.map((call) => call.model)).toEqual([modelRef(MAIN[1] as string)])
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
    test("a 429 answers wait until the model spent the schedule, and the re-spawn carries the count on", async () => {
        const fake = await setup(fixtureConfig(SHARED_GROUPS))
        const tried = [WORKER[0] as string]

        // 1. Nothing observed: the failed worker spent one host step, so the next wait is retry 11's.
        expect(await fallbackNext(fake, { tier: "plan-worker-junior", tried, status: 429 })).toBe("wait:5")

        // 2. The re-spawn's first rate-limit retry continues at 12, inside the 11 to 15 band.
        const respawn = await retry(fake, {
            sessionID: "ses_worker_2",
            agent: "ac/plan-worker-junior",
            model: WORKER[0] as string,
            status: 429,
            attempt: 2,
        })
        expect(respawn.decision).toEqual({ retry: true, delay: 5_000 })

        // 3. Once a session of the tier reached the end of the schedule on that model, the chain moves on in order.
        for (let attempt = 3; attempt <= 21; attempt++) {
            await retry(fake, {
                sessionID: "ses_worker_2",
                agent: "ac/plan-worker-junior",
                model: WORKER[0] as string,
                status: 429,
                attempt,
            })
        }
        expect(await fallbackNext(fake, { tier: "plan-worker-junior", tried, status: 429 })).toBe(WORKER[1])
    })

    test("a 429 on an exhausted chain still answers none", async () => {
        const fake = await setup(fixtureConfig({}, SHORT_BACKOFF))

        expect(await fallbackNext(fake, { tier: "plan-worker-junior", tried: WORKER, status: 429 })).toBe("none")
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
        const fake = await setup(fixtureConfig(SHARED_GROUPS, SHORT_BACKOFF))
        for (const attempt of [2, 3, 4]) await retry(fake, { model: MAIN[0] as string, status: 429, attempt })
        setSystemTime(new Date("2026-10-23T10:00:20Z"))
        await fallbackNext(fake, { tier: "plan-worker-junior", tried: ["beta/two"], status: 429 })

        setSystemTime(new Date("2026-10-23T10:00:31Z"))
        await fake.fire.session("prompt", { sessionID: "ses_main" })

        expect(fake.calls.switchModel.map((call) => call.model)).toEqual([modelRef(MAIN[1] as string)])
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
                ["ac fallback: alpha/one#high -> beta/two#high (status 500, attempt 3)"],
                ["ac fallback: beta/two#high -> alpha/one#high (chain head available again)"],
            ])
        } finally {
            info.mockRestore()
        }
    })
})

describe("rate-limit edge cases", () => {
    const rateLimited = (fake: FakeCtx, attempt: number, input: Partial<RetryInput> = {}) =>
        retry(fake, { model: MAIN[0] as string, status: 429, attempt, ...input })

    test("a stray 503 inside an unspent rate-limit run does not switch, three in a row do", async () => {
        const fake = await setup()

        for (let attempt = 2; attempt <= 9; attempt++) await rateLimited(fake, attempt)
        const stray = await retry(fake, { model: MAIN[0] as string, status: 503, attempt: 10 })
        expect(stray.decision).toEqual({ retry: true, delay: 2_000 })
        expect(fake.calls.switchModel).toHaveLength(0)

        await rateLimited(fake, 11)
        await retry(fake, { model: MAIN[0] as string, status: 503, attempt: 2 })
        await retry(fake, { model: MAIN[0] as string, status: 503, attempt: 3 })
        expect(fake.calls.switchModel).toHaveLength(0)
        await retry(fake, { model: MAIN[0] as string, status: 503, attempt: 4 })
        expect(fake.calls.switchModel.map((call) => call.model)).toEqual([modelRef(MAIN[1] as string)])
    })

    test("a new user turn starts the schedule again", async () => {
        const fake = await setup(fixtureConfig({}, [
            { through: 1, seconds: 1 },
            { through: 9, seconds: 9 },
        ]))

        await rateLimited(fake, 2)
        await fake.fire.session("prompt", { sessionID: "ses_main" })

        expect((await rateLimited(fake, 2)).decision).toEqual({ retry: true, delay: 1_000 })
    })

    test("an agent outside the ac plugin keeps the host's rate-limit policy", async () => {
        const fake = await setup(fixtureConfig({}, SHORT_BACKOFF))

        for (const attempt of [2, 3, 4, 5]) {
            const event = await rateLimited(fake, attempt, { sessionID: "ses_general", agent: "general" })
            expect(event.decision).toEqual({ retry: true, delay: 2_000 })
        }
    })

    test("a rate limit reported in the stream without a status is still on the schedule", async () => {
        const fake = await setup()

        const event = await retry(fake, {
            model: MAIN[0] as string,
            status: undefined as unknown as number,
            type: "provider.rate-limit",
            attempt: 2,
        })

        expect(event.decision).toEqual({ retry: true, delay: 1_000 })
    })

    test("a spent rate limit without a status cools the group, not the model, so siblings stay in the chain", async () => {
        const fake = await setup(fixtureConfig(SHARED_GROUPS, SHORT_BACKOFF))
        const stream = { status: undefined as unknown as number, type: "provider.rate-limit" }
        for (const attempt of [2, 3, 4]) await retry(fake, { model: MAIN[0] as string, attempt, ...stream })

        await retry(fake, { sessionID: "ses_b", model: MAIN[1] as string, status: 500 })

        expect(fake.calls.switchModel.map((call) => call.model)).toEqual([
            modelRef(MAIN[1] as string),
            modelRef(MAIN[0] as string),
        ])
    })

    test("an advisory subagent past the schedule stops retrying instead of switching behind its parent", async () => {
        const config = loadConfig({
            env: {},
            options: { models: { rateLimitBackoff: SHORT_BACKOFF, tiers: { oracle: MAIN } } },
        })
        const fake = await setup(config, { subagents: ["ses_oracle"] })
        const oracle = { sessionID: "ses_oracle", agent: "ac/oracle" }

        await rateLimited(fake, 2, oracle)
        await rateLimited(fake, 3, oracle)
        const spent = await rateLimited(fake, 4, oracle)

        expect(spent.decision).toEqual({ retry: false })
        expect(fake.calls.switchModel).toHaveLength(0)
    })

    test("ac_fallback_next reads a worker's own failure and count from its session id", async () => {
        const fake = await setup()
        const worker = { sessionID: "ses_w1", agent: "ac/plan-worker-junior", model: WORKER[0] as string }
        for (let attempt = 2; attempt <= 11; attempt++) await rateLimited(fake, attempt, worker)
        fake.pushEvent({
            type: "session.execution.failed",
            id: "evt_w1",
            data: { sessionID: "ses_w1", error: { type: "provider.rate-limit", message: "API rate limit reached" } },
        })
        await Bun.sleep(5)

        // No status: the parent only saw the provider's message.
        const next = await fallbackNext(fake, {
            tier: "plan-worker-junior",
            tried: [WORKER[0] as string],
            session_id: "ses_w1",
        })

        expect(next).toBe("wait:5")
    })

    test("two workers waiting on one model each hand their own count to their re-spawn", async () => {
        const fake = await setup()
        const tried = [WORKER[0] as string]
        const junior = { agent: "ac/plan-worker-junior", model: WORKER[0] as string }
        for (const sessionID of ["ses_a", "ses_b"]) {
            for (let attempt = 2; attempt <= 11; attempt++) await rateLimited(fake, attempt, { ...junior, sessionID })
        }

        await fallbackNext(fake, { tier: "plan-worker-junior", tried, status: 429, session_id: "ses_a" })
        await fallbackNext(fake, { tier: "plan-worker-junior", tried, status: 429, session_id: "ses_b" })
        const first = await rateLimited(fake, 2, { ...junior, sessionID: "ses_a2" })
        const second = await rateLimited(fake, 2, { ...junior, sessionID: "ses_b2" })

        expect([first.decision, second.decision]).toEqual([
            { retry: true, delay: 5_000 },
            { retry: true, delay: 5_000 },
        ])
    })

    test("a resume that cannot be decided leaves the session failed and keeps the event loop alive", async () => {
        const fake = await setup(fixtureConfig({}, [{ through: 5, seconds: 0 }]), { currentModel: () => MAIN[0] })
        await rateLimited(fake, 2)
        const get = fake.ctx.session.get
        Object.assign(fake.ctx.session, {
            get: async () => {
                throw new Error("session moved")
            },
        })

        expect(await fake.fallback.resumes("evt_gone", "ses_main", { type: "provider.rate-limit", message: "" })).toBe(
            false,
        )
        Object.assign(fake.ctx.session, { get })
        fake.pushEvent({
            type: "session.execution.failed",
            id: "evt_ok",
            data: { sessionID: "ses_main", error: { type: "provider.rate-limit", message: "" } },
        })
        await Bun.sleep(10)

        expect(fake.calls.synthetic).toHaveLength(1)
    })
})

describe("an account that cannot serve requests", () => {
    const SPEND_LIMIT = {
        status: 400,
        type: "provider.invalid-request",
        message: "You have reached your specified API usage limits. You will regain access on 2026-11-01 at 00:00 UTC.",
        retryable: false,
    }

    test("a spend limit, a billing error or a refused key switches at once and forces the retry", async () => {
        for (const failure of [
            SPEND_LIMIT,
            { status: 402, type: "provider.quota", message: "billing", retryable: false },
            { status: 401, type: "provider.auth", message: "invalid x-api-key", retryable: false },
        ]) {
            const fake = await setup()

            const event = await retry(fake, { model: MAIN[0] as string, attempt: 2, ...failure })

            expect(event.decision).toEqual({ retry: true, delay: 0 })
            expect(fake.calls.switchModel.map((call) => call.model)).toEqual([modelRef(MAIN[1] as string)])
        }
    })

    test("every session skips the provider afterwards, and a worker is left to ac_fallback_next", async () => {
        const fake = await setup()

        const worker = await retry(fake, {
            sessionID: "ses_worker",
            agent: "ac/plan-worker-junior",
            model: MAIN[0] as string,
            ...SPEND_LIMIT,
        })

        expect(worker.decision).toEqual({ retry: false })
        expect(fake.calls.switchModel).toHaveLength(0)
        expect(await fallbackNext(fake, { tier: "main", tried: [], status: 400 })).toBe(MAIN[1])
    })

    test("any other 400 is left to the host", async () => {
        const fake = await setup()

        const event = await retry(fake, {
            model: MAIN[0] as string,
            status: 400,
            type: "provider.invalid-request",
            message: "messages.1.content.0: thinking blocks cannot be modified",
            retryable: false,
        })

        expect(event.decision).toEqual({ retry: false })
        expect(fake.calls.switchModel).toHaveLength(0)
    })
})

describe("continuing a session whose step ran out on a 429", () => {
    const RATE_LIMITED = { type: "provider.rate-limit", message: "API rate limit reached", status: 429 }

    const failed = (fake: FakeCtx, sessionID: string, status = 429, id = `evt_${sessionID}`): void =>
        fake.pushEvent({
            type: "session.execution.failed",
            id,
            data: {
                sessionID,
                error: { type: status === 429 ? "provider.rate-limit" : "provider.internal", message: "", status },
            },
        })

    test("a root session is continued after the next wait, the count carried on", async () => {
        const fake = await setup(fixtureConfig({}, [{ through: 5, seconds: 0 }]), { currentModel: () => MAIN[0] })
        await retry(fake, { model: MAIN[0] as string, status: 429, attempt: 2 })

        failed(fake, "ses_main")
        await Bun.sleep(10)

        expect(fake.calls.synthetic).toHaveLength(1)
        expect(fake.calls.synthetic[0]).toMatchObject({ sessionID: "ses_main", description: "ac rate limit retry" })
        expect(fake.calls.switchModel).toHaveLength(0)
    })

    test("past the schedule the session moves down its chain before it is continued", async () => {
        const fake = await setup(fixtureConfig({}, SHORT_BACKOFF), { currentModel: () => MAIN[0] })
        await retry(fake, { model: MAIN[0] as string, status: 429, attempt: 2 })
        await retry(fake, { model: MAIN[0] as string, status: 429, attempt: 3 })

        failed(fake, "ses_main")
        await Bun.sleep(10)

        expect(fake.calls.switchModel.map((call) => call.model)).toEqual([modelRef(MAIN[1] as string)])
        expect(fake.calls.synthetic).toHaveLength(1)
    })

    test("a subagent, another status, or a session with no 429 retry is left failed", async () => {
        const fake = await setup(fixtureConfig({}, SHORT_BACKOFF), {
            currentModel: () => MAIN[0],
            subagents: ["ses_sub"],
        })
        await retry(fake, {
            sessionID: "ses_sub",
            agent: "ac/oracle",
            model: MAIN[0] as string,
            status: 429,
            attempt: 2,
        })
        await retry(fake, { sessionID: "ses_500", model: MAIN[0] as string, status: 500, attempt: 2 })

        failed(fake, "ses_sub")
        failed(fake, "ses_500", 500)
        failed(fake, "ses_none")
        await Bun.sleep(10)

        expect(fake.calls.synthetic).toHaveLength(0)
    })

    test("a 5xx that ends a step inside a rate-limit run is continued, and switches at retryAttempts", async () => {
        const fake = await setup(fixtureConfig({}, [{ through: 30, seconds: 0 }]), { currentModel: () => MAIN[0] })
        await retry(fake, { model: MAIN[0] as string, status: 429, attempt: 2 })

        for (const id of ["evt_a", "evt_b"]) failed(fake, "ses_main", 503, id)
        await Bun.sleep(10)
        expect(fake.calls.synthetic).toHaveLength(2)
        expect(fake.calls.switchModel).toHaveLength(0)

        failed(fake, "ses_main", 503, "evt_c")
        await Bun.sleep(10)
        expect(fake.calls.switchModel.map((call) => call.model)).toEqual([modelRef(MAIN[1] as string)])
        expect(fake.calls.synthetic).toHaveLength(3)
    })

    test("one failure event is decided once, so the coordinate relay reads the same answer", async () => {
        const fake = await setup(fixtureConfig({}, [{ through: 5, seconds: 0 }]), { currentModel: () => MAIN[0] })
        await retry(fake, { model: MAIN[0] as string, status: 429, attempt: 2 })

        const first = await fake.fallback.resumes("evt_1", "ses_main", RATE_LIMITED)
        const again = await fake.fallback.resumes("evt_1", "ses_main", RATE_LIMITED)
        await Bun.sleep(10)

        expect([first, again]).toEqual([true, true])
        expect(fake.calls.synthetic).toHaveLength(1)
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
