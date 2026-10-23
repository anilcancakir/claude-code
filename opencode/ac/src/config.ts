import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

/** A chain entry: `provider/model` or `provider/model#variant`. */
export type ModelRef = string

export interface TierOverride {
    replace?: ModelRef[]
    prepend?: ModelRef[]
}

/** One band of the rate-limit schedule: every retry numbered up to `through` waits `seconds` before it runs. */
export interface BackoffStep {
    through: number
    seconds: number
}

export interface ModelsConfigFile {
    tiers?: Record<string, ModelRef[] | TierOverride>
    cooldownSeconds?: number
    retryOn?: number[]
    retryAttempts?: number
    /** Retries of a rate-limited model, in ascending bands; the last band's `through` is the retry count. */
    rateLimitBackoff?: BackoffStep[]
    /** Rate-limit group name to the provider ids that share its limit. */
    groups?: Record<string, string[]>
    /** Default cap on workers running at once in an execute wave. */
    maxParallel?: number
    /** Cap on coordinate lanes working at once per coordinator. */
    maxLanes?: number
    /** Rate-limit group to the request starts per minute the plugin lets through, for every session at once. */
    rateLimits?: Record<string, number>
}

export interface ModelConfig {
    /** Every tier with a non-empty chain. */
    tiers(): readonly string[]
    /** Whether `tier` has a non-empty chain, so a caller can skip a tier instead of catching `chain`'s throw. */
    hasChain(tier: string): boolean
    chain(tier: string): readonly ModelRef[]
    readonly retryOn: readonly number[]
    readonly retryAttempts: number
    /** How many times a rate-limited model is retried before the chain moves on: the schedule's last `through`. */
    readonly rateLimitRetries: number
    /** Wait before rate-limit retry `retry` (1-based) on one model, in ms; past the schedule, its last band. */
    rateLimitDelayMs(retry: number): number
    readonly cooldownSeconds: number
    /** Providers not listed here form a group of their own. */
    readonly groups: Readonly<Record<string, readonly string[]>>
    /** Default cap on workers running at once in an execute wave; `--max-parallel` overrides it per run. */
    readonly maxParallel: number
    /** Coordinate lanes working at once per coordinator; `ac_lane_start` reports it and the skill keeps it. */
    readonly maxLanes: number
    /** Request starts per minute per rate-limit group, queued across every session of the service. */
    readonly rateLimits: Readonly<Record<string, number>>
}

export interface LoadConfigInput {
    /** Plugin options from opencode.jsonc; `options.models` carries a ModelsConfigFile. */
    options?: Readonly<Record<string, unknown>>
    env?: Readonly<Record<string, string | undefined>>
}

const DEFAULTS_URL = new URL("../config/models.jsonc", import.meta.url)

/** `provider/model` or `provider/model#variant`; the model id may hold slashes, as Model.Ref.parse allows. */
const MODEL_REF = /^[^/#\s]+\/[^#\s]+(#[^#\s]+)?$/

/**
 * Removes comments and trailing commas outside string literals. A regex pass would corrupt
 * `//` inside a string (URLs, base paths), so this walks the text once.
 */
export function stripJsonc(text: string): string {
    let out = ""
    let i = 0
    while (i < text.length) {
        const ch = text[i] as string
        const next = text[i + 1]
        if (ch === '"') {
            const start = i
            i++
            while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1
            i++
            out += text.slice(start, i)
        } else if (ch === "/" && next === "/") {
            while (i < text.length && text[i] !== "\n") i++
        } else if (ch === "/" && next === "*") {
            const end = text.indexOf("*/", i + 2)
            i = end === -1 ? text.length : end + 2
        } else {
            out += ch
            i++
        }
    }
    return out.replace(/,(\s*[\]}])/g, "$1")
}

export function parseJsonc(text: string, source: string): unknown {
    try {
        return JSON.parse(stripJsonc(text))
    } catch (error) {
        throw new Error(`${source}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
    }
}

function readConfigFile(path: string): ModelsConfigFile {
    return parseJsonc(readFileSync(path, "utf8"), path) as ModelsConfigFile
}

function applyTier(base: ModelRef[] | undefined, override: ModelRef[] | TierOverride): ModelRef[] {
    if (Array.isArray(override)) return [...override]
    if (override.replace) return [...override.replace]
    return [...(override.prepend ?? []), ...(base ?? [])]
}

function merge(base: ModelsConfigFile, override: ModelsConfigFile): ModelsConfigFile {
    const tiers: Record<string, ModelRef[]> = {}
    for (const [tier, refs] of Object.entries(base.tiers ?? {})) tiers[tier] = applyTier(undefined, refs)
    for (const [tier, tierOverride] of Object.entries(override.tiers ?? {})) {
        tiers[tier] = applyTier(tiers[tier], tierOverride)
    }

    return {
        tiers,
        cooldownSeconds: override.cooldownSeconds ?? base.cooldownSeconds,
        retryOn: override.retryOn ?? base.retryOn,
        retryAttempts: override.retryAttempts ?? base.retryAttempts,
        rateLimitBackoff: override.rateLimitBackoff ?? base.rateLimitBackoff,
        groups: override.groups ?? base.groups,
        maxParallel: override.maxParallel ?? base.maxParallel,
        maxLanes: override.maxLanes ?? base.maxLanes,
        rateLimits: override.rateLimits ?? base.rateLimits,
    }
}

/** Defaults, then plugin options, then the file named by AC_OPENCODE_MODELS; later layers win. */
export function loadConfig(input: LoadConfigInput = {}): ModelConfig {
    const env = input.env ?? process.env

    // 1. Layers in ascending precedence; the env file is the most specific and ephemeral one.
    const layers: ModelsConfigFile[] = [readConfigFile(fileURLToPath(DEFAULTS_URL))]
    const fromOptions = input.options?.models
    if (fromOptions) layers.push(fromOptions as ModelsConfigFile)
    const envFile = env.AC_OPENCODE_MODELS
    if (envFile) layers.push(readConfigFile(envFile))

    // 2. Fold them; the defaults file is complete, so the result has every field.
    const merged = layers.reduce((acc, layer) => merge(acc, layer))
    // merge() resolves every override against its base, so each folded tier is a plain list.
    const tiers = (merged.tiers ?? {}) as Readonly<Record<string, ModelRef[]>>

    const hasChain = (tier: string): boolean => (tiers[tier]?.length ?? 0) > 0

    // 3. A malformed ref would throw later inside an agent transform, and a failing transform disables the whole
    //    plugin (core/src/plugin/state.ts:182-183), so it fails here instead, naming the tier.
    for (const [tier, refs] of Object.entries(tiers)) {
        const invalid = refs.find((ref) => !MODEL_REF.test(ref))
        if (invalid !== undefined) throw new Error(`Invalid model reference "${invalid}" in tier "${tier}"`)
    }
    //    A cap below one would leave a wave or a coordinate run unable to start anything.
    for (const [key, value] of [["maxParallel", merged.maxParallel], ["maxLanes", merged.maxLanes]] as const) {
        if (Number.isInteger(value) && (value as number) >= 1) continue
        throw new Error(`${key} must be a whole number of at least 1`)
    }
    //    An unordered or empty schedule would leave some retry without a wait, or the count undefined.
    const backoff = merged.rateLimitBackoff ?? []
    const ordered = backoff.every(
        (step, index) =>
            Number.isInteger(step.through)
            && step.through > (index === 0 ? 0 : (backoff[index - 1] as BackoffStep).through)
            && Number.isFinite(step.seconds)
            && step.seconds >= 0,
    )
    for (const [group, limit] of Object.entries(merged.rateLimits ?? {})) {
        if (Number.isInteger(limit) && limit >= 1) continue
        throw new Error(`rateLimits.${group} must be a whole number of requests per minute, at least 1`)
    }
    if (backoff.length === 0 || !ordered) {
        throw new Error("rateLimitBackoff must list bands with ascending whole `through` values and `seconds` >= 0")
    }
    const lastBand = backoff.at(-1) as BackoffStep

    return {
        tiers: () => Object.keys(tiers).filter(hasChain),
        hasChain,
        chain(tier) {
            if (!hasChain(tier)) throw new Error(`No model chain configured for tier "${tier}"`)
            return tiers[tier] as ModelRef[]
        },
        retryOn: merged.retryOn ?? [],
        retryAttempts: merged.retryAttempts ?? 0,
        rateLimitRetries: lastBand.through,
        rateLimitDelayMs: (retry) => (backoff.find((step) => retry <= step.through) ?? lastBand).seconds * 1_000,
        cooldownSeconds: merged.cooldownSeconds ?? 0,
        groups: merged.groups ?? {},
        maxParallel: merged.maxParallel ?? 0,
        maxLanes: merged.maxLanes ?? 0,
        rateLimits: merged.rateLimits ?? {},
    }
}
