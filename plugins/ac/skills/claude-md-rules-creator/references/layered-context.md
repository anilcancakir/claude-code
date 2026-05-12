# The Layered Context: Audit Before You Write

A CLAUDE.md or rule file does not land in an empty context. By the time it reaches the model, the conversation already contains 5 to 7 layers of standing instructions. Writing without auditing those layers produces duplicates that waste the attention budget, or rules that conflict with content the model already received from a layer with higher precedence.

This reference teaches the full stack, what each layer already provides "for free", and the audit protocol you walk BEFORE writing any new content.

## Contents

- The full layered context stack
- What is already in Claude Code's built-in system prompt
- Conflict precedence between layers
- The audit protocol: `/memory` first, then write
- Duplicate detection between layers
- Conflict resolution rules
- Cross-layer worked examples
- Quick "do not restate" cheat sheet

## The full layered context stack

In order of arrival in the API call, lower priority first, higher priority later (the model weights later content more on conflict):

1. **Claude Code built-in system prompt.** The harness's defaults: communication style, parallel tool calls, security baseline, software-engineering frame, code-reference convention, action-safety gates, executing-with-care rules, no-comments-by-default in code, no-error-handling-for-impossible-scenarios, no-compatibility-shims, hard prohibition on destructive actions without confirmation. Around 50 distinct instructions on a typical CC build. Always present, always first in system prompt, cached.
2. **Managed CLAUDE.md + managed `.claude/rules/*.md`.** Org-deployed policy. Loaded first into the user-context block. Cannot be excluded by user settings. Use for compliance, security, data-handling rules across the whole org.
3. **User `~/.claude/CLAUDE.md` + `~/.claude/rules/*.md`.** Personal cross-project preferences. Loaded next. Communication style, package-manager preferences, default behaviors. Your dotfiles.
4. **Project `<dir>/CLAUDE.md` + `<dir>/.claude/CLAUDE.md` + unconditional `.claude/rules/*.md`.** Team-shared via git, walked from filesystem root down to cwd. Closer-to-cwd files override on conflict.
5. **Local `<dir>/CLAUDE.local.md`.** Personal overrides for this project specifically. Loaded LAST in the user-context block, so it has the final word on conflicts with the team file.
6. **Auto memory `MEMORY.md`** (first 200 lines / 25KB). Machine-local, written by Claude itself based on your corrections and preferences. Loaded alongside, in a separate slot. Distinct from CLAUDE.md: CLAUDE.md is for the TEAM; auto memory is for YOU on this machine.
7. **Path-scoped `.claude/rules/*.md` with `paths:` frontmatter.** Held back from the initial user-context message. Loads on demand when Claude reads a matching file via the Read tool. Persists in the conversation message stream after first match. Summarized away by compact.

Plus, when Claude reads files in subdirectories: **nested `<subdir>/CLAUDE.md` files** load lazily into the message stream, same way path-scoped rules do.

When you write new content, you are adding to a stack the model already sees. The audit step below makes that explicit.

## What is already in Claude Code's built-in system prompt

These instructions are baked into the harness. The model receives them in every session, regardless of any CLAUDE.md or rule file. Restating them in your CLAUDE.md is pure tax: more bytes, more attention dilution, no behavioral change.

The list below is condensed from the canonical Claude Code system prompt (extracted via tooling like Piebald's `claude-code-system-prompts` repo). Cross-check against your installed CC version with `/doctor` if behavior contradicts what you expect.

**Communication and output:**
- Brief user-facing updates at key moments; one sentence at a time.
- No narration of internal deliberation.
- End-of-turn summary is one or two sentences.
- Match response format to task complexity (simple question gets a direct answer, no headers).
- Default to writing NO comments in code; one short line max when needed.
- Never write multi-paragraph docstrings or multi-line comment blocks.
- Do not create planning, decision, or analysis documents unless explicitly asked.
- Reference code as `file_path:line_number` for clickability.
- Responses are short and concise by default.

**Software engineering frame:**
- Default interpretation of generic instructions is "do this in code".
- Solve bugs, add functionality, refactor, explain code.
- For "change methodName to snake_case", find the method and edit the code (not chat output).

**Code quality defaults:**
- No comments unless the WHY is non-obvious.
- No error handling for scenarios that cannot happen. Trust internal code and framework guarantees. Validate only at system boundaries (user input, external APIs).
- No feature flags or backwards-compatibility shims when you can just change the code.
- No `_oldName` aliases, no `// removed` markers, no re-exports for code that no longer exists.
- Security baseline: no SQL injection, XSS, command injection. Fix insecure code immediately.

**Tool use defaults:**
- Maximize parallel tool calls when there are no dependencies.
- Sequential only when call N depends on N-1.
- No placeholder values; ask for missing required parameters.

**Action safety:**
- Confirm before destructive operations: deleting files/branches, dropping tables, `rm -rf` outside obvious build artifacts.
- Confirm before hard-to-reverse operations: force-push, `git reset --hard`, amending published commits, removing dependencies.
- Confirm before externally visible actions: pushing code, creating/closing PRs, sending messages, posting to third-party services.
- Confirm before uploading to third-party tools (pastebins, diagram renderers, gists).
- Authorization for one action does NOT extend to others.
- Do not use destructive actions as a shortcut around obstacles; investigate root causes.
- Truthful reporting: if tests fail, say so with the output; if a step was skipped, say so.

**The implication for CLAUDE.md authoring:**

If a rule you are about to write matches anything in the list above, it is already in effect. Skip it. Adding "be concise" or "always confirm before pushing" or "never use SQL injection" or "include file:line references" to CLAUDE.md is pure noise: the model already follows those rules.

Reserve CLAUDE.md for what CC's defaults do NOT cover: your project's stack, build commands, conventions that differ from language defaults, off-limits paths, project-specific gotchas, communication preferences that DIFFER from CC defaults (e.g., your preference for an end-of-turn diff summary even though CC defaults to one or two sentences).

## Conflict precedence between layers

When two layers say contradictory things, the runtime does NOT silently pick a winner. The model receives BOTH and has to reconcile. The general pattern (per Anthropic's docs):

- Files closer to cwd are read LATER in the concatenation. The model weights later content more, so closer files USUALLY override farther files.
- Within a directory, intra-directory load order is: `CLAUDE.md` -> `.claude/CLAUDE.md` -> unconditional `.claude/rules/*.md` -> `CLAUDE.local.md`. The last one (Local) overrides team content at the same level.
- Across scopes: managed -> user -> project (root to cwd) -> local. Local has the last word.
- Path-scoped rules and nested subdir CLAUDE.md load INTO MESSAGE HISTORY (not the cached user-context block). They appear after the eager content and get more attention because they are recent in context. But they do NOT survive compact.

What this means in practice:

- A team CLAUDE.md saying "use 4-space indentation" will be overridden by a `CLAUDE.local.md` saying "use 2-space indentation in this project" at the same level.
- A user-global `~/.claude/CLAUDE.md` saying "prefer pnpm" will be overridden by a project `./CLAUDE.md` saying "use npm because our CI uses it".
- A managed CLAUDE.md saying "never log PII" cannot be overridden by anything: it loads first, but the rule is unambiguous and the runtime forbids excluding managed files via `claudeMdExcludes`.
- CC's built-in system prompt is the FIRST layer, and its rules are reinforced by the runtime's own behavior (e.g., the harness gates destructive actions regardless of what CLAUDE.md says). User CLAUDE.md cannot reliably override harness-level rules: the model is conditioned to treat them as authoritative.

When in doubt, run `/memory` and read the full loaded stack. If two files in the list say different things on the same topic, the model is guessing.

## The audit protocol: `/memory` first, then write

Before writing or editing ANY CLAUDE.md or rule file:

1. **Run `/memory` in the target session.** List every file currently loaded. Read each one if needed.
2. **Identify the scope of the new rule.** Is it the team's? Yours alone? Org-wide?
3. **Search the loaded stack for the topic.** Use Grep across the loaded files (and `~/.claude/CLAUDE.md`, the project's `./CLAUDE.md`, any `.claude/rules/*.md`, the global rules, and the CC system prompt sections you can audit).
4. **For each existing mention of the topic, decide one of three actions:**
   - **Skip:** the rule already exists at the right scope. Do not duplicate.
   - **Edit in place:** the rule exists but is wrong, outdated, or could be tightened. Edit the existing file.
   - **Move to the right scope:** the rule exists in the wrong scope (e.g., team rule in user-global, or vice versa). Move it before adding new content.
5. **Check the CC built-in system prompt list above** for overlap. If the rule is already a built-in default, do NOT add it.
6. **Check for conflicts:** does the new rule contradict any existing layer? If yes, either drop one or explicitly note the override in the higher-priority file.
7. **Now write the new content** in the layer that best matches its scope, following the file shape (`CLAUDE.md` / `CLAUDE.local.md` / `.claude/rules/<topic>.md`).
8. **Run `/memory` again after writing** to confirm the new file is picked up and no unexpected duplicates remain.

The audit step takes a minute. It saves hours of "why is Claude ignoring this rule?" debugging later.

## Duplicate detection between layers

The most common duplicates and how to spot them:

| Duplicate pattern | Where to find it |
|-------------------|------------------|
| "Run tests after changes" in user-global AND project CLAUDE.md | Search for "test" across both files. Pick one; usually project (team-shared and per-stack). |
| "Use `pnpm` not `npm`" in user-global AND project CLAUDE.md | Search for the package manager name. If the project's tool agrees with your default, the user-global line is enough. If the project explicitly differs, keep the project line and drop the user-global one for this project. |
| "Be concise" in CC system prompt AND user CLAUDE.md | The CC default already says "your responses should be short and concise". Dropping the user-global line is the simplest fix. |
| Code style rule that the linter already enforces | The linter is deterministic; the rule in CLAUDE.md is advisory. Drop the CLAUDE.md line; let the linter do its job. |
| "Validate inputs at API boundaries" in CC system prompt AND `.claude/rules/api.md` | CC system prompt says "validate only at system boundaries". The rule restates it. Tighten the rule to the project-specific schema/library (`use Zod schemas in src/api/schemas/`), or drop. |
| "Confirm before destructive actions" in CLAUDE.md AND CC system prompt | CC system prompt covers this exhaustively. CLAUDE.md restating it is noise. |

Run `/memory` periodically and Grep for redundancy. Every duplicate you remove returns attention budget to the rules that matter.

## Conflict resolution rules

When two layers say different things on the same topic, the runtime concatenates both. The model reconciles using these heuristics (per the CC behavior reference):

- **Specificity wins.** "Use 2-space indentation in TypeScript" beats "format code properly", regardless of layer order.
- **Recency wins on tie.** Closer-to-cwd files appear later in context; the model weights them more.
- **Managed always-on.** If the managed CLAUDE.md says something, the runtime ensures it is loaded. The model may not contradict it without explicit user instruction.
- **CC system prompt is usually first-mover.** The harness behavior is conditioned on these rules; CLAUDE.md instructions that fight them lose silently.

Rules for AUTHORING with conflicts in mind:

1. **Detect the conflict before writing.** If your new rule contradicts an existing layer, either drop one or call out the override explicitly.
2. **Be explicit about overrides.** If `CLAUDE.local.md` overrides the team CLAUDE.md on indentation, write: "Overrides team rule on indentation: use 2-space for this project, not 4." The model now knows the conflict is intentional.
3. **Prefer scope hierarchy over inline overrides.** A team-wide rule with a project-personal override is cleaner than a single team CLAUDE.md trying to say "use 4-space by default but Alice prefers 2-space".
4. **Do not fight the CC system prompt.** If a rule you want would override built-in behavior (e.g., "always autonomously push without confirmation"), it will not work reliably. Use the SDK's `--system-prompt` or `--append-system-prompt` flags for true system-prompt-level rules, or use a hook for deterministic enforcement.

## Cross-layer worked examples

**Example 1: package manager preference**

- User-global `~/.claude/CLAUDE.md` says: "Prefer `pnpm` over `npm` across all projects."
- Project `./CLAUDE.md` says: "Use `pnpm`. Do not run `npm install`."

Result: redundant. Drop the user-global line (the project enforces it). OR drop the project line (user-global already covers it). Decide by what the team needs: if any teammate's user-global says different, the project line is the consistent enforcer.

**Example 2: communication style**

- CC built-in system prompt says: "Responses are short and concise. End-of-turn summary is one or two sentences."
- User-global `~/.claude/CLAUDE.md` says: "Be terse. No end-of-turn summary; I read the diff."

The user-global TIGHTENS the CC default: still concise, plus drops the end-of-turn summary entirely. Not a duplicate; not a conflict. This is the right shape: layer adds specificity to the default, does not restate it.

**Example 3: error handling**

- CC built-in says: "Do not add error handling for scenarios that cannot happen. Validate only at system boundaries."
- Project `.claude/rules/api.md` says: "Validate API input with Zod schemas in `src/api/schemas/`. Return errors as `{ error: { code, message } }`."

Not a duplicate. CC default is general (validate at boundaries). The project rule names the specific library, schema location, and error shape. This is the right shape: project adds project-specific enforcement to the general default.

**Example 4: confirmation before destructive actions**

- CC built-in covers this in detail (force-push, deletions, `rm -rf`, etc.).
- Project `./CLAUDE.md` says: "Never push directly to `main`. PR-only."

Adjacent, not duplicate. CC's rule is generic confirmation; the project rule is a specific prohibition (no push to a specific branch). This sharpens the default. Right shape.

**Example 5: redundancy worth catching**

- CC built-in says: "Default to writing no comments. Only add one when the WHY is non-obvious."
- Project `./CLAUDE.md` says: "Do not write unnecessary comments. No multi-paragraph docstrings."

Duplicate. The CC default already enforces this. The project line is pure tax. Cut.

## Quick "do not restate" cheat sheet

CC's built-in system prompt already covers ALL of the following. Do NOT add these to your CLAUDE.md or rules:

- "Be concise / brief / short"
- "No comments unless WHY is non-obvious"
- "Reference code as file:line"
- "Maximize parallel tool calls"
- "Validate at system boundaries"
- "Confirm before destructive operations"
- "No SQL injection / XSS / command injection"
- "Never push to main without PR" (variant: CC says confirm before push, project rule can SHARPEN this with branch-specific prohibition)
- "Solve bugs, refactor, explain code" (the software-engineering frame is the default)
- "Truthful reporting of test outcomes"
- "No backwards-compatibility shims"
- "Use the right tool for the job" (CC's tool-usage policy already guides this)

When you find yourself writing a rule that pattern-matches any of these, ask: is the new rule MORE SPECIFIC than the CC default, or just restating it? If more specific (Zod for input validation, specific branch protection, specific test command), keep it. If just restating, cut.

## Auto memory and the writing layer split

Auto memory (`~/.claude/projects/<proj>/memory/MEMORY.md`) is separate from CLAUDE.md in three ways that matter for authoring:

1. **Who writes it.** Auto memory is written by Claude based on your corrections and "remember X" requests. CLAUDE.md is written by you (with this skill).
2. **Audience.** Auto memory is just you on this machine; not committed, not shared. CLAUDE.md is the team via git.
3. **What goes where.** When a user says "remember that we use Redis for caching", the team rule is project CLAUDE.md. When the user says "remember that I prefer Ghostty over iTerm", that is auto memory or `~/.claude/CLAUDE.md` (personal). The skill should ask: is this team-shared or personal?

If a user says "add to CLAUDE.md" vs "remember this", the routing differs:
- "Add to CLAUDE.md" -> project `./CLAUDE.md` (team-shared) or `./CLAUDE.local.md` (personal). Edit explicitly.
- "Remember this" -> auto memory writes it. Claude decides where. May also offer CLAUDE.md as an option.

When generating CLAUDE.md content, consider whether the user actually wants CLAUDE.md (durable, shared) or auto memory (the kind of soft preference Claude learns over time). Ask if ambiguous.

## When in doubt, run `/memory` and Grep

The single most useful debug step is to see what the model actually sees:

1. `/memory` lists every loaded CLAUDE.md, CLAUDE.local.md, and rule file.
2. Open each and Grep for the topic you are about to write about.
3. If anyone else's file already covers it (or CC built-ins do), decide skip / edit / move BEFORE writing.

This single habit prevents most "Claude is not following my rule" bug reports. The model is rarely ignoring the rule; usually two layers are saying different things and the model is reconciling.
