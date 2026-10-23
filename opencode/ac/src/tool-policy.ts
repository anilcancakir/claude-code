import type { Plugin } from "@opencode/plugin"

export interface ToolPolicyOptions {
    /** Tool calls one `ac/explore` session may make before it is told to report. */
    exploreMaxCalls?: number
    shellDefaultTimeoutMs?: number
}

const EXPLORE_AGENT = "ac/explore"
const BUDGETED_ACTIONS: ReadonlySet<string> = new Set(["read", "grep", "glob", "shell"])

// Same tail-calibrated number as pretooluse-explore-budget.sh: it never fires on a median run and cuts the outliers.
const DEFAULT_EXPLORE_MAX_CALLS = 60

// CC's BASH_DEFAULT_TIMEOUT_MS; opencode's own shell default is 120000.
const DEFAULT_SHELL_TIMEOUT_MS = 180_000

function budgetMessage(maxCalls: number): string {
    return [
        `Call budget reached for this explore spawn: ${maxCalls} of ${maxCalls} tool calls.`,
        "",
        "Report the findings you already have. Cite each one as file_path:line_number, and under Notes",
        "name the angle you did not finish and the query you would have run next, so the orchestrator can",
        "brief that angle separately rather than guessing what is missing.",
        "",
        "Returning partial findings with the gap named is the expected outcome here, not a failure. An",
        "empty report is the failure.",
    ].join("\n")
}

export async function registerToolPolicy(ctx: Plugin.Context, options: ToolPolicyOptions = {}): Promise<void> {
    const maxCalls = options.exploreMaxCalls ?? DEFAULT_EXPLORE_MAX_CALLS
    const shellTimeoutMs = options.shellDefaultTimeoutMs ?? DEFAULT_SHELL_TIMEOUT_MS
    const calls = new Map<string, number>()

    // A call refused here is not counted, so the count stays at the limit and every later call is refused too.
    await ctx.permission.hook("evaluate", (event) => {
        if (event.agent !== EXPLORE_AGENT || !BUDGETED_ACTIONS.has(event.action)) return

        const made = calls.get(event.sessionID) ?? 0
        if (made >= maxCalls) {
            event.effect = "deny"
            event.message = budgetMessage(maxCalls)
            return
        }
        calls.set(event.sessionID, made + 1)
    })

    await ctx.tool.hook("execute.before", (event) => {
        if (event.tool !== "shell" || typeof event.input !== "object" || event.input === null) return

        const input: { timeout?: unknown; background?: unknown } = event.input
        // A background command has no timeout by default in opencode, and a dev server must keep it that way.
        if (input.timeout !== undefined || input.background === true) return

        event.input = { ...event.input, timeout: shellTimeoutMs }
    })
}
