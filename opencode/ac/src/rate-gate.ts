import type { Plugin } from "@opencode/plugin"
import type { ModelConfig } from "./config.ts"

/** The window a group's `rateLimits` entry counts request starts over; codefast reports `rpm_window_seconds: 60`. */
const WINDOW_MS = 60_000

/**
 * Request starts of one rate-limit group, spread over a rolling window. Every lane, worker and main session of every
 * project sends through the one background service, and that whole service shares one limit (codefast answers with
 * `rate_limit_scope: "group:unlimited"`, `rpm_limit: 25`), so a gate per plugin instance would not hold it.
 */
export class Gate {
    private readonly starts: number[] = []
    private tail: Promise<void> = Promise.resolve()

    constructor(
        /** Request starts per window; a reload with a new config changes it on the live gate. */
        public limit: number,
        private readonly windowMs: number = WINDOW_MS,
    ) {}

    /** Resolves when one more request may start; callers are served in arrival order. */
    acquire(): Promise<void> {
        const turn = this.tail.then(() => this.wait())
        this.tail = turn
        return turn
    }

    private async wait(): Promise<void> {
        for (;;) {
            const now = Date.now()
            while (this.starts.length > 0 && now - (this.starts[0] as number) >= this.windowMs) this.starts.shift()
            if (this.starts.length < this.limit) {
                this.starts.push(now)
                return
            }
            await Bun.sleep((this.starts[0] as number) + this.windowMs - now)
        }
    }
}

/**
 * The host evaluates a local plugin afresh for every location (plugin/src/source.bun.ts:17-22 clears the module cache
 * before each load), so module-level state is per location; the gates hang off the process global instead.
 */
const GATES = Symbol.for("ac.opencode.rate-gates")
const registry = globalThis as typeof globalThis & { [GATES]?: Map<string, Gate> }
const gates: Map<string, Gate> = (registry[GATES] ??= new Map<string, Gate>())

/**
 * The process-wide gate of `group`, created on first use with `limit` request starts per window. A later call with
 * another limit (a plugin reload after a config change) retunes the live gate, keeping its queue and its history.
 */
export function gateOf(group: string, limit: number): Gate {
    let gate = gates.get(group)
    if (gate === undefined) {
        gate = new Gate(limit)
        gates.set(group, gate)
    }
    gate.limit = limit
    return gate
}

/**
 * Holds each HTTP request to a provider in a limited group until its gate lets it start (`http.request` runs right
 * before every send, retries included: core/src/session/model-request.ts:314-331). Pacing below the provider's limit
 * keeps the 429s, and the Cloudflare bans a burst of quick retries earns, from happening at all.
 */
export async function registerRateGate(ctx: Plugin.Context, config: ModelConfig): Promise<void> {
    for (const [group, limit] of Object.entries(config.rateLimits)) {
        const gate = gateOf(group, limit)
        const providers = config.groups[group] ?? [group]
        for (const providerID of providers) {
            await ctx.session.hook("http.request", () => gate.acquire(), { providerID })
        }
    }
}
