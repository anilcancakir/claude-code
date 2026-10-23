import { fileURLToPath } from "node:url"
import type { Plugin } from "@opencode/plugin"

export interface ToolPolicyOptions {
    /** Tool calls one `ac/explore` session may make before it is told to report. */
    exploreMaxCalls?: number
    shellDefaultTimeoutMs?: number
}

const EXPLORE_AGENT = "ac/explore"
// Advisory agents that never change the tree; their shell is judged by the same write-mode check as explore's.
const READ_ONLY_AGENTS: ReadonlySet<string> = new Set([
    EXPLORE_AGENT,
    "ac/oracle",
    "ac/plan-reviewer",
    "ac/plan-code-review",
    "ac/librarian",
])
const BUDGETED_ACTIONS: ReadonlySet<string> = new Set(["read", "grep", "glob", "shell"])

// Same tail-calibrated number as pretooluse-explore-budget.sh: it never fires on a median run and cuts the outliers.
const DEFAULT_EXPLORE_MAX_CALLS = 60

// CC's BASH_DEFAULT_TIMEOUT_MS; opencode's own shell default is 120000.
const DEFAULT_SHELL_TIMEOUT_MS = 180_000

const EXPLORE_ONLY = /^(\S*\/)?(php\s+)?artisan\s+test(?=\s|$)/

/** Artisan subcommands that change nothing and print no secret; `config:show` prints APP_KEY, so it is not here. */
const READ_ONLY_ARTISAN: readonly string[] = [
    "list",
    "about",
    "help",
    "--version",
    "test",
    "route:list",
    "schedule:list",
    "migrate:status",
    "event:list",
    "model:show",
    "db:show",
]

/** The ac CLI that ships beside this package (plan-check, plan-scaffold), so a pinned install runs its own copy. */
const AC_CLI = fileURLToPath(new URL("../../../plugins/ac/cli/ac.js", import.meta.url))

/**
 * Environment for every shell the host starts. An agent shell has no TTY, so a git command that opens an editor
 * (rebase --continue, a merge commit, cherry-pick) would sit until the shell timeout; with these it takes the default
 * message, and a commit without -m fails at once on an empty message instead of hanging.
 */
const SHELL_ENV: Readonly<Record<string, string>> = {
    GIT_EDITOR: "true",
    GIT_SEQUENCE_EDITOR: "true",
    GIT_MERGE_AUTOEDIT: "no",
    GIT_TERMINAL_PROMPT: "0",
    AC_CLI,
}

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

const SECRET_REASON =
    "ac/explore does not open secret-shaped files. Report the path only (it exists, it is or is not tracked), " +
    "and continue with the rest of the search."

function writeReason(agent: string): string {
    return (
        `${agent} is read-only: it does not run formatters or fixers in write mode, install packages, write files, ` +
        "clear caches or change git state. Test runs are allowed (`php artisan test`, `vendor/bin/phpunit`, the " +
        "project's own test command); for anything else read the tool's config and the manifest instead (a --version " +
        "check is fine), note the command in your report for the orchestrator, and continue."
    )
}

// Ported from plugins/ac/hooks/pretooluse-explore-budget.sh (is_secret, is_write) so the two harnesses refuse
// the same commands. A template or a public half (.env.example, .pub, a .d.ts type file) stays readable.
const PUBLIC_FILE = /\.(example|sample|dist|template|pub|d\.ts|schema)$/
const SECRET_FILE =
    /^(\.env|\.env\..*|.*\.pem|.*\.key|.*\.p12|.*\.pfx|id_rsa|id_ed25519|credentials.*\.json|service-account.*\.json|auth\.json)$/s

// A simple command that only asks whether a file exists or is tracked may name a secret; a redirect or a
// substitution in it carries no such exemption.
const EXISTENCE_CHECK = /^(test |\[ |ls |stat |git check-ignore |git ls-files|git status|echo )/
const REDIRECT_OR_SUBSTITUTION = /[<>`]|\$\(/

const WRITE_COMMANDS: readonly RegExp[] = [
    /^(\S*\/)?(npx\s+|bunx\s+|pnpm\s+exec\s+|yarn\s+)?(prettier|biome)\b.*\s(--write|-w)\b/,
    /^(\S*\/)?(npx\s+)?eslint\b.*\s--fix\b/,
    /^(\S*\/)?ruff\s+(format\b(?!.*--(check|diff))|check\b.*--fix)/,
    /^(\S*\/)?black\b(?!.*--(check|diff|version|help))/,
    /^(\S*\/)?(gofmt\b.*\s-w\b|go\s+(fmt|get|mod\s+tidy)\b|rustfmt\b(?!.*--(check|version)))/,
    /^(\S*\/)?cargo\s+(fmt|add|remove|install|update|fix)\b/,
    /^(\S*\/)?dart\s+(format|fix)\b(?!.*(--output[= ]none|--dry-run|--set-exit-if-changed|--version))/,
    /^(\S*\/)?(dart|flutter)\s+pub\s+(get|add|remove|upgrade|downgrade)\b/,
    /^(\S*\/)?pint\b(?!.*(--test|--version|--help))/,
    /^(\S*\/)?php-cs-fixer\s+fix\b(?!.*--dry-run)/,
    // Read-only subcommands stay open, a test run included, since the reviewers rerun the plan's verification
    // commands; `config:show` stays closed because it prints APP_KEY and database passwords past the .env deny.
    new RegExp(`^(\\S*\\/)?(php\\s+)?artisan\\s+(?!(${READ_ONLY_ARTISAN.join("|")})(?=\\s|$))\\S`),
    /^(npm|pnpm|yarn|bun)\s+(i|install|ci|add|remove|update|upgrade|up)\b/,
    /^yarn\s*$/,
    /^(npm|pnpm|yarn|bun)\s+(run\s+)?(format|fix|lint:fix|format:write)\b/,
    /^(npm|pnpm|yarn|bun)\b.*\s--\s.*--fix\b/,
    /^(composer\s+(install|update|require|remove)|pip3?\s+install|gem\s+install|bundle(\s+install)?\s*$)\b/,
    /^git\b(\s+-C\s+\S+)?\s+(checkout|switch|reset|clean|commit|push|rebase|merge|restore|apply|cherry-pick|am|rm|mv|branch\s+-[dDmM])(?![-\w])/,
    /^git\b(\s+-C\s+\S+)?\s+tag(?![-\w])(?!\s*$|\s+(-l|--list|-n\d*|--contains|--points-at|--merged|--no-merged|--sort)(\s|=|$))/,
    /^git\b(\s+-C\s+\S+)?\s+tag(?![-\w]).*\s(-[adsfmu]+|--delete|--annotate|--sign|--force)(\s|$)/,
    /^git\b(\s+-C\s+\S+)?\s+stash(?!\s+(list|show))(?![-\w])/,
    /^(rm|mv|cp|mkdir|touch|chmod|chown|ln|truncate|dd|tee)\b/,
    /^sed\b.*\s-i/,
    /^perl\b.*\s-\w*i/,
    /^xargs\b.*\b(rm|mv)\b/,
    /^find\b.*\s(-delete|-exec\s+(rm|mv))\b/,
]

// An interpreter's payload is quoted, so blanking hides exactly the text it runs; those calls are judged raw too.
const INTERPRETER =
    /(?:^|[(`])\s*(?:\S*\/)?(?:(?:sh|bash|zsh|dash|ksh|eval)(?![\w-])|(?:perl|python3?|node|ruby)\s+(?:-\S+\s+)*-[A-Za-z]*[ecE]\b)/

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** Redirect targets that write nothing the operator keeps: /dev/null and scratch files under a temp directory. */
function scratchTarget(): RegExp {
    const dirs = ["/tmp", "/private/tmp", "\\$TMPDIR", "\\$\\{TMPDIR\\}", "\\$\\{TMPDIR:-/tmp\\}"]
    const tmpdir = (process.env.TMPDIR ?? "").replace(/\/+$/, "")
    if (/^\/./.test(tmpdir)) dirs.push(escapeRegExp(tmpdir), escapeRegExp(`/private${tmpdir}`))
    return new RegExp(`^(?:/dev/null|(?:${dirs.join("|")})/.+)$`, "s")
}

/**
 * Replaces every character inside a quoted span with `_`, keeping the length, so an offset in the result is an
 * offset in the command. A `$(...)` or backtick span inside double quotes runs as a command and stays visible.
 * Same scanner as plugins/ac/hooks/lib/blank-quotes.sh.
 */
function blankQuotes(command: string): string {
    let out = ""
    let i = 0

    const code = (term?: string): void => {
        let depth = 0
        while (i < command.length) {
            const c = command[i] as string
            if (c === "\\") {
                out += command.slice(i, i + 2)
                i += 2
                continue
            }
            if (term !== undefined) {
                if (c === term && depth === 0) {
                    out += c
                    i++
                    return
                }
                if (term === ")" && c === "(") depth++
                if (term === ")" && c === ")") depth--
            }
            if (c === "'") {
                out += c
                i++
                blankUntil("'", false)
            } else if (c === '"') {
                out += c
                i++
                blankDouble()
            } else if (c === "$" && command[i + 1] === "'") {
                out += "$'"
                i += 2
                blankUntil("'", true)
            } else {
                out += c
                i++
            }
        }
    }

    const blankUntil = (close: string, escapes: boolean): void => {
        while (i < command.length) {
            const d = command[i] as string
            if (d === close) {
                out += d
                i++
                return
            }
            if (escapes && d === "\\") {
                out += "_".repeat(command.slice(i, i + 2).length)
                i += 2
                continue
            }
            out += "_"
            i++
        }
    }

    const blankDouble = (): void => {
        while (i < command.length) {
            const d = command[i] as string
            if (d === '"') {
                out += d
                i++
                return
            }
            if (d === "\\") {
                out += "_".repeat(command.slice(i, i + 2).length)
                i += 2
            } else if (d === "$" && command[i + 1] === "(") {
                out += "$("
                i += 2
                code(")")
            } else if (d === "`") {
                out += d
                i++
                code("`")
            } else {
                out += "_"
                i++
            }
        }
    }

    code()
    return out
}

function isSecret(path: string): boolean {
    const name = path.slice(path.lastIndexOf("/") + 1)
    return !PUBLIC_FILE.test(name) && SECRET_FILE.test(name)
}

/** Splits on whitespace, quotes and shell punctuation so `cat ".env"` and `git show HEAD:.env` surface the path. */
function readsSecret(command: string): boolean {
    for (const raw of command.split(/[;|&\n]/)) {
        const segment = raw.trimStart()
        if (!REDIRECT_OR_SUBSTITUTION.test(segment) && EXISTENCE_CHECK.test(segment)) continue
        if (segment.replace(/["`()<>=:,\t']/g, " ").split(/\s+/).some(isSecret)) return true
    }
    return false
}

/** `raw` is the command, `judged` the text to judge: the command with quotes blanked, or the raw command again. */
function writes(raw: string, judged: string): boolean {
    // 1. A redirect into a file; `2>&1` duplicates a descriptor and writes nothing. The `>` is found in the judged
    //    text and its target read from the raw one, quotes stripped, so a quoted "$TMPDIR/a.log" counts as scratch.
    const scratch = scratchTarget()
    for (const match of judged.matchAll(/(?<!>)(?:&|\d*)>>?\s*(?!&)(?=\S)/g)) {
        const start = (match.index ?? 0) + match[0].length
        const end = start + (/^[^\s;|&<>)`]*/.exec(judged.slice(start))?.[0].length ?? 0)
        const target = raw.slice(start, end).replace(/["']/g, "")
        if (scratch.test(target) && !/(?:^|\/)\.\.(?:\/|$)/.test(target)) continue
        return true
    }

    // 2. A write-mode command word, per simple command, after any leading `VAR=value` assignments.
    return judged
        .split(/[;|&\n]/)
        .map((segment) => segment.trimStart().replace(/^([A-Za-z_][A-Za-z0-9_]*=\S* )*/, ""))
        .some((segment) => WRITE_COMMANDS.some((pattern) => pattern.test(segment)))
}

/**
 * The reason a read-only agent's shell command is refused, or undefined when it may run. Only `ac/explore` gets the
 * secret check: the other reviewers carry deny rules for secret files in their own permission blocks.
 */
function shellDenial(agent: string, command: string): string | undefined {
    if (agent === EXPLORE_AGENT && readsSecret(command)) return SECRET_REASON
    // Explore keeps the CC rule that an artisan test run is no search (pretooluse-explore-budget.sh:126).
    const segments = blankQuotes(command).split(/[;|&\n]/)
    if (agent === EXPLORE_AGENT && segments.some((part) => EXPLORE_ONLY.test(part.trimStart()))) {
        return writeReason(agent)
    }

    const blanked = blankQuotes(command)
    if (writes(command, blanked)) return writeReason(agent)
    const interpreted = blanked.split(/[;|&\n]/).some((segment) => INTERPRETER.test(segment.trimStart()))
    if (interpreted && writes(command, command)) return writeReason(agent)
    return undefined
}

export async function registerToolPolicy(ctx: Plugin.Context, options: ToolPolicyOptions = {}): Promise<void> {
    const maxCalls = options.exploreMaxCalls ?? DEFAULT_EXPLORE_MAX_CALLS
    const shellTimeoutMs = options.shellDefaultTimeoutMs ?? DEFAULT_SHELL_TIMEOUT_MS
    const calls = new Map<string, number>()

    // A call refused here is not counted, so the count stays at the limit and every later call is refused too.
    await ctx.permission.hook("evaluate", (event) => {
        if (event.agent === undefined || !READ_ONLY_AGENTS.has(event.agent)) return

        // The read-only guard runs before the count, as in the CC hook, so a refused command spends no budget.
        if (event.action === "shell") {
            const agent = event.agent
            const denial = event.resources
                .map((command) => shellDenial(agent, command))
                .find((reason) => reason !== undefined)
            if (denial) {
                event.effect = "deny"
                event.message = denial
                return
            }
        }

        if (event.agent !== EXPLORE_AGENT || !BUDGETED_ACTIONS.has(event.action)) return

        const made = calls.get(event.sessionID) ?? 0
        if (made >= maxCalls) {
            event.effect = "deny"
            event.message = budgetMessage(maxCalls)
            return
        }
        calls.set(event.sessionID, made + 1)
    })

    // A value the operator already set (a real editor in their own `!` shell, say) is kept.
    await ctx.shell.hook("create.before", (event) => {
        for (const [key, value] of Object.entries(SHELL_ENV)) event.env[key] ??= value
    })

    await ctx.tool.hook("execute.before", (event) => {
        if (event.tool !== "shell" || typeof event.input !== "object" || event.input === null) return

        const input: { timeout?: unknown; background?: unknown } = event.input
        // A background command has no timeout by default in opencode, and a dev server must keep it that way.
        if (input.timeout !== undefined || input.background === true) return

        event.input = { ...event.input, timeout: shellTimeoutMs }
    })
}
