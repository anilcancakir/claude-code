import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ToolContext } from "@opencode/plugin/promise/tool"
import { loadConfig } from "../src/config.ts"
import {
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
    cleanup: () => void
}

interface SetupOptions {
    /** The plugin instance's location; the coordinator's checkout by default. */
    directory?: string
    /** Makes `session.create` throw, as when the host rejects the location. */
    failCreate?: boolean
    /** Makes the brief's `session.prompt` throw. */
    failPrompt?: boolean
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
        context: async ({ sessionID }: { sessionID: string }) => [
            { type: "assistant", content: [{ type: "text", text: "an earlier turn" }] },
            { type: "user", content: [] },
            { type: "assistant", content: [{ type: "text", text: texts.get(sessionID) ?? "" }] },
        ],
    })
    const cleanup = await registerCoordinate(fake.ctx, loadConfig({ env: {} }), {
        directory: options.directory ?? repo,
        git: {
            addWorktree: async (request) => {
                mkdirSync(request.directory, { recursive: true })
                worktrees.push(request)
            },
            discardWorktree: async (request) => void discarded.push(request),
        },
    })
    fake.applyTransforms()
    return { fake, worktrees, discarded, created, texts, sessions, removed, cleanup }
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
