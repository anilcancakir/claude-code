import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AWAY_MARKER_PATH, awayShellDenial, readAwayMarker, registerAwayGuards } from "../src/away.ts"
import { COORDINATE_MARKER_PATH } from "../src/coordinate.ts"
import { MARKER_PATH } from "../src/marker.ts"
import { createFakeCtx, type FakeCtx, type FakeSession } from "./fake-ctx.ts"

const HOUR_MS = 3_600_000

const SESSIONS: Record<string, FakeSession> = {
    ses_root: { id: "ses_root" },
    ses_worker: { id: "ses_worker", parentID: "ses_root" },
    ses_other: { id: "ses_other" },
}

let dir: string
let cleanup: (() => void) | undefined

function isoAgo(ms: number): string {
    return new Date(Date.now() - ms).toISOString().replace(/\.\d{3}Z$/, "Z")
}

function writeJson(path: string, value: unknown): void {
    mkdirSync(join(dir, path, ".."), { recursive: true })
    writeFileSync(join(dir, path), JSON.stringify(value))
}

function writeAway(overrides: Record<string, unknown> = {}): void {
    writeJson(AWAY_MARKER_PATH, {
        slug: "demo",
        session_id: "ses_root",
        harness: "opencode",
        started_at: isoAgo(HOUR_MS),
        turns_used: 0,
        phase: "gating",
        source: "new",
        allowed_outward: [],
        decisions: ".ac/away/demo/decisions.md",
        ...overrides,
    })
}

function writeRunFile(path: string, text = "x"): void {
    mkdirSync(join(dir, path, ".."), { recursive: true })
    writeFileSync(join(dir, path), text)
}

async function setup(shells?: { pending(sessionID: string): number }): Promise<FakeCtx> {
    const fake = createFakeCtx({ sessions: SESSIONS })
    cleanup = await registerAwayGuards(fake.ctx, { directory: dir, shells })
    return fake
}

function settle(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 5))
}

async function push(fake: FakeCtx, type: string, data: Record<string, unknown>): Promise<void> {
    fake.pushEvent({ type, data })
    await settle()
}

async function stop(fake: FakeCtx, sessionID = "ses_root"): Promise<void> {
    await push(fake, "session.execution.succeeded", { sessionID })
}

async function toolCall(fake: FakeCtx, sessionID = "ses_root"): Promise<void> {
    await fake.fire.tool("execute.after", {
        tool: "read",
        sessionID,
        input: {},
        status: "completed",
        result: { content: "ok" },
    })
}

function shell(fake: FakeCtx, sessionID: string, command: string) {
    return fake.fire.permission("evaluate", { sessionID, action: "shell", resources: [command], effect: "allow" })
}

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ac-away-"))
})

afterEach(() => {
    cleanup?.()
    cleanup = undefined
    rmSync(dir, { recursive: true, force: true })
})

describe("readAwayMarker", () => {
    test("reads a live opencode marker and defaults what the model left out", () => {
        writeAway({ phase: undefined, decisions: undefined, allowed_outward: "push" })

        expect(readAwayMarker(dir)).toMatchObject({
            slug: "demo",
            session_id: "ses_root",
            phase: "unknown",
            allowed_outward: [],
            decisions: ".ac/away/demo/decisions.md",
        })
    })

    test("a Claude Code marker, a traversing slug or a stale one reads as absent", () => {
        writeAway({ harness: undefined })
        expect(readAwayMarker(dir)).toBeUndefined()
        writeAway({ slug: "../escape" })
        expect(readAwayMarker(dir)).toBeUndefined()
        writeAway({ started_at: isoAgo(25 * HOUR_MS) })
        expect(readAwayMarker(dir)).toBeUndefined()
    })

    test("a coordinator source lives 72 h, and an unsafe source_ref is dropped", () => {
        writeAway({ source: "coordinate", source_ref: "../x", started_at: isoAgo(48 * HOUR_MS) })

        const marker = readAwayMarker(dir)
        expect(marker?.source).toBe("coordinate")
        expect(marker?.source_ref).toBeUndefined()
    })
})

describe("awayShellDenial", () => {
    const marker = (allowed: string[] = []) => {
        writeAway({ allowed_outward: allowed })
        const read = readAwayMarker(dir)
        if (!read) throw new Error("marker did not read")
        return read
    }

    const ALWAYS_DENIED: Array<[string, string]> = [
        ["git push --force origin main", "git push --force"],
        ["git push -f", "git push --force"],
        ["git push --force-with-lease", "git push --force"],
        ["git push origin +main", "git push --force"],
        ["git push origin --delete feature", "git push --delete"],
        ["git push origin :feature", "git push --delete"],
        ["git push --mirror", "git push --delete"],
        ["git reset --hard HEAD~1", "git reset --hard"],
        ["git clean -fd", "git clean"],
        ["git checkout .", "git checkout ."],
        ["git restore .", "git restore ."],
        ["rm -rf build", "rm -rf"],
        ["rm -r -f build", "rm -rf"],
        ["rm --recursive --force build", "rm -rf"],
        ["sed -i 's/a/b/' file.ts", "sed -i"],
        ["sed --in-place 's/a/b/' file.ts", "sed -i"],
        ["perl -pi -e 's/a/b/' file.ts", "perl -i"],
        ["git -C ../wt push --force", "git push --force"],
        ["cd app && git reset --hard", "git reset --hard"],
        ["FOO=1 timeout 30 git push -f", "git push --force"],
        ["sudo -E rm -rf /var/tmp/x", "rm -rf"],
        ["git status\ngit clean -f", "git clean"],
        ["git push \\\n  --force", "git push --force"],
    ]

    test.each(ALWAYS_DENIED)("denies %p whatever allowed_outward names", (command, verb) => {
        const reason = awayShellDenial(
            marker([
                "push",
                "pr",
                "merge",
                "release",
                "deploy",
            ]),
            command,
        )

        expect(reason).toContain(`'${verb}'`)
        expect(reason).toContain(".ac/away/demo/decisions.md")
    })

    const OUTWARD: Array<[string, string]> = [
        ["git push origin main", "push"],
        ["git push -u origin feature", "push"],
        ["gh pr create --fill", "pr"],
        ["gh pr merge 12 --squash", "merge"],
        ["gh release create v1.0.0", "release"],
        ["gh release upload v1.0.0 dist.tgz", "release"],
    ]

    test.each(OUTWARD)("denies %p until allowed_outward names %p", (command, value) => {
        expect(awayShellDenial(marker(), command)).toContain(`does not name '${value}'`)
        expect(awayShellDenial(marker([value]), command)).toBeUndefined()
    })

    test("pr and merge each carry the push they need, and merge the PR", () => {
        expect(awayShellDenial(marker(["pr"]), "git push origin feature")).toBeUndefined()
        expect(awayShellDenial(marker(["merge"]), "git push origin feature")).toBeUndefined()
        expect(awayShellDenial(marker(["merge"]), "gh pr create --fill")).toBeUndefined()
        expect(awayShellDenial(marker(["pr"]), "gh pr merge 12")).toContain("does not name 'merge'")
        expect(awayShellDenial(marker(["push"]), "gh pr create")).toContain("does not name 'pr'")
    })

    test("an allowed verb does not hide a denied one later in the command", () => {
        expect(awayShellDenial(marker(["push"]), "git push && git push --force")).toContain("'git push --force'")
    })

    const ALLOWED = [
        "git status",
        "git commit -m 'never git push'",
        "echo git push --force",
        "git clean -n",
        "git clean --dry-run -fd",
        "git checkout main",
        "git restore src/a.ts",
        "git reset --soft HEAD~1",
        "rm -f file.txt",
        "rm -r dir",
        "sed -n 1,5p file.ts",
        "gh pr view 12",
        "gh release list",
        "bun test",
        "",
    ]

    test.each(ALLOWED)("lets %p through", (command) => {
        expect(awayShellDenial(marker(), command)).toBeUndefined()
    })
})

describe("shell and question guard", () => {
    test("denies a blocked command for the owning root and its workers", async () => {
        writeAway()
        const fake = await setup()

        const root = await shell(fake, "ses_root", "git push origin main")
        const worker = await shell(fake, "ses_worker", "git reset --hard HEAD~1")

        expect(root.effect).toBe("deny")
        expect(root.message).toContain("ac away guard")
        expect(worker.effect).toBe("deny")
    })

    test("denies the question tool for the owning root", async () => {
        writeAway()
        const fake = await setup()

        const event = await fake.fire.permission("evaluate", {
            sessionID: "ses_root",
            action: "question",
            resources: ["*"],
            effect: "allow",
        })

        expect(event.effect).toBe("deny")
        expect(event.message).toContain("## Decisions in .ac/away/demo/decisions.md")
    })

    const FAIL_OPEN: Array<[string, () => void]> = [
        ["no marker", () => {}],
        ["another session's marker", () => writeAway({ session_id: "ses_other" })],
        ["a stale marker", () => writeAway({ started_at: isoAgo(25 * HOUR_MS) })],
        ["a malformed marker", () => writeRunFile(AWAY_MARKER_PATH, "{ not json")],
        ["a Claude Code marker", () => writeAway({ harness: undefined })],
    ]

    test.each(FAIL_OPEN)("allows every command and question under %s", async (_name, arrange) => {
        arrange()
        const fake = await setup()

        for (const command of ["git push origin main", "git push --force", "git reset --hard HEAD~1"]) {
            expect((await shell(fake, "ses_root", command)).effect).toBe("allow")
        }
        const question = await fake.fire.permission("evaluate", {
            sessionID: "ses_root",
            action: "question",
            resources: ["*"],
            effect: "allow",
        })
        expect(question.effect).toBe("allow")
    })

    test("a session outside the owning root is never affected", async () => {
        writeAway()
        const fake = await setup()

        expect((await shell(fake, "ses_other", "git push --force")).effect).toBe("allow")
    })

    test("a failed root lookup leaves the default effect and logs it", async () => {
        writeAway()
        const fake = await setup()
        const logged = spyOn(console, "error").mockImplementation(() => {})
        try {
            expect((await shell(fake, "ses_unknown", "git push --force")).effect).toBe("allow")
            expect(String(logged.mock.calls[0]?.[0])).toContain("ac away")
        } finally {
            logged.mockRestore()
        }
    })

    test("other actions are not judged", async () => {
        writeAway()
        const fake = await setup()

        const event = await fake.fire.permission("evaluate", {
            sessionID: "ses_root",
            action: "edit",
            resources: ["src/a.ts"],
            effect: "allow",
        })

        expect(event.effect).toBe("allow")
    })
})

describe("stop guard", () => {
    test("at gating it nudges once per stall toward the gate", async () => {
        writeAway()
        writeRunFile(".ac/auto/demo/criteria.md")
        const fake = await setup()

        await stop(fake)
        await stop(fake)

        expect(fake.calls.synthetic).toHaveLength(1)
        const call = fake.calls.synthetic[0]
        expect(call?.sessionID).toBe("ses_root")
        expect(call?.text).toContain("ac/auto-verifier")
        expect(call?.text).toContain(".ac/auto/demo/verdict.md")
    })

    test("caps at 3 per phase and opens a fresh budget on the next user prompt", async () => {
        writeAway()
        writeRunFile(".ac/auto/demo/criteria.md")
        const fake = await setup()

        for (let stall = 0; stall < 5; stall++) {
            await stop(fake)
            await toolCall(fake)
        }
        expect(fake.calls.synthetic).toHaveLength(3)

        await fake.fire.session("prompt", { sessionID: "ses_root" })
        await stop(fake)
        expect(fake.calls.synthetic).toHaveLength(4)
    })

    test("a phase change opens a new budget", async () => {
        writeAway({ phase: "executing", source: "adhoc" })
        writeRunFile(".ac/auto/demo/criteria.md")
        const fake = await setup()

        for (let stall = 0; stall < 4; stall++) {
            await stop(fake)
            await toolCall(fake)
        }
        expect(fake.calls.synthetic).toHaveLength(3)

        writeAway({ phase: "gating", source: "adhoc" })
        await stop(fake)
        expect(fake.calls.synthetic).toHaveLength(4)
    })

    test("with the verdict written it asks once for the close", async () => {
        writeAway()
        writeRunFile(".ac/auto/demo/verdict.md")
        const fake = await setup()

        await stop(fake)
        await toolCall(fake)
        await stop(fake)

        expect(fake.calls.synthetic).toHaveLength(1)
        expect(fake.calls.synthetic[0]?.text).toContain("what is left is the close")
    })

    test("a plan or execute source defers to the run guards until gating", async () => {
        writeRunFile(".ac/auto/demo/criteria.md")
        writeJson(MARKER_PATH, {
            slug: "demo",
            session_id: "ses_root",
            root_session_id: "ses_root",
            harness: "opencode",
            started_at: isoAgo(HOUR_MS),
            wave_files: [],
        })
        const fake = await setup()

        for (const source of ["plan", "new"]) {
            writeAway({ phase: "executing", source })
            await stop(fake)
            await toolCall(fake)
        }
        expect(fake.calls.synthetic).toHaveLength(0)
    })

    test("a plan or new source with no execute marker is owed the gate once executing, a note while planning", async () => {
        writeRunFile(".ac/auto/demo/criteria.md")
        const fake = await setup()

        writeAway({ phase: "executing", source: "new" })
        await stop(fake)
        expect(fake.calls.synthetic.at(-1)?.text).toContain("has ended (its marker is gone)")

        await toolCall(fake)
        writeAway({ phase: "planning", source: "plan", started_at: isoAgo(2 * HOUR_MS) })
        await stop(fake)
        expect(fake.calls.synthetic).toHaveLength(2)
        expect(fake.calls.synthetic.at(-1)?.text).toContain("still working")
    })

    test("an execute source whose execute marker is gone is owed the gate", async () => {
        writeAway({ phase: "executing", source: "execute", source_ref: "demo" })
        writeRunFile(".ac/auto/demo/criteria.md")
        const fake = await setup()

        await stop(fake)

        expect(fake.calls.synthetic[0]?.text).toContain("has ended (its marker is gone)")
    })

    test("an execute source with its execute marker live stays silent", async () => {
        writeAway({ phase: "executing", source: "execute", source_ref: "demo" })
        writeRunFile(".ac/auto/demo/criteria.md")
        writeJson(MARKER_PATH, {
            slug: "demo",
            session_id: "ses_root",
            root_session_id: "ses_root",
            harness: "opencode",
            started_at: isoAgo(HOUR_MS),
            wave_files: [],
        })
        const fake = await setup()

        await stop(fake)

        expect(fake.calls.synthetic).toHaveLength(0)
    })

    test("a coordinator source defers while its coordinate marker lives, then asks for the gate", async () => {
        writeAway({ phase: "executing", source: "coordinate", source_ref: "coord-a" })
        writeRunFile(".ac/coord/coord-a/criteria.md")
        writeJson(COORDINATE_MARKER_PATH, {
            slug: "coord-a",
            session_id: "ses_root",
            started_at: isoAgo(HOUR_MS),
            phase: "dispatch",
            harness: "opencode",
        })
        const fake = await setup()

        await stop(fake)
        expect(fake.calls.synthetic).toHaveLength(0)

        rmSync(join(dir, COORDINATE_MARKER_PATH))
        await stop(fake)
        expect(fake.calls.synthetic).toHaveLength(1)
        expect(fake.calls.synthetic[0]?.text).toContain(".ac/coord/coord-a/criteria.md")
    })

    test("a coordinator that ended before its lock has nothing to gate", async () => {
        writeAway({ phase: "executing", source: "coordinate", source_ref: "coord-a" })
        mkdirSync(join(dir, ".ac/coord/coord-a"), { recursive: true })
        const fake = await setup()

        await stop(fake)

        expect(fake.calls.synthetic[0]?.text).toContain("ended before its roadmap lock")
    })

    test("stays silent while a child session runs or a background shell will wake the root", async () => {
        writeAway()
        writeRunFile(".ac/auto/demo/criteria.md")
        let pending = 1
        const fake = await setup({ pending: (id) => (id === "ses_root" ? pending : 0) })

        await stop(fake)
        pending = 0
        await push(fake, "session.execution.started", { sessionID: "ses_worker" })
        await stop(fake)
        expect(fake.calls.synthetic).toHaveLength(0)

        await stop(fake, "ses_worker")
        await stop(fake)
        expect(fake.calls.synthetic).toHaveLength(1)
    })

    test("a child that started before the marker existed still keeps the root silent", async () => {
        const fake = await setup()

        await push(fake, "session.execution.started", { sessionID: "ses_worker" })
        writeAway()
        writeRunFile(".ac/auto/demo/criteria.md")
        await stop(fake)
        expect(fake.calls.synthetic).toHaveLength(0)

        await stop(fake, "ses_worker")
        await stop(fake)
        expect(fake.calls.synthetic).toHaveLength(1)
    })

    test("a user interrupt silences the guard until the next prompt", async () => {
        writeAway()
        writeRunFile(".ac/auto/demo/criteria.md")
        const fake = await setup()

        await push(fake, "session.execution.interrupted", { sessionID: "ses_root", reason: "user" })
        await stop(fake)
        expect(fake.calls.synthetic).toHaveLength(0)

        await fake.fire.session("prompt", { sessionID: "ses_root" })
        await stop(fake)
        expect(fake.calls.synthetic).toHaveLength(1)
    })

    const SILENT: Array<[string, () => void]> = [
        ["no marker", () => writeRunFile(".ac/auto/demo/criteria.md")],
        [
            "another session's marker",
            () => {
                writeAway({ session_id: "ses_other" })
                writeRunFile(".ac/auto/demo/criteria.md")
            },
        ],
        [
            "a stale marker",
            () => {
                writeAway({ started_at: isoAgo(25 * HOUR_MS) })
                writeRunFile(".ac/auto/demo/criteria.md")
            },
        ],
        [
            "a malformed marker",
            () => {
                writeRunFile(AWAY_MARKER_PATH, "{ not json")
                writeRunFile(".ac/auto/demo/criteria.md")
            },
        ],
        ["a missing run directory", () => writeAway()],
        [
            "a coordinator source without a safe source_ref",
            () => {
                writeAway({ source: "coordinate", source_ref: "../x" })
                writeRunFile(".ac/coord/x/criteria.md")
            },
        ],
    ]

    test.each(SILENT)("stays silent with %s", async (_name, arrange) => {
        arrange()
        const fake = await setup()

        await stop(fake)

        expect(fake.calls.synthetic).toHaveLength(0)
    })

    test("a worker's turn end is not the root's", async () => {
        writeAway()
        writeRunFile(".ac/auto/demo/criteria.md")
        const fake = await setup()

        await stop(fake, "ses_worker")

        expect(fake.calls.synthetic).toHaveLength(0)
    })
})
