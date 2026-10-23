import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { execFile } from "node:child_process"
import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import type { ToolContext } from "@opencode/plugin/promise/tool"
import { loadConfig } from "../src/config.ts"
import type { RateLimitResume } from "../src/fallback.ts"
import {
    cloneDependencies,
    COORDINATE_MARKER_PATH,
    laneStatus,
    readCoordinateMarker,
    registerCoordinate,
    type WorktreeRequest,
} from "../src/coordinate.ts"
import { createFakeCtx, type FakeCtx } from "./fake-ctx.ts"

const COORDINATOR = "ses_coord"
const LANE = "ses_lane_1"

let repo: string

interface FakeSessionRecord {
    id: string
    parentID?: string
    metadata?: unknown
    location: { directory: string }
}

interface Harness {
    fake: FakeCtx
    worktrees: WorktreeRequest[]
    discarded: WorktreeRequest[]
    created: Array<Record<string, unknown>>
    /** The last assistant text each session's context returns. */
    texts: Map<string, string>
    sessions: Record<string, FakeSessionRecord>
    removed: string[]
    /** Message lists a session's context returns instead of the default one built from `texts`. */
    contexts: Map<string, unknown[]>
    interrupts: Array<{ sessionID: string; resume?: boolean }>
    cleanup: () => void
}

interface SetupOptions {
    /** The plugin instance's location; the coordinator's checkout by default. */
    directory?: string
    /** Makes `session.create` throw, as when the host rejects the location. */
    failCreate?: boolean
    /** Makes the brief's `session.prompt` throw. */
    failPrompt?: boolean
    /** Background shells the guard consults. */
    shells?: { pending(sessionID: string): number }
    /** Arms the owner-question check with this timeout, checked every few milliseconds. */
    questionTimeoutMs?: number
    /** The fallback's rate-limit answer for a failed session. */
    rateLimit?: RateLimitResume
}

function block(status: string, bundle = "b1"): string {
    return ["LANE STATUS", `status: ${status}`, `bundle: ${bundle}`, "phase: plan", "next: waiting"].join("\n")
}

async function settle(): Promise<void> {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

function laneDirectory(bundle = "b1"): string {
    return join(repo, ".ac/worktrees/lane/ship-auth", bundle)
}

async function setup(options: SetupOptions = {}): Promise<Harness> {
    const sessions: Harness["sessions"] = { [COORDINATOR]: { id: COORDINATOR, location: { directory: repo } } }
    const fake = createFakeCtx({ sessions: sessions as never })
    const worktrees: WorktreeRequest[] = []
    const discarded: WorktreeRequest[] = []
    const created: Array<Record<string, unknown>> = []
    const texts = new Map<string, string>()
    const removed: string[] = []
    const contexts = new Map<string, unknown[]>()
    const interrupts: Harness["interrupts"] = []
    Object.assign(fake.ctx.session, {
        create: async (input: Record<string, unknown>) => {
            if (options.failCreate) throw new Error("location rejected")
            const id = `ses_lane_${created.length + 1}`
            created.push(input)
            sessions[id] = { id, metadata: input.metadata, location: input.location as { directory: string } }
            return { id }
        },
        prompt: async (call: { sessionID: string; text: string }) => {
            if (options.failPrompt) throw new Error("prompt rejected")
            fake.calls.prompt.push(call as never)
        },
        remove: async ({ sessionID }: { sessionID: string }) => void removed.push(sessionID),
        interrupt: async (call: { sessionID: string; resume?: boolean }) => void interrupts.push(call),
        context: async ({ sessionID }: { sessionID: string }) => contexts.get(sessionID) ?? [
            { type: "assistant", content: [{ type: "text", text: "an earlier turn" }] },
            { type: "user", content: [] },
            { type: "assistant", content: [{ type: "text", text: texts.get(sessionID) ?? "" }] },
        ],
    })
    const cleanup = await registerCoordinate(fake.ctx, loadConfig({ env: {} }), {
        directory: options.directory ?? repo,
        ...(options.shells ? { shells: options.shells } : {}),
        ...(options.rateLimit ? { rateLimit: options.rateLimit } : {}),
        questionTimeoutMs: options.questionTimeoutMs ?? 0,
        questionCheckMs: 5,
        git: {
            addWorktree: async (request) => {
                mkdirSync(request.directory, { recursive: true })
                worktrees.push(request)
            },
            discardWorktree: async (request) => void discarded.push(request),
        },
    })
    fake.applyTransforms()
    return { fake, worktrees, discarded, created, texts, sessions, removed, contexts, interrupts, cleanup }
}

async function call(harness: Harness, tool: string, input: Record<string, unknown>): Promise<unknown> {
    const entry = harness.fake.tools.get(tool)
    if (!entry) throw new Error(`no tool ${tool}`)
    const result = await entry.execute(input, { sessionID: COORDINATOR } as ToolContext)
    return JSON.parse(String(result.content))
}

function start(harness: Harness, bundle = "b1"): Promise<unknown> {
    return call(harness, "ac_lane_start", {
        coord_slug: "ship-auth",
        bundle,
        base_sha: "91be07d",
        brief: `brief ${bundle}`,
    })
}

function ended(harness: Harness, sessionID: string): void {
    harness.fake.pushEvent({ type: "session.execution.succeeded", data: { sessionID } })
}

function writeMarker(fields: Record<string, unknown> = {}): void {
    mkdirSync(join(repo, ".ac/state"), { recursive: true })
    mkdirSync(join(repo, ".ac/coord/ship-auth"), { recursive: true })
    writeFileSync(
        join(repo, COORDINATE_MARKER_PATH),
        JSON.stringify({
            slug: "ship-auth",
            session_id: COORDINATOR,
            harness: "opencode",
            started_at: new Date().toISOString(),
            phase: "dispatch",
            ...fields,
        }),
    )
}

function writeState(bundles: Array<{ id: string; status: string }>): void {
    writeFileSync(join(repo, ".ac/coord/ship-auth/state.json"), JSON.stringify({ bundles }))
}

beforeEach(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), "ac-oc-coord-")))
})

afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
})

describe("ac_lane_start", () => {
    test("creates the worktree, a root lane session there, and sends the brief", async () => {
        const harness = await setup()

        const result = await start(harness)

        expect(harness.worktrees).toEqual([
            { repository: repo, directory: laneDirectory(), branch: "lane/ship-auth/b1", baseSha: "91be07d" },
        ])
        expect(harness.created[0]).toMatchObject({
            location: { directory: laneDirectory() },
            agent: "ac/lane",
            metadata: { ac_lane: { coordinator_session: COORDINATOR, coordinator_directory: repo, bundle: "b1" } },
        })
        expect(harness.created[0]).not.toHaveProperty("parentID")
        expect(harness.fake.calls.prompt).toEqual([{ sessionID: LANE, text: "brief b1" }])
        expect(result).toEqual({
            session_id: LANE,
            worktree: laneDirectory(),
            branch: "lane/ship-auth/b1",
            max_lanes: 2,
        })
        harness.cleanup()
    })

    test("rejects a slug or bundle that could leave the worktrees directory, and a ref that is not a sha", async () => {
        const harness = await setup()

        await expect(
            call(harness, "ac_lane_start", { coord_slug: "../x", bundle: "b1", base_sha: "91be07d", brief: "b" }),
        ).rejects.toThrow("kebab-case")
        await expect(
            call(harness, "ac_lane_start", { coord_slug: "x", bundle: "b1", base_sha: "--force", brief: "b" }),
        ).rejects.toThrow("hex")
        expect(harness.worktrees).toHaveLength(0)
        harness.cleanup()
    })

    test("a lane session that cannot be created takes its worktree and branch with it", async () => {
        const harness = await setup({ failCreate: true })

        await expect(start(harness)).rejects.toThrow("location rejected")

        expect(harness.discarded.map((request) => request.branch)).toEqual(["lane/ship-auth/b1"])
        expect(harness.fake.calls.prompt).toHaveLength(0)
        harness.cleanup()
    })
})

test("a lane whose brief cannot be sent is removed with its worktree and branch", async () => {
    const harness = await setup({ failPrompt: true })

    await expect(start(harness)).rejects.toThrow("prompt rejected")

    expect(harness.removed).toEqual([LANE])
    expect(harness.discarded.map((request) => request.branch)).toEqual(["lane/ship-auth/b1"])
    harness.cleanup()
})

describe("lane relay", () => {
    test("the instance at the lane's worktree relays its last message to the coordinator", async () => {
        const coordinator = await setup()
        await start(coordinator)
        const laneInstance = await setup({ directory: laneDirectory() })
        Object.assign(laneInstance.sessions, coordinator.sessions)
        laneInstance.texts.set(LANE, block("DECISIONS"))

        ended(laneInstance, LANE)
        await settle()

        expect(laneInstance.fake.calls.synthetic).toHaveLength(1)
        const relayed = laneInstance.fake.calls.synthetic[0]
        expect(relayed?.sessionID).toBe(COORDINATOR)
        expect(relayed?.text).toStartWith(`<lane sessionID="${LANE}" bundle="b1" state="completed">\n`)
        expect(relayed?.text).toContain("status: DECISIONS")
        expect(relayed?.text).not.toContain("an earlier turn")
        coordinator.cleanup()
        laneInstance.cleanup()
    })

    test("an instance elsewhere, the coordinator's included, never relays, so a lane is relayed once", async () => {
        const coordinator = await setup()
        await start(coordinator)
        coordinator.texts.set(LANE, block("PLANNED"))

        ended(coordinator, LANE)
        await settle()

        expect(coordinator.fake.calls.synthetic).toHaveLength(0)
        coordinator.cleanup()
    })

    test("a lane's subagent inherits the lane metadata but is not a lane", async () => {
        const laneInstance = await setup({ directory: laneDirectory() })
        laneInstance.sessions.ses_worker = {
            id: "ses_worker",
            parentID: LANE,
            location: { directory: laneDirectory() },
            metadata: {
                ac_lane: {
                    coordinator_session: COORDINATOR,
                    coordinator_directory: repo,
                    coord_slug: "x",
                    bundle: "b1",
                },
            },
        }
        laneInstance.texts.set("ses_worker", "worker report")

        ended(laneInstance, "ses_worker")
        await settle()

        expect(laneInstance.fake.calls.synthetic).toHaveLength(0)
        laneInstance.cleanup()
    })

    test("a WORKING lane is not relayed; a failed one is relayed as failed; a shutdown is neither", async () => {
        const coordinator = await setup()
        await start(coordinator)
        const laneInstance = await setup({ directory: laneDirectory() })
        Object.assign(laneInstance.sessions, coordinator.sessions)

        laneInstance.texts.set(LANE, block("WORKING"))
        ended(laneInstance, LANE)
        laneInstance.fake.pushEvent({
            type: "session.execution.interrupted",
            data: { sessionID: LANE, reason: "shutdown" },
        })
        await settle()
        expect(laneInstance.fake.calls.synthetic).toHaveLength(0)

        laneInstance.fake.pushEvent({
            type: "session.execution.failed",
            data: { sessionID: LANE, error: { message: "boom" } },
        })
        await settle()
        expect(laneInstance.fake.calls.synthetic[0]?.text).toContain('state="failed"')
        expect(laneInstance.fake.calls.synthetic[0]?.text).toContain("boom")
        coordinator.cleanup()
        laneInstance.cleanup()
    })
})

describe("a rate-limited lane", () => {
    test("a failure the fallback continues is not relayed; one it leaves is", async () => {
        const coordinator = await setup()
        await start(coordinator)
        const decided: string[] = []
        const laneInstance = await setup({
            directory: laneDirectory(),
            rateLimit: {
                resumes: async (eventID, _sessionID, error) => {
                    decided.push(eventID)
                    return error.status === 429
                },
                onLost: () => {},
            },
        })
        Object.assign(laneInstance.sessions, coordinator.sessions)

        laneInstance.fake.pushEvent({
            type: "session.execution.failed",
            id: "evt_429",
            data: { sessionID: LANE, error: { message: "rate limited", status: 429 } },
        })
        await settle()
        expect(laneInstance.fake.calls.synthetic).toHaveLength(0)

        laneInstance.fake.pushEvent({
            type: "session.execution.failed",
            id: "evt_500",
            data: { sessionID: LANE, error: { message: "boom", status: 500 } },
        })
        await settle()
        expect(decided).toEqual(["evt_429", "evt_500"])
        expect(laneInstance.fake.calls.synthetic[0]?.text).toContain('state="failed"')
        coordinator.cleanup()
        laneInstance.cleanup()
    })
})

describe("a lost rate-limit continuation", () => {
    test("a lane whose continue message was not delivered is relayed as failed", async () => {
        const coordinator = await setup()
        await start(coordinator)
        let lost: ((sessionID: string) => void) | undefined
        const laneInstance = await setup({
            directory: laneDirectory(),
            rateLimit: { resumes: async () => true, onLost: (listener) => void (lost = listener) },
        })
        Object.assign(laneInstance.sessions, coordinator.sessions)

        lost?.(LANE)
        await settle()

        expect(laneInstance.fake.calls.synthetic[0]?.text).toContain('state="failed"')
        expect(laneInstance.fake.calls.synthetic[0]?.text).toContain("could not be delivered")
        coordinator.cleanup()
        laneInstance.cleanup()
    })
})

describe("ac_lane_send", () => {
    test("needs a protocol token and a lane of this coordinator", async () => {
        const harness = await setup()
        await start(harness)
        harness.sessions.ses_plain = { id: "ses_plain", location: { directory: repo } }

        await expect(call(harness, "ac_lane_send", { session_id: LANE, message: "please run" })).rejects.toThrow(
            "must start with",
        )
        await expect(call(harness, "ac_lane_send", { session_id: "ses_plain", message: "EXECUTE" })).rejects.toThrow(
            "not a lane",
        )
        harness.cleanup()
    })

    test("PAUSE steers into a working lane like STOP; RESUME waits for its turn to end", async () => {
        const harness = await setup()
        await start(harness)

        await call(harness, "ac_lane_send", { session_id: LANE, message: "PAUSE" })
        await call(harness, "ac_lane_send", { session_id: LANE, message: "RESUME" })

        expect(harness.fake.calls.prompt.slice(1)).toEqual([
            { sessionID: LANE, text: "PAUSE", delivery: "steer" },
            { sessionID: LANE, text: "RESUME", delivery: "queue" },
        ])
        harness.cleanup()
    })

    test("a resume message waits for the lane's turn to end; STOP steers into it", async () => {
        const harness = await setup()
        await start(harness)

        await call(harness, "ac_lane_send", { session_id: LANE, message: "EXECUTE" })
        await call(harness, "ac_lane_send", { session_id: LANE, message: "STOP" })

        expect(harness.fake.calls.prompt.slice(1)).toEqual([
            { sessionID: LANE, text: "EXECUTE", delivery: "queue" },
            { sessionID: LANE, text: "STOP", delivery: "steer" },
        ])
        harness.cleanup()
    })
})

describe("coordinate stop guard", () => {
    test("nudges an owner that stopped with the run open and nothing working, once per stall", async () => {
        writeMarker()
        writeState([{ id: "b1", status: "planned" }, { id: "b2", status: "merged" }])
        const harness = await setup()

        ended(harness, COORDINATOR)
        await settle()
        ended(harness, COORDINATOR)
        await settle()

        expect(harness.fake.calls.synthetic).toHaveLength(1)
        expect(harness.fake.calls.synthetic[0]?.text).toContain("b1 (planned)")
        expect(harness.fake.calls.synthetic[0]?.text).not.toContain("b2")
        harness.cleanup()
    })

    test("stays quiet while state.json has a lane planning or executing, or once the verdict exists", async () => {
        writeMarker()
        writeState([{ id: "b1", status: "executing" }])
        const harness = await setup()

        ended(harness, COORDINATOR)
        await settle()
        expect(harness.fake.calls.synthetic).toHaveLength(0)

        writeState([{ id: "b1", status: "done" }])
        writeFileSync(join(repo, ".ac/coord/ship-auth/verdict.md"), "status: passed\n")
        ended(harness, COORDINATOR)
        await settle()
        expect(harness.fake.calls.synthetic).toHaveLength(0)
        harness.cleanup()
    })

    test("stays quiet while the owner has paused the run", async () => {
        writeMarker({ phase: "paused" })
        writeState([{ id: "b1", status: "paused" }])
        const harness = await setup()

        ended(harness, COORDINATOR)
        await settle()

        expect(harness.fake.calls.synthetic).toHaveLength(0)
        harness.cleanup()
    })

    test("stays quiet while the owner's background gate run will wake it", async () => {
        writeMarker({ phase: "integrate" })
        writeState([{ id: "b1", status: "done" }])
        let pending = 1
        const harness = await setup({ shells: { pending: (id) => (id === COORDINATOR ? pending : 0) } })

        ended(harness, COORDINATOR)
        await settle()
        expect(harness.fake.calls.synthetic).toHaveLength(0)

        pending = 0
        ended(harness, COORDINATOR)
        await settle()
        expect(harness.fake.calls.synthetic.map((call) => call.description)).toEqual(["ac coordinate stop guard"])
        harness.cleanup()
    })

    test("the standing rules ride in the owner's system prompt only", async () => {
        writeMarker()
        const harness = await setup()

        const owner = await harness.fake.fire.session("context", { sessionID: COORDINATOR, system: [] } as never)
        const other = await harness.fake.fire.session("context", { sessionID: "ses_other", system: [] } as never)

        expect(owner.system.map((part) => part.text).join("\n")).toContain("ac coordinate run in progress")
        expect(other.system).toHaveLength(0)
        harness.cleanup()
    })
})

describe("markers and blocks", () => {
    test("a Claude Code marker or a traversing slug reads as no run", () => {
        writeMarker({ harness: undefined })
        expect(readCoordinateMarker(repo)).toBeUndefined()
        writeMarker({ slug: "../x" })
        expect(readCoordinateMarker(repo)).toBeUndefined()
        writeMarker()
        expect(readCoordinateMarker(repo)?.phase).toBe("dispatch")
    })

    test("laneStatus reads the last block", () => {
        expect(laneStatus(`${block("WORKING")}\n\nlater\n${block("DONE")}`)).toBe("DONE")
        expect(laneStatus("no block here")).toBeUndefined()
    })
})

describe("owner question timeout", () => {
    const MINUTE = 60_000

    function waiting(since: number, alongside = false): unknown[] {
        const running = { status: "running" }
        const question = { type: "tool", id: "call_q1", name: "question", state: running, time: { ran: since } }
        const other = { type: "tool", id: "call_s1", name: "shell", state: running, time: { ran: since } }
        return [{ type: "assistant", id: "msg_a1", content: alongside ? [question, other] : [question] }]
    }

    /** A lane relay as the coordinator's inbox publishes it. */
    function relay(bundle = "b1") {
        return {
            type: "session.inbox.enqueued",
            data: {
                sessionID: COORDINATOR,
                inboxID: `msg_relay_${bundle}`,
                item: { type: "synthetic", payload: { text: "<lane>", metadata: { source: "ac_lane", bundle } } },
            },
        }
    }

    async function armed(questionSince: number, options: { relay?: boolean; alongside?: boolean } = {}) {
        writeMarker()
        writeState([{ id: "b1", status: "planning" }])
        const harness = await setup({ questionTimeoutMs: 10 * MINUTE })
        harness.contexts.set(COORDINATOR, waiting(questionSince, options.alongside))
        if (options.relay ?? true) harness.fake.pushEvent(relay())
        await new Promise((resolve) => setTimeout(resolve, 40))
        return harness
    }

    test("withdraws a question past the timeout when a lane relay waits behind it, once", async () => {
        const harness = await armed(Date.now() - 11 * MINUTE)

        expect(harness.interrupts).toEqual([{ sessionID: COORDINATOR, resume: true }])
        const note = harness.fake.calls.synthetic.find((call) => call.description === "ac question timeout")
        expect(note?.text).toContain("lane b1 parked")
        expect(note?.text).toContain("ask the open question again")
        harness.cleanup()
    })

    test("leaves a young question, one with no relay behind it, and one beside another running tool", async () => {
        for (const [since, options] of [
            [Date.now() - 2 * MINUTE, {}],
            [Date.now() - 11 * MINUTE, { relay: false }],
            [Date.now() - 11 * MINUTE, { alongside: true }],
        ] as const) {
            const harness = await armed(since, options)
            expect(harness.interrupts).toHaveLength(0)
            harness.cleanup()
        }
    })

    test("its own interrupt does not silence the stop guard, the owner's next one does", async () => {
        const harness = await armed(Date.now() - 11 * MINUTE)
        writeState([{ id: "b1", status: "planned" }])
        harness.contexts.delete(COORDINATOR)
        const interrupted = { type: "session.execution.interrupted", data: { sessionID: COORDINATOR, reason: "user" } }

        harness.fake.pushEvent(interrupted)
        ended(harness, COORDINATOR)
        await settle()
        expect(harness.fake.calls.synthetic.map((call) => call.description)).toContain("ac coordinate stop guard")

        harness.fake.pushEvent(interrupted)
        await coordinatorToolCall(harness)
        ended(harness, COORDINATOR)
        await settle()
        const nudges = harness.fake.calls.synthetic.filter((call) => call.description === "ac coordinate stop guard")
        expect(nudges).toHaveLength(1)
        harness.cleanup()
    })
})

/** A coordinator tool call, which ends the guard's current stall. */
async function coordinatorToolCall(harness: Harness): Promise<void> {
    await harness.fake.fire.tool("execute.after", {
        tool: "read",
        sessionID: COORDINATOR,
        status: "completed",
        input: {},
    })
}

describe("lane dependency clone", () => {
    test("clones ignored dependency directories into a new worktree and leaves tracked or present ones", async () => {
        const root = realpathSync(mkdtempSync(join(tmpdir(), "ac-deps-")))
        const repository = join(root, "repo")
        const lane = join(root, "lane")
        try {
            mkdirSync(join(repository, "vendor/acme"), { recursive: true })
            writeFileSync(join(repository, "vendor/acme/autoload.php"), "<?php")
            mkdirSync(join(repository, "node_modules"), { recursive: true })
            writeFileSync(join(repository, ".gitignore"), "/vendor\n")
            await promisify(execFile)("git", ["init", "-q", repository])
            mkdirSync(lane)

            await cloneDependencies(repository, lane)

            expect(existsSync(join(lane, "vendor/acme/autoload.php"))).toBe(true)
            expect(lstatSync(join(lane, "vendor")).isSymbolicLink()).toBe(false)
            // node_modules is not ignored in this repository, so it is not the clone's to make.
            expect(existsSync(join(lane, "node_modules"))).toBe(false)
        } finally {
            rmSync(root, { recursive: true, force: true })
        }
    })
})
