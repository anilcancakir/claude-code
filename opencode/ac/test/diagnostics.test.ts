import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { registerDiagnostics } from "../src/diagnostics.ts"
import type { DiagnosticsOptions } from "../src/diagnostics.ts"
import { createFakeCtx } from "./fake-ctx.ts"
import type { FakeCtx } from "./fake-ctx.ts"

const BROKEN_PHP = "<?php\nfunction broken( {\n"
const CLEAN_PHP = "<?php\nfunction clean(): int\n{\n    return 1;\n}\n"

const phpTest = Bun.which("php") ? test : test.skip

let dir: string
let outside: string

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ac-oc-diag-"))
    outside = mkdtempSync(join(tmpdir(), "ac-oc-diag-outside-"))
})

afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
})

async function setup(options: Partial<DiagnosticsOptions> = {}): Promise<FakeCtx> {
    const fake = createFakeCtx()
    await registerDiagnostics(fake.ctx, { directory: dir, ...options })
    return fake
}

type Result = { output?: unknown; content?: string | ReadonlyArray<{ type: "text"; text: string }> }

/** Fires a completed tool call and returns the model-visible text of the (possibly rewritten) result. */
async function complete(fake: FakeCtx, tool: string, input: unknown, result: Result): Promise<string> {
    const event = await fake.fire.tool("execute.after", {
        tool,
        status: "completed",
        input,
        result: result as never,
    })
    if (event.status !== "completed") throw new Error("event status changed")
    const content = event.result.content
    if (content === undefined) return ""
    if (typeof content === "string") return content
    return content.map((part) => (part.type === "text" ? part.text : "")).join("\n")
}

function write(path: string, content: string): string {
    const full = join(dir, path)
    mkdirSync(join(full, ".."), { recursive: true })
    writeFileSync(full, content)
    return full
}

describe("php checker", () => {
    phpTest("a syntax error appends a block naming the line", async () => {
        const fake = await setup()
        write("src/broken.php", BROKEN_PHP)

        const text = await complete(fake, "edit", { path: "src/broken.php" }, { content: "Edit applied" })

        expect(text).toStartWith("Edit applied")
        expect(text).toContain('<diagnostics file="src/broken.php">')
        expect(text).toMatch(/on line 2/)
        expect(text).toContain("</diagnostics>")
    })

    phpTest("a clean file appends nothing", async () => {
        const fake = await setup()
        write("clean.php", CLEAN_PHP)

        const text = await complete(fake, "write", { path: "clean.php", content: CLEAN_PHP }, { content: "Wrote" })

        expect(text).toBe("Wrote")
    })

    phpTest("an absolute path inside the directory is accepted", async () => {
        const fake = await setup()
        const full = write("abs.php", BROKEN_PHP)

        const text = await complete(fake, "edit", { path: full }, { content: "ok" })

        expect(text).toContain('<diagnostics file="abs.php">')
    })

    phpTest("a patch checks every added and updated file and skips deletions", async () => {
        const fake = await setup()
        write("added.php", BROKEN_PHP)
        write("updated.php", BROKEN_PHP)
        write("deleted.php", BROKEN_PHP)
        const patchText = [
            "*** Begin Patch",
            "*** Add File: added.php",
            "+<?php",
            "*** Update File: updated.php",
            "@@",
            "-a",
            "+b",
            "*** Delete File: deleted.php",
            "*** End Patch",
        ].join("\n")

        const text = await complete(fake, "patch", { patchText }, { content: "Success" })

        expect(text).toContain('<diagnostics file="added.php">')
        expect(text).toContain('<diagnostics file="updated.php">')
        expect(text).not.toContain("deleted.php")
    })

    phpTest("a moved file is checked at its destination", async () => {
        const fake = await setup()
        write("new-home.php", BROKEN_PHP)
        const patchText = [
            "*** Begin Patch",
            "*** Update File: old-home.php",
            "*** Move to: new-home.php",
            "@@",
            "-a",
            "+b",
            "*** End Patch",
        ].join("\n")

        const text = await complete(fake, "patch", { patchText }, { content: "Success" })

        expect(text).toContain('<diagnostics file="new-home.php">')
    })
})

describe("checker resolution", () => {
    test("a missing checker binary appends nothing", async () => {
        const fake = await setup({ checkers: { ".php": [{ bin: "ac-no-such-checker-xyz", args: [] }] } })
        write("a.php", BROKEN_PHP)

        const text = await complete(fake, "edit", { path: "a.php" }, { content: "Edit applied" })

        expect(text).toBe("Edit applied")
    })

    test("a project-relative checker that does not exist appends nothing", async () => {
        const fake = await setup({ checkers: { ".php": [{ bin: "vendor/bin/pint", args: ["--test"] }] } })
        write("a.php", BROKEN_PHP)

        const text = await complete(fake, "edit", { path: "a.php" }, { content: "Edit applied" })

        expect(text).toBe("Edit applied")
    })

    test("extensions without a checker are ignored", async () => {
        const fake = await setup()
        write("a.ts", "const = ;")

        const text = await complete(fake, "edit", { path: "a.ts" }, { content: "Edit applied" })

        expect(text).toBe("Edit applied")
    })

    test("a path outside the directory is never checked", async () => {
        const fake = await setup({ checkers: { ".txt": [failing("should not run")] } })
        const stray = join(outside, "stray.txt")
        writeFileSync(stray, "x")

        const text = await complete(fake, "edit", { path: stray }, { content: "Edit applied" })

        expect(text).toBe("Edit applied")
    })

    test("a relative traversal out of the directory is never checked", async () => {
        const fake = await setup({ checkers: { ".txt": [failing("should not run")] } })
        writeFileSync(join(outside, "stray.txt"), "x")
        const escape = join("..", outside.split("/").pop() ?? "", "stray.txt")

        const text = await complete(fake, "edit", { path: escape }, { content: "Edit applied" })

        expect(text).toBe("Edit applied")
    })
})

describe("checker execution", () => {
    test("checkers run in the project directory, not the host process directory", async () => {
        const fake = await setup({
            checkers: {
                ".txt": [{ bin: process.execPath, args: ["-e", "console.log(process.cwd()); process.exit(1)"] }],
            },
        })
        write("a.txt", "x")

        const text = await complete(fake, "edit", { path: "a.txt" }, { content: "ok" })

        expect(text).toContain(realpathSync(dir))
    })

    test("independent checkers of one file run in parallel", async () => {
        const fake = await setup({ checkers: { ".txt": [sleeping("first", 600), sleeping("second", 600)] } })
        write("a.txt", "x")

        const started = performance.now()
        const text = await complete(fake, "edit", { path: "a.txt" }, { content: "ok" })

        expect(performance.now() - started).toBeLessThan(1100)
        expect(text).toContain("first")
        expect(text).toContain("second")
    })

    test("output keeps the checker order even when a later checker finishes first", async () => {
        const fake = await setup({ checkers: { ".txt": [sleeping("first", 400), sleeping("second", 0)] } })
        write("a.txt", "x")

        const text = await complete(fake, "edit", { path: "a.txt" }, { content: "ok" })

        expect(text.indexOf("first")).toBeGreaterThan(-1)
        expect(text.indexOf("first")).toBeLessThan(text.indexOf("second"))
    })
})

describe("result rewriting", () => {
    test("the block is capped at 4000 characters", async () => {
        const fake = await setup({ checkers: { ".txt": [failing("x".repeat(20000))] } })
        write("big.txt", "x")

        const text = await complete(fake, "edit", { path: "big.txt" }, { content: "" })

        const block = text.slice(text.indexOf("<diagnostics"))
        expect(block.length).toBeLessThanOrEqual(4000)
        expect(block).toContain("[truncated]")
        expect(block).toEndWith("</diagnostics>")
    })

    test("a result with only output still gets the block and keeps the output text", async () => {
        const fake = await setup({ checkers: { ".txt": [failing("boom")] } })
        write("a.txt", "x")

        const text = await complete(fake, "write", { path: "a.txt" }, { output: { operation: "write" } })

        expect(text).toContain('{"operation":"write"}')
        expect(text).toContain('<diagnostics file="a.txt">')
        expect(text).toContain("boom")
    })

    test("array content is preserved and the block is added as a further part", async () => {
        const fake = await setup({ checkers: { ".txt": [failing("boom")] } })
        write("a.txt", "x")

        const text = await complete(
            fake,
            "edit",
            { path: "a.txt" },
            { content: [{ type: "text", text: "first" }] },
        )

        expect(text.split("\n")[0]).toBe("first")
        expect(text).toContain("boom")
    })

    test("a slow checker is killed at the timeout and reported", async () => {
        const fake = await setup({
            timeoutMs: 300,
            checkers: { ".txt": [{ bin: process.execPath, args: ["-e", "setTimeout(() => {}, 30000)"] }] },
        })
        write("a.txt", "x")

        const text = await complete(fake, "edit", { path: "a.txt" }, { content: "ok" })

        expect(text).toContain("timed out")
    })

    test("only completed edit, write and patch calls are inspected", async () => {
        const fake = await setup({ checkers: { ".txt": [failing("boom")] } })
        write("a.txt", "x")

        const read = await complete(fake, "read", { path: "a.txt" }, { content: "file text" })
        const errored = await fake.fire.tool("execute.after", {
            tool: "edit",
            status: "error",
            input: { path: "a.txt" },
        })

        expect(read).toBe("file text")
        expect(errored.status).toBe("error")
        expect("result" in errored).toBe(false)
    })
})

/** A checker that always exits 1 after printing `message`; runs under bun so the test needs no other tool. */
function failing(message: string) {
    return {
        bin: process.execPath,
        args: ["-e", `console.log(${JSON.stringify(message)}); process.exit(1)`],
    }
}

/** A checker that waits `delayMs`, prints `message` and exits 1. */
function sleeping(message: string, delayMs: number) {
    return {
        bin: process.execPath,
        args: [
            "-e",
            `setTimeout(() => { console.log(${JSON.stringify(message)}); process.exit(1) }, ${delayMs})`,
        ],
    }
}
