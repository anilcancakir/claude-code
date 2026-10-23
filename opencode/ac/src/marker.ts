import { join } from "node:path"
import type { Plugin } from "@opencode/plugin"
import { readIfPresent } from "./memory.ts"

/**
 * The active-execution marker the execute skill writes at `.ac/state/active-execution.json`, the same slot and the
 * same CC fields as plugins/ac/skills/execute/references/execution-state.md, so the `.ac/` layout stays shared.
 *
 * Two fields are opencode-only. `harness: "opencode"` tells the two runtimes' guards apart: a marker without it was
 * written by Claude Code and is left to the CC hooks, and the CC hooks in turn never match an opencode marker because
 * they compare `session_id` with a Claude Code session id. `root_session_id` is the ownership key: workers run as
 * child sessions with their own ids, so a guard walks the caller's parentID chain to the root and compares that, and
 * `session_id` (the orchestrator's own id, from the `ac_session` tool) is informational.
 *
 * `started_at` bounds the marker's life: a crashed run that never deleted it must not keep scoping edits or nudging
 * turns, so past 24 h the marker reads as absent.
 */
export interface ExecutionMarker {
    readonly slug: string
    readonly session_id: string
    readonly root_session_id: string
    readonly harness: "opencode"
    /** ISO-8601 UTC, written once per run and never refreshed. */
    readonly started_at: string
    readonly current_wave?: number
    /** The active wave's step Files, absolute or relative to the repository root; empty means undeclared. */
    readonly wave_files: readonly string[]
    readonly note?: string
}

export const MARKER_PATH = ".ac/state/active-execution.json"

const MAX_AGE_MS = 24 * 3_600_000

// A model-written local time with a trailing Z reads as up to 14 h in the future (UTC+14 is the widest offset), the
// same tolerance stop-guard.sh accepts rather than going inert for the run.
const MAX_FUTURE_SKEW_MS = 14 * 3_600_000

// The slug becomes a path segment under .ac/plans/, and the marker is model-written, so it must not traverse.
const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

function readJson(path: string): unknown {
    const text = readIfPresent(path)
    if (text === undefined) return undefined

    try {
        return JSON.parse(text)
    } catch (error) {
        // A half-written or hand-mangled marker is uncertainty, and every guard fails open on uncertainty.
        if (error instanceof SyntaxError) return undefined
        throw error
    }
}

function nonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.length > 0
}

function isFresh(startedAt: string, now: number): boolean {
    const started = Date.parse(startedAt)
    if (Number.isNaN(started)) return false
    const age = now - started
    return age >= -MAX_FUTURE_SKEW_MS && age <= MAX_AGE_MS
}

/** The live opencode run's marker under `dir`, or undefined when there is none, it is malformed, or it is stale. */
export function readMarker(dir: string, now: number = Date.now()): ExecutionMarker | undefined {
    const raw = readJson(join(dir, MARKER_PATH))
    if (typeof raw !== "object" || raw === null) return undefined

    const fields = raw as Record<string, unknown>
    const { slug, session_id, root_session_id, harness, started_at, current_wave, wave_files, note } = fields
    if (harness !== "opencode") return undefined
    if (!nonEmptyString(slug) || !SLUG.test(slug)) return undefined
    if (!nonEmptyString(session_id) || !nonEmptyString(root_session_id)) return undefined
    if (!nonEmptyString(started_at) || !isFresh(started_at, now)) return undefined
    if (wave_files !== undefined && !(Array.isArray(wave_files) && wave_files.every(nonEmptyString))) return undefined

    return {
        slug,
        session_id,
        root_session_id,
        harness,
        started_at,
        ...(typeof current_wave === "number" ? { current_wave } : {}),
        wave_files: wave_files ?? [],
        ...(typeof note === "string" ? { note } : {}),
    }
}

export function ownsMarker(marker: ExecutionMarker, rootSessionID: string): boolean {
    return marker.root_session_id === rootSessionID
}

/** The top of the caller's parentID chain: the session the user drives, whatever subagent depth the caller sits at. */
export async function rootSessionOf(ctx: Pick<Plugin.Context, "session">, sessionID: string): Promise<string> {
    let current = sessionID
    for (;;) {
        const session = await ctx.session.get({ sessionID: current })
        if (!session.parentID) return current
        current = session.parentID
    }
}
