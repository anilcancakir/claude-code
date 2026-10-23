import { describe, expect, test } from "bun:test"
import { loadConfig } from "../src/config.ts"
import { Gate, gateOf, registerRateGate } from "../src/rate-gate.ts"
import { createFakeCtx } from "./fake-ctx.ts"

describe("rate gate", () => {
    test("lets the limit through at once and holds the next until the oldest start leaves the window", async () => {
        const gate = new Gate(3, 100)
        const started: number[] = []
        const t0 = Date.now()

        await Promise.all([0, 1, 2, 3].map(async (i) => {
            await gate.acquire()
            started[i] = Date.now() - t0
        }))

        expect(started.slice(0, 3).every((ms) => ms < 30)).toBe(true)
        expect(started[3]).toBeGreaterThanOrEqual(95)
    })

    test("serves waiting requests in arrival order", async () => {
        const gate = new Gate(1, 30)
        const order: number[] = []

        await Promise.all([0, 1, 2].map((i) => gate.acquire().then(() => order.push(i))))

        expect(order).toEqual([0, 1, 2])
    })

    test("one gate per group is shared by every caller in the process, across fresh module evaluations", async () => {
        const reloaded = (await import(`../src/rate-gate.ts?fresh=${Date.now()}`)) as typeof import("../src/rate-gate.ts")

        expect(reloaded.gateOf("test-shared", 5)).toBe(gateOf("test-shared", 5))
    })

    test("hooks http.request once for every provider of each limited group", async () => {
        const fake = createFakeCtx()
        const registered: Array<{ name: string; providerID?: string }> = []
        Object.assign(fake.ctx.session, {
            hook: async (name: string, _callback: unknown, options?: { providerID?: string }) => {
                registered.push({ name, ...(options?.providerID === undefined ? {} : { providerID: options.providerID }) })
                return { dispose: async () => {} }
            },
        })

        await registerRateGate(fake.ctx, loadConfig({ env: {} }))

        expect(registered).toEqual([
            { name: "http.request", providerID: "codefast-glm" },
            { name: "http.request", providerID: "codefast-kimi" },
            { name: "http.request", providerID: "codefast-deepseek" },
            { name: "http.request", providerID: "codefast-qwen" },
        ])
    })

    test("the shipped config paces codefast at its 25 requests per minute", () => {
        expect(loadConfig({ env: {} }).rateLimits).toEqual({ codefast: 25 })
    })
})
