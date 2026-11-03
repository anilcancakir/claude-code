import { readdirSync } from "node:fs"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin"
import { readIfPresent } from "./memory.ts"

/**
 * The per-plan execution marker the execute skill writes at `.ac/state/execute/<slug>.json`, the same slot and the
 * same CC fields as plugins/ac/skills/execute/references/execution-state.md, so the `.ac/` layout stays shared. The
 * file name is the slug and several markers can coexist; a root session acts on every marker it owns.
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
    /** Set by `execute --lane`: the coordinator supervises a lane's turn ends, so the stop nudge stays off. */
    readonly lane?: boolean
    /** Set by a lane on `PAUSE` and cleared on `RESUME`: a compaction meanwhile must not restart the steps. */
    readonly paused?: boolean
}

/** One `<slug>.json` per running plan, so several runs can share a checkout. */
export const EXECUTE_MARKER_DIR = ".ac/state/execute"

// The stop guard of the Claude Code side keeps its block counter beside a marker; it is not a run.
const COUNTER_SUFFIX = ".stop-guard"

const MAX_AGE_MS = 24 * 3_600_000

// A model-written local time with a trailing Z reads as up to 14 h in the future (UTC+14 is the widest offset), the
// same tolerance stop-guard.sh accepts rather than going inert for the run.
const MAX_FUTURE_SKEW_MS = 14 * 3_600_000

// The slug becomes a path segment under .ac/, and the marker is model-written, so it must not traverse.
export const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** The parsed JSON at `path`, or undefined when the file is absent or not JSON; other read errors propagate. */
export function readJson(path: string): unknown {
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

export function nonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.length > 0
}

/** False for an unparseable time too: a marker whose age cannot be confirmed reads as stale. */
export function isFresh(startedAt: string, now: number, maxAgeMs: number = MAX_AGE_MS): boolean {
    const started = Date.parse(startedAt)
    if (Number.isNaN(started)) return false
    const age = now - started
    return age >= -MAX_FUTURE_SKEW_MS && age <= maxAgeMs
}

/** The slugs whose `<slug>.json` sits in `dir`, sorted; counters and names outside the slug charset are skipped. */
function markerSlugs(dir: string): string[] {
    let names: string[]
    try {
        names = readdirSync(join(dir, EXECUTE_MARKER_DIR))
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === "ENOENT" || code === "ENOTDIR") return []
        throw error
    }

    return names
        .filter((name) => name.endsWith(".json"))
        .map((name) => name.slice(0, -".json".length))
        .filter((slug) => !slug.endsWith(COUNTER_SUFFIX) && SLUG.test(slug))
        .sort()
}

/** The marker `slug` names under `dir`, or undefined when it is gone, malformed, foreign or stale. */
function readMarker(dir: string, slug: string, now: number): ExecutionMarker | undefined {
    const raw = readJson(join(dir, EXECUTE_MARKER_DIR, `${slug}.json`))
    if (typeof raw !== "object" || raw === null) return undefined

    // The file name is the slug: the body's own `slug` is never trusted, as it ends up in paths and model text.
    const { session_id, root_session_id, harness, started_at, current_wave, wave_files, note, lane, paused } =
        raw as Record<string, unknown>
    if (harness !== "opencode") return undefined
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
        ...(lane === true ? { lane } : {}),
        ...(paused === true ? { paused } : {}),
    }
}

/** Every live opencode run's marker under `dir`, ordered by slug; unusable files are skipped, never thrown on. */
export function readMarkers(dir: string, now: number = Date.now()): ExecutionMarker[] {
    return markerSlugs(dir).flatMap((slug) => readMarker(dir, slug, now) ?? [])
}

export function ownsMarker(marker: ExecutionMarker, rootSessionID: string): boolean {
    return marker.root_session_id === rootSessionID
}

/** The markers one root session owns: a run only ever acts on these, so another root's runs never touch it. */
export function ownedMarkers(markers: readonly ExecutionMarker[], rootSessionID: string): ExecutionMarker[] {
    return markers.filter((marker) => ownsMarker(marker, rootSessionID))
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
