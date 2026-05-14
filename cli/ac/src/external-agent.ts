import type { Tool } from "@modelcontextprotocol/sdk/types.js";

export type ExternalCli = "codex" | "gemini" | "opencode";

export const LOCAL_TOOL_NAME = "call-external-agent" as const;

export const EXTERNAL_AGENT_TOOL_DEFINITION: Tool = {
    name: LOCAL_TOOL_NAME,
    description: "Dispatch a prompt to a local AI coding CLI (codex, gemini, opencode) running in a chosen directory. Returns the CLI's completion text.",
    inputSchema: {
        type: "object",
        properties: {
            cli: {
                type: "string",
                enum: ["codex", "gemini", "opencode"],
                description: "Which local CLI to invoke.",
            },
            prompt: {
                type: "string",
                description: "Prompt to send to the CLI (non-empty).",
            },
            directory: {
                type: "string",
                description: "Absolute path to the working directory for the CLI.",
            },
            model: {
                type: "string",
                description: "Optional model identifier passed to the CLI (e.g. gpt-5.5, gemini-2.5-flash, anthropic/claude-sonnet-4-6).",
            },
            timeout_seconds: {
                type: "number",
                minimum: 10,
                maximum: 3600,
                description: "Optional hard timeout in seconds (default 600).",
            },
        },
        required: ["cli", "prompt", "directory"],
    },
};

const modelSlot = (flag: string, m: string | undefined): string[] =>
    m && m.length > 0 ? [flag, m] : [];

export function buildArgv(
    cli: ExternalCli,
    prompt: string,
    directory: string,
    model: string | undefined,
): string[] {
    switch (cli) {
        case "codex": {
            const bin = process.env["AC_EXTERNAL_AGENT_CODEX_BIN"] ?? "codex";
            return [bin, "--cd", directory, "exec", ...modelSlot("--model", model), "--skip-git-repo-check", "-"];
        }
        case "gemini": {
            const bin = process.env["AC_EXTERNAL_AGENT_GEMINI_BIN"] ?? "gemini";
            return [bin, "-p", prompt, ...modelSlot("--model", model)];
        }
        case "opencode": {
            const bin = process.env["AC_EXTERNAL_AGENT_OPENCODE_BIN"] ?? "opencode";
            return [bin, "run", "--dir", directory, ...modelSlot("--model", model)];
        }
    }
}
