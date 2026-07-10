---
description: Interactive post-install setup for the ac plugin. Phase 0 parses flags (--dry-run, --skip-skills, --skip-settings, --skip-claude-md), detects the OS, the presence of the my-coding, my-language, and my-workflow user skills, the global CLAUDE.md and settings.json, and probes ac MCP reachability. Phases 1, 2, and 2.5 run short interviews and delegate my-coding, my-language, and my-workflow skill creation to ac:skill-creator with the bundled templates, skipping any skill that already exists unless the user picks Recreate. Phase 3 merges a lean workflow-pointer section into the global CLAUDE.md between the ac:delegation fence markers behind a .proposed gate. Phase 4 backs up (non-clobber) and idempotently merges settings.json in groups: safe-silent tuning (Group A, set-only-when-absent), core ac parity (Group C, enabledPlugins plus MCP allow plus plan-mode deny), security-sensitive keys behind an explicit opt-in multiSelect (Group B, default off), and an interactive MCP-token prompt whose value is masked in every rendered surface. The plan-mode block ships in the plugin hooks, so Phase 4 writes no settings hook. Phase 5 reports what was created, merged, skipped, and the backup path.
argument-hint: [--dry-run] [--skip-skills] [--skip-settings] [--skip-claude-md]
effort: high
disable-model-invocation: true
---

# /ac:install

Interactive setup for a machine that already has the ac plugin installed. This command tunes your user-scope environment: it generates your personal `my-coding`, `my-language`, and `my-workflow` skills, merges a lean workflow-pointer section into your global `~/.claude/CLAUDE.md`, and configures `~/.claude/settings.json` so the ac workflow replaces the matching Claude Code built-ins. Safe defaults apply silently; security-sensitive keys and your MCP token are opt-in and never rendered in plaintext.

Request: $ARGUMENTS

Precondition: the ac plugin is already installed and loaded (you are running this as `/ac:install`). This command does not bootstrap the install. It never calls `/plugin marketplace add` or `/plugin install`. It writes only under `~/.claude/` and only the files each phase names.

## Phase 0: Identity, Arguments, and Preflight

You are the `/ac:install` orchestrator. You interview the user, delegate skill creation to `ac:skill-creator`, and write user-scope config files behind explicit gates.

**CAN**: Use `Read`, `Write`, `Edit`, `Bash`, `AskUserQuestion`. Invoke `ac:skill-creator` via the `Skill` tool (Phases 1, 2, and 2.5). Probe the ac MCP server by calling `mcp__plugin_ac_ac__resolve-library`. Write a `~/.claude/CLAUDE.md.proposed` sidecar and a `~/.claude/settings.json.bak-ac-install` backup.

**CANNOT**: Hand-write `my-coding`, `my-language`, or `my-workflow` `SKILL.md` content; that is `ac:skill-creator`'s job. Blind-overwrite `~/.claude/CLAUDE.md` or `~/.claude/settings.json`; both go through merge plus a gate or a backup. Run `/plugin marketplace add` or `/plugin install`. Edit files outside `~/.claude/`. Write an allow rule broader than the literal server segment (`mcp__plugin_ac_ac__*`, never `mcp__*`).

**MUST**: Honor every flag from 0a for the rest of the run. Under `--dry-run`, render every planned change but call no `Write` or `Edit`. Back up `~/.claude/settings.json` before the Phase 4 merge. Skip a skill that already exists unless the user chooses Recreate. Keep the merged global `CLAUDE.md` within the 200-line guidance.

### 0a. Parse arguments

Mirror the `commit.md` Phase 0 flag scan. Read `$ARGUMENTS` once and set each flag:

1. `--dry-run`: set `DRY_RUN = true` if present, else `false`. When true, every phase plans and prints but writes nothing.
2. `--skip-skills`: set `SKIP_SKILLS = true` if present, else `false`. When true, skip Phases 1 and 2 entirely.
3. `--skip-settings`: set `SKIP_SETTINGS = true` if present, else `false`. When true, skip Phase 4.
4. `--skip-claude-md`: set `SKIP_CLAUDE_MD = true` if present, else `false`. When true, skip Phase 3.
5. Ignore any other tokens.

### 0b. Detect the environment

Run these detections and record the result. On any failure, note it and continue; detection failure never blocks the run.

1. OS: `uname -ms`.
2. Existing `my-coding` skill: `test -d ~/.claude/skills/my-coding` (record `MY_CODING_EXISTS`).
3. Existing `my-language` skill: `test -d ~/.claude/skills/my-language` (record `MY_LANGUAGE_EXISTS`).
4. Existing `my-workflow` skill: `test -d ~/.claude/skills/my-workflow` (record `MY_WORKFLOW_EXISTS`).
5. Existing global CLAUDE.md: `test -f ~/.claude/CLAUDE.md` (record `CLAUDE_MD_EXISTS`).
6. Existing settings: `test -f ~/.claude/settings.json` (record `SETTINGS_EXISTS`).

### 0c. Probe ac MCP reachability

Call `mcp__plugin_ac_ac__resolve-library` with a trivial query (for example `react`). Record `MCP_REACHABLE = true` when it returns a result, `false` on error, timeout, or tool-not-available. This gates whether Phase 3's CLAUDE.md section names the ac MCP fallback tools: include the fallback steering text only when `MCP_REACHABLE` is true, so the delegation section does not point at tools the user cannot reach.

If the probe path does not resolve, tell the user they can run `/mcp` to confirm the exact server name and re-run. The bundled server is keyed `ac` in `.mcp.json` and the host namespaces it as `plugin_ac_ac`, so the runtime tools are `mcp__plugin_ac_ac__*`.

## Phase 1: my-coding skill (skip if `--skip-skills`)

Skip this entire phase when `SKIP_SKILLS = true`.

### 1a. Skip-if-present gate

When `MY_CODING_EXISTS` is true, ask before touching it:

```
AskUserQuestion({
  header: "my-coding?",
  question: "A my-coding skill already exists at ~/.claude/skills/my-coding/. How should I handle it?",
  options: [
    {label: "Skip (Recommended)", description: "Leave the existing my-coding skill untouched and continue."},
    {label: "Recreate", description: "Run the style interview and regenerate my-coding from scratch."}
  ]
})
```

On Skip, continue to Phase 2. On Recreate, run 1b and 1c.

When `MY_CODING_EXISTS` is false, run 1b and 1c directly.

### 1b. Short style interview

Gather the user's coding profile through `AskUserQuestion` in tight rounds. Keep each round focused; one decision per question. Cover, in order:

1. Primary stack and the language versions in play.
2. Non-negotiable rules (multiSelect: type everything, English-only identifiers, TDD, zero linter suppressions, minimal-diff, plus an "Add your own" free-text option).
3. Architecture philosophy (how business logic is organized).
4. Formatting (line width, indentation, trailing commas, import order).
5. Testing discipline (test-first, test-alongside, post-implementation).
6. Pet peeves and anything the rounds above missed (free text).

Compile the answers into a short brief: stack and versions, the rules with a one-line rationale each, the architecture stance, the formatting table, the testing stance, the pet peeves.

### 1c. Delegate to ac:skill-creator

Under `--dry-run`, print the compiled brief and the target path, then skip the invocation. Otherwise invoke the skill:

```
Skill({skill: "ac:skill-creator"})
```

Hand it the brief plus the bundled template path, and instruct it to create the skill at user scope:

- Create the `my-coding` skill at `~/.claude/skills/my-coding/`.
- Read the structural template at `${CLAUDE_PLUGIN_ROOT}/references/coding-style-template.md` and fill its angle-bracket placeholders from the brief.
- Author one `references/<language>.md` per primary stack from the brief; keep the SKILL.md body lean and push language detail into those references.

Do not write the SKILL.md yourself. The skill-creator owns the file content; this command only supplies the brief and the template path.

## Phase 2: my-language skill (skip if `--skip-skills`)

Skip this entire phase when `SKIP_SKILLS = true`. Same shape as Phase 1.

### 2a. Skip-if-present gate

When `MY_LANGUAGE_EXISTS` is true, ask before touching it:

```
AskUserQuestion({
  header: "my-language?",
  question: "A my-language skill already exists at ~/.claude/skills/my-language/. How should I handle it?",
  options: [
    {label: "Skip (Recommended)", description: "Leave the existing my-language skill untouched and continue."},
    {label: "Recreate", description: "Run the voice interview and regenerate my-language from scratch."}
  ]
})
```

On Skip, continue to Phase 3. On Recreate, run 2b and 2c. When `MY_LANGUAGE_EXISTS` is false, run 2b and 2c directly.

### 2b. Short voice interview

Gather the user's writing profile through `AskUserQuestion` in tight rounds:

1. Mode preferences (which modes matter: documentation, article, commit message, code comment, PR description).
2. Tone (how formality shifts across those modes).
3. Voice characteristics (the traits that make their writing recognizable).
4. Signature phrases (recurring constructions, or "none").
5. Whether the user supplies writing samples for `references/examples.md`; if yes, collect the excerpts or a path.

Compile the answers into a short brief: the active modes with opening and closing patterns, the tone spectrum, the voice traits, the signature phrases, and any supplied samples.

### 2c. Delegate to ac:skill-creator

Under `--dry-run`, print the compiled brief and the target path, then skip the invocation. Otherwise invoke the skill:

```
Skill({skill: "ac:skill-creator"})
```

Hand it the brief plus the bundled template path, and instruct it to create the skill at user scope:

- Create the `my-language` skill at `~/.claude/skills/my-language/`.
- Read the structural template at `${CLAUDE_PLUGIN_ROOT}/references/language-style-template.md` and fill its angle-bracket placeholders from the brief.
- When the user supplied samples, write them to `references/examples.md` and point the SKILL.md at that file.

Do not write the SKILL.md yourself. The skill-creator owns the file content.

## Phase 2.5: my-workflow skill (skip if `--skip-skills`)

Skip this entire phase when `SKIP_SKILLS = true`. Same shape as Phases 1 and 2, but the workflow discipline is mostly generic; the interview only personalizes a few placeholders.

### 2.5a. Skip-if-present gate

When `MY_WORKFLOW_EXISTS` is true, ask before touching it:

```
AskUserQuestion({
  header: "my-workflow?",
  question: "A my-workflow skill already exists at ~/.claude/skills/my-workflow/. How should I handle it?",
  options: [
    {label: "Skip (Recommended)", description: "Leave the existing my-workflow skill untouched and continue."},
    {label: "Recreate", description: "Run the short workflow interview and regenerate my-workflow from scratch."}
  ]
})
```

On Skip, continue to Phase 3. On Recreate, run 2.5b and 2.5c. When `MY_WORKFLOW_EXISTS` is false, run 2.5b and 2.5c directly.

### 2.5b. Short workflow interview

The workflow discipline itself is generic to any ac user, so the template carries it as static content. The interview only fills the personal placeholders. Gather these through `AskUserQuestion` in tight rounds:

1. Operator name (for the skill title, for example the byline on `<operator name>'s workflow discipline`).
2. End-to-end trigger words: the phrases that mean "verify it through actual use, do not stop at compiles" (default examples: "ship it", "make it work").
3. Real-world-test tools: how the operator runs a live check (multiSelect with defaults SSH, browser automation, HTTP client, REPL, plus an "Add your own" free-text option).
4. Primary stack, for the optional stack-specific verification line (free text, or "skip").

Compile the answers into a short brief: the operator name, the trigger words, the real-world-test tools, and the optional stack note.

### 2.5c. Delegate to ac:skill-creator

Under `--dry-run`, print the compiled brief and the target path, then skip the invocation. Otherwise invoke the skill:

```
Skill({skill: "ac:skill-creator"})
```

Hand it the brief plus the bundled template path, and instruct it to create the skill at user scope:

- Create the `my-workflow` skill at `~/.claude/skills/my-workflow/` as a single `SKILL.md` file; do not create a `references/` subdirectory for it (the discipline fits in one file).
- Read the structural template at `${CLAUDE_PLUGIN_ROOT}/references/workflow-template.md` and fill only its angle-bracket placeholders from the brief (`<operator name>`, the end-to-end trigger words, the real-world-test tools, the optional stack line). Keep every static discipline section verbatim.
- Leave the `<!-- WORKFLOW_CUSTOM_PLACEHOLDER -->` marker in place for the operator's later additions.

Do not write the SKILL.md yourself. The skill-creator owns the file content; this command only supplies the brief and the template path.

## Phase 3: global CLAUDE.md (skip if `--skip-claude-md`)

Skip this entire phase when `SKIP_CLAUDE_MD = true`.

### 3a. Build the proposed section

Read the portable section template at `${CLAUDE_PLUGIN_ROOT}/references/global-claude-md-section-template.md`. This template is a lean pointer: a short `## Workflow discipline` line that routes procedural detail to the `my-workflow` skill, plus a `## Skills` list, all wrapped between `<!-- ac:delegation:start -->` and `<!-- ac:delegation:end -->` fence markers. The procedural discipline itself lives in the `my-workflow` skill (Phase 2.5), not in CLAUDE.md. Keep the pointer verbatim; light tuning of the Skills routing wording from the Phase 1, 2, and 2.5 answers is fine, but do not paste procedural prose back in.

### 3b. Merge via the fence markers, do not overwrite

The fence markers make the merge deterministic. Treat the whole block from `<!-- ac:delegation:start -->` through `<!-- ac:delegation:end -->` (inclusive) as the ac-managed region.

When `CLAUDE_MD_EXISTS` is false, write the template's fenced block directly to `~/.claude/CLAUDE.md` (skip under `--dry-run`, print the planned content instead).

When `CLAUDE_MD_EXISTS` is true, merge instead of replacing. Read the current file:

1. If both fence markers are present in order (start before end), replace everything between them (inclusive of the markers) with the template's fenced block, and preserve every byte outside the fenced region verbatim.
2. If neither marker is present, append the template's fenced block (including the leading HTML-comment header) after the user's content.
3. If exactly one marker is present, or the two appear out of order, do not guess the boundary: append a fresh fenced block as in case 2, leave the stray marker untouched (ADD-only), and flag the anomaly in the gate diff so the user can reconcile the duplicate by hand.

Do not do a fuzzy heading-based match; the markers are the only anchor. Confirm the merged result stays within 200 lines; trim the pointer wording before the user's own content if it would overflow.

Then gate the write per the `init-project` `.proposed` pattern:

1. Under `--dry-run`, print the merged result and stop here; write nothing.
2. Otherwise write the merged result to `~/.claude/CLAUDE.md.proposed` and ask:

```
AskUserQuestion({
  header: "Apply?",
  question: "Your global CLAUDE.md already exists. The proposed merge is at ~/.claude/CLAUDE.md.proposed. How should I handle it?",
  options: [
    {label: "Apply (Recommended)", description: "Overwrite ~/.claude/CLAUDE.md with the proposed merge and remove the sidecar."},
    {label: "Skip", description: "Leave the original in place; keep the .proposed file for manual review."},
    {label: "Edit", description: "Leave the .proposed file for you to edit; re-run after editing to apply."}
  ]
})
```

On Apply, write `~/.claude/CLAUDE.md` with the merged content and delete the sidecar. On Skip, leave both files in place. On Edit, leave the sidecar and print a one-line note that the user can edit it and copy it over.

## Phase 4: settings.json (skip if `--skip-settings`)

Skip this entire phase when `SKIP_SETTINGS = true`.

The values in this phase are authored from the ac install spec, not read out of any existing profile. Every write is ADD-only: never strip, downgrade, or overwrite a key the user already set. "Set only when absent" means if the key exists at all, even with a different value, leave it untouched. For arrays, append the missing entries and skip any already present.

### 4a. Read and back up

Read `~/.claude/settings.json`. When `SETTINGS_EXISTS` is false, start from `{}`. Before any write, back the file up with `cp -n ~/.claude/settings.json ~/.claude/settings.json.bak-ac-install` (only when the file exists). The `-n` flag is deliberate: a re-run must not clobber the pristine first backup. Under `--dry-run`, skip the backup; you write nothing.

### 4b. Group A: safe-silent tuning (set only when absent)

These are non-secret performance and workflow defaults. Set each only when its key is absent; no prompt, no override.

Top-level keys:

1. `disableWorkflows = true` (setting key, not an env duplicate; do not also write `CLAUDE_CODE_DISABLE_WORKFLOWS`).
2. `disableArtifact = true`.
3. `effortLevel = "xhigh"`.
4. `alwaysThinkingEnabled = true`.
5. `statusLine = {"type": "command", "command": "bunx -y ccstatusline@latest", "padding": 0}` (assumes `bun`/`npx` on PATH; note this in the Phase 5 summary).

Under `env` (string values), each set only when absent:

6. `MAX_MCP_OUTPUT_TOKENS = "50000"`.
7. `MCP_TIMEOUT = "30000"`.
8. `MCP_TOOL_TIMEOUT = "60000"`.
9. `API_TIMEOUT_MS = "30000"`.
10. `BASH_DEFAULT_TIMEOUT_MS = "180000"`.
11. `BASH_MAX_TIMEOUT_MS = "900000"`.
12. `BASH_MAX_OUTPUT_LENGTH = "50000"`.
13. `CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS = "30000"`.
14. `CLAUDE_CODE_MAX_RETRIES = "15"` (clamped at 15; do not raise it).

### 4c. Group C: core ac parity (always merged)

The ac wiring is not security-sensitive, so it merges without a prompt. All ADD-only:

1. `enabledPlugins["ac@ac"] = true`.
2. Add `mcp__plugin_ac_ac__*`, `WebSearch`, and `WebFetch` to `permissions.allow` (create the array if missing, skip any entry already present). Never widen to `mcp__*`.
3. Add to `permissions.deny`: `EnterPlanMode`, `ExitPlanMode`, `Agent(Plan)`, `Agent(Explore)`. These are the load-bearing plan-mode block.
4. Idempotent migration strip for prior install versions. This removes artifacts a previous run of THIS command wrote. The hook entries below carry an install-specific fingerprint (matcher plus command), so their removal never touches user config; the deny-string entry cannot be fingerprinted, so it is stripped on the assumption a prior install wrote it (see the caveat):
   - Remove any `WebSearch` or `WebFetch` entry from `permissions.deny`. Caveat: these plain strings are indistinguishable from a user-authored deny, so a user who intentionally denies `WebSearch`/`WebFetch` will see it removed on re-run and must re-add it. Surface this removal in the gate diff so the user can catch it.
   - Remove any `hooks.PreToolUse` entry whose matcher equals `WebSearch|WebFetch`.
   - Remove the `hooks.PreToolUse` entry a prior install wrote for plan mode: matcher `EnterPlanMode` whose command echoes the `use /ac:plan` steer and exits 2. The plan-mode block now ships in the plugin's `hooks.json`, so this command writes NO settings hook.

This command writes no `hooks.*` entry of its own. The plan-mode PreToolUse block is delivered by the plugin (`plugins/ac/hooks/hooks.json`, matcher `EnterPlanMode|ExitPlanMode`); `permissions.deny` above is the load-bearing guard either way.

When `MCP_REACHABLE` is false, the CLAUDE.md fallback steering section (Phase 3) simply omits the mention of the ac web-fetch and web-search tools; the built-in WebSearch and WebFetch remain primary either way.

The allow array entries (bundled MCP surface plus the built-in web tools):

```json
{
  "permissions": {
    "allow": [
      "mcp__plugin_ac_ac__*",
      "WebSearch",
      "WebFetch"
    ]
  }
}
```

The deny array (plan-mode entries only):

```json
{
  "permissions": {
    "deny": [
      "EnterPlanMode",
      "ExitPlanMode",
      "Agent(Plan)",
      "Agent(Explore)"
    ]
  }
}
```

### 4d. Group B: security-sensitive keys (explicit opt-in, default off)

These change permission or telemetry behavior, so they are never silent. Present one `AskUserQuestion` multiSelect with every option unchecked by default. Write only the keys the operator checks; each is ADD-only (set only when absent, and do not extend the 4c migration strip to these keys). Under `--dry-run`, skip this prompt and note that no security-sensitive keys would be set.

```
AskUserQuestion({
  header: "Opt-in?",
  question: "These change permission or telemetry behavior and are off by default. Select any you want applied. Each is added only when the key is absent; nothing you already set is changed.",
  multiSelect: true,
  options: [
    {label: "Auto-accept edits", description: "permissions.defaultMode=acceptEdits. Edits apply without a per-edit prompt."},
    {label: "Skip dangerous prompt", description: "permissions.skipDangerousModePermissionPrompt=true. No confirmation when entering bypass mode."},
    {label: "All project MCP", description: "enableAllProjectMcpServers=true. Every project-scoped MCP server loads without asking."},
    {label: "Skip fetch preflight", description: "skipWebFetchPreflight=true. Drops the per-fetch domain-safety blocklist preflight (a hang source) at the cost of that safety check."},
    {label: "AFK timeout 10m", description: "env.CLAUDE_AFK_TIMEOUT_MS=600000."},
    {label: "Disable agent teams", description: "env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=0."},
    {label: "OTEL telemetry", description: "env.CLAUDE_CODE_ENABLE_TELEMETRY=1 plus OTEL_METRICS_EXPORTER=otlp, OTEL_EXPORTER_OTLP_PROTOCOL=grpc, OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4317. Exports metrics to a local collector."}
  ]
})
```

Map each checked option to its keys, writing each only when absent. Unchecked options write nothing:

- Auto-accept edits: `permissions.defaultMode = "acceptEdits"`.
- Skip dangerous prompt: `permissions.skipDangerousModePermissionPrompt = true`.
- All project MCP: `enableAllProjectMcpServers = true`.
- Skip fetch preflight: `skipWebFetchPreflight = true`.
- AFK timeout 10m: `env.CLAUDE_AFK_TIMEOUT_MS = "600000"`.
- Disable agent teams: `env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = "0"`.
- OTEL telemetry: `env.CLAUDE_CODE_ENABLE_TELEMETRY = "1"`, `env.OTEL_METRICS_EXPORTER = "otlp"`, `env.OTEL_EXPORTER_OTLP_PROTOCOL = "grpc"`, `env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4317"`.

### 4e. MCP token (interactive, masked)

The ac MCP token is a secret; it is never bundled and never rendered. Two keys:

1. `env.KODIZM_MCP_URL = "https://mcp.kodizm.com"` (set only when absent; this is the public default, safe to write).
2. Prompt the operator to paste their `kdz-` MCP token, or leave it blank to skip. Under `--dry-run`, skip this prompt. Write `env.KODIZM_MCP_TOKEN` ONLY when the operator supplies a non-empty value; a blank or skipped answer leaves the key untouched. Never echo the pasted value, and never write it to a log, the diff, or the summary.

### 4f. Show the diff and write (mask secrets)

Render the merged result as a diff against the original: which keys, deny entries, and allow entries were newly added versus already present, grouped as Group A / Group C / Group B (opt-in) / token. Mask every secret-pattern value: render `env.KODIZM_MCP_TOKEN` as `<set>` when newly written, `<unchanged>` when it was already present and left as-is, and omit it entirely when skipped. Never print the token value or any `kdz-` string in the diff. Under `--dry-run`, stop here; write nothing. Otherwise write the merged object back to `~/.claude/settings.json` and report the newly-added versus already-present breakdown, with the token still masked.

## Phase 5: Summary

Report the outcome in one block:

```
## /ac:install Complete

my-coding:    <created | recreated | skipped (exists) | skipped (--skip-skills) | dry-run>
my-language:  <created | recreated | skipped (exists) | skipped (--skip-skills) | dry-run>
my-workflow:  <created | recreated | skipped (exists) | skipped (--skip-skills) | dry-run>
CLAUDE.md:    <written | merged + applied | proposed (awaiting review) | skipped (--skip-claude-md) | dry-run>
settings:     <merged | skipped (--skip-settings) | dry-run>
Group A:      <N tuning keys set | all already present>
Group B:      <opt-ins applied: comma-list | none selected | skipped (dry-run)>
MCP token:    <set | unchanged | skipped>
MCP URL:      <set to https://mcp.kodizm.com | unchanged>
Backup:       <~/.claude/settings.json.bak-ac-install | kept (pre-existing) | none (settings absent or dry-run)>
MCP probe:    <reachable | unreachable (CLAUDE.md fallback steering omitted)>
```

Never print the token value in this block: `MCP token` shows only `<set>`, `<unchanged>`, or `<skipped>`.

Notes to print when relevant:

- `my-workflow`: the workflow discipline (delegation, code-lookup, investigation, verification) now lives in this skill; the global CLAUDE.md carries only a lean pointer to it.
- If a Group B opt-in was applied, restate its tradeoff. `skipWebFetchPreflight` skips the Anthropic domain-safety blocklist preflight (a hang source; Claude Code has no tool-scoped web timeout, tracked as anthropics/claude-code#34565). `permissions.skipDangerousModePermissionPrompt` and `acceptEdits` reduce confirmation friction.
- `statusLine` uses `bunx -y ccstatusline@latest`; it needs `bun`/`npx` on PATH to render.
- Plan-mode block: the plugin ships the PreToolUse hook and `permissions.deny` covers `EnterPlanMode` and `ExitPlanMode`. Verify it live: try entering native plan mode and confirm it is blocked with the `/ac:plan` steer.

Next steps to print:

- Restart Claude Code for the settings.json changes to take effect.
- Run `/mcp` to verify the ac MCP tools are reachable.
- The `my-coding`, `my-language`, and `my-workflow` skills load automatically in every session; no restart needed for those.

## References

Anchors this command body relies on. Cross-check before editing.

- `plugins/ac/commands/init-project.md:19-23` (CAN / CANNOT / MUST orchestrator block shape).
- `plugins/ac/commands/init-project.md:137` (bare `Skill({skill: "ac:..."})` invocation).
- `plugins/ac/commands/init-project.md:167-173` (`.proposed` sidecar plus AskUserQuestion write-gate).
- `plugins/ac/commands/commit.md:14-19` (Phase 0 `$ARGUMENTS` flag-parsing shape).
- `ac:skill-creator` (delegated my-coding and my-language authoring at user scope).
- `${CLAUDE_PLUGIN_ROOT}/references/coding-style-template.md` (Phase 1 my-coding seed template).
- `${CLAUDE_PLUGIN_ROOT}/references/language-style-template.md` (Phase 2 my-language seed template).
- `${CLAUDE_PLUGIN_ROOT}/references/workflow-template.md` (Phase 2.5 my-workflow single-file seed template).
- `${CLAUDE_PLUGIN_ROOT}/references/global-claude-md-section-template.md` (Phase 3 lean pointer, wrapped in the `<!-- ac:delegation:start -->` / `<!-- ac:delegation:end -->` fence markers used for the deterministic merge).
- `plugins/ac/hooks/hooks.json` (ships the plan-mode PreToolUse block, matcher `EnterPlanMode|ExitPlanMode`; Phase 4 writes no settings hook).
