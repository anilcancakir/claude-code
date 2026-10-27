import { Command, Option } from "commander";
import { MCP_CLIENTS, runMcpProxy } from "./mcp.ts";
import type { McpClient } from "./mcp.ts";
import { AC_VERSION } from "./version.ts";
import { scaffoldPlan } from "./plan-scaffold.ts";
import { formatCheckResult, runPlanCheck } from "./plan-check.ts";
import { collectPlanStats, formatPlanStats } from "./plan-stats.ts";
import { resolveTranscriptPath, runRunStats } from "./run-stats.ts";
import { collectRunCost, formatRunCost } from "./run-cost.ts";
import {
    addLease,
    defaultLeaseDeps,
    leaseFilePath,
    LeaseError,
    releaseLeases,
    sweepLeases,
} from "./lease.ts";
import type { LeaseAddInput } from "./lease.ts";
import {
    HISTORY_HEAD_LIMIT_DEFAULT,
    HISTORY_HEAD_LIMIT_MAX,
    resolveProjectsRoot,
    runSearch,
} from "./history-search.ts";
import type { HistorySearchArgs } from "./history-search.ts";
import { syncArchive } from "./history-sync.ts";
import type { HistorySyncReport } from "./history-sync.ts";
import { openHistoryStore } from "./history-store.ts";
import type { HistoryStore } from "./history-store.ts";

const program = new Command();

program
    .name("ac")
    .description("ac CLI. Companion runtime for the ac Claude Code plugin.")
    .version(AC_VERSION);

program
    .command("mcp")
    .description("Run the ac stdio MCP server (proxies tools to kodizm).")
    .option(
        "--url <value>",
        "Override the kodizm MCP endpoint (defaults to https://mcp.kodizm.com; "
            + "use http://127.0.0.1:<port>/mcp/kodizm for local dev).",
    )
    .option(
        "--token <value>",
        "Override the kdz- bearer token (also reads KODIZM_MCP_TOKEN).",
    )
    .addOption(
        new Option(
            "--client <value>",
            "Host the server speaks to: opencode drops search-history and names no Claude Code built-ins.",
        )
            .choices(MCP_CLIENTS)
            .default("claude-code"),
    )
    .action(async (opts: { token?: string; url?: string; client: McpClient }): Promise<void> => {
        await runMcpProxy(
            {
                token: opts.token,
                url: opts.url,
                client: opts.client,
            },
        );
    });

program
    .command("plan-scaffold <slug>")
    .description(
        "Create .ac/plans/<slug>/ with research/ and evidence/, and write a plan.md skeleton "
            + "carrying the template's sections in order. Leaves an existing plan.md untouched.",
    )
    .requiredOption(
        "--auto-mode <true|false>",
        "The Stage 4 `Lock all?` answer, recorded in the plan frontmatter. Required: a run that "
            + "skipped Stage 4 has no value to pass here, which is the point.",
    )
    .requiredOption(
        "--qa <true|false>",
        "The Stage 3 QA answer, recorded in the plan frontmatter. Required: /ac:execute Phase 3e "
            + "reads it, and a planner that never asked has no value to pass here.",
    )
    .option("--dir <value>", "Project root to scaffold under.", process.cwd())
    .action((slug: string, opts: { autoMode: string; qa: string; dir: string }): void => {
        if (opts.autoMode !== "true" && opts.autoMode !== "false") {
            process.stderr.write(`--auto-mode must be true or false, got "${opts.autoMode}"\n`);
            process.exitCode = 1;
            return;
        }
        if (opts.qa !== "true" && opts.qa !== "false") {
            process.stderr.write(`--qa must be true or false, got "${opts.qa}"\n`);
            process.exitCode = 1;
            return;
        }
        const result = scaffoldPlan(slug, {
            autoMode: opts.autoMode === "true",
            qa: opts.qa === "true",
            dir: opts.dir,
        });
        const state = result.created ? "created" : "exists, left untouched";
        process.stdout.write(`${result.planPath} (${state})\n`);
    });

program
    .command("plan-check <slug>")
    .description(
        "Validate a plan file's machine-readable shape: one `- [ ]` checkbox per step matching the "
            + "frontmatter count, a Type from code/infra/verification, a Tier on every worker step, "
            + "Commands and Evidence on every verification step. Exits 1 on any error. Accepts a slug "
            + "or a path to the plan.md.",
    )
    .option("--dir <value>", "Project root holding .ac/plans/.", process.cwd())
    .action((slug: string, opts: { dir: string }): void => {
        // A missing plan and a malformed plan are different problems with different fixes, so they
        // get different exit codes. Sharing 1 would put "wrong slug" and "wrong shape" on the same
        // branch of the caller's routing, and the caller here is a skill body following a table.
        let result;
        try {
            result = runPlanCheck(slug, { dir: opts.dir });
        } catch (error) {
            process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
            process.exitCode = 2;
            return;
        }
        process.stdout.write(formatCheckResult(result) + "\n");
        if (result.errorCount > 0) {
            process.exitCode = 1;
        }
    });

program
    .command("run-stats <session>")
    .description(
        "Print the cost anatomy of one run from its session transcript: turns, output tokens, "
            + "cache-read, average and peak resident context, compactions, the tool mix and the "
            + "per-agent-type subagent rollup. Accepts a session id or a path to the .jsonl.",
    )
    .action((session: string): void => {
        const path = resolveTranscriptPath(session, resolveProjectsRoot());
        process.stdout.write(runRunStats(path) + "\n");
    });

program
    .command("cost")
    .description(
        "Price what ac runs cost across every session transcript: the main thread and each subagent "
            + "type, with runs, turns, output and context per turn, minutes and dollars per run, and the "
            + "share of cache writes that rebuilt a context after the five-minute TTL expired. Dollars are "
            + "API list prices; on a subscription read them as shares of usage.",
    )
    .option("--days <n>", "Count the last N days.", "14")
    .option("--since <date>", "Count from this UTC date (YYYY-MM-DD); overrides --days.")
    .option("--project <substring>", "Only project directories whose name contains this.")
    .option("--all-sessions", "Count sessions that spawned no ac agent too.")
    .action((opts: { days: string; since?: string; project?: string; allSessions?: boolean }): void => {
        const days = Number.parseInt(opts.days, 10);
        if (opts.since === undefined && (!Number.isInteger(days) || days < 1)) {
            throw new Error(`--days must be a positive integer, got ${opts.days}`);
        }
        const since = opts.since ?? new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) {
            throw new Error(`--since must be YYYY-MM-DD, got ${since}`);
        }
        const report = collectRunCost({
            allSessions: opts.allSessions === true,
            project: opts.project,
            root: resolveProjectsRoot(),
            since,
        });
        process.stdout.write(formatRunCost(report) + "\n");
    });

program
    .command("plan-stats")
    .description(
        "Scan a directory tree for `.ac/plans/<slug>/plan.md` files and print the tier and "
            + "codebase-state distributions across them, plus complexity for plans old enough to "
            + "carry that retired field, and for executed plans the [RETRY] rungs per tier and the "
            + "[REMEDIATION] lines from wisdom.md. Use it to measure what the plan-time tier rules actually "
            + "produce, and what a tier or effort change costs in quality, before and after the change.",
    )
    .option("--dir <value>", "Root to scan.", process.cwd())
    .option("--since <date>", "Only plans whose plan.md changed on or after this UTC date (YYYY-MM-DD).")
    .action((opts: { dir: string; since?: string }): void => {
        if (opts.since !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(opts.since)) {
            throw new Error(`--since must be YYYY-MM-DD, got ${opts.since}`);
        }
        process.stdout.write(formatPlanStats(collectPlanStats(opts.dir, { since: opts.since })) + "\n");
    });

const lease = program
    .command("lease")
    .description(
        "Record test resources a session started (a pid, an Android emulator, an iOS simulator, a "
            + "playwright-cli session) and stop them when the session ends or at the next session start.",
    );

interface LeaseTargetOpts {
    readonly kind: string;
    readonly pid?: string;
    readonly match?: string;
    readonly serial?: string;
    readonly udid?: string;
    readonly session?: string;
    readonly label?: string;
}

/** `add` and `release` name a target with the same flags, so a release always matches what was added. */
function withLeaseTargetOptions(command: Command): Command {
    return command
        .requiredOption("--kind <value>", "pid|adb-emu|simctl|playwright")
        .option("--pid <value>", "pid kind: the process id to stop.")
        .option("--match <value>", "pid kind: a substring the process's command line must contain.")
        .option("--serial <value>", "adb-emu kind: the emulator serial, emulator-<port>.")
        .option("--udid <value>", "simctl kind: the simulator UDID.")
        .option("--session <value>", "playwright kind: the playwright-cli session name (not the Claude session).");
}

function leaseTargetInput(opts: LeaseTargetOpts): LeaseAddInput {
    return {
        kind: opts.kind,
        pid: opts.pid,
        match: opts.match,
        serial: opts.serial,
        udid: opts.udid,
        pwSession: opts.session,
        label: opts.label,
    };
}

withLeaseTargetOptions(
    lease
        .command("add")
        .description(
            "Append a lease to <tmpdir>/ac-leases/<CLAUDE_CODE_SESSION_ID>.jsonl, owned by the nearest "
                + "claude ancestor, and print that file. A pid lease pins the process's start time and "
                + "command, and is refused for a process that started before that claude process or "
                + "that has a controlling terminal. An adb-emu lease records the emulator's AVD name.",
        ),
)
    .option("--label <value>", "Free text shown in sweep output.")
    .action((opts: LeaseTargetOpts): void => {
        try {
            const deps = defaultLeaseDeps();
            const added = addLease(leaseTargetInput(opts), deps);
            process.stdout.write(
                `leased ${added.kind} for session ${added.session} in ${leaseFilePath(deps.leaseDir, added.session)}\n`,
            );
        } catch (error) {
            if (!(error instanceof LeaseError)) {
                throw error;
            }
            process.stderr.write(`${error.message}\n`);
            process.exitCode = 1;
        }
    });

withLeaseTargetOptions(
    lease
        .command("release")
        .description(
            "Remove the current session's leases on one target without stopping anything. Run it after "
                + "stopping a leased resource yourself, so the session-end sweep does not stop a later "
                + "device that reuses the serial or UDID.",
        ),
)
    .action((opts: LeaseTargetOpts): void => {
        try {
            const report = releaseLeases(leaseTargetInput(opts), defaultLeaseDeps());
            const where = report.files.length === 0 ? "" : ` from ${report.files.join(", ")}`;
            process.stdout.write(`released ${report.removed} lease(s)${where}\n`);
        } catch (error) {
            if (!(error instanceof LeaseError)) {
                throw error;
            }
            process.stderr.write(`${error.message}\n`);
            process.exitCode = 1;
        }
    });

interface LeaseSweepOpts {
    readonly session?: string;
    readonly reason?: string;
    readonly stale?: boolean;
    readonly detach?: boolean;
}

lease
    .command("sweep")
    .description(
        "Stop what a Claude session leased, in both the TMPDIR and the sandbox lease store; a target "
            + "another live session also leases is left running, and a failed stop stays in the file. "
            + "No-op for --reason resume.",
    )
    .option("--session <value>", "Claude session id to sweep (defaults to CLAUDE_CODE_SESSION_ID).")
    .option("--reason <value>", "SessionEnd reason; resume sweeps nothing.")
    .option("--stale", "Also sweep every lease entry whose own owning claude process is gone.")
    .option("--detach", "Relaunch the sweep detached and exit at once (SessionEnd allows 1.5 s).")
    .action(async (opts: LeaseSweepOpts): Promise<void> => {
        try {
            const report = await sweepLeases(opts, defaultLeaseDeps());
            for (const outcome of report.outcomes) {
                process.stdout.write(`${outcome.status} ${outcome.target} (${outcome.file}): ${outcome.detail}\n`);
            }
            if (report.malformed > 0) {
                process.stderr.write(`ignored ${report.malformed} malformed lease line(s)\n`);
            }
        } catch (error) {
            if (!(error instanceof LeaseError)) {
                throw error;
            }
            process.stderr.write(`${error.message}\n`);
            process.exitCode = 1;
        }
    });

const history = program
    .command("history")
    .description(
        "Debugging and warming surface for the local Claude Code history archive that backs the "
            + "search-history MCP tool.",
    );

history
    .command("index")
    .description(
        "Build or refresh the history archive from ~/.claude/projects (or CLAUDE_CONFIG_DIR) and "
            + "print the sync report. A cold build costs roughly 21s; a warm no-change pass is near-instant.",
    )
    .action(async (): Promise<void> => {
        const store = await openHistoryStore();
        try {
            const report = await syncArchive({ root: resolveProjectsRoot(), store });
            process.stdout.write(formatSyncReport(report) + "\n");
        } finally {
            store.close();
        }
    });

interface HistorySearchOpts {
    readonly path?: string;
    readonly outputMode: string;
    readonly headLimit: string;
    readonly offset: string;
    readonly since?: string;
    readonly until?: string;
    readonly role?: string;
    readonly kind?: string;
    readonly includeSubagents: boolean;
    readonly agentType?: string;
    readonly sessionId?: string;
}

history
    .command("search <pattern>")
    .description(
        "Search the history archive. pattern is tokenized full-text with prefix matching, not a "
            + "regex, and punctuation is dropped rather than matched, so 'C++' searches for 'c'. "
            + "Turkish folding works in both directions: 'gozden' finds 'gözden' and 'calisiyor' "
            + "finds 'çalışıyor', so type a Turkish word either way.",
    )
    .option("--path <value>", "Filter to project paths containing this substring.")
    .option(
        "--output-mode <value>",
        "content|sessions|projects|count|read. projects rolls the hits up per project, busiest first.",
        "content",
    )
    .option(
        "--head-limit <value>",
        `Max hits per page (1-${HISTORY_HEAD_LIMIT_MAX}).`,
        String(HISTORY_HEAD_LIMIT_DEFAULT),
    )
    .option("--offset <value>", "Page offset.", "0")
    .option("--since <value>", "ISO date/time lower bound.")
    .option("--until <value>", "ISO date/time upper bound.")
    .option("--role <value>", "user|assistant|any", "any")
    .option("--kind <value>", "prose|tool_use|tool_error|any", "any")
    .option("--no-include-subagents", "Exclude subagent turns (included by default).")
    .option("--agent-type <value>", "Filter to one subagent agent type, e.g. ac:librarian.")
    .option(
        "--session-id <value>",
        "Session to open a window on; required (and pattern is ignored) when --output-mode is read.",
    )
    .action(async (pattern: string, opts: HistorySearchOpts): Promise<void> => {
        const store = await openHistoryStore();
        try {
            const headLimit = Number.parseInt(opts.headLimit, 10);
            const offset = Number.parseInt(opts.offset, 10);
            const args: HistorySearchArgs = {
                pattern,
                path: opts.path,
                output_mode: opts.outputMode,
                head_limit: Number.isNaN(headLimit) ? undefined : headLimit,
                offset: Number.isNaN(offset) ? undefined : offset,
                since: opts.since,
                until: opts.until,
                role: opts.role,
                kind: opts.kind,
                include_subagents: opts.includeSubagents,
                agent_type: opts.agentType,
                session_id: opts.sessionId,
            };
            const text = await runSearch(args, { store });
            process.stdout.write(text + "\n");
        } finally {
            store.close();
        }
    });

interface HistoryForgetOpts {
    readonly session?: string;
    readonly project?: string;
    readonly before?: string;
}

history
    .command("forget")
    .description(
        "Delete rows from the history archive. Requires at least one of --session, --project, "
            + "--before; there is no wholesale wipe.",
    )
    .option("--session <value>", "Delete rows for one session id.")
    .option(
        "--project <value>",
        "Delete rows for one project path, matched EXACTLY (never as a substring).",
    )
    .option("--before <value>", "Delete rows older than this ISO date/time.")
    .action(async (opts: HistoryForgetOpts): Promise<void> => {
        if (opts.session === undefined && opts.project === undefined && opts.before === undefined) {
            process.stderr.write(
                "history forget requires at least one of --session, --project, --before\n",
            );
            process.exitCode = 1;
            return;
        }

        let before: number | undefined;
        if (opts.before !== undefined) {
            const parsed = Date.parse(opts.before);
            if (Number.isNaN(parsed)) {
                process.stderr.write("--before must be an ISO 8601 date or date-time string\n");
                process.exitCode = 1;
                return;
            }
            before = parsed;
        }

        const store: HistoryStore = await openHistoryStore();
        try {
            const result = store.forget({
                sessionId: opts.session,
                projectPath: opts.project,
                before,
            });
            process.stdout.write(
                `Removed ${result.turnsRemoved} turn(s), ${result.sessionsRemoved} session(s), `
                    + `${result.quarantineRemoved} quarantine row(s).\n`,
            );
        } finally {
            store.close();
        }
    });

/** Renders a sync report as human-readable lines for `history index`. */
function formatSyncReport(report: HistorySyncReport): string {
    return [
        `Files scanned: ${report.filesScanned}`,
        `Files vanished mid-walk: ${report.filesVanished}`,
        // Both counters exist to be seen. `filesFailed` counts a transcript this pass could not
        // read at all, and `skipped` counts conversational lines that carried nothing indexable;
        // misclassifying the latter is what once produced a 1.53 GB quarantine table, so the
        // diagnostic surface for it must not hide either number.
        `Files failed to read: ${report.filesFailed}`,
        `Rows added: ${report.rowsAdded}`,
        `Lines skipped (nothing indexable): ${report.skipped}`,
        `Lines quarantined: ${report.quarantined}`,
        `Redactions applied: ${report.redactions}`,
        `Elapsed: ${report.elapsedMillis} ms`,
        `Changed: ${report.changed ? "yes" : "no"}`,
    ].join("\n");
}

await program.parseAsync(process.argv);
