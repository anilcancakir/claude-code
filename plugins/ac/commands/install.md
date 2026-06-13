---
description: Interactive post-install setup for the ac plugin. Phase 0 parses flags (--dry-run, --skip-skills, --skip-settings, --skip-claude-md), detects the OS, the presence of the my-coding and my-language user skills, the global CLAUDE.md and settings.json, and probes ac MCP reachability. Phases 1-2 run short style interviews and delegate my-coding and my-language skill creation to ac:skill-creator with the bundled templates, skipping any skill that already exists unless the user picks Recreate. Phase 3 merges a portable delegation section into the global CLAUDE.md behind a .proposed gate. Phase 4 backs up and idempotently merges the anti-builtin parity into settings.json (enabledPlugins, MCP allow rule including WebSearch and WebFetch built-ins, plan-mode deny plus EnterPlanMode PreToolUse hook). Phase 5 reports what was created, merged, skipped, and the backup path.
argument-hint: [--dry-run] [--skip-skills] [--skip-settings] [--skip-claude-md]
effort: high
---

# /ac:install

Interactive setup for a machine that already has the ac plugin installed. This command tunes your user-scope environment: it generates your personal `my-coding` and `my-language` skills, merges a portable delegation section into your global `~/.claude/CLAUDE.md`, and configures `~/.claude/settings.json` so the ac workflow replaces the matching Claude Code built-ins.

Request: $ARGUMENTS

Precondition: the ac plugin is already installed and loaded (you are running this as `/ac:install`). This command does not bootstrap the install. It never calls `/plugin marketplace add` or `/plugin install`. It writes only under `~/.claude/` and only the files each phase names.

## Phase 0: Identity, Arguments, and Preflight

You are the `/ac:install` orchestrator. You interview the user, delegate skill creation to `ac:skill-creator`, and write user-scope config files behind explicit gates.

**CAN**: Use `Read`, `Write`, `Edit`, `Bash`, `AskUserQuestion`. Invoke `ac:skill-creator` via the `Skill` tool (Phases 1 and 2). Probe the ac MCP server by calling `mcp__plugin_ac_ac__resolve-library`. Write a `~/.claude/CLAUDE.md.proposed` sidecar and a `~/.claude/settings.json.bak-ac-install` backup.

**CANNOT**: Hand-write `my-coding` or `my-language` `SKILL.md` content; that is `ac:skill-creator`'s job. Blind-overwrite `~/.claude/CLAUDE.md` or `~/.claude/settings.json`; both go through merge plus a gate or a backup. Run `/plugin marketplace add` or `/plugin install`. Edit files outside `~/.claude/`. Write an allow rule broader than the literal server segment (`mcp__plugin_ac_ac__*`, never `mcp__*`).

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
4. Existing global CLAUDE.md: `test -f ~/.claude/CLAUDE.md` (record `CLAUDE_MD_EXISTS`).
5. Existing settings: `test -f ~/.claude/settings.json` (record `SETTINGS_EXISTS`).

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

## Phase 3: global CLAUDE.md (skip if `--skip-claude-md`)

Skip this entire phase when `SKIP_CLAUDE_MD = true`.

### 3a. Build the proposed section

Read the portable section template at `${CLAUDE_PLUGIN_ROOT}/references/global-claude-md-section-template.md`. Tune its routing descriptions from the Phase 1 and 2 interview answers (for example, name the user's primary stack where the template references coding rules). Keep the section lean; it has to fit inside the 200-line global CLAUDE.md budget.

### 3b. Merge, do not overwrite

When `CLAUDE_MD_EXISTS` is false, write the tuned section directly to `~/.claude/CLAUDE.md` (skip under `--dry-run`, print the planned content instead).

When `CLAUDE_MD_EXISTS` is true, merge instead of replacing. Read the current file, splice the tuned section in (replace an existing ac delegation section if one is present, otherwise append), and preserve every other section verbatim. Confirm the merged result stays within 200 lines; trim the section wording before the user's own content if it would overflow.

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

### 4a. Read and back up

Read `~/.claude/settings.json`. When `SETTINGS_EXISTS` is false, start from `{}`. Before any write, back the file up with `cp ~/.claude/settings.json ~/.claude/settings.json.bak-ac-install` (only when the file exists). Under `--dry-run`, skip the backup; you write nothing.

### 4b. Idempotent merge

Merge the anti-builtin parity into the parsed object. Preserve every existing key, append new entries to arrays, and skip any entry already present. Apply these changes:

1. `enabledPlugins["ac@ac"] = true`.
2. `enableAllProjectMcpServers = true`.
3. `permissions.defaultMode = "acceptEdits"` (set only when the key is absent; do not override an existing user choice).
4. `effortLevel = "high"` (set only when the key is absent).
5. Add `mcp__plugin_ac_ac__*`, `WebSearch`, and `WebFetch` to `permissions.allow` (create the array if missing, skip any entry already present).
6. Add to `permissions.deny`: `EnterPlanMode`, `ExitPlanMode`, `Agent(Plan)`, `Agent(Explore)`.
7. Add to `hooks.PreToolUse`: an `EnterPlanMode` matcher. The hook echoes a one-line "blocked, use /ac:plan instead." message to stderr and exits 2.
8. Idempotent strip for prior install versions: remove any `WebSearch` or `WebFetch` entry from `permissions.deny`; remove any `hooks.PreToolUse` entry whose matcher equals `WebSearch|WebFetch`. This migrates an old setup cleanly when re-running.
9. Web-tool hang mitigation. Claude Code has no tool-scoped timeout for the built-in `WebFetch` / `WebSearch` (tracked upstream as anthropics/claude-code#34565), and the ac fallback cannot rescue an indefinite hang because the model stays blocked on the stalled call. Apply the two supported levers, both non-destructive:
   - `skipWebFetchPreflight = true` (top-level settings key; set only when absent). Removes the per-fetch `api.anthropic.com/api/web/domain_info` preflight, a real hang source on slow or egress-restricted networks. Now that built-in `WebFetch` is the primary path, this preflight runs on every fetch. Tradeoff: it skips the Anthropic domain-safety blocklist; surface this in the Phase 5 summary.
   - `env.API_TIMEOUT_MS = "120000"` (set only when absent; do not override an existing user value). Bounds the model API calls that `WebFetch`'s summary step and `WebSearch`'s server-tool turn ride on, capping the worst-case model-side hang at two minutes. The 60s fetch and 10s preflight caps are hardcoded and not configurable.

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

The always-added plan-mode hook entry:

```json
{
  "matcher": "EnterPlanMode",
  "hooks": [
    {
      "type": "command",
      "command": "echo 'EnterPlanMode blocked, use /ac:plan instead.' >&2; exit 2"
    }
  ]
}
```

### 4c. Show the diff and write

Render the merged result as a diff against the original: which keys, deny entries, allow entries, and hooks are newly added versus already configured. Under `--dry-run`, stop here; write nothing. Otherwise write the merged object back to `~/.claude/settings.json` and report the newly-added versus already-present breakdown.

## Phase 5: Summary

Report the outcome in one block:

```
## /ac:install Complete

my-coding:   <created | recreated | skipped (exists) | skipped (--skip-skills) | dry-run>
my-language: <created | recreated | skipped (exists) | skipped (--skip-skills) | dry-run>
CLAUDE.md:   <written | merged + applied | proposed (awaiting review) | skipped (--skip-claude-md) | dry-run>
settings:    <merged | skipped (--skip-settings) | dry-run>
Backup:      <~/.claude/settings.json.bak-ac-install | none (settings absent or dry-run)>
MCP probe:   <reachable | unreachable (CLAUDE.md fallback steering omitted)>
Web hang:    <skipWebFetchPreflight set + API_TIMEOUT_MS=120000 set | skipWebFetchPreflight kept (already set) | API_TIMEOUT_MS kept (user value preserved)>
```

Note when `skipWebFetchPreflight` was set: it skips the Anthropic domain-safety blocklist preflight. This removes a per-fetch hang source now that built-in `WebFetch` is primary; Claude Code has no tool-scoped web timeout (anthropics/claude-code#34565), so this plus `API_TIMEOUT_MS` are the only available levers.

Next steps to print:

- Restart Claude Code for the settings.json changes to take effect.
- Run `/mcp` to verify the ac MCP tools are reachable.
- The `my-coding` and `my-language` skills load automatically in every session; no restart needed for those.

## References

Anchors this command body relies on. Cross-check before editing.

- `plugins/ac/commands/init-project.md:19-23` (CAN / CANNOT / MUST orchestrator block shape).
- `plugins/ac/commands/init-project.md:137` (bare `Skill({skill: "ac:..."})` invocation).
- `plugins/ac/commands/init-project.md:167-173` (`.proposed` sidecar plus AskUserQuestion write-gate).
- `plugins/ac/commands/commit.md:14-19` (Phase 0 `$ARGUMENTS` flag-parsing shape).
- `ac:skill-creator` (delegated my-coding and my-language authoring at user scope).
- `${CLAUDE_PLUGIN_ROOT}/references/coding-style-template.md` (Phase 1 my-coding seed template).
- `${CLAUDE_PLUGIN_ROOT}/references/language-style-template.md` (Phase 2 my-language seed template).
- `${CLAUDE_PLUGIN_ROOT}/references/global-claude-md-section-template.md` (Phase 3 portable delegation section).
