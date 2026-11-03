import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { EXECUTE_MARKER_DIR, ownedMarkers, ownsMarker, readMarkers, rootSessionOf } from "../src/marker.ts"
import { createFakeCtx } from "./fake-ctx.ts"

const HOUR_MS = 3_600_000

let dir: string

function isoAgo(ms: number): string {
    return new Date(Date.now() - ms).toISOString().replace(/\.\d{3}Z$/, "Z")
}

function writeMarkerFile(fileName: string, text: string): void {
    mkdirSync(join(dir, EXECUTE_MARKER_DIR), { recursive: true })
    writeFileSync(join(dir, EXECUTE_MARKER_DIR, fileName), text)
}

function writeMarker(fields: Record<string, unknown>, slug = "demo-plan"): void {
    writeMarkerFile(`${slug}.json`, JSON.stringify(fields))
}

function validMarker(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        slug: "demo-plan",
        session_id: "ses_root",
        root_session_id: "ses_root",
        harness: "opencode",
        started_at: isoAgo(HOUR_MS),
        current_wave: 2,
        wave_files: ["src/a.ts"],
        note: "wave 1 committed",
        ...overrides,
    }
}

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ac-marker-"))
})

afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
})

describe("readMarkers", () => {
    test("returns the parsed marker for a fresh opencode run", () => {
        writeMarker(validMarker())

        expect(readMarkers(dir)).toEqual([
            {
                slug: "demo-plan",
                session_id: "ses_root",
                root_session_id: "ses_root",
                harness: "opencode",
                started_at: expect.any(String),
                current_wave: 2,
                wave_files: ["src/a.ts"],
                note: "wave 1 committed",
            },
        ])
    })

    test("an absent directory means no run", () => {
        expect(readMarkers(dir)).toEqual([])
    })

    test("malformed JSON is uncertainty, not a run", () => {
        writeMarkerFile("demo-plan.json", "{ not json")

        expect(readMarkers(dir)).toEqual([])
    })

    test("a marker older than 24 h is stale", () => {
        writeMarker(validMarker({ started_at: isoAgo(25 * HOUR_MS) }))

        expect(readMarkers(dir)).toEqual([])
    })

    test("an unparseable started_at cannot be confirmed fresh", () => {
        writeMarker(validMarker({ started_at: "yesterday" }))

        expect(readMarkers(dir)).toEqual([])
    })

    test("a Claude Code marker (no harness field) is left to the CC hooks", () => {
        const { harness: _harness, root_session_id: _root, ...ccFields } = validMarker()
        writeMarker(ccFields)

        expect(readMarkers(dir)).toEqual([])
    })

    test("a file name that is not a slug is ignored", () => {
        writeMarker(validMarker(), "bad slug")
        writeMarker(validMarker(), "..")
        writeMarker(validMarker(), ".hidden")

        expect(readMarkers(dir)).toEqual([])
    })

    test("the file name is the slug, whatever the body claims", () => {
        writeMarker(validMarker({ slug: "../../etc" }))

        expect(readMarkers(dir).map((marker) => marker.slug)).toEqual(["demo-plan"])
    })

    test("a stop-guard counter is not a run", () => {
        writeMarkerFile("demo-plan.stop-guard.json", JSON.stringify(validMarker()))

        expect(readMarkers(dir)).toEqual([])
    })

    test("a non-json file is ignored", () => {
        writeMarkerFile("demo-plan.json.tmp", JSON.stringify(validMarker()))

        expect(readMarkers(dir)).toEqual([])
    })

    test("an absent wave_files reads as an empty scope", () => {
        const { wave_files: _files, ...rest } = validMarker()
        writeMarker(rest)

        expect(readMarkers(dir)[0]?.wave_files).toEqual([])
    })

    test("one bad file does not hide its siblings, and the result is ordered by slug", () => {
        writeMarker(validMarker(), "plan-b")
        writeMarkerFile("plan-broken.json", "{ not json")
        writeMarker(validMarker({ started_at: isoAgo(25 * HOUR_MS) }), "plan-stale")
        writeMarker(validMarker(), "plan-a")

        expect(readMarkers(dir).map((marker) => marker.slug)).toEqual(["plan-a", "plan-b"])
    })
})

describe("ownsMarker", () => {
    test("matches on root_session_id only", () => {
        writeMarker(validMarker({ session_id: "ses_other", root_session_id: "ses_root" }))
        const [marker] = readMarkers(dir)
        if (!marker) throw new Error("expected a marker")

        expect(ownsMarker(marker, "ses_root")).toBe(true)
        expect(ownsMarker(marker, "ses_other")).toBe(false)
    })
})

describe("ownedMarkers", () => {
    test("keeps every marker of one root and none of another's", () => {
        writeMarker(validMarker({ root_session_id: "ses_root" }), "plan-a")
        writeMarker(validMarker({ root_session_id: "ses_root" }), "plan-b")
        writeMarker(validMarker({ session_id: "ses_other", root_session_id: "ses_other" }), "plan-c")
        const markers = readMarkers(dir)

        expect(ownedMarkers(markers, "ses_root").map((marker) => marker.slug)).toEqual(["plan-a", "plan-b"])
        expect(ownedMarkers(markers, "ses_other").map((marker) => marker.slug)).toEqual(["plan-c"])
        expect(ownedMarkers(markers, "ses_none")).toEqual([])
    })
})

describe("rootSessionOf", () => {
    test("walks parentID up to the session that has none", async () => {
        const fake = createFakeCtx({
            sessions: {
                ses_root: { id: "ses_root" },
                ses_worker: { id: "ses_worker", parentID: "ses_root" },
                ses_explore: { id: "ses_explore", parentID: "ses_worker" },
            },
        })

        expect(await rootSessionOf(fake.ctx, "ses_explore")).toBe("ses_root")
        expect(await rootSessionOf(fake.ctx, "ses_root")).toBe("ses_root")
    })
})
