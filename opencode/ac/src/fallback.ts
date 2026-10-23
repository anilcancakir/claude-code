import type { Plugin } from "@opencode/plugin"
import type { SessionRetry } from "@opencode/plugin/promise/session"
import type { ModelConfig, ModelRef } from "./config.ts"

type Context = Plugin.Context
type SessionModel = SessionRetry["model"]
type SessionMessage = Awaited<ReturnType<Context["session"]["context"]>>[number]
type UserMessage = Extract<SessionMessage, { type: "user" }>
type PromptInput = Parameters<Context["session"]["prompt"]>[0]

interface FallbackNextInput {
    tier: string
    tried: string[]
}

/**
 * Primary agents whose sessions this module switches. `ac/*` workers are absent on purpose: the execute skill
 * re-spawns them on the model `ac_fallback_next` names, so switching their session here would race that re-spawn.
 */
const AGENT_TIERS: Readonly<Record<string, string>> = {
    build: "main",
}

/** Prompt metadata key that marks a replay, so the prompt hook does not mistake it for a new user turn. */
const REPLAY_MARKER = "ac.fallback"

/** Splits like opencode's `Model.Ref.parse`: the provider ends at the first slash, the model id may hold more. */
function parseModelRef(ref: ModelRef): SessionModel {
    const providerEnd = ref.indexOf("/")
    const variantStart = ref.indexOf("#", providerEnd + 1)
    if (providerEnd <= 0) throw new Error(`Invalid model reference in fallback chain: ${ref}`)

    return {
        providerID: ref.slice(0, providerEnd),
        id: ref.slice(providerEnd + 1, variantStart === -1 ? undefined : variantStart),
        ...(variantStart === -1 ? {} : { variant: ref.slice(variantStart + 1) }),
    } as SessionModel
}

/**
 * Availability is a property of the model, not of the reasoning variant: a 429 on `glm-5.3#high` means
 * `glm-5.3#max` is down too, so cooldown and tried bookkeeping key on `provider/model`.
 */
function modelKey(ref: ModelRef | SessionModel): string {
    if (typeof ref !== "string") return `${ref.providerID}/${ref.id}`
    const variantStart = ref.indexOf("#", ref.indexOf("/") + 1)
    return variantStart === -1 ? ref : ref.slice(0, variantStart)
}

function lastUserMessage(messages: readonly SessionMessage[]): UserMessage | undefined {
    for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index]
        if (message?.type === "user") return message
    }
    return undefined
}

/**
 * Rebuilds prompt input from a stored user message. Stored files are already resolved to bytes, so they go back
 * as data URLs; agents and skills keep their mentions, which still line up because the text is unchanged.
 */
function replayInput(message: UserMessage): Pick<PromptInput, "text" | "files" | "agents" | "skills"> {
    return {
        text: message.text,
        files: message.files?.map((file) => ({
            uri: `data:${file.mime};base64,${file.data}`,
            name: file.name,
            description: file.description,
            mention: file.mention,
        })),
        agents: message.agents,
        skills: message.skills?.map((skill) => ({
            id: skill.id,
            mention: skill.mention,
        })),
    }
}

/**
 * Main-session model fallback. A failure at the retry cap moves the session one step down its tier chain and
 * replays the last user message; `ac_fallback_next` gives the execute skill the same chain walk for workers.
 */
export async function registerFallback(ctx: Context, config: ModelConfig): Promise<void> {
    const cooldownUntil = new Map<string, number>()
    // Models that already failed in the current user turn, per session. A new turn starts a fresh descent.
    const tried = new Map<string, Set<string>>()
    const switching = new Set<string>()

    const isCoolingDown = (key: string): boolean => (cooldownUntil.get(key) ?? 0) > Date.now()

    const nextEntry = (tier: string, excluded: ReadonlySet<string>): ModelRef | undefined =>
        config.chain(tier).find((ref) => !excluded.has(modelKey(ref)) && !isCoolingDown(modelKey(ref)))

    await ctx.session.hook("prompt", (event) => {
        if (event.metadata?.[REPLAY_MARKER] !== undefined) return
        tried.delete(event.sessionID)
    })

    await ctx.session.hook("retry", async (event) => {
        // 1. Only a retryable failure at the cap of a session this module owns; anything else keeps the host policy.
        const tier = AGENT_TIERS[event.agent]
        const status = event.error.status
        if (tier === undefined || status === undefined || !config.retryOn.includes(status)) return
        if (event.attempt < config.retryAttempts) return

        // 2. One action per failure observation: a model already handled this turn, or a switch still in flight,
        //    is a repeat of an observation that was acted on.
        const failed = modelKey(event.model)
        const sessionTried = tried.get(event.sessionID) ?? new Set<string>()
        if (switching.has(event.sessionID) || sessionTried.has(failed)) return
        sessionTried.add(failed)
        tried.set(event.sessionID, sessionTried)
        cooldownUntil.set(failed, Date.now() + config.cooldownSeconds * 1_000)

        // 3. An exhausted chain or nothing to replay leaves the host decision, so the error stays visible.
        const next = nextEntry(tier, sessionTried)
        if (next === undefined) return
        const replay = lastUserMessage(await ctx.session.context({ sessionID: event.sessionID }))
        if (replay === undefined) return

        // 4. Veto, switch, replay. The replay is queued because the vetoed turn is still settling; opencode
        //    starts it as the next turn, on the switched model.
        event.decision = { retry: false }
        switching.add(event.sessionID)
        try {
            await ctx.session.switchModel({ sessionID: event.sessionID, model: parseModelRef(next) })
            await ctx.session.prompt({
                sessionID: event.sessionID,
                ...replayInput(replay),
                metadata: { [REPLAY_MARKER]: { from: failed, to: next } },
                delivery: "queue",
            })
        } finally {
            switching.delete(event.sessionID)
        }
    })

    await ctx.tool.transform((editor) => {
        editor.add({
            name: "ac_fallback_next",
            description: [
                "Returns the next model to re-spawn a failed ac worker on: the first entry of the tier's fallback",
                "chain that is not in `tried` and not cooling down after a recent failure. Returns `none` when the",
                "chain is exhausted; then report the failure instead of re-spawning.",
            ].join(" "),
            input: {
                type: "object",
                properties: {
                    tier: {
                        type: "string",
                        description: "Agent tier without the ac/ prefix, e.g. plan-worker-junior.",
                    },
                    tried: {
                        type: "array",
                        items: { type: "string" },
                        description: "Models this step already ran on, as provider/model or provider/model#variant.",
                    },
                },
                required: [
                    "tier",
                    "tried",
                ],
                additionalProperties: false,
            },
            execute: async (input: unknown) => {
                const { tier, tried: triedRefs } = input as FallbackNextInput
                const next = nextEntry(tier, new Set(triedRefs.map(modelKey)))
                return { content: next ?? "none" }
            },
        })
    })
}
