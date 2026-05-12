# Argument Design

Designing the argument shape of a slash command. Read this when you are picking between free-form, positional, and named arguments, when you need flag detection inside the body, or when you are debugging substitution that comes out wrong.

Source of truth: `utils/argumentSubstitution.ts` in the CC source.

## Contents

- The three argument shapes
- Substitution token cheat sheet
- The escape convention used in this doc
- Free-form (single sentence)
- Positional (structured)
- Named (named-positional)
- Flag detection inside the body
- Multi-line and quoted arguments
- The append-fallback rule
- Common pitfalls

## The three argument shapes

| Shape | Frontmatter | Body uses | Pick when |
|-------|-------------|-----------|-----------|
| **Free-form** | (none) | `&#36;ARGUMENTS` | The user types a sentence or query: `/deep-research how does auth work?` |
| **Positional** | `argument-hint: "[a] [b] [c]"` | `&#36;0`, `&#36;1`, `&#36;ARGUMENTS[N]` | Structured positional inputs: `/migrate-component SearchBar React Vue` |
| **Named** | `arguments: [pr_number, target_branch]` | `&#36;pr_number`, `&#36;target_branch` | Structured inputs that read better with names: `/cherry-pick 123 release` |

You can mix: name some positions and use `&#36;ARGUMENTS` for the whole string too. The body decides what to read.

## Substitution token cheat sheet

The loader runs `substituteArguments(content, args, true, argumentNames)` from `argumentSubstitution.ts`:

- `&#36;ARGUMENTS` substitutes the raw string the user typed (line 136: `content.replaceAll('$ARGUMENTS', args)`).
- `&#36;ARGUMENTS[N]` substitutes the Nth shell-quoted token. Out-of-range returns empty (line 124-127).
- `&#36;N` (where N is digits) is shorthand for `&#36;ARGUMENTS[N]`. Regex requires `&#36;\d+` not followed by a word character, so `&#36;0word` does not match (line 130).
- `&#36;<name>` substitutes when `name` appears in the `arguments:` frontmatter list. Regex requires `&#36;name` not followed by `[` or word character (line 117-120).
- Names that are pure digits are rejected at frontmatter parse time (`parseArgumentNames` regex `/^\d+$/`).
- Argument parsing uses shell-quote semantics: `/cmd "hello world" foo` produces `&#36;0 = "hello world"`, `&#36;1 = "foo"`. Quotes are stripped, spaces inside quotes are preserved.
- If parsing fails (mismatched quote, etc.), the loader falls back to splitting on whitespace.

## The escape convention used in this doc

This file is a skill reference. Reference files are read via the Read tool, NOT preprocessed. So literal `$ARGUMENTS` and `${CLAUDE_SKILL_DIR}` are SAFE in this file. The HTML entity `&#36;` shown above is for compatibility with the SKILL.md body (which IS preprocessed). When you copy a snippet from this file into a new command's body, drop the `&#36;` entities and write a plain dollar sign.

The remainder of this doc switches to literal `$` for readability, since this file is not preprocessed.

## Free-form (single sentence)

Use when the command takes one free-form input, often a sentence, query, or path.

```yaml
---
description: Researches a topic across the codebase.
argument-hint: "[question or topic]"
---

Research the following topic: $ARGUMENTS

Use Grep, Glob, and Read to find relevant code. Return a markdown report under 500 words with `file:line` citations.
```

User invokes: `/deep-research how does auth work end-to-end?`

After substitution, the body's `$ARGUMENTS` becomes `how does auth work end-to-end?`.

No `arguments:` frontmatter needed. `$ARGUMENTS` always works.

## Positional (structured)

Use when the command takes a fixed-arity tuple of distinct inputs.

```yaml
---
description: Migrates a component from one framework to another.
argument-hint: "[component] [from-framework] [to-framework]"
---

Migrate the $0 component from $1 to $2.

Preserve all existing behavior and tests. Return a diff summary.
```

User invokes: `/migrate-component SearchBar React Vue`.

After substitution:
- `$0` becomes `SearchBar`
- `$1` becomes `React`
- `$2` becomes `Vue`

Use `$ARGUMENTS[0]`, `$ARGUMENTS[1]`, etc. if you prefer the verbose form. Both work identically.

`argument-hint` is documentation only, shown during autocomplete. It does not validate the number of arguments. The body must handle missing inputs (e.g., empty string substitution).

## Named (named-positional)

Use when positional indices read poorly (`$0` in a multi-step body forces the reader to remember what `$0` was).

```yaml
---
description: Cherry-picks a merged PR to the current release branch.
argument-hint: "[pr-number] [target-branch]"
arguments: [pr_number, target_branch]
disable-model-invocation: true
---

Cherry-pick PR $pr_number to $target_branch.

1. Fetch the PR's merge commit.
2. Switch to $target_branch and pull.
3. Cherry-pick the merge commit.
4. Push and open the backport PR.
```

User invokes: `/cherry-pick 123 release`.

After substitution:
- `$pr_number` becomes `123`
- `$target_branch` becomes `release`

Constraints on names:

- Names must not be pure digits (`arguments: [0, 1]` is filtered out).
- Empty strings are filtered out.
- Whitespace separation in the frontmatter string form: `arguments: pr_number target_branch` is equivalent to `arguments: [pr_number, target_branch]`.
- Mapping is by position, not by name match: `arguments: [pr_number, target_branch]` means the first user-typed token binds to `$pr_number`, the second to `$target_branch`. The order in the array is the order of substitution.

You can still use `$ARGUMENTS` (full string) and `$0`/`$1` (positional) alongside named substitutions in the same body. They all draw from the same parsed argument list.

## Flag detection inside the body

There is no built-in flag parser. To detect flags like `--interactive`, `--dry-run`, `--skip-X`, the body has to parse `$ARGUMENTS` itself.

The conventional pattern (from the prior MVP `/ac:commit` command):

```markdown
Request context: $ARGUMENTS

## Default Behavior (Auto Mode)

By default, /ac:commit runs in auto mode, no interactive prompts.

## Interactive Mode (`--interactive`)

Detect `--interactive` flag in $ARGUMENTS. If present:
- Strip `--interactive` from arguments.
- Use AskUserQuestion for all decisions: staging, grouping, commit message review, push confirmation.
- This is the old behavior, full manual control over every step.

## Phase 1: Context Gathering

0. Detect flags in $ARGUMENTS: `--interactive` (enables interactive mode) and `--skip-preflight` (skips Phase 2 preflight checks). Strip detected flags from $ARGUMENTS.
```

The body tells the model to scan `$ARGUMENTS`, branch on detected flags, and strip them before processing remaining args. The model handles the parsing logic in natural language, since `$ARGUMENTS` is just text.

Common flag conventions:

| Flag | Meaning |
|------|---------|
| `--interactive` | Switch from auto mode to user-confirmation-driven mode |
| `--dry-run` | Show what would happen without executing |
| `--skip-X` | Skip a specific phase or check (often used by orchestrators chaining commands) |
| `--force` | Bypass safety gates (requires explicit user invocation) |
| `--<env>` (e.g. `--staging`, `--prod`) | Mode/environment selectors |

Document the flags in a clear "Flags" section near the top of the body so the user (and the model) know what's available.

## Multi-line and quoted arguments

`parseArguments` uses shell-quote, so:

- `/cmd "hello world"` produces `$0 = "hello world"` (one argument, spaces preserved).
- `/cmd 'hello world'` works the same.
- `/cmd hello world` produces `$0 = "hello"`, `$1 = "world"` (two arguments).
- `/cmd "$KEY"` preserves the literal `$KEY` (line 30: shell-quote is given a replacer that returns `$key` for any variable, so vars stay literal rather than expanding).

Newlines in arguments are not common for slash commands (the user types on one line). If you need multi-line input, prompt the user via AskUserQuestion in the body rather than expecting them to embed newlines in the slash invocation.

## The append-fallback rule

From `substituteArguments` line 140-142:

> If no placeholders were found and appendIfNoPlaceholder is true, append. But only if args is non-empty.

If the body contains no `$ARGUMENTS`, no `$N`, no `$<name>` placeholder, but the user typed arguments, the loader appends `\n\nARGUMENTS: <args>` to the end of the body so the model still sees the input.

Treat this as a fallback, not a design. Always reference `$ARGUMENTS` (or an indexed/named variant) explicitly in the body so the model knows where to look. The append-fallback is a safety net for commands that forgot to wire up arguments.

## Common pitfalls

| Pitfall | Symptom | Fix |
|---------|---------|-----|
| Forgetting `arguments:` frontmatter when using `$<name>` | `$pr_number` stays literal in the rendered body | Add `arguments: [pr_number]` |
| Using `arguments: [0, 1]` | Substitution fails, names filtered | Use real names (`arguments: [first, second]`) |
| Documenting `$ARGUMENTS` literal in body | Self-substitutes on every invocation, corrupts the documentation | Escape as `&#36;ARGUMENTS` in documentation contexts |
| Documenting `$0` literal in body | Substitutes to the user's first positional arg, corrupts the documentation | Escape as `&#36;0` |
| Assuming a fixed number of arguments | Out-of-range `$N` returns empty string, body silently misbehaves | Have the body check: if `$0` is empty, AskUserQuestion or report missing input |
| Mixing positional and named for the same position | Both `$0` and `$pr_number` resolve to the same input but readers get confused | Pick one style per command |
| Stripping flags but not removing from `$ARGUMENTS` literal | Body re-substitutes `$ARGUMENTS` later and the flag reappears | Use a working variable (the body's local state) after stripping; do not re-reference `$ARGUMENTS` |
