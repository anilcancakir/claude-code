import { existsSync } from "node:fs"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin"
import { readCoordinateMarker } from "./coordinate.ts"
import { log } from "./log.ts"
import { isFresh, nonEmptyString, readJson, readMarker, rootSessionOf, SLUG } from "./marker.ts"
import type { BackgroundShells } from "./wake.ts"

/** Test seams; the plugin entry passes only the shared shell tracker, so each instance roots itself at its location. */
export interface AwayGuardsOptions {
    directory?: string
    /** Background shells that will wake a session; a stop while one runs is how the run waits for it. */
    shells?: BackgroundShells
}

type Cleanup = () => void

/**
 * The away marker the auto skill writes at `.ac/state/active-auto.json`, the opencode counterpart of the
 * `.ac/state/active-auto.json` section in plugins/ac/skills/auto/references/criteria-schema.md.
 *
 * As with the execute marker, `harness: "opencode"` separates the runtimes: a marker without it was written by Claude
 * Code and is left to the CC hooks. Unlike the execute marker, `session_id` itself is the ownership key and holds the
 * ROOT session id from the `ac_session` tool, because the guards scope every session under that root (the workers
 * included), the way the CC hooks scope every agent of one Claude Code session.
 */
export interface AwayMarker {
    readonly slug: string
    readonly session_id: string
    /** ISO-8601 UTC, written once per run and never refreshed. */
    readonly started_at: string
    /** `planning`, `executing` or `gating`; `unknown` when the model left it out. */
    readonly phase: string
    /** `coordinate`, `execute`, `plan`, `adhoc` or `new`; `unknown` when absent. */
    readonly source: string
    /** The coordinator or plan slug; dropped when it is not a safe path segment. */
    readonly source_ref?: string
    /** The outward actions the user named: `push`, `merge`, `pr`, `release`, `deploy`. */
    readonly allowed_outward: readonly string[]
    /** The decisions file, named in the guards' reasons. */
    readonly decisions: string
}

export const AWAY_MARKER_PATH = ".ac/state/active-auto.json"

const HOUR_MS = 3_600_000
// The CC hooks' bounds: 24 h, and 72 h over a coordinator run, which spans several bundle waves.
const MAX_AGE_MS = 24 * HOUR_MS
const COORDINATE_MAX_AGE_MS = 72 * HOUR_MS

// stop-guard-auto.sh: 3 per phase, because a nudge can buy only one gate run; the close after a verdict gets 1.
const MAX_NUDGES_PER_PHASE = 3
const MAX_CLOSING_NUDGES = 1

/** The live opencode away run under `dir`, or undefined when there is none, it is malformed, or it is stale. */
export function readAwayMarker(dir: string, now: number = Date.now()): AwayMarker | undefined {
    const raw = readJson(join(dir, AWAY_MARKER_PATH))
    if (typeof raw !== "object" || raw === null) return undefined

    const { slug, session_id, started_at, phase, source, source_ref, allowed_outward, decisions, harness } =
        raw as Record<string, unknown>
    if (harness !== "opencode") return undefined
    if (!nonEmptyString(slug) || !SLUG.test(slug)) return undefined
    if (!nonEmptyString(session_id)) return undefined
    const maxAge = source === "coordinate" ? COORDINATE_MAX_AGE_MS : MAX_AGE_MS
    if (!nonEmptyString(started_at) || !isFresh(started_at, now, maxAge)) return undefined

    return {
        slug,
        session_id,
        started_at,
        phase: nonEmptyString(phase) ? phase : "unknown",
        source: nonEmptyString(source) ? source : "unknown",
        ...(nonEmptyString(source_ref) && SLUG.test(source_ref) ? { source_ref } : {}),
        // A non-list grants nothing, as the hook's `if type == "array"` reads it; it does not void the marker.
        allowed_outward: Array.isArray(allowed_outward) ? allowed_outward.filter(nonEmptyString) : [],
        decisions: nonEmptyString(decisions) ? decisions : `.ac/away/${slug}/decisions.md`,
    }
}

/** One denied verb: `needs` names the outward value that would allow it; none means it is always denied. */
interface Hit {
    readonly verb: string
    readonly needs?: string
}

// Prefixes that leave the command word after them (pretooluse-bash-guard.sh's command position).
const WRAPPERS: ReadonlySet<string> = new Set([
    "env",
    "command",
    "exec",
    "nohup",
    "time",
    "sudo",
    "!",
    "{",
    "if",
    "then",
    "else",
    "elif",
    "do",
    "while",
    "until",
])
const GIT_VALUE_OPTIONS: ReadonlySet<string> = new Set([
    "-C",
    "-c",
    "--git-dir",
    "--work-tree",
    "--namespace",
])
const TIMEOUT_VALUE_OPTIONS: ReadonlySet<string> = new Set([
    "-s",
    "-k",
    "--signal",
    "--kill-after",
])
const GH_RELEASE_VERBS: ReadonlySet<string> = new Set([
    "create",
    "delete",
    "edit",
    "upload",
    "delete-asset",
])

/** A short option cluster such as `-rf` or `-fd`; a long option is never one. */
const flagged = (token: string): boolean => /^-[^-]/.test(token)

/** Index of the command word after assignments, wrappers and `timeout N`; past the end when there is none. */
function commandPosition(tokens: readonly string[]): number {
    let p = 0
    while (p < tokens.length) {
        const token = tokens[p] as string
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
            p++
        } else if (token === "timeout") {
            p++
            while (p < tokens.length && (tokens[p] as string).startsWith("-")) {
                if (TIMEOUT_VALUE_OPTIONS.has(tokens[p] as string)) p++
                p++
            }
            // The duration.
            p++
        } else if (WRAPPERS.has(token)) {
            p++
            while (p < tokens.length && (tokens[p] as string).startsWith("-")) p++
        } else {
            break
        }
    }
    return p
}

function classifyGit(args: readonly string[]): Hit | undefined {
    let q = 0
    while (q < args.length) {
        const token = args[q] as string
        if (GIT_VALUE_OPTIONS.has(token)) q += 2
        else if (token.startsWith("-")) q++
        else break
    }
    const subcommand = args[q]
    const rest = args.slice(q + 1)

    switch (subcommand) {
        case "reset":
            return rest.includes("--hard") ? { verb: "git reset --hard" } : undefined
        case "clean":
            return rest.some((token) => token === "--dry-run" || (flagged(token) && token.includes("n")))
                ? undefined
                : { verb: "git clean" }
        case "checkout":
        case "restore":
            return rest.includes(".") ? { verb: `git ${subcommand} .` } : undefined
        case "push": {
            let force = false
            let remove = false
            for (const token of rest) {
                if (token === "--force" || token.startsWith("--force-with-lease") || token === "--force-if-includes") {
                    force = true
                } else if (token === "--mirror" || token === "--delete" || token === "--prune") {
                    remove = true
                } else if (flagged(token)) {
                    force ||= token.includes("f")
                    remove ||= token.includes("d")
                } else if (token.startsWith("+")) {
                    force = true
                } else if (token.startsWith(":")) {
                    remove = true
                }
            }
            if (force) return { verb: "git push --force" }
            if (remove) return { verb: "git push --delete" }
            return { verb: "git push", needs: "push" }
        }
        default:
            return undefined
    }
}

function classifySegment(segment: string): Hit | undefined {
    const tokens = segment
        .split(/\s+/)
        .map((token) => token.replace(/["']/g, ""))
        .filter((token) => token !== "")
    const p = commandPosition(tokens)
    if (p >= tokens.length) return undefined
    const command = (tokens[p] as string).replace(/.*\//, "")
    const args = tokens.slice(p + 1)

    switch (command) {
        case "rm": {
            const options = args.slice(0, args.includes("--") ? args.indexOf("--") : args.length)
            const recursive = options.some((t) => t === "--recursive" || (flagged(t) && /[rR]/.test(t)))
            const force = options.some((t) => t === "--force" || (flagged(t) && t.includes("f")))
            return recursive && force ? { verb: "rm -rf" } : undefined
        }
        case "sed":
            return args.some((t) => t.startsWith("--in-place") || (flagged(t) && /^-[A-Za-z]*i/.test(t)))
                ? { verb: "sed -i" }
                : undefined
        case "perl":
            return args.some((t) => flagged(t) && /^-[0-9aFlnpsTtuUWwXx]*i/.test(t)) ? { verb: "perl -i" } : undefined
        case "git":
            return classifyGit(args)
        case "gh": {
            const [group, verb] = args
            if (group === "pr" && verb === "merge") return { verb: "gh pr merge", needs: "merge" }
            if (group === "pr" && verb === "create") return { verb: "gh pr create", needs: "pr" }
            if (group === "release" && verb !== undefined && GH_RELEASE_VERBS.has(verb)) {
                return { verb: `gh release ${verb}`, needs: "release" }
            }
            return undefined
        }
        default:
            return undefined
    }
}

/**
 * Every guarded verb in `command`, in order. The hook's lexical normalisation, not shell parsing: continuations are
 * joined, the text is split at newline, `;`, `&`, `|`, parentheses and backticks, quotes are dropped from each token,
 * and a verb counts only at a segment's command position. So `git commit -m "never git push"` passes and
 * `git -C ../wt push --force` does not. Every miss errs toward allowing: a verb behind eval, an alias or a variable
 * is not seen.
 */
function classify(command: string): Hit[] {
    return command
        .replace(/\r/g, "")
        .replace(/\\\n/g, " ")
        .split(/[\n;&|()`]/)
        .flatMap((segment) => classifySegment(segment) ?? [])
}

/** A PR needs its branch pushed, and a merge needs both the PR and the push. */
function allows(allowed: readonly string[], needs: string): boolean {
    if (allowed.includes(needs)) return true
    if (needs === "push") return allowed.includes("pr") || allowed.includes("merge")
    if (needs === "pr") return allowed.includes("merge")
    return false
}

/**
 * The reason `command` is refused under `marker`, or undefined when it may run. The first hit that is not an allowed
 * outward verb decides, so `git push && git push --force` is still refused under `allowed_outward: ["push"]`.
 */
export function awayShellDenial(marker: AwayMarker, command: string): string | undefined {
    const hit = classify(command).find(
        (candidate) => candidate.needs === undefined || !allows(marker.allowed_outward, candidate.needs),
    )
    if (hit === undefined) return undefined

    const why = hit.needs
        ? `'${hit.verb}' is an outward action, and this away run's allowed_outward list does not name ` +
          `'${hit.needs}': the user's request did not ask for it.`
        : `'${hit.verb}' cannot be undone from inside the session (or, for sed -i and perl -i, belongs to the edit ` +
          "tool), so it stays denied under any away run whatever the request named."
    return [
        `ac away guard: ${why}`,
        "",
        `Record the action as deferred under ## Blocked in ${marker.decisions} (what, why it was denied) and ` +
            "continue every other independent part of the run; the user picks it up from the closing report. Edit " +
            "files with the edit tool and remove named files with a plain rm. Do not work around this guard.",
        "",
        `If no away run is in progress, the marker ${AWAY_MARKER_PATH} was left behind by an interrupted one: delete ` +
            "it and the command is allowed.",
    ].join("\n")
}

function questionDenial(marker: AwayMarker): string {
    return (
        "ac away guard: the user is away and this session owns the ac/auto away run, so no question reaches them. " +
        "Take the option the flow marks Recommended (a flow gate's default), apply it, and add one line under " +
        `## Decisions in ${marker.decisions}: time | source | question | chosen option | why | not user-approved. ` +
        "If the question is a true blocker (a destructive or irreversible action, an outward action the user did " +
        "not name, a finding that the plan is wrong, a missing secret or credential), add it under ## Blocked in " +
        "the same file instead and continue every other independent part of the run."
    )
}

type Stage = "closing" | "coordinate-closed" | "coordinate-aborted" | "source-ended" | "working" | "gating"

interface StopState {
    /** Nudges spent, keyed `<started_at>:<phase>`: a phase change proves the run moved, so it opens a new budget. */
    readonly spent: Map<string, number>
    /** Set by a nudge, cleared by the root session's next tool call: one nudge per stall. */
    stalled: boolean
    interrupted: boolean
}

function nextAction(stage: Stage, runDir: string, verdict: string): string {
    switch (stage) {
        case "closing":
            return (
                "The verdict exists, so what is left is the close: run the named outward actions its status allows, " +
                `delete ${AWAY_MARKER_PATH}, and report (the auto skill's Phase 4). The marker still arms the away ` +
                "guards, so do not end the turn with it on disk."
            )
        case "coordinate-closed":
            return (
                "The coordinator run this away run carries has closed without a verdict. Set the marker's phase to " +
                `gating, run the read-only gate (ac/auto-verifier) against ${runDir}/criteria.md now and write its ` +
                `body to ${verdict}, then close the away run. A verdict reporting something unmet is a complete ending.`
            )
        case "coordinate-aborted":
            return (
                "The coordinator run this away run carries ended before its roadmap lock, so there are no frozen " +
                `criteria to gate against. Delete ${AWAY_MARKER_PATH} and report what happened and what is recorded ` +
                "under ## Blocked in the decisions file."
            )
        case "source-ended":
            return (
                "The plan or execute run this away run carries has ended (its marker is gone). Set the marker's phase to " +
                `gating and hand off to the read-only gate (ac/auto-verifier) now; its body goes to ${verdict}.`
            )
        case "working":
            return (
                "The run is still working, so this is a note rather than an instruction: no verdict exists yet and " +
                "one will be owed at the end. Continue the run. Once the work it carries is finished, set the marker's " +
                "phase to gating and run the gate."
            )
        case "gating":
            return (
                `Hand off to the read-only gate (ac/auto-verifier) now; its body goes to ${verdict}. A verdict ` +
                "reporting something unmet is a complete and correct ending: report it, do not go back and try to " +
                "make it pass. Running out of achievable work is a result for the gate to record, not a reason to " +
                "invent more work."
            )
    }
}

function stopNudge(marker: AwayMarker, stage: Stage, runDir: string): string {
    const verdict = `${runDir}/verdict.md`
    const state =
        stage === "closing"
            ? `State from disk: ${AWAY_MARKER_PATH} and ${verdict} both exist, so the run is judged but not closed. ` +
              "This note comes once."
            : `State from disk: ${AWAY_MARKER_PATH} exists and ${verdict} does not. That is the entire test behind ` +
              "this note. It does not read what the run was asked to achieve and it does not measure how much of it " +
              "you managed, so nothing you do to the work itself will clear it. The one action that clears it is " +
              "the gate's verdict being written."
    return [
        `The ac/auto away run '${marker.slug}' is not finished, so this turn should not have ended.`,
        "",
        state,
        "",
        nextAction(stage, runDir, verdict),
        "",
        "No subagent or background shell of this session is running, so do not wait with sleep or a polling loop; " +
            "while one runs, ending the turn is the right way to wait and this guard stays silent.",
        "",
        "Context pressure is not a stopping condition. Compaction summarizes older turns and the run continues; do " +
            "not announce a context concern in place of finishing, and do not hand the remainder to a new session.",
        "",
        "If the user asked you to stop, pause or take back control, that outranks this note: delete " +
            `${AWAY_MARKER_PATH} and stop.`,
    ].join("\n")
}

/**
 * The away run's two guards, ports of plugins/ac/hooks/pretooluse-bash-guard.sh and stop-guard-auto.sh. Both act only
 * while the session's ROOT owns a live opencode away marker, and every uncertainty (no marker, another root, a stale
 * or malformed marker, an unreadable file, a failed root lookup) leaves the default.
 *
 * The shell guard refuses the listed publishing and destructive verbs through `permission.hook("evaluate")`, and the
 * question tool with them, since the user is not there to answer. It is a list, not a sandbox: what it cannot parse
 * runs.
 *
 * The stop guard is sequencing only, never satisfaction: it reads the marker and whether a verdict file exists, never
 * the criteria. opencode cannot block a turn end, so it nudges with a synthetic message on
 * `session.execution.succeeded`, as run-guards.ts does. One owner per phase: while this root owns a live coordinate
 * marker coordinate.ts owns the stop; while this root owns a live execute marker run-guards.ts owns it; a plan, execute
 * or new source without one has ended (executing, or an execute source) and is owed the gate, or is still planning
 * and gets the working note.
 */
export async function registerAwayGuards(ctx: Plugin.Context, options: AwayGuardsOptions = {}): Promise<Cleanup> {
    const directory = options.directory ?? ctx.location.directory
    const roots = new Map<string, Promise<string>>()
    const states = new Map<string, StopState>()
    /** Running descendant session id to its root, for the owning run only. */
    const running = new Map<string, string>()

    // A failed walk is dropped so the next call walks again instead of replaying the rejection.
    const rootOf = (sessionID: string): Promise<string> => {
        const known = roots.get(sessionID)
        if (known) return known
        const root = rootSessionOf(ctx, sessionID)
        roots.set(sessionID, root)
        root.catch(() => {
            if (roots.get(sessionID) === root) roots.delete(sessionID)
        })
        return root
    }

    const stateOf = (sessionID: string): StopState => {
        const existing = states.get(sessionID)
        if (existing) return existing
        const created = { spent: new Map<string, number>(), stalled: false, interrupted: false }
        states.set(sessionID, created)
        return created
    }

    // 1. The shell and question guard. Workers are child sessions, so ownership is decided on the caller's root.
    await ctx.permission.hook("evaluate", async (event) => {
        if (event.action !== "shell" && event.action !== "question") return
        if (event.effect === "deny") return
        try {
            const marker = readAwayMarker(directory)
            if (!marker) return
            const root = event.sessionID === marker.session_id ? marker.session_id : await rootOf(event.sessionID)
            if (root !== marker.session_id) return

            const denial =
                event.action === "question"
                    ? questionDenial(marker)
                    : event.resources.map((command) => awayShellDenial(marker, command)).find((reason) => reason)
            if (denial === undefined) return
            event.effect = "deny"
            event.message = denial
        } catch (error) {
            log("error", "ac away: guard check failed, call left to the default", event.sessionID, error)
        }
    })

    // 2. A user prompt opens a fresh nudge budget; any root tool call ends the current stall.
    await ctx.session.hook("prompt", (event) => {
        states.delete(event.sessionID)
    })
    await ctx.tool.hook("execute.after", (event) => {
        const state = states.get(event.sessionID)
        if (state) state.stalled = false
    })

    /** What the run owes next, or undefined when another guard owns this stop or the run cannot be judged. */
    const stageOf = (marker: AwayMarker, sessionID: string): { stage: Stage; runDir: string } | undefined => {
        // 1. Locate the run. A coordinator source keeps no directory of its own, and while its marker lives the
        //    coordinate stop guard owns every stop.
        let runDir = `.ac/auto/${marker.slug}`
        if (marker.source === "coordinate") {
            if (marker.source_ref === undefined) return undefined
            if (readCoordinateMarker(directory)?.session_id === sessionID) return undefined
            runDir = `.ac/coord/${marker.source_ref}`
        }
        // 2. No run directory is a malformed run: there is nowhere for a verdict to land.
        if (!existsSync(join(directory, runDir))) return undefined

        // 3. A verdict means the gate ran, whatever it says; only the close is owed.
        if (existsSync(join(directory, runDir, "verdict.md"))) return { stage: "closing", runDir }
        if (marker.source === "coordinate") {
            const frozen = existsSync(join(directory, runDir, "criteria.md"))
            return { stage: frozen ? "coordinate-closed" : "coordinate-aborted", runDir }
        }

        // 4. Mid-run, the flow being carried owns the stop.
        if (marker.phase === "planning" || marker.phase === "executing") {
            if (marker.source === "adhoc") return { stage: "working", runDir }
            // A live execute run owned by this root has its own stop guard (run-guards.ts). Without one, the plan or
            // execute run being carried is over, or is still planning, and nothing else will nudge this stop.
            if (readMarker(directory)?.root_session_id === sessionID) return undefined
            const ended = marker.source === "execute" || marker.phase === "executing"
            return { stage: ended ? "source-ended" : "working", runDir }
        }
        return { stage: "gating", runDir }
    }

    const onSucceeded = async (sessionID: string): Promise<void> => {
        const marker = readAwayMarker(directory)
        if (!marker || marker.session_id !== sessionID) return
        // Running work wakes the session when it lands, so ending the turn is how the run waits for it.
        if ([...running.values()].includes(sessionID)) return
        if ((options.shells?.pending(sessionID) ?? 0) > 0) return

        const owed = stageOf(marker, sessionID)
        if (!owed) return

        const state = stateOf(sessionID)
        const phase = owed.stage === "closing" ? "closing" : marker.phase
        const key = `${marker.started_at}:${phase}`
        const spent = state.spent.get(key) ?? 0
        const budget = phase === "closing" ? MAX_CLOSING_NUDGES : MAX_NUDGES_PER_PHASE
        if (state.interrupted || state.stalled || spent >= budget) return

        state.spent.set(key, spent + 1)
        state.stalled = true
        await ctx.session.synthetic({
            sessionID,
            text: stopNudge(marker, owed.stage, owed.runDir),
            description: "ac away stop guard",
        })
    }

    const onStarted = async (sessionID: string): Promise<void> => {
        // Recorded whether or not a marker exists yet: a run adopted by /ac/auto may already have children going.
        const root = await rootOf(sessionID)
        if (root !== sessionID) running.set(sessionID, root)
    }

    // 3. Events one at a time, so a child's start is recorded before the root's next stop is judged.
    const controller = new AbortController()
    const loop = async (): Promise<void> => {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
            try {
                switch (event.type) {
                    case "session.execution.started":
                        await onStarted(event.data.sessionID)
                        break
                    case "session.execution.succeeded":
                        running.delete(event.data.sessionID)
                        await onSucceeded(event.data.sessionID)
                        break
                    case "session.execution.failed":
                        running.delete(event.data.sessionID)
                        break
                    case "session.execution.interrupted":
                        running.delete(event.data.sessionID)
                        if (event.data.reason === "user") stateOf(event.data.sessionID).interrupted = true
                        break
                }
            } catch (error) {
                // One failed lookup must not end the stream and silently disarm the guard for the session.
                log("error", "ac away: event handling failed", event.type, error)
            }
        }
    }
    void loop()

    return () => controller.abort()
}
