import type { Tool } from "@modelcontextprotocol/sdk/types.js";

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
