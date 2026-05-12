# Command Anti-Patterns

Common command-authoring mistakes specific to commands (above and beyond the general skill anti-patterns in `ac:skill-creator`'s `anti-patterns.md`). Read this when auditing or debugging a misbehaving command.

## Contents

- Argument-design failures
- Shell-injection failures
- Phase-structure failures
- Approval-gate failures
- Output-format failures
- Plugin-packaging failures
- Quick audit checklist

## Argument-design failures

### Forgetting `arguments:` frontmatter when using `$<name>`

**Mistake**: Body uses `$pr_number` but frontmatter has no `arguments: [pr_number]`.

**Symptom**: Body shows literal `$pr_number` after substitution. The model sees `$pr_number` as a placeholder it cannot resolve and either ignores it or asks the user.

**Fix**: Add `arguments: [pr_number]` (or whatever name(s) the body uses).

### Conflicting positional and named for the same slot

**Mistake**: Both `$0` and `$component` substitute to the same first positional input.

**Symptom**: Works, but readers get confused about which to use.

**Fix**: Pick one style per command. Named for multi-arg commands; positional for one or two args.

### `arguments: [0, 1]`

**Mistake**: Trying to name arguments as digits.

**Symptom**: Names filtered out at parse time (per `argumentSubstitution.ts:parseArgumentNames`). The `$0`/`$1` shorthand still works (it doesn't need names), but the named substitutions silently fail.

**Fix**: Use real names: `arguments: [first, second]`.

### Documenting `$ARGUMENTS` literal in the body

**Mistake**: Writing "the `$ARGUMENTS` placeholder substitutes..." in the body for documentation purposes.

**Symptom**: On every invocation, `$ARGUMENTS` gets substituted with the user's actual args, corrupting the documentation. The rendered body reads "the `<user-args>` placeholder substitutes...".

**Fix**: Escape with `&#36;ARGUMENTS` in documentation contexts. Or move the documentation to a reference file (reference files are not preprocessed).

### Stripping flags but re-referencing `$ARGUMENTS`

**Mistake**: Body detects `--interactive` and "strips it from $ARGUMENTS", then later in the body references `$ARGUMENTS` again expecting the flag-stripped version.

**Symptom**: The flag re-appears in the second reference. `$ARGUMENTS` always re-substitutes to the raw user input; the body cannot "modify" it.

**Fix**: After stripping flags conceptually, work with a named working variable in natural language. Tell the model: "use $ARGUMENTS only in Phase 1 for flag detection; treat the remaining tokens as the commit-message hint for the rest of the body."

### Assuming a fixed number of arguments

**Mistake**: Body uses `$0`, `$1`, `$2` without checking whether they were provided.

**Symptom**: Empty substitution. The body reads "Migrate the  component from  to ." (with empty placeholders).

**Fix**: Phase 1 should validate. If `$0` is empty, AskUserQuestion or report missing input. Set `argument-hint` so autocomplete reflects the expected shape.

## Shell-injection failures

### Live injection in a documentation example

**Mistake**: Writing `` !`gh pr view` `` literally in a documentation comment inside the body.

**Symptom**: Every invocation runs `gh pr view`. Failures errorist the entire render. Unexpected output appears where the documentation example should have been.

**Fix**: Escape with `\!` in documentation contexts. CommonMark renders `\!` as `!` outside code spans, so users still see the right syntax. Inside code spans the backslash is visible; that's the price.

### Injection without matching `allowed-tools`

**Mistake**: Body uses `` !`gh pr view` `` but `allowed-tools` does not include `Bash(gh:*)`.

**Symptom**: First invocation prompts the user for permission on `gh pr view`. Annoying once; annoying every time if there are multiple `gh` calls.

**Fix**: List every shell subcommand the body uses in `allowed-tools` with narrow patterns: `Bash(gh pr view:*)`, `Bash(gh pr create:*)`. Or use `Bash(gh:*)` for broader gh access.

### Bare `Bash` in `allowed-tools`

**Mistake**: `allowed-tools: Bash` (whitelists every shell command).

**Symptom**: The command can run `rm -rf` without prompting. Permission system useless during the command's run.

**Fix**: Narrow patterns. List exact subcommands.

### Injection that depends on machine state

**Mistake**: Body has `` !`ls /tmp/build/output` `` and downstream phases assume that path exists.

**Symptom**: Works on the author's machine, fails on others. The injection succeeds with empty output and the model proceeds with bad assumptions.

**Fix**: Pre-check existence in the injection itself: `` !`test -d /tmp/build/output && ls /tmp/build/output || echo NOT_FOUND` ``. Have downstream phases handle the `NOT_FOUND` case explicitly.

### Multiple inline injections that exceed permission patterns

**Mistake**: Body has `` !`git status` ``, `` !`git diff` ``, `` !`git log -10` ``, etc., but `allowed-tools` only lists `Bash(git status:*)`.

**Symptom**: Some injections execute, others prompt mid-render. Mixed behavior.

**Fix**: Either list each subcommand individually or use the broader `Bash(git:*)` pattern. The latter is acceptable for trusted contexts; the former is safer.

### Forgetting that frontmatter is NOT preprocessed

**Mistake**: Author tries to use `` !`<cmd>` `` in the frontmatter `description` to inject dynamic content into the description.

**Symptom**: The literal `` !`<cmd>` `` appears in the description; no injection runs (frontmatter is parsed, not preprocessed).

**Fix**: Descriptions must be static text. Dynamic context belongs in the body.

## Phase-structure failures

### All actions in one phase

**Mistake**: A 30-step body with no phase boundaries.

**Symptom**: Model skips steps, repeats work, loses track. Hard to debug.

**Fix**: Group into 3 to 7 phases by responsibility (Context, Plan, Approve, Execute, Verify, Report).

### No `Success criterion` on consequential phases

**Mistake**: Phase says "Run the migration" with no signal for how to know it worked.

**Symptom**: Model proceeds without verifying. Half-completed migrations slip through.

**Fix**: Every side-effect phase gets a **Success criterion**: an observable signal (file exists, command exits 0, hash printed, etc.).

### Phase ordering depends on side effects from a later phase

**Mistake**: Phase 2 reads a file that Phase 4 writes.

**Symptom**: Phase 2 always fails on first run.

**Fix**: Phases must be sequential; later phases depend on earlier ones, never the reverse.

### Missing `Error Handling` section

**Mistake**: No closing section listing failure modes.

**Symptom**: When something goes wrong, the model improvises. Different runs produce different recovery behavior.

**Fix**: Add an Error Handling section at the bottom. List each predictable failure mode with a specific response.

### Body grows unbounded over time

**Mistake**: Each iteration appends a new "also do this" without revisiting whether old steps still apply.

**Symptom**: Body bloats to 1,000+ lines. After auto-compact, only the first 5,000 tokens survive; the tail is silently dropped.

**Fix**: When you add a step, look for a step it replaces. Move details to `references/` if the body exceeds 500 lines. Keep standing instructions near the top so compact preserves them.

## Approval-gate failures

### Approval gate after the side effect

**Mistake**: "Run the deploy. Then ask the user if it looked right."

**Symptom**: Bad deploys ship; the "approval" is post-hoc.

**Fix**: Place AskUserQuestion BEFORE the irreversible step. If the user says no, the action does not run.

### Auto mode prompts the user

**Mistake**: Body has AskUserQuestion calls with no auto-mode bypass.

**Symptom**: `/cmd` (without `--interactive`) still prompts. Defeats automation, breaks orchestration.

**Fix**: Wrap AskUserQuestion in conditional logic: "If `--interactive` detected OR if the action is irreversible AND there's no `--force` flag, ask. Otherwise proceed."

### Interactive mode bypasses safety

**Mistake**: User selecting "Yes" in AskUserQuestion is treated as carte blanche for everything else.

**Symptom**: "Yes, push to main", "Yes, drop the table", "Yes, force-push" all roll forward without further checks.

**Fix**: Even in interactive mode, irreversible actions go behind a SECOND confirmation OR a separate `--force` flag. The first Yes confirms the plan; the second confirms the irreversible step.

### Approval gate fires for read-only actions

**Mistake**: AskUserQuestion before reading a file.

**Symptom**: Annoying friction with no safety benefit.

**Fix**: Gates are for side effects. Read-only actions should not gate.

## Output-format failures

### No final report

**Mistake**: Command finishes silently. User has to inspect git state to know what happened.

**Symptom**: User confidence drops. "Did it work? What did it do?"

**Fix**: End with a Report phase that commits to a one-line summary format. The user knows what to look for.

### Report format varies between runs

**Mistake**: Sometimes the report says "Committed: <hash>", sometimes "Done. Commit hash is <hash>".

**Symptom**: Hard to grep, hard to parse, hard to chain.

**Fix**: Commit to a single format. Document it in the Report phase.

### Report buries the lede

**Mistake**: Report opens with three paragraphs of context before stating the outcome.

**Symptom**: User scrolls to find the answer.

**Fix**: One-line outcome first. Context below.

## Plugin-packaging failures

### Using `${CLAUDE_PLUGIN_ROOT}` in a NON-plugin skill

**Mistake**: Project skill at `.claude/skills/foo/SKILL.md` body has `Read ${CLAUDE_PLUGIN_ROOT}/templates/foo.md`.

**Symptom**: The literal `${CLAUDE_PLUGIN_ROOT}` appears in the rendered body. The non-plugin loader (`loadSkillsDir.ts`) only substitutes `${CLAUDE_SKILL_DIR}` and `${CLAUDE_SESSION_ID}`, not `${CLAUDE_PLUGIN_ROOT}`.

**Fix**: For non-plugin skills, use `${CLAUDE_SKILL_DIR}/...` for bundled files. `${CLAUDE_PLUGIN_ROOT}` is only meaningful when the command is shipped via a plugin (`utils/plugins/loadPluginCommands.ts:339-343` substitutes it then).

### Documenting `${CLAUDE_PLUGIN_ROOT}` literally in any skill body

**Mistake**: Plugin skill body has documentation text "`${CLAUDE_PLUGIN_ROOT}` is the plugin root", expecting the placeholder name to stay literal.

**Symptom**: For plugin skills, the loader substitutes `${CLAUDE_PLUGIN_ROOT}` on every invocation, so the documentation reads "`/path/to/plugin` is the plugin root", corrupting the explanation.

**Fix**: Escape with `&#36;{CLAUDE_PLUGIN_ROOT}` in documentation contexts, just like `&#36;ARGUMENTS` and `&#36;{CLAUDE_SKILL_DIR}`.

### Flat command with bundled files

**Mistake**: Plugin has `<plugin>/commands/foo.md` and tries to reference `<plugin>/templates/bar.md`.

**Symptom**: The command's body cannot resolve the path. `${CLAUDE_SKILL_DIR}` is not set for flat commands (no baseDir).

**Fix**: Convert to skill-directory format: `<plugin>/skills/foo/SKILL.md` with `<plugin>/skills/foo/templates/bar.md`. Reference via `${CLAUDE_SKILL_DIR}/templates/bar.md`.

### Repo-relative paths in plugin commands

**Mistake**: `Read ../docs/foo.md` in a plugin command body.

**Symptom**: Works in the source repo, breaks the moment a user installs the plugin elsewhere. The path resolves relative to cwd, not the plugin install location.

**Fix**: Always use `${CLAUDE_SKILL_DIR}/...` for plugin-bundled files. Never repo-relative or `..` walks.

### Forgetting plugin namespace in cross-references

**Mistake**: Plugin's command-A references plugin's skill-B via `/skill-b`.

**Symptom**: User has multiple plugins; `/skill-b` is ambiguous or resolves to a different plugin's skill.

**Fix**: Use the fully qualified `/<plugin>:skill-b` form. Always.

## Quick audit checklist

When auditing an existing command:

- [ ] `description` is third-person, specific, names the trigger contexts.
- [ ] Combined `description` + `when_to_use` under 1,536 characters.
- [ ] `argument-hint` matches what the body actually expects.
- [ ] If `arguments:` is set, every `$<name>` in the body matches a declared name.
- [ ] No literal `$ARGUMENTS` or `$N` in documentation contexts (escape as `&#36;`).
- [ ] No literal `!`<cmd>`` or ` ```!...``` ` in documentation contexts (escape as `\!`).
- [ ] `allowed-tools` lists exactly the bash subcommands the body invokes (narrow patterns, not bare `Bash`).
- [ ] `disable-model-invocation: true` set if the command has irreversible side effects.
- [ ] Phase structure: Context, Plan, Approve, Execute, Verify, Report (each phase has Goal + Actions).
- [ ] Side-effect phases have **Success criterion**.
- [ ] Approval gates are BEFORE the irreversible step they guard.
- [ ] Auto mode is silent (no prompts unless `--interactive` flag detected).
- [ ] Interactive mode has a second confirmation for irreversible actions OR a separate `--force` flag.
- [ ] Final Report phase commits to a one-line output format.
- [ ] `Error Handling` section lists named failure modes.
- [ ] For plugin commands needing bundled files: skill-directory format, `${CLAUDE_SKILL_DIR}` paths.
- [ ] For plugin commands cross-referencing siblings: fully qualified `/<plugin>:name` form.
