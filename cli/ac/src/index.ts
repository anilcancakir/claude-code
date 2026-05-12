import { Command } from "commander";
import { runMcpProxy } from "./mcp.ts";

const program = new Command();

program
    .name("ac")
    .description("ac CLI. Companion runtime for the ac Claude Code plugin.")
    .version("0.1.0");

program
    .command("mcp")
    .description("Run the ac stdio MCP server (proxies tools to kodizm).")
    .option("--token <value>", "Override kodizm bearer token")
    .action(async (opts: { token?: string }): Promise<void> => {
        await runMcpProxy({ token: opts.token });
    });

await program.parseAsync(process.argv);
