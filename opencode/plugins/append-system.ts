import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { Plugin } from "@opencode-ai/plugin"

/**
 * Injects the `ac` operating-mode overlay into the system prompt of main-thread sessions.
 *
 * This is the OpenCode equivalent of Claude Code's `--append-system-prompt-file` flag. The overlay
 * at `opencode/append-prompt.md` defines delegation routing (explore / librarian / oracle), the
 * code lookup hierarchy, investigation and verification discipline, and communication style.
 *
 * The overlay must reach ONLY primary agents running on OpenCode's provider base prompt (build and
 * friends). Gating by agent name is not possible here: the transform hook input carries no agent
 * name, and `chat.params` (which does) fires after the transform within the same request, so any
 * session-to-agent map is one request stale. Instead the gate reads the leading system block:
 *
 * - Provider base prompts open with "You are opencode" (anthropic.txt and siblings): inject.
 * - Our subagent bodies (`opencode/agents/*.md`) open with "## Identity": no match, skip.
 * - Internal helpers open differently ("You are a title generator", summary, compaction): skip.
 */
const OVERLAY_PATH = join(homedir(), "Code", "claude-code", "opencode", "append-prompt.md")

const PROVIDER_PROMPT_SIGNATURE = "You are opencode"

let cachedOverlay: string | null = null

/**
 * Reads the overlay file once per process and caches it. An unreadable file disables injection
 * instead of crashing the session; OpenCode logs plugin errors but the session must stay usable.
 */
function loadOverlay(): string {
  if (cachedOverlay !== null) {
    return cachedOverlay
  }

  let overlay = ""

  try {
    overlay = readFileSync(OVERLAY_PATH, "utf8").trim()
  } catch (error) {
    console.error(`[append-system] overlay unreadable at ${OVERLAY_PATH}: ${String(error)}`)
  }

  cachedOverlay = overlay

  return overlay
}

export const AppendSystemPlugin: Plugin = async () => {
  return {
    "experimental.chat.system.transform": async (_input, output): Promise<void> => {
      const overlay = loadOverlay()

      if (overlay === "") {
        return
      }

      // 1. Only requests running on the provider base prompt are main-thread turns.
      const head = output.system[0] ?? ""

      if (!head.startsWith(PROVIDER_PROMPT_SIGNATURE)) {
        return
      }

      // 2. Single push keeps the two-part system shape intact for Anthropic prompt caching.
      output.system.push(overlay)
    },
  }
}
