import { afterEach, describe, expect, setSystemTime, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import type { SessionRetry } from "@opencode/plugin/promise/session"
import type { ToolContext } from "@opencode/plugin/promise/tool"
import { loadConfig, type ModelConfig } from "../src/config.ts"
import { registerFallback } from "../src/fallback.ts"
import { createFakeCtx, type FakeCtx } from "./fake-ctx.ts"

type SessionMessage = Awaited<ReturnType<Plugin.Context["session"]["context"]>>[number]

/**
 * Fixture chains, independent of config/models.jsonc, so a preset edit cannot break the fallback mechanics.
 */
const MAIN = ["alpha/one#high", "beta/two#high", "gamma/three#high"]
const WORKER = ["alpha/code", "beta/two#high", "gamma/three#high"]

function fixtureConfig(): ModelConfig {
    return loadConfig({
        env: {},
        options: { models: { tiers: { main: MAIN, "plan-worker-junior": WORKER } } },
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

function userMessage(text: string): SessionMessage {
    return {
        type: "user",
        id: "msg_user",
        text,
        time: { created: 0 },
    } as unknown as SessionMessage
}

/**
 * The Step 1 fake does not script `session.context`, so the transcript the replay reads is attached here.
 */
async function setup(
    config: ModelConfig = fixtureConfig(),
    messages: SessionMessage[] = [
        userMessage("first request"),
        { type: "assistant", id: "msg_assistant" } as unknown as SessionMessage,
        userMessage("fix the failing build"),
    ],
): Promise<FakeCtx> {
    const fake = createFakeCtx()
    Object.assign(fake.ctx.session, {
        context: async () => messages,
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
        attempt: input.attempt ?? 2,
        decision: {
            retry: true,
            delay: 2_000,
        },
    })
}

async function fallbackNext(fake: FakeCtx, input: { tier: string; tried: string[] }): Promise<unknown> {
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
    test("a 429 at the attempt cap vetoes the retry, switches to chain[1] and replays once", async () => {
        const fake = await setup()

        const event = await retry(fake, { model: MAIN[0] as string })

        expect(event.decision).toEqual({ retry: false })
        expect(fake.calls.switchModel).toEqual([
            {
                sessionID: "ses_main",
                model: modelRef(MAIN[1] as string),
            },
        ] as unknown as typeof fake.calls.switchModel)
        expect(fake.calls.prompt).toHaveLength(1)
        expect(fake.calls.prompt[0]).toMatchObject({
            sessionID: "ses_main",
            text: "fix the failing build",
            delivery: "queue",
        })
    })

    test("a second failure on the replacement moves to chain[2]", async () => {
        const fake = await setup()

        await retry(fake, { model: MAIN[0] as string })
        await retry(fake, { model: MAIN[1] as string })

        expect(fake.calls.switchModel.map((call) => call.model)).toEqual([
            modelRef(MAIN[1] as string),
            modelRef(MAIN[2] as string),
        ])
        expect(fake.calls.prompt).toHaveLength(2)
    })

    test("an exhausted chain switches no further and leaves the host decision alone", async () => {
        const fake = await setup()

        await retry(fake, { model: MAIN[0] as string })
        await retry(fake, { model: MAIN[1] as string })
        const last = await retry(fake, { model: MAIN[2] as string })

        expect(last.decision).toEqual({ retry: true, delay: 2_000 })
        expect(fake.calls.switchModel).toHaveLength(2)
        expect(fake.calls.prompt).toHaveLength(2)
    })

    test("a repeated observation of an already handled model is not acted on twice", async () => {
        const fake = await setup()

        await retry(fake, { model: MAIN[0] as string })
        const stale = await retry(fake, { model: MAIN[0] as string, attempt: 3 })

        expect(stale.decision).toEqual({ retry: true, delay: 2_000 })
        expect(fake.calls.switchModel).toHaveLength(1)
        expect(fake.calls.prompt).toHaveLength(1)
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

    test("a new user turn starts a fresh descent, the replay does not", async () => {
        const fake = await setup()

        await retry(fake, { model: MAIN[0] as string })
        await fake.fire.session("prompt", {
            sessionID: "ses_main",
            metadata: (fake.calls.prompt[0] as { metadata?: Record<string, unknown> }).metadata,
        })
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

    test("the replay carries the stored attachments back as prompt input", async () => {
        const message = {
            ...(userMessage("look at @shot.png with @ac/oracle") as object),
            files: [
                {
                    data: "aGk=",
                    mime: "image/png",
                    source: { type: "uri", uri: "file:///tmp/shot.png" },
                    name: "shot.png",
                },
            ],
            agents: [
                {
                    name: "ac/oracle",
                },
            ],
            skills: [
                {
                    id: "plan",
                    name: "plan",
                    text: "skill body",
                },
            ],
        } as unknown as SessionMessage
        const fake = await setup(fixtureConfig(), [message])

        await retry(fake, { model: MAIN[0] as string })

        expect(fake.calls.prompt[0]).toMatchObject({
            text: "look at @shot.png with @ac/oracle",
            files: [
                {
                    uri: "data:image/png;base64,aGk=",
                    name: "shot.png",
                },
            ],
            agents: [
                {
                    name: "ac/oracle",
                },
            ],
            skills: [
                {
                    id: "plan",
                },
            ],
        })
    })

    test("no user message to replay leaves the host decision alone", async () => {
        const fake = await setup(fixtureConfig(), [])

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

    test("returns none once every entry was tried", async () => {
        const fake = await setup()

        const next = await fallbackNext(fake, {
            tier: "plan-worker-junior",
            tried: WORKER,
        })

        expect(next).toBe("none")
    })
})
