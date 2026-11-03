import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ToolContext } from "@opencode/plugin/promise/tool"
import { EXECUTE_MARKER_DIR } from "../src/marker.ts"
import { registerRunGuards } from "../src/run-guards.ts"
import { createFakeCtx, type FakeCtx, type FakeSession } from "./fake-ctx.ts"

const HOUR_MS = 3_600_000

const SESSIONS: Record<string, FakeSession> = {
    ses_root: { id: "ses_root" },
    ses_worker: { id: "ses_worker", parentID: "ses_root" },
    ses_explore: { id: "ses_explore", parentID: "ses_worker" },
    ses_other: { id: "ses_other" },
    ses_other_worker: { id: "ses_other_worker", parentID: "ses_other" },
}

const PLAN = [
    "# Plan",
    "",
    "- [x] **Step 1**: Scaffold the package",
    "- [ ] **Step 2**: Port the guards",
    "- [ ] **Step 3**: Wire the plugin",
    "",
].join("\n")

let dir: string
let cleanup: (() => void) | undefined

function isoAgo(ms: number): string {
    return new Date(Date.now() - ms).toISOString().replace(/\.\d{3}Z$/, "Z")
}

function markerFile(fileName: string): string {
    return join(dir, EXECUTE_MARKER_DIR, fileName)
}

function writeMarker(overrides: Record<string, unknown> = {}, fileName = "demo.json"): void {
    mkdirSync(join(dir, EXECUTE_MARKER_DIR), { recursive: true })
    writeFileSync(
        markerFile(fileName),
        JSON.stringify({
            slug: "demo",
            session_id: "ses_root",
            root_session_id: "ses_root",
            harness: "opencode",
            started_at: isoAgo(HOUR_MS),
            current_wave: 2,
            wave_files: [join(dir, "src/in-scope.ts"), "src/relative.ts"],
            note: "wave 1 committed",
            ...overrides,
        }),
    )
}

function writePlan(text = PLAN, slug = "demo"): void {
    mkdirSync(join(dir, ".ac/plans", slug), { recursive: true })
    writeFileSync(join(dir, ".ac/plans", slug, "plan.md"), text)
}

async function setup(shells?: { pending(sessionID: string): number }): Promise<FakeCtx> {
    const fake = createFakeCtx({ sessions: SESSIONS })
    cleanup = await registerRunGuards(fake.ctx, { directory: dir }, shells)
    fake.applyTransforms()
    return fake
}

/** Lets the event loop drain everything pushed so far; the guards only await microtasks. */
function settle(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 5))
}

async function push(fake: FakeCtx, type: string, data: Record<string, unknown>): Promise<void> {
    fake.pushEvent({ type, data })
    await settle()
}

async function toolCall(fake: FakeCtx, sessionID: string): Promise<void> {
    await fake.fire.tool("execute.after", {
        tool: "read",
        sessionID,
        input: {},
        status: "completed",
        result: { content: "ok" },
    })
}

function edit(fake: FakeCtx, sessionID: string, ...resources: string[]) {
    return fake.fire.permission("evaluate", { sessionID, action: "edit", resources, effect: "allow" })
}

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ac-guards-"))
})

afterEach(() => {
    cleanup?.()
    cleanup = undefined
    rmSync(dir, { recursive: true, force: true })
})

describe("ac_session tool", () => {
    test("returns the caller's session id and its root session id", async () => {
        const fake = await setup()
        const tool = fake.tools.get("ac_session")
        if (!tool) throw new Error("ac_session not registered")

        const result = await tool.execute({}, { sessionID: "ses_explore" } as unknown as ToolContext)

        expect(JSON.parse(String(result.content))).toEqual({
            session_id: "ses_explore",
            root_session_id: "ses_root",
        })
    })
})

describe("stop guard", () => {
    test("sends one synthetic naming the unchecked steps on the first succeeded event", async () => {
        writeMarker()
        writePlan()
        const fake = await setup()

        await push(fake, "session.execution.succeeded", { sessionID: "ses_root" })

        expect(fake.calls.synthetic).toHaveLength(1)
        const call = fake.calls.synthetic[0]
        expect(call?.sessionID).toBe("ses_root")
        expect(call?.text).toContain("**Step 2**: Port the guards")
        expect(call?.text).toContain("**Step 3**: Wire the plugin")
        expect(call?.text).not.toContain("Step 1")
        expect(call?.text).toContain("1 of 3 steps checked")
    })

    test("a second stop with no tool call in between is the same stall", async () => {
        writeMarker()
        writePlan()
        const fake = await setup()

        await push(fake, "session.execution.succeeded", { sessionID: "ses_root" })
        await push(fake, "session.execution.succeeded", { sessionID: "ses_root" })

        expect(fake.calls.synthetic).toHaveLength(1)
    })

    test("caps at 3 per user prompt and resets on the next prompt", async () => {
        writeMarker()
        writePlan()
        const fake = await setup()

        for (let stall = 0; stall < 5; stall++) {
            await push(fake, "session.execution.succeeded", { sessionID: "ses_root" })
            await toolCall(fake, "ses_root")
        }
        expect(fake.calls.synthetic).toHaveLength(3)

        await fake.fire.session("prompt", { sessionID: "ses_root" })
        await push(fake, "session.execution.succeeded", { sessionID: "ses_root" })
        expect(fake.calls.synthetic).toHaveLength(4)
    })

    test("a worker's tool call does not reset the root's stall", async () => {
        writeMarker()
        writePlan()
        const fake = await setup()

        await push(fake, "session.execution.succeeded", { sessionID: "ses_root" })
        await toolCall(fake, "ses_worker")
        await push(fake, "session.execution.succeeded", { sessionID: "ses_root" })

        expect(fake.calls.synthetic).toHaveLength(1)
    })

    test("stays silent while a child session runs, and nudges once it has finished", async () => {
        writeMarker()
        writePlan()
        const fake = await setup()

        await push(fake, "session.execution.started", { sessionID: "ses_worker" })
        await push(fake, "session.execution.succeeded", { sessionID: "ses_root" })
        expect(fake.calls.synthetic).toHaveLength(0)

        await push(fake, "session.execution.succeeded", { sessionID: "ses_worker" })
        await push(fake, "session.execution.succeeded", { sessionID: "ses_root" })
        expect(fake.calls.synthetic).toHaveLength(1)
    })

    test("stays silent while a background shell of the root will wake it", async () => {
        writeMarker()
        writePlan()
        let pending = 1
        const fake = await setup({ pending: (id) => (id === "ses_root" ? pending : 0) })

        await push(fake, "session.execution.succeeded", { sessionID: "ses_root" })
        expect(fake.calls.synthetic).toHaveLength(0)

        pending = 0
        await push(fake, "session.execution.succeeded", { sessionID: "ses_root" })
        expect(fake.calls.synthetic).toHaveLength(1)
    })

    test("a grandchild counts as running work too", async () => {
        writeMarker()
        writePlan()
        const fake = await setup()

        await push(fake, "session.execution.started", { sessionID: "ses_explore" })
        await push(fake, "session.execution.succeeded", { sessionID: "ses_root" })
        expect(fake.calls.synthetic).toHaveLength(0)

        await push(fake, "session.execution.failed", { sessionID: "ses_explore", error: {} })
        await push(fake, "session.execution.succeeded", { sessionID: "ses_root" })
        expect(fake.calls.synthetic).toHaveLength(1)
    })

    test("a user interrupt silences the guard until the next prompt", async () => {
        writeMarker()
        writePlan()
        const fake = await setup()

        await push(fake, "session.execution.interrupted", { sessionID: "ses_root", reason: "user" })
        await push(fake, "session.execution.succeeded", { sessionID: "ses_root" })
        expect(fake.calls.synthetic).toHaveLength(0)

        await fake.fire.session("prompt", { sessionID: "ses_root" })
        await push(fake, "session.execution.succeeded", { sessionID: "ses_root" })
        expect(fake.calls.synthetic).toHaveLength(1)
    })

    test("a marker owned by another root session is ignored", async () => {
        writeMarker({ session_id: "ses_other", root_session_id: "ses_other" })
        writePlan()
        const fake = await setup()

        await push(fake, "session.execution.succeeded", { sessionID: "ses_root" })

        expect(fake.calls.synthetic).toHaveLength(0)
    })

    test("no marker, no nudge", async () => {
        writePlan()
        const fake = await setup()

        await push(fake, "session.execution.succeeded", { sessionID: "ses_root" })

        expect(fake.calls.synthetic).toHaveLength(0)
    })

    test("a marker older than 24 h is ignored", async () => {
        writeMarker({ started_at: isoAgo(25 * HOUR_MS) })
        writePlan()
        const fake = await setup()

        await push(fake, "session.execution.succeeded", { sessionID: "ses_root" })

        expect(fake.calls.synthetic).toHaveLength(0)
    })

    test("an unreadable plan gives no concrete next action, so no nudge", async () => {
        writeMarker()
        const fake = await setup()

        await push(fake, "session.execution.succeeded", { sessionID: "ses_root" })

        expect(fake.calls.synthetic).toHaveLength(0)
    })

    test("with every step checked it names the review and deliver phases", async () => {
        writeMarker()
        writePlan("- [x] **Step 1**: Done\n")
        const fake = await setup()

        await push(fake, "session.execution.succeeded", { sessionID: "ses_root" })

        expect(fake.calls.synthetic[0]?.text).toContain("all steps checked")
    })
})

describe("file-scope guard", () => {
    test("denies a worker edit outside wave_files with a reason", async () => {
        writeMarker()
        const fake = await setup()

        const event = await edit(fake, "ses_worker", "src/elsewhere.ts")

        expect(event.effect).toBe("deny")
        expect(event.message).toContain("src/elsewhere.ts")
    })

    test("denies a grandchild edit outside wave_files", async () => {
        writeMarker()
        const fake = await setup()

        expect((await edit(fake, "ses_explore", "src/elsewhere.ts")).effect).toBe("deny")
    })

    test("allows a worker edit inside wave_files, absolute or repo-relative", async () => {
        writeMarker()
        const fake = await setup()

        expect((await edit(fake, "ses_worker", "src/in-scope.ts")).effect).toBe("allow")
        expect((await edit(fake, "ses_worker", join(dir, "src/relative.ts"))).effect).toBe("allow")
    })

    test("denies when any one of several resources is out of scope", async () => {
        writeMarker()
        const fake = await setup()

        expect((await edit(fake, "ses_worker", "src/in-scope.ts", "src/elsewhere.ts")).effect).toBe("deny")
    })

    test("allows a worker edit under .ac/", async () => {
        writeMarker()
        const fake = await setup()

        expect((await edit(fake, "ses_worker", ".ac/plans/demo/evidence/step2.txt")).effect).toBe("allow")
    })

    test("a traversal out of .ac/ is still scoped", async () => {
        writeMarker()
        const fake = await setup()

        expect((await edit(fake, "ses_worker", ".ac/../src/elsewhere.ts")).effect).toBe("deny")
    })

    test("never scopes the orchestrator's own edits", async () => {
        writeMarker()
        const fake = await setup()

        expect((await edit(fake, "ses_root", "src/elsewhere.ts")).effect).toBe("allow")
    })

    test("a marker owned by another root session does not scope this one's workers", async () => {
        writeMarker({ session_id: "ses_other", root_session_id: "ses_other" })
        const fake = await setup()

        expect((await edit(fake, "ses_worker", "src/elsewhere.ts")).effect).toBe("allow")
        expect((await edit(fake, "ses_other_worker", "src/elsewhere.ts")).effect).toBe("deny")
    })

    test("no marker, no scope", async () => {
        const fake = await setup()

        expect((await edit(fake, "ses_worker", "src/elsewhere.ts")).effect).toBe("allow")
    })

    test("a stale marker does not scope", async () => {
        writeMarker({ started_at: isoAgo(25 * HOUR_MS) })
        const fake = await setup()

        expect((await edit(fake, "ses_worker", "src/elsewhere.ts")).effect).toBe("allow")
    })

    test("an empty wave_files leaves the scope undeclared", async () => {
        writeMarker({ wave_files: [] })
        const fake = await setup()

        expect((await edit(fake, "ses_worker", "src/elsewhere.ts")).effect).toBe("allow")
    })

    test("a failed root lookup leaves the default effect, logs it, and is retried on the next call", async () => {
        writeMarker()
        const sessions: Record<string, FakeSession> = { ...SESSIONS }
        const fake = createFakeCtx({ sessions })
        cleanup = await registerRunGuards(fake.ctx, { directory: dir })
        const logged = spyOn(console, "error").mockImplementation(() => {})
        try {
            const failed = await edit(fake, "ses_late", "src/elsewhere.ts")

            expect(failed.effect).toBe("allow")
            expect(logged).toHaveBeenCalledTimes(1)
            expect(String(logged.mock.calls[0]?.[0])).toContain("ac run-guards")
        } finally {
            logged.mockRestore()
        }

        sessions.ses_late = { id: "ses_late", parentID: "ses_root" }
        expect((await edit(fake, "ses_late", "src/elsewhere.ts")).effect).toBe("deny")
    })

    test("actions other than edit are not scoped", async () => {
        writeMarker()
        const fake = await setup()
        const event = await fake.fire.permission("evaluate", {
            sessionID: "ses_worker",
            action: "read",
            resources: ["src/elsewhere.ts"],
            effect: "allow",
        })

        expect(event.effect).toBe("allow")
    })
})

describe("compaction recovery", () => {
    test("sends one reload synthetic naming the skill and the plan path", async () => {
        writeMarker()
        writePlan()
        const fake = await setup()

        await push(fake, "session.compaction.ended", { sessionID: "ses_root", reason: "auto", text: "summary" })

        expect(fake.calls.synthetic).toHaveLength(1)
        const text = fake.calls.synthetic[0]?.text ?? ""
        expect(text).toContain("`execute`")
        expect(text).toContain(join(dir, ".ac/plans/demo/plan.md"))
    })

    test("a paused lane is told to wait for RESUME, not to continue its steps", async () => {
        writeMarker({ lane: true, paused: true })
        writePlan()
        const fake = await setup()

        await push(fake, "session.compaction.ended", { sessionID: "ses_root", reason: "auto", text: "summary" })

        const text = fake.calls.synthetic[0]?.text ?? ""
        expect(text).toContain("paused")
        expect(text).toContain("wait for RESUME")
        expect(text).not.toContain("next unchecked step")
    })

    test("a worker's compaction is not the orchestrator's", async () => {
        writeMarker()
        const fake = await setup()

        await push(fake, "session.compaction.ended", { sessionID: "ses_worker", reason: "auto", text: "summary" })

        expect(fake.calls.synthetic).toHaveLength(0)
    })

    test("no marker, no reload", async () => {
        const fake = await setup()

        await push(fake, "session.compaction.ended", { sessionID: "ses_root", reason: "auto", text: "summary" })

        expect(fake.calls.synthetic).toHaveLength(0)
    })
})

describe("standing rules", () => {
    async function systemFor(fake: FakeCtx, sessionID: string): Promise<string[]> {
        const event = await fake.fire.session("context", {
            sessionID,
            system: [{ type: "text", text: "base" }],
        })
        return event.system.map((part) => part.text)
    }

    test("appends one fixed part for the owning root session while the marker lives", async () => {
        writeMarker()
        const fake = await setup()

        const first = await systemFor(fake, "ses_root")
        writeMarker({ current_wave: 3, note: "wave 2 committed", wave_files: ["src/other.ts"] })
        const second = await systemFor(fake, "ses_root")

        expect(first).toHaveLength(2)
        expect(first[0]).toBe("base")
        expect(second).toEqual(first)
    })

    test("adds nothing for workers or without an owned marker", async () => {
        writeMarker()
        const fake = await setup()

        expect(await systemFor(fake, "ses_worker")).toEqual(["base"])
        rmSync(markerFile("demo.json"))
        expect(await systemFor(fake, "ses_root")).toEqual(["base"])
    })
})

describe("several runs in one checkout", () => {
    function writeOtherRootRun(): void {
        writeMarker(
            { slug: "beta", session_id: "ses_other", root_session_id: "ses_other", wave_files: ["src/beta.ts"] },
            "beta.json",
        )
        writePlan("- [ ] **Step 9**: Beta work\n", "beta")
    }

    test("two roots each get their own nudge, and neither names the other's plan", async () => {
        writeMarker()
        writePlan()
        writeOtherRootRun()
        const fake = await setup()

        await push(fake, "session.execution.succeeded", { sessionID: "ses_root" })
        await push(fake, "session.execution.succeeded", { sessionID: "ses_other" })

        expect(fake.calls.synthetic).toHaveLength(2)
        const [first, second] = fake.calls.synthetic
        expect(first?.sessionID).toBe("ses_root")
        expect(first?.text).toContain("'demo'")
        expect(first?.text).not.toContain("beta")
        expect(second?.sessionID).toBe("ses_other")
        expect(second?.text).toContain("'beta'")
        expect(second?.text).not.toContain("demo")
    })

    test("each root's workers are scoped by their own run's wave_files only", async () => {
        writeMarker()
        writeOtherRootRun()
        const fake = await setup()

        expect((await edit(fake, "ses_worker", "src/in-scope.ts")).effect).toBe("allow")
        expect((await edit(fake, "ses_worker", "src/beta.ts")).effect).toBe("deny")
        expect((await edit(fake, "ses_other_worker", "src/beta.ts")).effect).toBe("allow")
        expect((await edit(fake, "ses_other_worker", "src/in-scope.ts")).effect).toBe("deny")
    })

    test("ending one run leaves the other root's guards armed", async () => {
        writeMarker()
        writePlan()
        writeOtherRootRun()
        const fake = await setup()

        rmSync(markerFile("beta.json"))
        await push(fake, "session.execution.succeeded", { sessionID: "ses_other" })
        await push(fake, "session.execution.succeeded", { sessionID: "ses_root" })

        expect(fake.calls.synthetic.map((call) => call.sessionID)).toEqual(["ses_root"])
        expect((await edit(fake, "ses_other_worker", "src/elsewhere.ts")).effect).toBe("allow")
        expect((await edit(fake, "ses_worker", "src/elsewhere.ts")).effect).toBe("deny")
    })

    describe("one root owning two markers", () => {
        function writeTwoRuns(): void {
            writeMarker({ wave_files: ["src/a.ts"] }, "demo.json")
            writePlan()
            writeMarker({ slug: "second", wave_files: ["src/b.ts"] }, "second.json")
            writePlan("- [ ] **Step 7**: Second work\n", "second")
        }

        test("file scope is the union of the owned wave_files", async () => {
            writeTwoRuns()
            const fake = await setup()

            expect((await edit(fake, "ses_worker", "src/a.ts")).effect).toBe("allow")
            expect((await edit(fake, "ses_worker", "src/b.ts")).effect).toBe("allow")
            expect((await edit(fake, "ses_worker", "src/c.ts")).effect).toBe("deny")
        })

        test("an undeclared run does not lift the scope another owned run declares", async () => {
            writeMarker({ wave_files: [] }, "demo.json")
            writeMarker({ slug: "second", wave_files: ["src/b.ts"] }, "second.json")
            const fake = await setup()

            expect((await edit(fake, "ses_worker", "src/b.ts")).effect).toBe("allow")
            expect((await edit(fake, "ses_worker", "src/c.ts")).effect).toBe("deny")
        })

        test("one stop nudge names both slugs and both plans' outstanding steps", async () => {
            writeTwoRuns()
            const fake = await setup()

            await push(fake, "session.execution.succeeded", { sessionID: "ses_root" })

            expect(fake.calls.synthetic).toHaveLength(1)
            const text = fake.calls.synthetic[0]?.text ?? ""
            expect(text).toContain("'demo'")
            expect(text).toContain("'second'")
            expect(text).toContain("**Step 2**: Port the guards")
            expect(text).toContain("**Step 7**: Second work")
        })

        test("a lane marker keeps the stop nudge off for its own run only", async () => {
            writeMarker({ lane: true }, "demo.json")
            writePlan()
            writeMarker({ slug: "second" }, "second.json")
            writePlan("- [ ] **Step 7**: Second work\n", "second")
            const fake = await setup()

            await push(fake, "session.execution.succeeded", { sessionID: "ses_root" })

            const text = fake.calls.synthetic[0]?.text ?? ""
            expect(text).toContain("'second'")
            expect(text).not.toContain("'demo'")
        })

        test("compaction recovery names each owned run's plan", async () => {
            writeTwoRuns()
            const fake = await setup()

            await push(fake, "session.compaction.ended", { sessionID: "ses_root", reason: "auto", text: "summary" })

            expect(fake.calls.synthetic).toHaveLength(1)
            const text = fake.calls.synthetic[0]?.text ?? ""
            expect(text).toContain(join(dir, ".ac/plans/demo/plan.md"))
            expect(text).toContain(join(dir, ".ac/plans/second/plan.md"))
        })

        test("a running child silences the nudge for both runs", async () => {
            writeTwoRuns()
            const fake = await setup()

            await push(fake, "session.execution.started", { sessionID: "ses_worker" })
            await push(fake, "session.execution.succeeded", { sessionID: "ses_root" })

            expect(fake.calls.synthetic).toHaveLength(0)
        })
    })

    test("a bad slug and a stop-guard counter are not runs", async () => {
        writeMarker({}, "bad slug.json")
        writeMarker({}, "demo.stop-guard.json")
        writePlan()
        const fake = await setup()

        await push(fake, "session.execution.succeeded", { sessionID: "ses_root" })
        await push(fake, "session.compaction.ended", { sessionID: "ses_root", reason: "auto", text: "summary" })

        expect(fake.calls.synthetic).toHaveLength(0)
        expect((await edit(fake, "ses_worker", "src/elsewhere.ts")).effect).toBe("allow")
    })
})
