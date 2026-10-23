import { describe, expect, test } from "bun:test"
import { footerLanes, laneRows, relayOf } from "../src/lane-view.ts"

const COORDINATOR = "ses_coord"

function lane(id: string, bundle: string, created: number, coordinator = COORDINATOR) {
    return {
        id,
        time: { created },
        metadata: {
            ac_lane: { coordinator_session: coordinator, coordinator_directory: "/repo", coord_slug: "ship", bundle },
        },
    }
}

function relay(laneID: string, status: string, state = "completed") {
    return {
        type: "synthetic",
        metadata: { source: "ac_lane", lane: laneID, bundle: "x", state },
        text: `<lane sessionID="${laneID}">\nLANE STATUS\nstatus: ${status}\nbundle: x\n</lane>`,
    }
}

describe("laneRows", () => {
    test("lists this coordinator's lanes oldest first with their last relayed status", () => {
        const sessions = [
            lane("ses_b2", "b2", 2),
            lane("ses_b1", "b1", 1),
            lane("ses_other", "b9", 3, "ses_elsewhere"),
            { id: "ses_plain", time: { created: 4 } },
        ]
        const messages = [relay("ses_b1", "PLANNED"), relay("ses_b1", "DONE"), { type: "user", text: "hi" }]

        expect(laneRows(sessions, COORDINATOR, messages)).toEqual([
            { sessionID: "ses_b1", bundle: "b1", coordSlug: "ship", status: "DONE", state: "completed" },
            { sessionID: "ses_b2", bundle: "b2", coordSlug: "ship" },
        ])
    })

    test("a lane's subagent carries the inherited metadata but is not a row", () => {
        const worker = { ...lane("ses_worker", "b1", 5), parentID: "ses_b1" }

        expect(laneRows([lane("ses_b1", "b1", 1), worker], COORDINATOR, [])).toHaveLength(1)
    })
})

describe("footerLanes", () => {
    const rows = [
        { sessionID: "s1", bundle: "b1", coordSlug: "x", status: "DONE", state: "completed" },
        { sessionID: "s2", bundle: "b2", coordSlug: "x", status: "PLANNED", state: "completed" },
        { sessionID: "s3", bundle: "b3", coordSlug: "x" },
        { sessionID: "s4", bundle: "b4", coordSlug: "x", status: "DONE", state: "failed" },
        { sessionID: "s5", bundle: "b5", coordSlug: "x", status: "DONE", state: "completed" },
    ]

    test("folds settled lanes into a count and labels parked ones; a working lane carries no label", () => {
        const running = new Set(["s3", "s5"])

        expect(footerLanes(rows, (id) => running.has(id))).toEqual({
            lanes: [
                { sessionID: "s2", bundle: "b2", running: false, label: "planned" },
                { sessionID: "s3", bundle: "b3", running: true, label: "" },
                { sessionID: "s4", bundle: "b4", running: false, label: "failed" },
                { sessionID: "s5", bundle: "b5", running: true, label: "" },
            ],
            settled: 1,
        })
    })
})

describe("relayOf", () => {
    test("reads a lane relay and ignores other synthetic messages", () => {
        expect(relayOf(relay("ses_b1", "BLOCKED", "failed"))).toEqual({
            lane: "ses_b1",
            status: "BLOCKED",
            state: "failed",
        })
        expect(relayOf({ type: "synthetic", metadata: { source: "subagent" }, text: "x" })).toBeUndefined()
        expect(relayOf({ type: "assistant", metadata: { source: "ac_lane", lane: "x" } })).toBeUndefined()
    })
})
