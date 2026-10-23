import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

/** A chain entry: `provider/model` or `provider/model#variant`. */
export type ModelRef = string

export interface TierOverride {
    replace?: ModelRef[]
    prepend?: ModelRef[]
}

export interface ModelsConfigFile {
    tiers?: Record<string, ModelRef[] | TierOverride>
    cooldownSeconds?: number
    retryOn?: number[]
    retryAttempts?: number
    /** Retry attempt at which a 429 is acted on; a rate limit clears on its own, so this is far above retryAttempts. */
    rateLimitAttempts?: number
    /** Rate-limit group name to the provider ids that share its limit. */
    groups?: Record<string, string[]>
}

export interface ModelConfig {
    chain(tier: string): readonly ModelRef[]
    readonly retryOn: readonly number[]
    readonly retryAttempts: number
    readonly rateLimitAttempts: number
    readonly cooldownSeconds: number
    /** Providers not listed here form a group of their own. */
    readonly groups: Readonly<Record<string, readonly string[]>>
}

export interface LoadConfigInput {
    /** Plugin options from opencode.jsonc; `options.models` carries a ModelsConfigFile. */
    options?: Readonly<Record<string, unknown>>
    env?: Readonly<Record<string, string | undefined>>
}

const DEFAULTS_URL = new URL("../config/models.jsonc", import.meta.url)

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
        rateLimitAttempts: override.rateLimitAttempts ?? base.rateLimitAttempts,
        groups: override.groups ?? base.groups,
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
    const tiers = merged.tiers ?? {}

    return {
        chain(tier) {
            const refs = tiers[tier] as ModelRef[] | undefined
            if (!refs || refs.length === 0) throw new Error(`No model chain configured for tier "${tier}"`)
            return refs
        },
        retryOn: merged.retryOn ?? [],
        retryAttempts: merged.retryAttempts ?? 0,
        rateLimitAttempts: merged.rateLimitAttempts ?? 0,
        cooldownSeconds: merged.cooldownSeconds ?? 0,
        groups: merged.groups ?? {},
    }
}
