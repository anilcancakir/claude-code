import type { Plugin } from "@opencode/plugin"
import type { SessionRetry } from "@opencode/plugin/promise/session"
import type { ModelConfig, ModelRef } from "./config.ts"
import { log } from "./log.ts"

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
    session_id?: string
}

/** The provider error a session failed or retried on, as the host types it (session-error.ts). */
export interface StructuredError {
    readonly type: string
    readonly message: string
    readonly status?: number
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

/** A session's run of rate-limit retries on one model, carried across the host's steps until a step ends cleanly. */
interface RateStreak {
    readonly agent: string
    /** `provider/model`. */
    readonly model: string
    count: number
}

/** Rate-limit retries counted for one `tier|model` at a moment, for the re-spawn of a failed subagent. */
interface SpentRetries {
    readonly count: number
    readonly at: number
}

/** Whether a failed session is one this module continues; decided once per `session.execution.failed` event. */
export interface RateLimitResume {
    resumes(eventID: string, sessionID: string, error: StructuredError): Promise<boolean>
    /** Called with a session whose continue message could not be delivered, so it will not run again. */
    onLost(listener: (sessionID: string) => void): void
}

/**
 * Agents whose sessions this module switches. The four plan workers are absent on purpose: the execute skill
 * re-spawns them on the model `ac_fallback_next` names, so switching their session here would race that re-spawn.
 * A coordinate lane and the advisory agents are re-spawned only once a call has failed outright, so a retryable
 * failure is cheapest handled in place, inside the call, before their caller ever sees it.
 */
const AGENT_TIERS: Readonly<Record<string, string>> = {
    build: "main",
    "ac/lane": "lane",
    "ac/oracle": "oracle",
    "ac/plan-reviewer": "plan-reviewer",
    "ac/plan-code-review": "plan-code-review",
    "ac/explore": "explore",
    "ac/librarian": "librarian",
    "ac/auto-verifier": "auto-verifier",
    "ac/qa-tester": "qa-tester",
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

/** Retries the host runs in one step before the step fails, so a failed subagent spent at least this many. */
const HOST_STEP_RETRIES = 10

/** How long a subagent's spent retries are remembered for its re-spawn; a later 429 starts the schedule again. */
const SPENT_MEMORY_MS = 10 * 60_000

/** Failure decisions kept per event id, so the coordinate relay and this module read one answer. */
const DECISION_MEMORY = 100

/** Failed sessions whose error is kept for ac_fallback_next. */
const FAILURE_MEMORY = 200

/** The parent key of a session that has none, for the re-spawn hand-off. */
const ROOT = "root"

/**
 * A provider account that cannot serve any request for a while: out of credit, over a spend limit, or a refused key.
 * The host types the first and last (`provider.quota` for a 402 or a billing code, `provider.auth` for 401 and 403,
 * ai/src/provider-error.ts:265-274), but Anthropic reports a spend limit as a 400 `invalid_request_error` whose message
 * starts "You have reached your specified API usage limits" (platform.claude.com/docs/en/api/rate-limits.md), and its
 * low-credit message (not in those docs) is matched as well. None of them is retryable, so the hook switches at once.
 */
const ACCOUNT_LIMIT_TEXT = /reached your specified (?:workspace )?API usage limits|credit balance is too low/i

function accountUnavailable(error: StructuredError): boolean {
    if (error.type === "provider.quota" || error.type === "provider.auth" || error.status === 402) return true
    return error.status === 400 && ACCOUNT_LIMIT_TEXT.test(error.message)
}

/** A throttle, typed by the host whether or not the failure carried an HTTP status (to-session-error.ts:35, :105). */
function isRateLimit(error: StructuredError): boolean {
    return error.type === "provider.rate-limit" || (error.status === RATE_LIMIT_STATUS && !accountUnavailable(error))
}

/** How long an unavailable account's provider is skipped: a top-up or a new key takes longer than a rate limit. */
const ACCOUNT_COOLDOWN_MS = 30 * 60_000

const RATE_LIMIT_CONTINUE =
    "The model provider rate-limited the last requests and the retries in that step ran out. " +
    "Continue from where you left off without repeating completed work."

/** The agent name without its `ac/` namespace, as tiers are named; `build` is the main session. */
function tierKey(agent: string): string {
    return AGENT_TIERS[agent] ?? (agent.startsWith("ac/") ? agent.slice(3) : agent)
}

/** The form chain entries are written in, so a log line reads like the config. */
function formatRef(model: PlainModel): ModelRef {
    return `${model.providerID}/${model.id}${model.variant === undefined ? "" : `#${model.variant}`}`
}

/** The provider is the part before the first slash, for both chain entries and live session models. */
function providerOf(ref: ModelRef | PlainModel): string {
    return typeof ref === "string" ? ref.slice(0, ref.indexOf("/")) : ref.providerID
}

/**
 * Main-session model fallback. A failure at the retry cap moves the session one step down its tier chain and leaves
 * the host retry going: opencode reloads the session and resolves its current model on every retry
 * (core/src/session/runner/llm.ts:211-212, session/context.ts:169), so the retry runs on the switched model without
 * a second copy of the user prompt. `ac_fallback_next` gives the execute skill the same chain walk for workers.
 *
 * A 429 follows `rateLimitBackoff` on every session, carried across the host's 10-retry steps: a root session whose
 * step ran out is continued with a synthetic message, and a failed subagent's re-spawn picks the count up again.
 */
export async function registerFallback(
    ctx: Context,
    config: ModelConfig,
): Promise<RateLimitResume & { stop(): void }> {
    // Keyed `model:<provider/model>` or `group:<name>`; a provider outside `config.groups` is its own group.
    const cooldownUntil = new Map<string, number>()
    // Models that already failed in the current user turn, per session. A new turn starts a fresh descent.
    const tried = new Map<string, Set<string>>()
    const switching = new Set<string>()
    const fallenBack = new Map<string, FallenBack>()
    const attempts = new Map<string, AttemptWindow>()
    const streaks = new Map<string, RateStreak>()
    // Keyed `tier|provider/model`: the highest count any session of that tier reached on that model, and the count
    // a `wait:` answer handed to the re-spawn, which its first rate-limit retry takes up.
    // `carried` is a queue per key, so two workers waiting on one model each hand their own count on.
    const observed = new Map<string, SpentRetries>()
    const carried = new Map<string, SpentRetries[]>()
    const decisions = new Map<string, Promise<boolean>>()
    const failures = new Map<string, StructuredError>()
    // Consecutive non-rate-limit failures inside a session's rate-limit run, keyed by session.
    const serverRuns = new Map<string, { model: string; count: number }>()
    const timers = new Set<ReturnType<typeof setTimeout>>()
    const lostListeners: Array<(sessionID: string) => void> = []
    const groupByProvider = new Map<string, string>(
        Object.entries(config.groups).flatMap(([group, providers]) => providers.map((provider) => [provider, group])),
    )

    const groupKey = (ref: ModelRef | PlainModel): string => {
        const provider = providerOf(ref)
        return `group:${groupByProvider.get(provider) ?? provider}`
    }

    const coolDown = (key: string, ms: number = config.cooldownSeconds * 1_000): void => {
        cooldownUntil.set(key, Date.now() + ms)
    }

    const isCoolingDown = (key: string): boolean => (cooldownUntil.get(key) ?? 0) > Date.now()

    // `model.list` answers with the models of providers that have a connection, so an entry missing from it has no
    // credential to run on; it is read per decision because the operator can log in while the server runs.
    const connectedModels = async (): Promise<ReadonlySet<string>> =>
        new Set((await ctx.model.list()).data.map((model) => `${model.providerID}/${model.id}`))

    // A group cooldown says the shared rate limit is spent; a 5xx is the model's own failure, so a sibling in a
    // cooling group can still take it. A provider cooldown is an account that cannot serve anything at all.
    const isUsable = (ref: ModelRef, connected: ReadonlySet<string>, groupCooldown: boolean): boolean =>
        connected.has(modelKey(ref))
        && !isCoolingDown(`provider:${providerOf(ref)}`)
        && !isCoolingDown(`model:${modelKey(ref)}`)
        && !(groupCooldown && isCoolingDown(groupKey(ref)))

    /** Untried, connected entries outside a model cooldown; the group cooldown is applied by the caller. */
    const candidates = async (tier: string, excluded: ReadonlySet<string>): Promise<ModelRef[]> => {
        const connected = await connectedModels()
        return config.chain(tier).filter((ref) => !excluded.has(modelKey(ref)) && isUsable(ref, connected, false))
    }

    // Chain order for every status: a 429 reaches this only once its model has spent the whole schedule.
    const nextEntry = async (tier: string, excluded: ReadonlySet<string>): Promise<ModelRef | undefined> =>
        (await candidates(tier, excluded))[0]

    const fresh = (entry: SpentRetries | undefined): SpentRetries | undefined =>
        entry !== undefined && Date.now() - entry.at <= SPENT_MEMORY_MS ? entry : undefined

    /** Counts one rate-limit retry of `sessionID` on `model` and returns its 1-based number on that model. */
    const rateLimitRetry = async (sessionID: string, agent: string, model: string): Promise<number> => {
        const key = `${tierKey(agent)}|${model}`
        let streak = streaks.get(sessionID)
        if (streak === undefined || streak.model !== model) {
            // A re-spawned subagent carries on from the count its failed predecessor handed over; the queue is per
            // parent, so a sibling the same parent starts for another step on that model does not take it.
            const handoff = `${(await ctx.session.get({ sessionID })).parentID ?? ROOT}|${key}`
            const queue = (carried.get(handoff) ?? []).filter((entry) => fresh(entry) !== undefined)
            const handed = queue.shift()?.count ?? 0
            if (queue.length === 0) carried.delete(handoff)
            else carried.set(handoff, queue)
            streak = { agent, model, count: handed }
            streaks.set(sessionID, streak)
        }
        streak.count++
        observed.set(key, { count: Math.max(streak.count, fresh(observed.get(key))?.count ?? 0), at: Date.now() })
        return streak.count
    }

    /**
     * Moves a session one entry down its tier chain. Returns the entry switched to, or undefined when the failure was
     * acted on already or nothing is left, in which case the host decision stands and the error stays visible.
     */
    const switchDown = async (
        sessionID: string,
        tier: string,
        model: SessionModel | PlainModel,
        failure: { readonly status?: number; readonly rateLimited: boolean },
        attempt?: number,
    ): Promise<ModelRef | undefined> => {
        // 1. One action per failure observation: a model already handled this turn, or a switch still in flight,
        //    is a repeat of an observation that was acted on.
        const failed = modelKey(model)
        const sessionTried = tried.get(sessionID) ?? new Set<string>()
        if (switching.has(sessionID) || sessionTried.has(failed)) return undefined
        sessionTried.add(failed)
        tried.set(sessionID, sessionTried)
        //    The cooldown covers the whole group on a rate limit, since siblings share it, else just the model.
        coolDown(failure.rateLimited ? groupKey(model) : `model:${failed}`)

        const next = await nextEntry(tier, sessionTried)
        if (next === undefined) return undefined

        // 2. The host's next attempt reloads the session and runs on `next`; its attempts start at this one, so it
        //    gets its own cap before the next switch.
        switching.add(sessionID)
        try {
            await ctx.session.switchModel({ sessionID, model: parseModelRef(next) })
            if (attempt !== undefined) attempts.set(sessionID, { offset: attempt - 1, last: attempt })
            const at = attempt === undefined ? "step retries spent" : `attempt ${attempt}`
            const why = failure.rateLimited ? "rate limit" : `status ${failure.status ?? "none"}`
            log("info", `ac fallback: ${formatRef(model)} -> ${next} (${why}, ${at})`)
            // Landing on the head again needs no switch back.
            if (modelKey(next) === modelKey(config.chain(tier)[0] as ModelRef)) fallenBack.delete(sessionID)
            else fallenBack.set(sessionID, { tier, to: next })
        } finally {
            switching.delete(sessionID)
        }
        return next
    }

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
        log("info", `ac fallback: ${formatRef(current)} -> ${head} (chain head available again)`)
    }

    await ctx.session.hook("prompt", async (event) => {
        // A user turn starts a fresh descent and a fresh rate-limit schedule.
        tried.delete(event.sessionID)
        streaks.delete(event.sessionID)
        serverRuns.delete(event.sessionID)
        await switchBack(event.sessionID)
    })

    await ctx.session.hook("retry", async (event) => {
        const status = event.error.status
        const tier = AGENT_TIERS[event.agent]

        // 0. An account that cannot serve anything is skipped by every session until a top-up or a new key could
        //    have landed. The host does not retry it, so a session this module owns switches and retries at once,
        //    and a worker fails so that ac_fallback_next, which now skips the provider, names the next entry.
        if (accountUnavailable(event.error)) {
            coolDown(`provider:${providerOf(event.model)}`, ACCOUNT_COOLDOWN_MS)
            const reason = `${event.error.type}: ${event.error.message}`
            log("info", `ac fallback: ${event.model.providerID} unavailable (${reason})`)
            const account = { status, rateLimited: false }
            if (tier !== undefined && (await switchDown(event.sessionID, tier, event.model, account, event.attempt))) {
                event.decision = { retry: true, delay: 0 }
            }
            return
        }

        // 1. A rate limit (typed, so one reported inside the stream without a status counts too) waits on the
        //    configured schedule on every ac session, in place of the host's backoff and the provider's retry-after;
        //    any other agent keeps the host policy. Past the schedule a root session this module owns moves down its
        //    chain, and a subagent stops retrying so its parent re-spawns it on what ac_fallback_next names.
        if (isRateLimit(event.error)) {
            if (tier === undefined && !event.agent.startsWith("ac/")) return
            serverRuns.delete(event.sessionID)
            const retry = await rateLimitRetry(event.sessionID, event.agent, modelKey(event.model))
            if (retry <= config.rateLimitRetries) {
                if (event.decision.retry) event.decision = { retry: true, delay: config.rateLimitDelayMs(retry) }
                return
            }
            if (tier === undefined || (await ctx.session.get({ sessionID: event.sessionID })).parentID) {
                event.decision = { retry: false }
                return
            }
            if (await switchDown(event.sessionID, tier, event.model, { status, rateLimited: true }, event.attempt)) {
                if (event.decision.retry) event.decision = { retry: true, delay: 0 }
            }
            return
        }
        if (status === undefined || !config.retryOn.includes(status)) return

        // 2. Any other retryable status switches at the per-model cap, and from the host's last attempts whatever
        //    the cap says, unless the model is inside a rate-limit run it has not spent: a stray 5xx there must not
        //    cut its schedule short. The scheduled delay honours the failed provider's retry-after, which says
        //    nothing about the next entry, so a switch sets it to zero.
        if (tier === undefined) return
        const model = modelKey(event.model)
        const run = streaks.get(event.sessionID)
        if (run !== undefined && run.model === model) {
            const previous = serverRuns.get(event.sessionID)
            const count = previous?.model === model ? previous.count + 1 : 1
            serverRuns.set(event.sessionID, { model, count })
            if (count < config.retryAttempts) return
        } else {
            const belowCap = modelAttempt(event.sessionID, event.attempt) < config.retryAttempts
            if (belowCap && event.attempt < HOST_LAST_SWITCH_ATTEMPT) return
        }
        if (await switchDown(event.sessionID, tier, event.model, { status, rateLimited: false }, event.attempt)) {
            if (event.decision.retry) event.decision = { retry: true, delay: 0 }
        }
    })

    /**
     * A root session whose step ran out of host retries on a rate limit is continued, after the schedule's next wait,
     * with one synthetic message; past the schedule it first moves down its chain. A subagent's failure has reached
     * its parent's tool call already (core/src/tool/plugin/subagent.ts:246-249), so only a root session continues.
     */
    const decideResume = async (sessionID: string, error: StructuredError): Promise<boolean> => {
        // 1. A rate limit, or a 5xx that ended the step inside a rate-limit run (a saturated gateway mixes both).
        const rateLimited = isRateLimit(error)
        const serverFailure = !rateLimited && error.status !== undefined && config.retryOn.includes(error.status)
        if (!rateLimited && !serverFailure) return false
        const known = streaks.get(sessionID)
        const tier = known === undefined ? undefined : AGENT_TIERS[known.agent]
        if (known === undefined || tier === undefined) return false
        const session = await ctx.session.get({ sessionID })
        if (session.parentID || session.model === undefined) return false

        // 2. The model may have changed since the streak was counted (a switch on the step's last attempt), and a
        //    count that belongs to another model must not spend this one's schedule.
        const model = modelKey(session.model)
        if (serverFailure && known.model !== model) return false
        const streak = known.model === model ? known : { agent: known.agent, model, count: 0 }
        streaks.set(sessionID, streak)

        // 3. A rate limit spends one retry of the schedule; a 5xx counts toward the model's own failure cap and
        //    waits the schedule's current gap. Past either, the session moves down its chain first.
        let spent: boolean
        if (rateLimited) {
            streak.count++
            spent = streak.count > config.rateLimitRetries
        } else {
            const previous = serverRuns.get(sessionID)
            const count = previous?.model === model ? previous.count + 1 : 1
            serverRuns.set(sessionID, { model, count })
            spent = count >= config.retryAttempts
        }
        let delay = config.rateLimitDelayMs(Math.max(streak.count, 1))
        if (spent) {
            const failure = { status: error.status, rateLimited }
            if ((await switchDown(sessionID, tier, session.model, failure)) === undefined) return false
            streaks.delete(sessionID)
            serverRuns.delete(sessionID)
            delay = 0
        }

        // 4. The continue message starts the next step. One that cannot be delivered is a session that has ended.
        const timer = setTimeout(() => {
            timers.delete(timer)
            ctx.session
                .synthetic({ sessionID, text: RATE_LIMIT_CONTINUE, description: "ac rate limit retry" })
                .catch((cause: unknown) => {
                    log("error", "ac fallback: rate limit continue failed", sessionID, cause)
                    for (const listener of lostListeners) listener(sessionID)
                })
        }, delay)
        timers.add(timer)
        return true
    }

    /** A decision that cannot be made leaves the session failed, so a coordinate lane is still relayed as failed. */
    const decideOrFail = (sessionID: string, error: StructuredError): Promise<boolean> =>
        decideResume(sessionID, error).catch((cause: unknown) => {
            log("error", "ac fallback: rate limit resume failed", sessionID, cause)
            return false
        })

    const resumes = (eventID: string, sessionID: string, error: StructuredError): Promise<boolean> => {
        let decision = decisions.get(eventID)
        if (decision === undefined) {
            decision = decideOrFail(sessionID, error)
            decisions.set(eventID, decision)
            for (const key of decisions.keys()) {
                if (decisions.size <= DECISION_MEMORY) break
                decisions.delete(key)
            }
        }
        return decision
    }

    // A step that ends cleanly closes the session's rate-limit run, and tells a re-spawn that the limit cleared. A
    // failure is kept per session, so ac_fallback_next can read what a subagent failed on from its session id.
    const controller = new AbortController()
    const follow = async (): Promise<void> => {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
            try {
                if (event.type === "session.execution.failed") {
                    failures.set(event.data.sessionID, event.data.error)
                    for (const key of failures.keys()) {
                        if (failures.size <= FAILURE_MEMORY) break
                        failures.delete(key)
                    }
                    await resumes(event.id, event.data.sessionID, event.data.error)
                } else if (event.type === "session.step.ended" && event.data.finish !== "error") {
                    const streak = streaks.get(event.data.sessionID)
                    if (streak === undefined) continue
                    streaks.delete(event.data.sessionID)
                    serverRuns.delete(event.data.sessionID)
                    observed.delete(`${tierKey(streak.agent)}|${streak.model}`)
                }
            } catch (cause) {
                log("error", "ac fallback: event handling failed", event.type, cause)
            }
        }
    }
    follow().catch((cause: unknown) => log("error", "ac fallback: event stream ended", cause))

    await ctx.tool.transform((editor) => {
        // The skills read routing from here, not from config/models.jsonc: an installed preset replaces those chains
        // through the plugin options, and only the plugin sees the merged result.
        editor.add({
            name: "ac_models",
            description: [
                "Returns the model routing this plugin runs on, as JSON: `tiers` maps each tier (an ac agent name",
                "without the ac/ prefix, plus `main`) to its fallback chain, whose first entry is the model that agent",
                "starts on; `groups` names the providers that share one rate limit; `maxParallel` is the default",
                "worker cap per execute wave and `maxLanes` the coordinate lane cap; `retryAttempts` is how many",
                "times a skill runs a failed subagent on one model before it takes the next chain entry.",
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
                    retryAttempts: config.retryAttempts,
                }),
            }),
        })
        editor.add({
            name: "ac_fallback_next",
            description: [
                "Returns the next model to re-spawn a failed ac worker on: the first entry of the tier's fallback",
                "chain that is not in `tried`, not cooling down after a recent failure and on a provider with a",
                "credential. Pass the failed subagent's `session_id` (from `Subagent failed (sessionID: ...)`) and",
                "its HTTP `status` when the error named one: a rate limit clears on its own, so until the last `tried`",
                "model has spent the plugin's rate-limit schedule (30 retries in the shipped config, counted across",
                "re-spawns) it returns `wait:<seconds>`: wait that long and re-spawn the same model. It bounds those",
                "waits itself. Returns `none` when the chain is exhausted; then report the failure instead.",
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
                    session_id: {
                        type: "string",
                        description: "Session id of the failed subagent, from its failure text.",
                    },
                },
                required: [
                    "tier",
                    "tried",
                ],
                additionalProperties: false,
            },
            execute: async (input: unknown, context) => {
                const { tier, tried: triedRefs, status, session_id: sessionID } = input as FallbackNextInput
                const excluded = new Set(triedRefs.map(modelKey))
                const last = triedRefs.at(-1)
                // The parent sees only the provider's message, so the failed session's own record decides.
                const failure = sessionID === undefined ? undefined : failures.get(sessionID)
                const rateLimited = failure === undefined ? status === RATE_LIMIT_STATUS : isRateLimit(failure)
                if (rateLimited && last !== undefined) {
                    // 1. The failed worker's own count, else the highest any session of the tier reached on the
                    //    model, else one host step; the re-spawn takes it on, with this wait as its next retry.
                    const key = `${tier}|${modelKey(last)}`
                    const own = sessionID === undefined ? undefined : streaks.get(sessionID)
                    const spent = own !== undefined && own.model === modelKey(last)
                        ? own.count
                        : (fresh(observed.get(key))?.count ?? HOST_STEP_RETRIES)
                    if (spent < config.rateLimitRetries) {
                        const handoff = `${context.sessionID ?? ROOT}|${key}`
                        carried.set(handoff, [...(carried.get(handoff) ?? []), { count: spent + 1, at: Date.now() }])
                        return { content: `wait:${Math.ceil(config.rateLimitDelayMs(spent + 1) / 1_000)}` }
                    }
                    // 2. Spent: the chain moves on, and the group stays cooled so a main session does not switch
                    //    back onto it at once.
                    observed.delete(key)
                    for (const ref of triedRefs) coolDown(groupKey(ref))
                }
                return { content: (await nextEntry(tier, excluded)) ?? "none" }
            },
        })
    })

    return {
        resumes,
        onLost: (listener) => void lostListeners.push(listener),
        stop: () => {
            controller.abort()
            for (const timer of timers) clearTimeout(timer)
            timers.clear()
        },
    }
}
