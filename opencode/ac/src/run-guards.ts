import { existsSync, readFileSync, realpathSync } from "node:fs"
import { basename, dirname, join, resolve, sep } from "node:path"
import type { Plugin } from "@opencode/plugin"
import { REPLAY_MARKER } from "./fallback.ts"
import { type ExecutionMarker, ownsMarker, readMarker, rootSessionOf } from "./marker.ts"

export interface RunGuardsOptions {
    /** The repository holding `.ac/`; defaults to the plugin instance's location, which its sessions share. */
    directory?: string
}

type Cleanup = () => void

// stop-guard-announce.sh's budget: one nudge per stall, three per user prompt. A nudge is a synthetic message that
// starts a new run, so without both caps a model that keeps ending its turn would loop on the guard indefinitely.
const MAX_NUDGES_PER_PROMPT = 3

const UNCHECKED_STEP = /^- \[ \] (.+)$/gm
const CHECKED_STEP = /^- \[x\] /gm

/**
 * Re-injected into the orchestrator's system prompt for as long as it owns a live marker. A compaction drops the loaded
 * execute skill body and a plugin cannot re-activate a skill, so these bounds are the part that must survive. The text
 * never varies with run state: system text is frozen into the session's cache prefix, and dynamic state rides in the
 * synthetic messages below instead.
 */
const STANDING_RULES = [
    "ac execute run in progress (standing rules; they hold after a compaction too).",
    "",
    "Turn termination: your turn ends on a question tool call, the Phase 4b execution summary, or a one-line wait " +
        "status while subagents you spawned still run. Nothing else ends it. Never end a turn by describing what " +
        "you would do next, and never propose a fresh session to continue the run.",
    "",
    "Every branch that terminates the run deletes .ac/state/active-execution.json first. While it exists and no " +
        "subagent of this session runs, the ac plugin hands an ended turn back with the outstanding steps.",
    "",
    "Context: compaction summarizes older turns and the run continues. A filling context window is not a stopping " +
        "condition. When the procedure you need is gone from context, load the skill `execute` again and read the " +
        "plan file named in .ac/state/active-execution.json for the authoritative step state.",
    "",
    "A stop needs a name: a fact you cannot obtain, a decision only the user can make, or a gate you cannot pass. " +
        "Take that branch, ask with the question tool, delete the marker, and report what landed.",
].join("\n")

interface NudgeState {
    nudges: number
    /** Set by a nudge, cleared by the root session's next tool call: one nudge per stall. */
    stalled: boolean
    interrupted: boolean
}

function planPath(directory: string, marker: ExecutionMarker): string {
    return join(directory, ".ac/plans", marker.slug, "plan.md")
}

function stopNudge(marker: ExecutionMarker, plan: string, path: string): string | undefined {
    const unchecked = [...plan.matchAll(UNCHECKED_STEP)].map((match) => match[1] as string)
    const checked = plan.match(CHECKED_STEP)?.length ?? 0
    const total = unchecked.length + checked
    // A plan with no step checkboxes is an unrecognised shape; a nudge with no concrete next action is worse than none.
    if (total === 0) return undefined

    const outstanding =
        unchecked.length > 0
            ? ["Outstanding steps:", ...unchecked.map((step) => `- ${step}`)]
            : [
                  "Outstanding: all steps checked; Phase 3 review, QA when the plan asks for it, " +
                      "and Phase 4 deliver remain.",
              ]

    return [
        `The ac execute run for '${marker.slug}' is still in flight, so this turn should not have ended.`,
        "",
        `State from disk: wave ${marker.current_wave ?? "unknown"}, ${checked} of ${total} steps checked, ` +
            `${unchecked.length} unchecked.`,
        ...outstanding,
        `Authoritative step state: ${path}, in its \`- [ ]\` checkboxes.`,
        "",
        "No subagent of this session is running, so do not wait with sleep or a polling loop: read the plan file and " +
            "the workers' evidence, and spawn a step again only when its output shows it ended without a result.",
        "",
        "If the user asked you to stop or pause, that outranks this note: delete .ac/state/active-execution.json and " +
            "stop. If an execute halt branch genuinely applies, take it; it deletes the marker before the run stops.",
        "",
        "Otherwise continue the wave loop from the next unchecked step.",
    ].join("\n")
}

function compactionNudge(marker: ExecutionMarker, path: string): string {
    return [
        `Context was just compacted during the ac execute run for '${marker.slug}', and the execute skill body is no ` +
            "longer in context.",
        `Load the skill \`execute\` again, then read ${path} for the authoritative step state and continue from the ` +
            "next unchecked step.",
    ].join("\n")
}

/**
 * Absolute, symlink-free and case-folded, as pretooluse-file-scope.sh compares paths: macOS APFS is case-insensitive
 * and /var is /private/var. A file that does not exist yet resolves through its nearest existing ancestor, so a new
 * file and an existing one canonicalise the same way.
 */
function canonical(path: string): string {
    let tail = ""
    let current = path
    while (!existsSync(current) && dirname(current) !== current) {
        tail = sep + basename(current) + tail
        current = dirname(current)
    }
    return (realpathSync(current) + tail).toLowerCase()
}

function within(parent: string, child: string): boolean {
    return child.startsWith(parent + sep)
}

export async function registerRunGuards(ctx: Plugin.Context, options: RunGuardsOptions = {}): Promise<Cleanup> {
    const directory = options.directory ?? ctx.location.directory
    const roots = new Map<string, Promise<string>>()
    const nudges = new Map<string, NudgeState>()
    /** Running descendant session id to its root, for the owning run only. */
    const running = new Map<string, string>()

    // A session's parent never changes, so each chain is walked once. A failed walk is not an answer: it is dropped
    // so the next call walks again instead of replaying the rejection for the rest of the session.
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

    const stateOf = (sessionID: string): NudgeState => {
        const existing = nudges.get(sessionID)
        if (existing) return existing
        const created = { nudges: 0, stalled: false, interrupted: false }
        nudges.set(sessionID, created)
        return created
    }

    const ownedMarker = (rootSessionID: string): ExecutionMarker | undefined => {
        const marker = readMarker(directory)
        return marker && ownsMarker(marker, rootSessionID) ? marker : undefined
    }

    // 1. The execute skill writes this id pair into the marker; it cannot learn its session id any other way.
    await ctx.tool.transform((editor) => {
        editor.add({
            name: "ac_session",
            description:
                "Returns this session's id and its root session id (the top of the parent chain) as JSON. " +
                "The ac execute skill writes both into .ac/state/active-execution.json.",
            input: {
                type: "object",
                properties: {},
                additionalProperties: false,
            },
            execute: async (_input, context) => ({
                content: JSON.stringify({
                    session_id: context.sessionID,
                    root_session_id: await rootOf(context.sessionID),
                }),
            }),
        })
    })

    // 2. A user prompt opens a fresh nudge budget; any root tool call ends the current stall. A fallback replay
    //    re-sends the prompt that already opened this budget, so it is not a new one.
    await ctx.session.hook("prompt", (event) => {
        if (event.metadata?.[REPLAY_MARKER] !== undefined) return
        nudges.delete(event.sessionID)
    })
    await ctx.tool.hook("execute.after", (event) => {
        const state = nudges.get(event.sessionID)
        if (state) state.stalled = false
    })

    // 3. Workers are child sessions, so ownership is decided on the caller's root. The orchestrator itself is never
    //    scoped: its plan ticks and Phase 3 remediation fall outside every wave's files by design.
    await ctx.permission.hook("evaluate", async (event) => {
        if (event.action !== "edit") return
        const marker = readMarker(directory)
        if (!marker || marker.wave_files.length === 0) return
        if (event.sessionID === marker.root_session_id) return
        // An unknown root leaves the default effect, as pretooluse-file-scope.sh fails open on any resolution doubt.
        const root = await rootOf(event.sessionID).catch((error: unknown) => {
            console.error("ac run-guards: root session lookup failed, edit left unscoped", event.sessionID, error)
            return undefined
        })
        if (root === undefined || !ownsMarker(marker, root)) return

        const acDir = canonical(join(directory, ".ac"))
        const scope = new Set(marker.wave_files.map((file) => canonical(resolve(directory, file))))
        // opencode passes a resource relative to the location directory, or absolute outside it (file-access.ts).
        const outside = event.resources.find((resource) => {
            const target = canonical(resolve(directory, resource))
            return !within(acDir, target) && !scope.has(target)
        })
        if (outside === undefined) return

        event.effect = "deny"
        event.message =
            `Edit outside the active wave's files: ${outside}. ` +
            "The ac execute run scopes worker edits to wave_files in .ac/state/active-execution.json; report the " +
            "need under Issues instead of editing it."
    })

    // 4. The context hook runs on every model request, so the owned-marker check is a cheap root id comparison.
    await ctx.session.hook("context", (event) => {
        if (!ownedMarker(event.sessionID)) return
        event.system.push({ type: "text", text: STANDING_RULES })
    })

    const onStarted = async (sessionID: string): Promise<void> => {
        const marker = readMarker(directory)
        if (!marker || sessionID === marker.root_session_id) return
        const root = await rootOf(sessionID)
        if (ownsMarker(marker, root)) running.set(sessionID, root)
    }

    const onSucceeded = async (sessionID: string): Promise<void> => {
        const marker = ownedMarker(sessionID)
        if (!marker) return
        // Running work wakes the session when it lands, so ending the turn is how the orchestrator waits for it.
        if ([...running.values()].includes(sessionID)) return

        const state = stateOf(sessionID)
        if (state.interrupted || state.stalled || state.nudges >= MAX_NUDGES_PER_PROMPT) return

        const path = planPath(directory, marker)
        if (!existsSync(path)) return
        const text = stopNudge(marker, readFileSync(path, "utf8"), path)
        if (!text) return

        state.nudges++
        state.stalled = true
        await ctx.session.synthetic({ sessionID, text, description: "ac stop guard" })
    }

    const onCompacted = async (sessionID: string): Promise<void> => {
        const marker = ownedMarker(sessionID)
        if (!marker) return
        await ctx.session.synthetic({
            sessionID,
            text: compactionNudge(marker, planPath(directory, marker)),
            description: "ac compaction recovery",
        })
    }

    // 5. Events are handled one at a time so a child's start is recorded before the parent's next stop is judged.
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
                    case "session.compaction.ended":
                        await onCompacted(event.data.sessionID)
                        break
                }
            } catch (error) {
                // One failed lookup must not end the stream and silently disarm every guard for the session.
                console.error("ac run-guards: event handling failed", event.type, error)
            }
        }
    }
    void loop()

    return () => controller.abort()
}
