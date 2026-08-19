import { Command } from "commander";
import { runMcpProxy } from "./mcp.ts";
import { scaffoldPlan } from "./plan-scaffold.ts";
import { runReviewCounters } from "./review-counters.ts";
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
    .version("0.10.1");

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
    .action(async (opts: { token?: string; url?: string }): Promise<void> => {
        await runMcpProxy(
            {
                token: opts.token,
                url: opts.url,
            },
        );
    });

program
    .command("review-counters <log>")
    .description(
        "Print the review-loop counters derived from an append-only log: "
            + "ITER=<n> PREV=<v> GATE=<OK|MAX_ITER> NEW=<count>.",
    )
    .option(
        "--run-prefix <value>",
        "Heading that scopes counters to one run (for example '## Run ').",
        "## Run ",
    )
    .option(
        "--iter-prefix <value>",
        "Heading that marks one logged pass (for example '## Phase 3d Iteration').",
        "## Phase 3d Iteration",
    )
    .option("--cap <value>", "Iteration cap; GATE reads MAX_ITER once ITER exceeds it.", "3")
    .action(
        (
            log: string,
            opts: { cap: string; iterPrefix: string; runPrefix: string },
        ): void => {
            const cap = Number.parseInt(opts.cap, 10);
            process.stdout.write(
                runReviewCounters(log, {
                    cap: Number.isNaN(cap) ? 3 : cap,
                    iterPrefix: opts.iterPrefix,
                    runPrefix: opts.runPrefix,
                }) + "\n",
            );
        },
    );

program
    .command("plan-scaffold <slug>")
    .description(
        "Create .ac/plans/<slug>/ with research/ and evidence/, and write a plan.md skeleton "
            + "carrying the template's sections in order. Leaves an existing plan.md untouched.",
    )
    .option("--dir <value>", "Project root to scaffold under.", process.cwd())
    .action((slug: string, opts: { dir: string }): void => {
        const result = scaffoldPlan(slug, { dir: opts.dir });
        const state = result.created ? "created" : "exists, left untouched";
        process.stdout.write(`${result.planPath} (${state})\n`);
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
