import { execFile } from "node:child_process"
import { existsSync, realpathSync } from "node:fs"
import { join } from "node:path"
import { promisify } from "node:util"
import type { Plugin } from "@opencode/plugin"
import type { ModelConfig } from "./config.ts"
import { rootSessionOf } from "./marker.ts"
import { readIfPresent } from "./memory.ts"

type Context = Plugin.Context
type Cleanup = () => void

/** Test seams; the plugin entry passes none, so every instance roots itself at its own location. */
export interface CoordinateOptions {
    directory?: string
    git?: LaneGit
}

export interface WorktreeRequest {
    /** The coordinator's checkout, where git runs. */
    repository: string
    directory: string
    branch: string
    baseSha: string
}

/** The two git operations a lane start needs; tests replace git with a recorder. */
export interface LaneGit {
    addWorktree(request: WorktreeRequest): Promise<void>
    /** Undoes `addWorktree` when the lane session could not be created, so a retry can reuse the branch name. */
    discardWorktree(request: WorktreeRequest): Promise<void>
}

/** What `ac_lane_start` stores on the lane session, so any plugin instance can find the lane's coordinator. */
export interface LaneMetadata {
    readonly coordinator_session: string
    readonly coordinator_directory: string
    readonly coord_slug: string
    readonly bundle: string
}

interface Lane {
    readonly id: string
    readonly meta: LaneMetadata
    /** The lane's worktree, canonical; the plugin instance located there is the one that relays the lane. */
    readonly directory: string
}

/** The coordinate run marker, the opencode counterpart of plugins/ac/skills/coordinate/references/state-schema.md. */
export interface CoordinateMarker {
    readonly slug: string
    readonly session_id: string
    readonly started_at: string
    readonly phase: string
}

interface GuardState {
    /** Nudges spent, keyed `<started_at>:<phase>`; a phase change proves the run moved, so it opens a new budget. */
    readonly spent: Map<string, number>
    stalled: boolean
    interrupted: boolean
}

export const COORDINATE_MARKER_PATH = ".ac/state/active-coordinate.json"

const NAME = /^[a-z0-9][a-z0-9-]{0,47}$/
const SHA = /^[0-9a-f]{7,40}$/
const RESUME_TOKEN = /^(ANSWERS|EXECUTE|REBASE|RESOLVE|REVISE|STOP)\b/
const LANE_STATUS = /^LANE STATUS\s*\n(?:.*\n)*?status:\s*([A-Z]+)/gm
const LANE_AGENT = "ac/lane"

/** state.json bundle statuses during which a lane is working and its park will wake the coordinator. */
const WORKING_BUNDLE = new Set(["planning", "executing"])

// stop-guard-coordinate.sh: 72 h, because a run spans several bundle waves; the same 14 h future skew as marker.ts.
const MAX_AGE_MS = 72 * 3_600_000
const MAX_FUTURE_SKEW_MS = 14 * 3_600_000
const MAX_NUDGES_PER_PHASE = 3

/**
 * Re-injected into the coordinator's system prompt while it owns the marker, because a compaction drops the skill
 * body and a plugin cannot re-activate a skill. The text never varies with run state, so the cached prefix holds.
 */
const STANDING_RULES = [
    "ac coordinate run in progress (standing rules; they hold after a compaction too).",
    "",
    "Turn termination: your turn ends on a question tool call, a one-line wait status while lanes or subagents " +
        "you started still work, the Phase 8 report, or a terminal branch that deleted " +
        ".ac/state/active-coordinate.json first. A lane's park arrives as a <lane ...> message and starts your " +
        "next turn.",
    "",
    "You are the only writer of .ac/coord/<slug>/ and of the marker. Lanes report through their LANE STATUS " +
        "block; resume one only with ac_lane_send. Keep the lanes in planning or executing at or under max_lanes. " +
        "Never push without the owner's Push? answer, never `git worktree remove --force`, never patch a lane's " +
        "work yourself.",
    "",
    "Context: when the coordinate procedure is gone from context, load the skill `coordinate` again, then read " +
        ".ac/coord/<slug>/state.json and the marker's phase and note; those files are the run's state.",
].join("\n")

const run = promisify(execFile)

const defaultGit: LaneGit = {
    addWorktree: async ({ repository, directory, branch, baseSha }) => {
        await run("git", ["-C", repository, "worktree", "add", "-b", branch, directory, baseSha])
    },
    // A worktree created a moment ago holds no work, so the plain remove succeeds; never --force.
    discardWorktree: async ({ repository, directory, branch }) => {
        await run("git", ["-C", repository, "worktree", "remove", directory])
        await run("git", ["-C", repository, "branch", "-D", branch])
    },
}

function canonical(path: string): string {
    return existsSync(path) ? realpathSync(path) : path
}

function isFresh(startedAt: string, now: number): boolean {
    const started = Date.parse(startedAt)
    if (Number.isNaN(started)) return false
    const age = now - started
    return age >= -MAX_FUTURE_SKEW_MS && age <= MAX_AGE_MS
}

function parseJson(text: string): unknown {
    try {
        return JSON.parse(text)
    } catch (error) {
        // A half-written file is uncertainty, and the guard fails open on uncertainty.
        if (error instanceof SyntaxError) return undefined
        throw error
    }
}

/** The live opencode coordinate run under `dir`; malformed, stale or Claude Code markers read as absent. */
export function readCoordinateMarker(dir: string, now: number = Date.now()): CoordinateMarker | undefined {
    const text = readIfPresent(join(dir, COORDINATE_MARKER_PATH))
    const raw = text === undefined ? undefined : parseJson(text)
    if (typeof raw !== "object" || raw === null) return undefined

    const { slug, session_id, started_at, phase, harness } = raw as Record<string, unknown>
    if (harness !== "opencode") return undefined
    if (typeof slug !== "string" || !NAME.test(slug)) return undefined
    if (typeof session_id !== "string" || session_id.length === 0) return undefined
    if (typeof started_at !== "string" || !isFresh(started_at, now)) return undefined
    return { slug, session_id, started_at, phase: typeof phase === "string" ? phase : "unknown" }
}

/** The status of the last LANE STATUS block in `text`, or undefined when it carries none. */
export function laneStatus(text: string): string | undefined {
    return [...text.matchAll(LANE_STATUS)].at(-1)?.[1]
}

function laneMetadata(value: unknown): LaneMetadata | undefined {
    if (typeof value !== "object" || value === null) return undefined
    const lane = (value as Record<string, unknown>).ac_lane
    if (typeof lane !== "object" || lane === null) return undefined
    const { coordinator_session, coordinator_directory, coord_slug, bundle } = lane as Record<string, unknown>
    const strings = [coordinator_session, coordinator_directory, coord_slug, bundle]
    if (!strings.every((field) => typeof field === "string" && field.length > 0)) return undefined
    return lane as LaneMetadata
}

/** The text of the final assistant message only, as the host's subagent completion reads it. */
function lastAssistantText(messages: ReadonlyArray<{ type: string }>): string {
    const last = [...messages].reverse().find((message) => message.type === "assistant")
    const content = (last as { content?: ReadonlyArray<{ type: string; text?: string }> } | undefined)?.content ?? []
    const text = content
        .filter((part) => part.type === "text" && (part.text?.length ?? 0) > 0)
        .map((part) => part.text as string)
        .join("\n\n")
    return text.length > 0 ? text : "Lane ended without a text response."
}

interface StateBundle {
    id?: string
    status?: string
}

function stateBundles(directory: string, slug: string): StateBundle[] {
    const text = readIfPresent(join(directory, ".ac/coord", slug, "state.json"))
    const state = text === undefined ? undefined : parseJson(text)
    const bundles = (state as { bundles?: unknown } | undefined)?.bundles
    return Array.isArray(bundles) ? (bundles as StateBundle[]) : []
}

const NEXT_ACTION: Readonly<Record<string, string>> = {
    roadmap:
        "Finish the roadmap: get it oracle-reviewed, then ask the owner with the Roadmap? question. Dispatch " +
        "starts only after that answer.",
    dispatch:
        "Dispatch every bundle whose dependencies are merged, up to the lane cap, and act on lane messages: ask " +
        "DECISIONS and BLOCKED in one batched owner round, send EXECUTE to PLANNED lanes, integrate DONE bundles.",
    integrate:
        "Merge each done bundle into the integration branch, run the gates, archive it, then remove its worktree.",
    gating:
        "Spawn ac/auto-verifier with the criteria path if it has not run, write its body to verdict.md, then ask " +
        "Push?.",
}

function coordinateNudge(marker: CoordinateMarker, bundles: StateBundle[]): string {
    const open = bundles
        .filter((bundle) => bundle.status !== "merged" && bundle.status !== "dropped")
        .map((bundle) => `${bundle.id ?? "?"} (${bundle.status ?? "?"})`)
    return [
        `The ac coordinate run '${marker.slug}' is still open (phase ${marker.phase}) and no lane or subagent of ` +
            "this session is working, so nothing will wake this session again.",
        `Open bundles from .ac/coord/${marker.slug}/state.json: ${open.length > 0 ? open.join(", ") : "none"}.`,
        NEXT_ACTION[marker.phase] ?? "Read state.json and the marker's note, then continue from the recorded phase.",
        "",
        "If the owner asked you to stop, take the Abort branch: it deletes .ac/state/active-coordinate.json first.",
    ].join("\n")
}

/**
 * Coordinate lanes and the coordinator's stop guard.
 *
 * A lane must run in its own worktree, and opencode places a child session in its parent's location
 * (core/src/session.ts:95, :281), so a lane cannot be a subagent of the coordinator. `ac_lane_start` creates the
 * worktree and a root session there instead; the lane's own subagents inherit the worktree, and its metadata too
 * (session.ts:298-300), which is why a session with a parent is never a lane. When a lane parks, its last text
 * reaches the coordinator as a synthetic `<lane ...>` message, the way the host delivers a background subagent's
 * completion (core/src/session/subagent-completion.ts:21-45).
 *
 * The plugin keeps no lane state that matters across a restart. The relay comes from the plugin instance at the
 * lane's own location, which is alive because the lane just ran there, while the coordinator's instance may have
 * been evicted for idling (location-activity.ts:29); `ctx.session.synthetic` reaches a session in any location.
 * Exactly one instance sits at that location, so a lane is relayed once whether or not an instance also sees
 * other locations' events. A message to a lane is a next-turn prompt (`delivery: "queue"`), so it never steers into
 * a turn in progress; only STOP steers. The lane cap is the skill's to keep, from state.json; the stop guard reads
 * the same file.
 */
export async function registerCoordinate(
    ctx: Context,
    config: ModelConfig,
    options: CoordinateOptions = {},
): Promise<Cleanup> {
    const directory = options.directory ?? ctx.location.directory
    const home = canonical(directory)
    const git = options.git ?? defaultGit
    const lanes = new Map<string, Lane>()
    // Session metadata and parents never change after create, so a session found not to be a lane stays so.
    const notLanes = new Set<string>()
    /** Running descendant sessions of the coordinator, keyed by session id, valued by the coordinator's id. */
    const running = new Map<string, string>()
    const guards = new Map<string, GuardState>()

    const laneOf = async (sessionID: string): Promise<Lane | undefined> => {
        const known = lanes.get(sessionID)
        if (known) return known
        if (notLanes.has(sessionID)) return undefined
        const session = await ctx.session.get({ sessionID })
        const meta = laneMetadata(session.metadata)
        if (!meta || session.parentID !== undefined) {
            notLanes.add(sessionID)
            return undefined
        }
        const lane = { id: sessionID, meta, directory: canonical(session.location.directory) }
        lanes.set(sessionID, lane)
        return lane
    }

    const relay = async (lane: Lane, state: "completed" | "failed", text: string): Promise<void> => {
        await ctx.session.synthetic({
            sessionID: lane.meta.coordinator_session,
            description: `lane ${lane.meta.bundle}`,
            text: `<lane sessionID="${lane.id}" bundle="${lane.meta.bundle}" state="${state}">\n${text}\n</lane>`,
            metadata: { source: "ac_lane", lane: lane.id, bundle: lane.meta.bundle, state },
        })
    }

    // 1. The two lane tools, called from the coordinator's session.
    await ctx.tool.transform((editor) => {
        editor.add({
            name: "ac_lane_start",
            description: [
                "Starts one ac coordinate lane: creates the git worktree",
                "<repo>/.ac/worktrees/lane/<coord_slug>/<bundle> on a new branch lane/<coord_slug>/<bundle> at",
                "base_sha, opens an ac/lane session there and sends it the brief. Returns JSON {session_id, worktree,",
                "branch, max_lanes}. Keep the lanes in planning or executing at or under max_lanes: they share the",
                "provider rate limit. A lane's park arrives later as a <lane sessionID=... bundle=... state=...>",
                "message carrying its LANE STATUS block.",
            ].join(" "),
            input: {
                type: "object",
                properties: {
                    coord_slug: { type: "string", description: "The coordinate run slug (lowercase kebab-case)." },
                    bundle: { type: "string", description: "The bundle id, e.g. b1." },
                    base_sha: { type: "string", description: "The integration head the lane branch starts at." },
                    brief: { type: "string", description: "The eight-field lane brief from the coordinate skill." },
                },
                required: [
                    "coord_slug",
                    "bundle",
                    "base_sha",
                    "brief",
                ],
                additionalProperties: false,
            },
            execute: async (input: unknown, context) => {
                const { coord_slug, bundle, base_sha, brief } = input as Record<string, string>
                // These become a path and a branch name, and the model wrote them.
                if (!NAME.test(coord_slug ?? "") || !NAME.test(bundle ?? "")) {
                    throw new Error("coord_slug and bundle must be lowercase kebab-case names of at most 48 characters")
                }
                if (!SHA.test(base_sha ?? "")) throw new Error("base_sha must be a hex commit id")

                // 1. Worktree and branch. The nested path keeps slug and bundle apart, since both may hold a dash.
                const coordinator = await rootSessionOf(ctx, context.sessionID)
                const request: WorktreeRequest = {
                    repository: home,
                    directory: join(home, ".ac/worktrees/lane", coord_slug as string, bundle as string),
                    branch: `lane/${coord_slug}/${bundle}`,
                    baseSha: base_sha as string,
                }
                await git.addWorktree(request)

                // 2. The lane session, a root session at the worktree; a failure here leaves no orphan worktree.
                const meta: LaneMetadata = {
                    coordinator_session: coordinator,
                    coordinator_directory: home,
                    coord_slug: coord_slug as string,
                    bundle: bundle as string,
                }
                const session = await ctx.session
                    .create({
                        location: { directory: request.directory },
                        agent: LANE_AGENT,
                        title: `lane ${coord_slug}/${bundle}`,
                        metadata: { ac_lane: { ...meta } },
                    })
                    .catch(async (error: unknown) => {
                        await git.discardWorktree(request)
                        throw error
                    })
                lanes.set(session.id, { id: session.id, meta, directory: canonical(request.directory) })

                // 3. The brief starts the lane's first turn. A lane that never got it is removed with its worktree,
                //    so a retry of the bundle can create the branch again.
                await ctx.session.prompt({ sessionID: session.id, text: brief as string }).catch(async (error) => {
                    lanes.delete(session.id)
                    await ctx.session.remove({ sessionID: session.id })
                    await git.discardWorktree(request)
                    throw error
                })
                return {
                    content: JSON.stringify({
                        session_id: session.id,
                        worktree: request.directory,
                        branch: request.branch,
                        max_lanes: config.maxLanes,
                    }),
                }
            },
        })

        editor.add({
            name: "ac_lane_send",
            description: [
                "Resumes an ac coordinate lane with one protocol message whose first token is ANSWERS, EXECUTE,",
                "REBASE, RESOLVE, REVISE or STOP. The message waits for the lane's current turn to end; STOP steers",
                "into a turn in progress. The lane's next park arrives as a <lane ...> message.",
            ].join(" "),
            input: {
                type: "object",
                properties: {
                    session_id: { type: "string", description: "The lane's session_id from ac_lane_start." },
                    message: { type: "string", description: "The resume message, first token first." },
                },
                required: [
                    "session_id",
                    "message",
                ],
                additionalProperties: false,
            },
            execute: async (input: unknown, context) => {
                const { session_id, message } = input as Record<string, string>
                if (!RESUME_TOKEN.test(message ?? "")) {
                    throw new Error("message must start with ANSWERS, EXECUTE, REBASE, RESOLVE, REVISE or STOP")
                }
                const lane = await laneOf(session_id as string)
                const coordinator = await rootSessionOf(ctx, context.sessionID)
                if (!lane || lane.meta.coordinator_session !== coordinator) {
                    throw new Error(`Session ${session_id} is not a lane this session started`)
                }

                const delivery = message?.startsWith("STOP") ? "steer" : "queue"
                await ctx.session.prompt({ sessionID: lane.id, text: message as string, delivery })
                return { content: JSON.stringify({ delivered: delivery }) }
            },
        })
    })

    // 2. The coordinator's standing rules ride in its system prompt while it owns the marker.
    const ownedMarker = (sessionID: string): CoordinateMarker | undefined => {
        const marker = readCoordinateMarker(directory)
        return marker?.session_id === sessionID ? marker : undefined
    }

    const guardOf = (sessionID: string): GuardState => {
        const existing = guards.get(sessionID)
        if (existing) return existing
        const created = { spent: new Map<string, number>(), stalled: false, interrupted: false }
        guards.set(sessionID, created)
        return created
    }

    await ctx.session.hook("context", (event) => {
        if (ownedMarker(event.sessionID)) event.system.push({ type: "text", text: STANDING_RULES })
    })
    await ctx.session.hook("prompt", (event) => {
        const guard = guards.get(event.sessionID)
        if (guard) guard.interrupted = false
    })
    await ctx.tool.hook("execute.after", (event) => {
        const guard = guards.get(event.sessionID)
        if (guard) guard.stalled = false
    })

    // 3. The stop guard: a coordinator that ends its turn with the run open and nothing that will wake it stalls.
    //    A lane in planning or executing will wake it, and state.json says so across any restart.
    const onCoordinatorStopped = async (sessionID: string): Promise<void> => {
        const marker = ownedMarker(sessionID)
        if (!marker || existsSync(join(directory, ".ac/coord", marker.slug, "verdict.md"))) return
        const bundles = stateBundles(directory, marker.slug)
        if (bundles.some((bundle) => WORKING_BUNDLE.has(bundle.status ?? ""))) return
        if ([...running.values()].includes(sessionID)) return

        const guard = guardOf(sessionID)
        const key = `${marker.started_at}:${marker.phase}`
        const spent = guard.spent.get(key) ?? 0
        if (guard.interrupted || guard.stalled || spent >= MAX_NUDGES_PER_PHASE) return
        guard.spent.set(key, spent + 1)
        guard.stalled = true
        await ctx.session.synthetic({
            sessionID,
            text: coordinateNudge(marker, bundles),
            description: "ac coordinate stop guard",
        })
    }

    const onStarted = async (sessionID: string): Promise<void> => {
        const marker = readCoordinateMarker(directory)
        if (!marker || sessionID === marker.session_id) return
        const root = await rootSessionOf(ctx, sessionID)
        if (root === marker.session_id) running.set(sessionID, root)
    }

    /** `failure` is the relayed text of a lane run that errored or was interrupted by the user. */
    const onEnded = async (sessionID: string, failure: string | undefined): Promise<void> => {
        running.delete(sessionID)
        const lane = await laneOf(sessionID)
        if (!lane) {
            if (failure === undefined) await onCoordinatorStopped(sessionID)
            return
        }
        if (lane.directory !== home) return
        if (failure !== undefined) return relay(lane, "failed", failure)
        const text = lastAssistantText(await ctx.session.context({ sessionID }))
        // A WORKING lane is parked on its own workers, whose completion wakes it again.
        if (laneStatus(text) === "WORKING") return
        return relay(lane, "completed", text)
    }

    const onCompacted = async (sessionID: string): Promise<void> => {
        const marker = ownedMarker(sessionID)
        if (!marker) return
        await ctx.session.synthetic({
            sessionID,
            description: "ac coordinate compaction recovery",
            text:
                `Context was just compacted during the ac coordinate run '${marker.slug}'. Load the skill ` +
                `\`coordinate\` again, then read .ac/coord/${marker.slug}/state.json and ${COORDINATE_MARKER_PATH} ` +
                "and resume at the recorded phase.",
        })
    }

    // 4. Events one at a time, so a child's start is recorded before the coordinator's next stop is judged.
    const controller = new AbortController()
    const loop = async (): Promise<void> => {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
            try {
                switch (event.type) {
                    case "session.execution.started":
                        await onStarted(event.data.sessionID)
                        break
                    case "session.execution.succeeded":
                        await onEnded(event.data.sessionID, undefined)
                        break
                    case "session.execution.failed":
                        await onEnded(event.data.sessionID, `Lane session failed: ${JSON.stringify(event.data.error)}`)
                        break
                    case "session.execution.interrupted":
                        // A shutdown keeps the run claimed and the host resumes it after the restart
                        // (core/src/session/execution.ts:126-131), so the lane has not ended.
                        if (event.data.reason === "shutdown") break
                        if (event.data.reason === "user") guardOf(event.data.sessionID).interrupted = true
                        await onEnded(event.data.sessionID, "Lane session was interrupted.")
                        break
                    case "session.compaction.ended":
                        await onCompacted(event.data.sessionID)
                        break
                }
            } catch (error) {
                // One failed lookup must not end the stream and silently strand every lane of the run.
                console.error("ac coordinate: event handling failed", event.type, error)
            }
        }
    }
    void loop()

    return () => controller.abort()
}
