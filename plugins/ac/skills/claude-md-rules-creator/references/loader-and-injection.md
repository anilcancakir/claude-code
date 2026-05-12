# Loader and Injection Mechanics

How CLAUDE.md and `.claude/rules/*.md` reach the model: discovery, concatenation, where each lands in the API call, what survives compaction, and how to debug "Claude is not following my CLAUDE.md".

## Contents

- The four loading sources
- Discovery and walk-up algorithm
- Intra-directory order
- Two injection paths: cached user-context vs attachment stream
- The `MEMORY_INSTRUCTION_PROMPT` prefix
- Per-file format inside the wrapper
- The `<system-reminder>` wrapper
- Path-scoped rules: when they trigger, how they persist
- Token cost of conditional rules
- What survives auto-compaction
- HTML comment stripping
- Settings and env-var kill switches
- The `InstructionsLoaded` hook
- Troubleshooting "my CLAUDE.md is not being followed"

## The four loading sources

1. **Managed memory** (`/etc/claude-code/CLAUDE.md` on Linux, `/Library/Application Support/ClaudeCode/CLAUDE.md` on macOS, `C:\Program Files\ClaudeCode\CLAUDE.md` on Windows). Org-wide; cannot be excluded by user settings.
2. **User memory** (`~/.claude/CLAUDE.md` and `~/.claude/rules/*.md`). Personal global instructions, all projects.
3. **Project memory** (`<dir>/CLAUDE.md`, `<dir>/.claude/CLAUDE.md`, `<dir>/.claude/rules/*.md` walked root-to-cwd). Team-shared.
4. **Local memory** (`<dir>/CLAUDE.local.md` walked root-to-cwd). Personal project, gitignored.

Auto memory's `MEMORY.md` (first 200 lines or 25KB) loads alongside, in a separate slot. Machine-local, written by Claude itself.

## Discovery and walk-up algorithm

For a session at `/repo/packages/web/`, the loader does:

1. Read managed CLAUDE.md plus `<managed>/.claude/rules/*.md` (unconditional).
2. If `userSettings` is enabled: read `~/.claude/CLAUDE.md`, then `~/.claude/rules/*.md` (unconditional, recursive).
3. Build the dir list from cwd up to filesystem root.
4. Reverse it so the walk runs ROOT-down to cwd. Per directory:
 - `<dir>/CLAUDE.md` (Project)
 - `<dir>/.claude/CLAUDE.md` (Project)
 - `<dir>/.claude/rules/**/*.md` (Project unconditional rules, recursive)
 - `<dir>/CLAUDE.local.md` (Local)
5. If `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1`, also include the `--add-dir` directories (otherwise they are scanned for files but not for CLAUDE.md content).
6. AutoMem `MEMORY.md` and TeamMem if enabled.

Files closer to cwd appear LATER in the concatenation. The model weights later content more, so closer files take precedence on conflicts.

Subdirectory CLAUDE.md (below cwd) is NOT loaded at session start. It loads lazily when Claude reads a file in that subdirectory. See "Path-scoped rules" below for the same mechanism applied to conditional rules.

Worktree gotcha: when running inside a nested git worktree (e.g., `.claude/worktrees/<name>/`), Project-type files from directories outside the worktree but inside the main repo are skipped. `CLAUDE.local.md` is not (it is gitignored and only exists in one tree).

## Intra-directory order

Per directory, files load in this fixed order (each appended, no overrides at this layer):

1. `CLAUDE.md`
2. `.claude/CLAUDE.md`
3. `.claude/rules/*.md` (unconditional only - files without `paths:` or with `paths: ['**']` which is treated as unconditional)
4. `CLAUDE.local.md`

So `CLAUDE.local.md` is the last thing read in its directory: personal notes override team rules at the same level on any conflict.

## Two injection paths

This is the most-misunderstood mechanic. There are TWO paths into the model's context, not one:

**Path A: cached user-context message (eager load).**

the loader returns files. the loader formats them, prefixes the `MEMORY_INSTRUCTION_PROMPT`, and stuffs the result into `userContext.claudeMd` the loader wraps `claudeMd` plus `currentDate` in a `<system-reminder>` user-role message with `isMeta: true` and prepends it as `messages[0]`. This message is at a fixed position; it benefits from prompt caching and is cheap on every request after the first.

Files in this path:
- Managed CLAUDE.md and `<managed>/.claude/rules/*.md` (unconditional)
- `~/.claude/CLAUDE.md` and `~/.claude/rules/*.md` (unconditional)
- Project `<dir>/CLAUDE.md`, `<dir>/.claude/CLAUDE.md`, `<dir>/.claude/rules/*.md` WITHOUT `paths:` (unconditional)
- `<dir>/CLAUDE.local.md`
- AutoMem `MEMORY.md` (first 200 lines / 25KB)

**Path B: attachment injection on tool result (lazy load).**

When Claude reads a file via the Read tool, the loader checks two pools:

- The runtime returns `.claude/rules/*.md` files WITH `paths:` whose globs match the file Claude just read.
- the loader returns `<subdir>/CLAUDE.md`, `<subdir>/.claude/CLAUDE.md`, and `<subdir>/CLAUDE.local.md` from directories between cwd and the file.

These get injected as `<system-reminder>`-tagged attachments alongside the tool result. They are NOT in the cached `messages[0]`; they live in the conversation stream.

Files in this path:
- `.claude/rules/*.md` WITH `paths:` matching the file
- Nested subdirectory CLAUDE.md /.claude/CLAUDE.md / CLAUDE.local.md

Once injected, these files persist in the conversation context for the rest of the session (the loader tracks the loader so it does not re-inject the same file twice). They are NOT scoped out when Claude moves to unrelated files. Token cost compounds as more rules accumulate across many tool calls.

Lazy-loaded content gets summarized away by `/compact` and reloads only when Claude next reads a matching file.

## The `MEMORY_INSTRUCTION_PROMPT` prefix

When at least one Path-A file is loaded, the runtime prepends this exact string:

```
Codebase and user instructions are shown below. Be sure to adhere to these instructions. IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.
```

This prefix is part of the `claudeMd` value. The runtime supplies the authority language; your file does not need to repeat `IMPORTANT:` / `you MUST` / `ALWAYS`. Doing so dilutes whatever emphasis you reserve for the 2 or 3 rules that really matter.

## Per-file format inside the wrapper

Each Path-A file is rendered by the loader as:

```
Contents of <absolute-path><description>:

<content>
```

Where `<description>` is one of:

| Type | Description suffix |
|------|--------------------|
| Project | ` (project instructions, checked into the codebase)` |
| Local | ` (user's private project instructions, not checked in)` |
| User | ` (user's private global instructions for all projects)` |
| AutoMem | ` (user's auto-memory, persists across conversations)` |
| Managed | falls through to the User suffix (no explicit branch in source) |
| TeamMem (feature flag) | ` (shared team memory, synced across the organization)` plus a `<team-memory-content>` wrapper |

The model sees the full path and a one-line label of what the file represents. Path names matter: `CLAUDE.md` and `CLAUDE.local.md` produce different labels.

## The `<system-reminder>` wrapper

the loader produces:

```
<system-reminder>
As you answer the user's questions, you can use the following context:
# claudeMd
<MEMORY_INSTRUCTION_PROMPT plus concatenated content>
# currentDate
Today's date is YYYY-MM-DD.

 IMPORTANT: this context may or may not be relevant to your tasks. You should not respond to this context unless it is highly relevant to your task.
</system-reminder>
```

- Role: `user`, but `isMeta: true` (the UI hides it; the model sees it).
- Position: `messages[0]`.
- Trailing line softens authority: "may or may not be relevant". The model still tries to follow, but it is conditioned to use judgment.
- `gitStatus` is NOT here. It rides in `systemContext` and is appended to the system prompt by the loader.

Two practical consequences:

1. **CLAUDE.md is not the system prompt.** It is a meta user message. For truly system-prompt-level rules, the SDK offers `--append-system-prompt`.
2. **The trailing "may or may not be relevant" softens authority.** Combined with the leading `MEMORY_INSTRUCTION_PROMPT`'s `IMPORTANT:. you MUST`, the net is "follow the rules, use judgment". Repeating `MUST` in your own content does not stack. Anthropic's docs say emphasis keywords (`IMPORTANT:`, `YOU MUST`, `NEVER`) DO work when used SPARINGLY (2 to 3 rules max). If every rule is `IMPORTANT`, none of them are.

## Path-scoped rules: when they trigger, how they persist

and community reports (path-scoping triggers off the Read tool, not Write/Edit):

- A `.claude/rules/<topic>.md` with `paths:` frontmatter is HELD BACK from `messages[0]` at session start.
- It activates when Claude uses the Read tool to read a file whose path matches any glob in `paths:`.
- Once activated, it is injected as an attachment and persists in conversation context.
- It does NOT scope out when Claude moves to other files. Once in, it is in.
- Edit / Write / MultiEdit tools do NOT trigger path-scoped rules. Only Read does. If Claude edits a file without reading it first, the rule is silent.

Practical implication: if a rule MUST hold whenever a matching file changes (not just when read), do not rely on `paths:`. Make the rule unconditional, or move the enforcement to a `PostToolUse` hook on the Edit/Write events.

## Token cost of conditional rules

Conditional rules in the attachment stream are not part of the cached `messages[0]`. Every API request after the rule loads has that rule in the message history. The model re-reads it implicitly each turn even though it is the same bytes.

Community-reported math: 11 rule files (~6,200 tokens) loaded across a 30-tool-call session consumed ~93K tokens of context (around 46 percent of 200K). Source: anthropics/claude-code GitHub issues #32057, #44045.

Mitigations:
- Keep rule file count low (3 to 5 typical).
- Keep each rule file short (under 30 lines is a common community target; the loader hard-caps at 40,000 characters per file via `MAX_MEMORY_CHARACTER_COUNT`).
- Use `paths:` aggressively so a rule does not load on sessions that do not touch its files.
- For rules that apply broadly, inline them in CLAUDE.md (cached, one-shot cost) instead of in `.claude/rules/<topic>.md` without `paths:` (which costs the same per-load but obscures the math).

## What survives auto-compaction

the loader clears `getUserContext.cache` and calls `resetGetMemoryFilesCache('compact')`. The next turn re-reads ALL Path-A files from disk and re-injects them.

| File class | Survives `/compact` |
|------------|---------------------|
| Project-root CLAUDE.md | Yes (re-read from disk) |
| Project-root `.claude/CLAUDE.md` | Yes |
| Project-root `.claude/rules/*.md` (unconditional) | Yes |
| `~/.claude/CLAUDE.md` and `~/.claude/rules/*.md` | Yes |
| Managed CLAUDE.md and managed rules | Yes |
| `CLAUDE.local.md` (root) | Yes |
| AutoMem `MEMORY.md` (200 lines / 25KB) | Yes |
| Subdirectory `<subdir>/CLAUDE.md` | No, summarized away. Reloads on next file touch in that subdir |
| `.claude/rules/*.md` WITH `paths:` (conditional) | No, summarized away. Reloads on next matching file read |
| In-conversation instructions typed by the user | No, summarized away. Move to CLAUDE.md to persist |

The subagent path (`agent:*` querySource) explicitly does NOT call this reset, to avoid clobbering main-thread state.

## HTML comment stripping

the loader:

- Block-level `<!-- ... -->` (own line, CommonMark type-2 HTML block) is stripped from the content before injection.
- Comments inside fenced code blocks survive (they are literal code).
- Inline HTML comments inside paragraphs survive.
- Unclosed `<!--` is left intact so a typo does not silently swallow the rest of the file.

Use block comments for maintainer notes that should not consume tokens:

```markdown
<!-- Maintainer note: keep this section under 30 lines, adherence drops past th -->
## Testing

- Run `pnpm test` before committing.
```

When you open the file with the Read tool directly, comments remain visible. Stripping happens only at injection time. `contentDiffersFromDisk` is set so the file-state cache knows the injected content does not byte-match the disk file.

## Settings and env-var kill switches

| Knob | Path / Variable | Effect | Source |
|------|-----------------|--------|--------|
| Disable all CLAUDE.md | `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` env var | Hard off | |
| `--bare` flag | CLI | Skips auto-discovery from cwd walk; honors explicit `--add-dir` | |
| `--add-dir` content loading | `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1` env var | Reads `CLAUDE.md`, `.claude/CLAUDE.md`, `.claude/rules/*.md`, `CLAUDE.local.md` from extra dirs | |
| `claudeMdExcludes` setting | `.claude/settings.local.json` / managed / user | Glob-match exclude for User / Project / Local files (Managed and AutoMem never excluded) | |
| `--setting-sources` (SDK) | CLI | Disables `userSettings` / `projectSettings` / `localSettings` independently; corresponding files do not load | `utils/claudemd.ts:826,887,923` |
| `tengu_paper_halyard` feature flag | server-side | Skips Project and Local files entirely from the listing | |
| `tengu_moth_copse` feature flag | server-side | Skips AutoMem and TeamMem from the inline listing (those route through attachments instead) | |

To see exactly which files load in your current session, run `/memory`. The dialog lists every file plus its scope label.

## The `InstructionsLoaded` hook

For programmatic debugging, register an `InstructionsLoaded` hook in `settings.json`.

```json
{
 "hooks": {
 "InstructionsLoaded": [
 {
 "hooks": [
 { "type": "command", "command": "echo \"$CLAUDE_HOOK_INPUT\" >> ~/instructions-loaded.log" }
 ]
 }
 ]
 }
}
```

Payload fields:

- `file_path`: absolute path of the loaded file
- `memory_type`: `User` / `Project` / `Local` / `Managed`
- `load_reason`: `session_start` / `nested_traversal` / `path_glob_match` / `include` / `compact`
- `globs`: glob patterns (only for `path_glob_match`)
- `trigger_file_path`: the file Claude was reading when the rule loaded (only for `path_glob_match` / `nested_traversal`)
- `parent_file_path`: the file that imported this one (only for `include`)

The hook is fire-and-forget, audit-only. It cannot block loading. AutoMem and TeamMem files do NOT fire this hook (they are a separate memory system).

## Troubleshooting "my CLAUDE.md is not being followed"

Diagnostic checklist by symptom. Apply in order.

1. **Run `/memory`.** Is the file in the list? If not: wrong path, wrong scope, `claudeMdExcludes` filtering it, settings-source disabled (`--setting-sources`), or the runtime hard-off (`CLAUDE_CODE_DISABLE_CLAUDE_MDS`). The fastest check is also the most often skipped.
2. **Is the rule specific?** "Use 2-space indentation in TypeScript" is verifiable; "format code properly" is not. The runtime delivers your content; the model still picks which vague rules to fall back on its priors for.
3. **Is the file too long?** Anthropic's docs target under 200 lines per file. Community benchmarks (HumanLayer, ChrisWiles) put the sweet spot at 40 to 80 lines, with adherence dropping uniformly past th The hard cap is 40,000 chars (`MAX_MEMORY_CHARACTER_COUNT`).
4. **Are there conflicting rules?** Two CLAUDE.md files in the hierarchy disagreeing on the same point, or your CLAUDE.md disagreeing with a rule file. Run `/memory` and scan for overlap.
5. **Did the session just compact?** Subdirectory CLAUDE.md and `paths:`-scoped rules do NOT survive compact. They reload on the next matching file touch. Project-root and unconditional content reload automatically.
6. **Is the rule an aspiration?** "We aim for 90% coverage" is not a rule the model can apply. Reframe to a verifiable rule, or move enforcement to a hook.
7. **Is the rule something a hook would guarantee?** If the rule MUST hold every time, no exceptions, CLAUDE.md is the wrong mechanism. CLAUDE.md is advisory; hooks are deterministic. See [hooks](https://docs.claude.com/en/docs/claude-code/hooks.md).
8. **Path-scoped rule not firing?** Confirm: `paths:` (not `globs:`). Confirm the glob actually matches the file Claude touched. Confirm Claude READ the file (Write/Edit/MultiEdit do not trigger). Confirm the rule is not also loaded unconditionally elsewhere (which would shadow it).
9. **Is your rule conflicting with Claude Code's built-in system prompt?** The system prompt always wins on conflicts (tool usage patterns, safety guidelines). Your override is silently ignored. Work with the grain; do not fight built-ins.
10. **Inherited ancestor rule?** Walking from cwd up to filesystem root picks up CLAUDE.md from every ancestor. In a monorepo, an unrelated team's CLAUDE.md may be loading. Use `claudeMdExcludes`.

For genuine system-prompt-level rules, use `--append-system-prompt` or `--system-prompt` flags. These must be passed every invocation, so they are better suited to scripts and automation than interactive use.

## Quick mechanic summary

- **Load order**: managed → user → project (root to cwd) → local. Later wins on conflict.
- **Two injection paths**: cached `<system-reminder>` user message at `messages[0]` for eager files; attachment stream alongside tool results for lazy / path-scoped files.
- **Prefix**: `MEMORY_INSTRUCTION_PROMPT` already supplies "IMPORTANT:. you MUST".
- **Survives compaction**: eager files (re-read from disk). Not lazy files until re-touched.
- **Stripped before injection**: block-level HTML comments only.
- **Path-scoped rules**: trigger on Read tool, persist in context once loaded, never scope out.
- **Debug**: `/memory` for the loaded list, `InstructionsLoaded` hook for audit log.
- **Hard guarantee**: not from CLAUDE.md. Use hooks or system-prompt flags.
