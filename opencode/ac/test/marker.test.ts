import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MARKER_PATH, ownsMarker, readMarker, rootSessionOf } from "../src/marker.ts"
import { createFakeCtx } from "./fake-ctx.ts"

const HOUR_MS = 3_600_000

let dir: string

function isoAgo(ms: number): string {
    return new Date(Date.now() - ms).toISOString().replace(/\.\d{3}Z$/, "Z")
}

function writeMarker(fields: Record<string, unknown>): void {
    mkdirSync(join(dir, ".ac/state"), { recursive: true })
    writeFileSync(join(dir, MARKER_PATH), JSON.stringify(fields))
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

describe("readMarker", () => {
    test("returns the parsed marker for a fresh opencode run", () => {
        writeMarker(validMarker())

        expect(readMarker(dir)).toEqual({
            slug: "demo-plan",
            session_id: "ses_root",
            root_session_id: "ses_root",
            harness: "opencode",
            started_at: expect.any(String),
            current_wave: 2,
            wave_files: ["src/a.ts"],
            note: "wave 1 committed",
        })
    })

    test("an absent marker means no run", () => {
        expect(readMarker(dir)).toBeUndefined()
    })

    test("malformed JSON is uncertainty, not a run", () => {
        mkdirSync(join(dir, ".ac/state"), { recursive: true })
        writeFileSync(join(dir, MARKER_PATH), "{ not json")

        expect(readMarker(dir)).toBeUndefined()
    })

    test("a marker older than 24 h is stale", () => {
        writeMarker(validMarker({ started_at: isoAgo(25 * HOUR_MS) }))

        expect(readMarker(dir)).toBeUndefined()
    })

    test("an unparseable started_at cannot be confirmed fresh", () => {
        writeMarker(validMarker({ started_at: "yesterday" }))

        expect(readMarker(dir)).toBeUndefined()
    })

    test("a Claude Code marker (no harness field) is left to the CC hooks", () => {
        const { harness: _harness, root_session_id: _root, ...ccFields } = validMarker()
        writeMarker(ccFields)

        expect(readMarker(dir)).toBeUndefined()
    })

    test("a slug that could leave .ac/plans is rejected", () => {
        writeMarker(validMarker({ slug: "../../etc" }))

        expect(readMarker(dir)).toBeUndefined()
    })

    test("an absent wave_files reads as an empty scope", () => {
        const { wave_files: _files, ...rest } = validMarker()
        writeMarker(rest)

        expect(readMarker(dir)?.wave_files).toEqual([])
    })
})

describe("ownsMarker", () => {
    test("matches on root_session_id only", () => {
        writeMarker(validMarker({ session_id: "ses_other", root_session_id: "ses_root" }))
        const marker = readMarker(dir)
        if (!marker) throw new Error("expected a marker")

        expect(ownsMarker(marker, "ses_root")).toBe(true)
        expect(ownsMarker(marker, "ses_other")).toBe(false)
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
