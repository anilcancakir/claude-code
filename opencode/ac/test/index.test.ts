import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import * as os from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import type { ToolContext } from "@opencode/plugin/promise/tool"
import type { SessionContext } from "@opencode/plugin/promise/session"
import { createFakeCtx } from "./fake-ctx.ts"
import type { FakeCtx, FakeCtxInput } from "./fake-ctx.ts"

let home: string

// Bun resolves os.homedir() once per process, so the memory module's default home is redirected here.
mock.module("node:os", () => ({ ...os, homedir: () => home }))

const { default: rootEntry } = await import("../index.ts")
const { default: plugin } = await import("../src/index.ts")
const { sanitizePath } = await import("../src/memory.ts")

type HookKind = "session" | "permission" | "tool"
type Recorder = (name: string, callback: unknown) => Promise<{ dispose: () => Promise<void> }>

const CORE_PROMPT = readFileSync(fileURLToPath(new URL("../src/prompts/core.md", import.meta.url)), "utf8").trim()

let sandbox: string
let repo: string

/** Wraps each `hook` registrar of the fake so the test can read which hook names setup registered. */
function recordHooks(fake: FakeCtx): Record<HookKind, string[]> {
    const names: Record<HookKind, string[]> = { session: [], permission: [], tool: [] }
    const targets: Record<HookKind, { hook: Recorder }> = {
        session: fake.ctx.session as unknown as { hook: Recorder },
        permission: fake.ctx.permission as unknown as { hook: Recorder },
        tool: fake.ctx.tool as unknown as { hook: Recorder },
    }
    for (const kind of Object.keys(targets) as HookKind[]) {
        const target = targets[kind]
        const original = target.hook
        target.hook = (name, callback) => {
            names[kind].push(name)
            return original(name, callback)
        }
    }
    return names
}

function fakeAt(directory: string, input: FakeCtxInput = {}): FakeCtx {
    const fake = createFakeCtx(input)
    Object.assign(fake.ctx, { location: { directory } })
    return fake
}

function buildContext(): Parameters<FakeCtx["fire"]["session"]>[1] {
    return {
        sessionID: "ses_1",
        agent: "build",
        model: { providerID: "opencode-go", id: "unlisted-model" } as SessionContext["model"],
        system: [{ type: "text", text: "opencode default prompt" }] as SessionContext["system"],
        messages: [],
        options: {},
        tools: {},
    }
}

beforeEach(() => {
    sandbox = realpathSync(mkdtempSync(join(os.tmpdir(), "ac-oc-index-")))
    home = join(sandbox, "home")
    repo = join(sandbox, "repo")
    mkdirSync(join(repo, ".git"), { recursive: true })
    mkdirSync(home, { recursive: true })
})

afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true })
})

describe("plugin entry", () => {
    test("is an ac plugin and the root index re-exports it", () => {
        expect(plugin.id).toBe("ac")
        expect(rootEntry).toBe(plugin)
    })

    test("registers every hook, tool and command the modules own", async () => {
        const fake = fakeAt(repo)
        const hooks = recordHooks(fake)

        await plugin.setup(fake.ctx)
        fake.applyTransforms()

        expect(hooks.session).toEqual(expect.arrayContaining(["context", "compaction", "generate", "retry"]))
        expect(hooks.permission).toContain("evaluate")
        expect(hooks.tool).toEqual(expect.arrayContaining(["execute.before", "execute.after"]))
        expect([...fake.tools.keys()]).toEqual(expect.arrayContaining(["ac_session", "ac_fallback_next"]))
        expect(fake.commands.map((command) => command.name).sort()).toEqual([
            "ac/commit",
            "ac/execute",
            "ac/plan",
            "ac/qa",
        ])
    })

    test("a build context event yields the core text first and the memory part after it", async () => {
        const memoryDirectory = join(home, ".claude", "projects", sanitizePath(repo), "memory")
        mkdirSync(memoryDirectory, { recursive: true })
        writeFileSync(join(memoryDirectory, "MEMORY.md"), "- [Topic](topic.md) - a remembered fact\n")
        const fake = fakeAt(repo)
        await plugin.setup(fake.ctx)

        const event = await fake.fire.session("context", buildContext())

        expect(event.system[0]?.text).toBe(CORE_PROMPT)
        expect(event.system[1]?.text).toContain("a remembered fact")
        expect(event.system).toHaveLength(2)
    })

    test("plugin options reach the model config", async () => {
        const fake = fakeAt(repo, {
            options: { models: { tiers: { "plan-worker-junior": { replace: ["acme/first#high", "acme/second#high"] } } } },
        })
        await plugin.setup(fake.ctx)
        fake.applyTransforms()

        const tool = fake.tools.get("ac_fallback_next")
        const result = await tool?.execute({ tier: "plan-worker-junior", tried: [] }, {} as ToolContext)

        expect(result?.content).toBe("acme/first#high")
    })

    test("returns a cleanup that can run", async () => {
        const fake = fakeAt(repo)

        const cleanup = await plugin.setup(fake.ctx)

        expect(cleanup).toBeFunction()
        expect(() => (cleanup as () => void)()).not.toThrow()
    })
})
