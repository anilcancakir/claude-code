import { describe, expect, test } from "bun:test"
import { laneRows, relayOf } from "../src/lane-view.ts"

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
