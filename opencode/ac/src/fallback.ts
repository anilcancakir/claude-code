import type { Plugin } from "@opencode/plugin"
import type { SessionRetry } from "@opencode/plugin/promise/session"
import type { ModelConfig, ModelRef } from "./config.ts"

type Context = Plugin.Context
type SessionModel = SessionRetry["model"]
/** A live model reference; the retry hook brands its ids, `session.get` does not. */
interface PlainModel {
    readonly providerID: string
    readonly id: string
    readonly variant?: string
}

interface FallbackNextInput {
    tier: string
    tried: string[]
    status?: number
}

/** A main session this module moved off its chain head, and the model it moved it to. */
interface FallenBack {
    tier: string
    to: ModelRef
}

/**
 * Where the current model's attempts start within the host's per-step retry count. The host counts attempts across
 * the whole step, including after a switch, so `offset` is the attempt number the previous model ended on.
 */
interface AttemptWindow {
    offset: number
    last: number
}

/**
 * Agents whose sessions this module switches. `ac/*` workers are absent on purpose: the execute skill re-spawns them
 * on the model `ac_fallback_next` names, so switching their session here would race that re-spawn. A coordinate lane
 * is a root session that nothing re-spawns mid-turn, so it falls back in place like the main session.
 */
const AGENT_TIERS: Readonly<Record<string, string>> = {
    build: "main",
    "ac/lane": "lane",
}

/** Splits like opencode's `Model.Ref.parse`: the provider ends at the first slash, the model id may hold more. */
export function parseModelRef(ref: ModelRef): SessionModel {
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
function modelKey(ref: ModelRef | PlainModel): string {
    if (typeof ref !== "string") return `${ref.providerID}/${ref.id}`
    const variantStart = ref.indexOf("#", ref.indexOf("/") + 1)
    return variantStart === -1 ? ref : ref.slice(0, variantStart)
}

/** HTTP status whose limit is shared by every provider of a group, so the whole group backs off together. */
const RATE_LIMIT_STATUS = 429

/**
 * The host offers one step 10 retries, hook attempts 2 to 11, shared by every model the step runs on
 * (core/src/model-retry.ts:22-28; past it the hook is never called, session/runner/retry.ts:37-38). From this attempt
 * on, a failure switches whatever the per-model cap says, so the last two retries go to the next rung instead of the
 * model that has been failing.
 */
const HOST_LAST_SWITCH_ATTEMPT = 10

/** The form chain entries are written in, so a log line reads like the config. */
function formatRef(model: PlainModel): ModelRef {
    return `${model.providerID}/${model.id}${model.variant === undefined ? "" : `#${model.variant}`}`
}

/** The provider is the part before the first slash, for both chain entries and live session models. */
function providerOf(ref: ModelRef | SessionModel): string {
    return typeof ref === "string" ? ref.slice(0, ref.indexOf("/")) : ref.providerID
}

/**
 * Main-session model fallback. A failure at the retry cap moves the session one step down its tier chain and leaves
 * the host retry going: opencode reloads the session and resolves its current model on every retry
 * (core/src/session/runner/llm.ts:211-212, session/context.ts:169), so the retry runs on the switched model without
 * a second copy of the user prompt. `ac_fallback_next` gives the execute skill the same chain walk for workers.
 */
export async function registerFallback(ctx: Context, config: ModelConfig): Promise<void> {
    // Keyed `model:<provider/model>` or `group:<name>`; a provider outside `config.groups` is its own group.
    const cooldownUntil = new Map<string, number>()
    // Models that already failed in the current user turn, per session. A new turn starts a fresh descent.
    const tried = new Map<string, Set<string>>()
    const switching = new Set<string>()
    const fallenBack = new Map<string, FallenBack>()
    const attempts = new Map<string, AttemptWindow>()
    const groupByProvider = new Map<string, string>(
        Object.entries(config.groups).flatMap(([group, providers]) => providers.map((provider) => [provider, group])),
    )

    const groupKey = (ref: ModelRef | SessionModel): string => {
        const provider = providerOf(ref)
        return `group:${groupByProvider.get(provider) ?? provider}`
    }

    const coolDown = (key: string): void => {
        cooldownUntil.set(key, Date.now() + config.cooldownSeconds * 1_000)
    }

    const isCoolingDown = (key: string): boolean => (cooldownUntil.get(key) ?? 0) > Date.now()

    // `model.list` answers with the models of providers that have a connection, so an entry missing from it has no
    // credential to run on; it is read per decision because the operator can log in while the server runs.
    const connectedModels = async (): Promise<ReadonlySet<string>> =>
        new Set((await ctx.model.list()).data.map((model) => `${model.providerID}/${model.id}`))

    // A group cooldown says the shared rate limit is spent; a 5xx is the model's own failure, so a sibling in a
    // cooling group can still take it.
    const isUsable = (ref: ModelRef, connected: ReadonlySet<string>, groupCooldown: boolean): boolean =>
        connected.has(modelKey(ref))
        && !isCoolingDown(`model:${modelKey(ref)}`)
        && !(groupCooldown && isCoolingDown(groupKey(ref)))

    /** Untried, connected entries outside a model cooldown; the group cooldown is applied by the caller. */
    const candidates = async (tier: string, excluded: ReadonlySet<string>): Promise<ModelRef[]> => {
        const connected = await connectedModels()
        return config.chain(tier).filter((ref) => !excluded.has(modelKey(ref)) && isUsable(ref, connected, false))
    }

    const nextEntry = async (
        tier: string,
        excluded: ReadonlySet<string>,
        status: number | undefined,
    ): Promise<ModelRef | undefined> =>
        (await candidates(tier, excluded)).find(
            (ref) => status !== RATE_LIMIT_STATUS || !isCoolingDown(groupKey(ref)),
        )

    /** The attempt number on the session's current model, counted from where the previous model's attempts ended. */
    const modelAttempt = (sessionID: string, attempt: number): number => {
        // A new step restarts the host count, so a number at or below the last one seen opens a fresh window.
        const window = attempts.get(sessionID)
        const offset = window === undefined || attempt <= window.last ? 0 : window.offset
        attempts.set(sessionID, { offset, last: attempt })
        return attempt - offset
    }

    /**
     * A fallback is for the turn that failed; the next real user turn goes back to the head once it can answer.
     * A model the user picked since the fallback is their choice, so it is left in place.
     */
    const switchBack = async (sessionID: string): Promise<void> => {
        const switched = fallenBack.get(sessionID)
        if (switched === undefined) return
        const head = config.chain(switched.tier)[0] as ModelRef
        // Returning onto a group whose shared limit is still spent would fail the turn at once.
        if (!isUsable(head, await connectedModels(), true)) return

        fallenBack.delete(sessionID)
        const current = (await ctx.session.get({ sessionID })).model
        if (current === undefined || modelKey(current) !== modelKey(switched.to)) return
        await ctx.session.switchModel({ sessionID, model: parseModelRef(head) })
        console.info(`ac fallback: ${formatRef(current)} -> ${head} (chain head available again)`)
    }

    await ctx.session.hook("prompt", async (event) => {
        tried.delete(event.sessionID)
        await switchBack(event.sessionID)
    })

    await ctx.session.hook("retry", async (event) => {
        // 1. Only a retryable failure at the cap of a session this module owns; anything else keeps the host policy.
        //    A 429 is an RPM limit that clears on its own, so the host keeps retrying (it honours retry-after)
        //    for longer before a switch.
        const tier = AGENT_TIERS[event.agent]
        const status = event.error.status
        if (tier === undefined || status === undefined || !config.retryOn.includes(status)) return
        const cap = status === RATE_LIMIT_STATUS ? config.rateLimitAttempts : config.retryAttempts
        const belowCap = modelAttempt(event.sessionID, event.attempt) < cap
        if (belowCap && event.attempt < HOST_LAST_SWITCH_ATTEMPT) return

        // 2. One action per failure observation: a model already handled this turn, or a switch still in flight,
        //    is a repeat of an observation that was acted on.
        const failed = modelKey(event.model)
        const sessionTried = tried.get(event.sessionID) ?? new Set<string>()
        if (switching.has(event.sessionID) || sessionTried.has(failed)) return
        sessionTried.add(failed)
        tried.set(event.sessionID, sessionTried)
        //    The cooldown covers the whole group on a rate limit, since siblings share it, else just the model.
        coolDown(status === RATE_LIMIT_STATUS ? groupKey(event.model) : `model:${failed}`)

        // 3. An exhausted chain leaves the host decision, so the error stays visible.
        const next = await nextEntry(tier, sessionTried, status)
        if (next === undefined) return

        // 4. Switch and keep the retry: the host's next attempt reloads the session and runs on `next`. The model's
        //    attempts start at this one, so it gets its own cap before the next switch. The scheduled delay honours
        //    the failed provider's retry-after (up to 15 min), which says nothing about `next`, so it goes to zero.
        switching.add(event.sessionID)
        try {
            await ctx.session.switchModel({ sessionID: event.sessionID, model: parseModelRef(next) })
            attempts.set(event.sessionID, { offset: event.attempt - 1, last: event.attempt })
            if (event.decision.retry) event.decision = { retry: true, delay: 0 }
            console.info(
                `ac fallback: ${formatRef(event.model)} -> ${next} (status ${status}, attempt ${event.attempt})`,
            )
            // Landing on the head again needs no switch back.
            if (modelKey(next) === modelKey(config.chain(tier)[0] as ModelRef)) fallenBack.delete(event.sessionID)
            else fallenBack.set(event.sessionID, { tier, to: next })
        } finally {
            switching.delete(event.sessionID)
        }
    })

    await ctx.tool.transform((editor) => {
        // The skills read routing from here, not from config/models.jsonc: an installed preset replaces those chains
        // through the plugin options, and only the plugin sees the merged result.
        editor.add({
            name: "ac_models",
            description: [
                "Returns the model routing this plugin runs on, as JSON: `tiers` maps each tier (an ac agent name",
                "without the ac/ prefix, plus `main`) to its fallback chain, whose first entry is the model that agent",
                "starts on; `groups` names the providers that share one rate limit; `maxParallel` is the default",
                "worker cap per execute wave and `maxLanes` the coordinate lane cap.",
            ].join(" "),
            input: {
                type: "object",
                properties: {},
                additionalProperties: false,
            },
            execute: async () => ({
                content: JSON.stringify({
                    tiers: Object.fromEntries(config.tiers().map((tier) => [tier, config.chain(tier)])),
                    groups: config.groups,
                    maxParallel: config.maxParallel,
                    maxLanes: config.maxLanes,
                }),
            }),
        })
        editor.add({
            name: "ac_fallback_next",
            description: [
                "Returns the next model to re-spawn a failed ac worker on: the first entry of the tier's fallback",
                "chain that is not in `tried`, not cooling down after a recent failure and on a provider with a",
                "credential. Pass the worker's provider error `status`: a 429 is a rate limit shared by every",
                "provider of a group, so it cools down the groups of the `tried` models and skips their entries;",
                "any other status ignores group cooldowns, since a 5xx is the model's own failure.",
                "Returns `wait:<seconds>` on a 429 when every remaining entry shares a tried model's group: wait that",
                "long and re-spawn the same model. Returns `none` when the chain is exhausted; then report the",
                "failure instead of re-spawning.",
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
                    status: {
                        type: "number",
                        description: "HTTP status of the worker's provider error, when it reported one (e.g. 429).",
                    },
                },
                required: [
                    "tier",
                    "tried",
                ],
                additionalProperties: false,
            },
            execute: async (input: unknown) => {
                const { tier, tried: triedRefs, status } = input as FallbackNextInput
                const excluded = new Set(triedRefs.map(modelKey))
                if (status !== RATE_LIMIT_STATUS) {
                    return { content: (await nextEntry(tier, excluded, status)) ?? "none" }
                }

                // 1. A 429 spends the whole group's limit, so the groups of the tried models cool down together.
                const failedGroups = new Set(triedRefs.map(groupKey))
                for (const group of failedGroups) coolDown(group)

                // 2. When only those groups are left, switching cannot help, but the limit clears within the cooldown.
                const rest = await candidates(tier, excluded)
                const next = rest.find((ref) => !isCoolingDown(groupKey(ref)))
                if (next !== undefined) return { content: next }
                const onlyFailedGroups = rest.length > 0 && rest.every((ref) => failedGroups.has(groupKey(ref)))
                return { content: onlyFailedGroups ? `wait:${config.cooldownSeconds}` : "none" }
            },
        })
    })
}
