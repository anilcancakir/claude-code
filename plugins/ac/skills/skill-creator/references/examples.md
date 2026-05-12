# Worked Examples

Six complete skills covering the patterns you will most often need: a reference skill, a manual-action skill, a forked research skill, a scripted-workflow skill, a path-conditional skill, and a plugin-distributed skill. Read this when you want a starting point to copy from.

Each example is annotated to call out the choices: why this scope, why this invocation control, why this body shape.

## Contents

- Example 1: Reference skill (always-on knowledge)
- Example 2: Manual-action skill (irreversible side effect)
- Example 3: Forked research skill
- Example 4: Scripted-workflow skill (low freedom, deterministic)
- Example 5: Path-conditional skill with subagent integration
- Example 6: Plugin-distributed skill (`${CLAUDE_SKILL_DIR}` discipline)

---

## Example 1: Reference skill (always-on knowledge)

**When to use this shape.** Conventions, style guides, domain facts the model should apply alongside conversation. No specific action; the body sets a lens.

**File**: `.claude/skills/laravel-conventions/SKILL.md`

```markdown
---
name: laravel-conventions
description: Applies the Laravel conventions used in this codebase. Triggers on PHP work in `app/`, `tests/`, or `database/migrations/`, on words like "controller", "service", "form request", "migration", and on requests to add or refactor backend features. Use even when the user does not say "Laravel" but is asking about server-side PHP.
paths:
  - "app/**/*.php"
  - "tests/**/*.php"
  - "database/migrations/*.php"
---

# Laravel Conventions

Apply these to every PHP file you create or modify in this repo.

## Naming
- PascalCase for classes, camelCase for methods, snake_case for table columns.
- Service classes end with `Service`. Form Requests end with `Request`. Resources end with `Resource`.

## Architecture
- Thin controllers, fat services. Constructor injection only, no facades inside classes.
- Enums for all status/type/category values. Place under `App\Enums`.
- Form Requests handle validation; controllers never validate inline.

## Tests
- Pest for new tests. PHPUnit-style only when extending existing test files.
- Every Service public method gets a feature test that hits the route, not the method directly.

## Migrations
- One migration = one schema change. Never bundle.
- Use `Schema::table` for alters; never raw SQL unless the change is impossible in the builder.
```

**Annotations.**

- *Project scope* (`.claude/skills/`), these conventions are repo-specific.
- *No invocation control*, both user and model can pull it in.
- *`paths:`*, auto-loads only when the model touches PHP files in the relevant directories. Avoids bloating the description listing for non-PHP sessions.
- *Body is reference content*, high freedom, no checklist, no script. The model applies the rules contextually.
- *Body is short*, Claude already knows Laravel; the body only adds the choices specific to this codebase.

---

## Example 2: Manual-action skill (irreversible side effect)

**When to use this shape.** Workflows the user must trigger explicitly because the work has consequences (deploy, commit, send-message, cherry-pick).

**File**: `.claude/skills/cherry-pick-to-release/SKILL.md`

```markdown
---
name: cherry-pick-to-release
description: Cherry-picks a merged PR to the current release branch and opens a backport PR. Use when the user says "cherry-pick to release", "CP this PR", "backport this", "hotfix this PR", or asks to ship a fix to the release branch.
disable-model-invocation: true
argument-hint: "[pr-number]"
arguments: [pr_number]
allowed-tools: Bash(gh pr view:*) Bash(gh pr create:*) Bash(git fetch:*) Bash(git checkout:*) Bash(git pull:*) Bash(git cherry-pick:*) Bash(git push:*)
---

# Cherry-pick PR $pr_number to release

## Goal
PR $pr_number's commits land on the current release branch with CI green, and a backport PR is open.

## Workflow

```
- [ ] Identify merge commit
- [ ] Fetch latest release
- [ ] Create backport branch
- [ ] Cherry-pick
- [ ] Push and open PR
```

### 1. Identify the merge commit
`gh pr view $pr_number --json mergeCommit -q .mergeCommit.oid`

**Success criterion**: a 40-character SHA on stdout. If empty, the PR is not merged, stop and tell the user.

### 2. Fetch the latest release branch
```
git fetch origin release
git checkout release
git pull --ff-only
```
**Success criterion**: HEAD is on `origin/release`, working tree clean.

### 3. Create the backport branch
`git checkout -b cp/$pr_number`

### 4. Cherry-pick
`git cherry-pick <merge-sha>`

If conflicts: stop and ask the user how to resolve. Do not improvise resolutions on a release branch.
**Success criterion**: clean cherry-pick, or user-confirmed resolution.

### 5. Push and open PR
```
git push -u origin cp/$pr_number
gh pr create --base release --title "Cherry-pick #$pr_number" --body "Backports #$pr_number to release."
```
**Success criterion**: PR URL printed.
```

**Annotations.**

- *`disable-model-invocation: true`*, the user must trigger; the model deciding to cherry-pick is a bad idea.
- *`arguments`*, single positional, named for body readability (`$pr_number` reads better than `$0`).
- *`allowed-tools`*, narrow patterns matching exactly the calls the body issues. Each `git` subcommand listed individually.
- *Workflow checklist*, gives the model a copy-paste progress tracker.
- *Success criteria on every step*, explicit stopping conditions so the model knows when to move on.
- *Conflict handling = stop and ask*, the body explicitly forbids improvisation on the release branch. This is low-freedom by design.
- *No `context: fork`*, the user might want to steer mid-process if the cherry-pick gets weird.

---

## Example 3: Forked research skill

**When to use this shape.** Self-contained investigations isolated from the main conversation context. The body is the prompt for a subagent.

**File**: `~/.claude/skills/auditing-feature/SKILL.md`

```markdown
---
name: auditing-feature
description: Audits how a specific feature is implemented across the codebase, returning a map of files, functions, data flow, and surfaces touched. Use when the user asks "how does X work end-to-end", "trace this feature", "where is X handled", "audit the X flow", or wants a self-contained understanding of a feature without polluting the main conversation.
context: fork
agent: Explore
argument-hint: "[feature description or starting point]"
allowed-tools: Read Grep Glob
---

# Audit: $ARGUMENTS

## Goal
Produce a complete map of how this feature works end-to-end.

## What to find

1. **Entry points**, every place user input or external triggers reach this feature. Routes, CLI commands, event handlers, UI components.
2. **Core logic**, the functions, services, classes where the actual work happens. Quote the key signatures.
3. **Data flow**, what data flows in, where it is transformed, where it lands (DB, response, file, queue). Trace at least one path end-to-end.
4. **Persistence**, what tables, files, or external services this feature reads from and writes to. Cite migration files for tables.
5. **Surfaces affected**, what other features or modules could break if this one changes. Identify shared dependencies.

## What to return

A markdown report with these sections, each with `file_path:line_number` citations:

```
## Feature: <name>

### Entry points
- `app/Http/Controllers/X.php:42`, POST /api/x route handler
- ...

### Core logic
[function signatures, what each does]

### Data flow
[step-by-step trace of one canonical path]

### Persistence
[tables, columns, files touched]

### Surfaces affected
[shared dependencies, sibling features]

### Risks for change
[1-3 things that would break if this feature changes]
```

Under 800 words. Lead with the feature's purpose in one sentence.
```

**Annotations.**

- *User scope* (`~/.claude/skills/`), this is a generic audit skill, useful across all projects.
- *`context: fork` + `agent: Explore`*, runs in an isolated read-only subagent. The audit does not pollute the main conversation, and Explore's tool set is exactly right for read-only investigation.
- *Pure body, no shell injection*, the subagent does the work; nothing is preprocessed.
- *Output shape locked*, section headers are dictated, with citation format and length cap. Forked skills must commit; the user has no way to steer mid-run.
- *Body is the task*, every line tells the subagent what to find or what to return. No standing rules, no general principles.

---

## Example 4: Scripted-workflow skill (low freedom, deterministic)

**When to use this shape.** Repeatable transformations where the same logic runs every time. Bundle the script; let the model orchestrate around it.

**File**: `.claude/skills/generating-changelog/SKILL.md`

```markdown
---
name: generating-changelog
description: Generates a CHANGELOG.md entry for the upcoming release by parsing merged PRs, grouping by type (feat/fix/chore/refactor/docs), and writing the entry to the changelog. Use when the user asks to "generate the changelog", "update CHANGELOG", "draft release notes", or is preparing a release.
argument-hint: "[next-version-tag]"
arguments: [next_version]
allowed-tools: Bash(gh pr list:*) Bash(python:*) Read Edit
---

# Generate CHANGELOG entry for $next_version

## Goal
A new section in `CHANGELOG.md` for $next_version, with PRs since the last tag grouped by type, in the format the rest of the file uses.

## Workflow

```
- [ ] Run the changelog script
- [ ] Review the generated section
- [ ] Insert into CHANGELOG.md
- [ ] Verify the file
```

### 1. Run the script

`!`python ${CLAUDE_SKILL_DIR}/scripts/build_changelog.py "$next_version"``

The script:
- Finds the most recent semver tag.
- Lists every merged PR since that tag via `gh pr list`.
- Groups by Conventional Commit type derived from the PR title.
- Writes the entry to `${CLAUDE_SKILL_DIR}/scratch/$next_version.md`.

### 2. Review the generated section

Read `${CLAUDE_SKILL_DIR}/scratch/$next_version.md`. Sanity-check:
- Every PR is grouped under the right type. PRs without a `feat/fix/chore/...` prefix in the title go under "Other"; flag those for the user.
- Breaking changes (PR title ends with `!:` or has the `breaking` label) appear at the top.
- Dates and PR numbers are correct.

### 3. Insert into CHANGELOG.md

Add the section immediately after the `# Changelog` header in `CHANGELOG.md`. Preserve the existing format, read the previous section first to match heading depth, blank lines, and link style.

### 4. Verify

Re-read `CHANGELOG.md` and confirm:
- The new section is present, positioned correctly.
- The formatting matches surrounding sections.
- No PRs from before the previous tag leaked in.

## Reference
Script source: `${CLAUDE_SKILL_DIR}/scripts/build_changelog.py`. Read it only if you need to debug a misbehavior or change the grouping logic.
```

**Bundled at**: `.claude/skills/generating-changelog/scripts/build_changelog.py` (~100 lines of Python that does the gh-CLI walk and grouping).

**Annotations.**

- *Bundled script*, the parsing logic is identical every run, so it lives once. The body orchestrates around it.
- *Shell injection*, the script runs as preprocessing via `` !`...` ``; the model receives the output. The model does not call `Bash` itself for the script.
- *`${CLAUDE_SKILL_DIR}` for paths*, the script and the scratch file resolve correctly regardless of cwd.
- *Verification step*, the model reviews the output before inserting, catching any edge cases the script missed.
- *Script as reference, not auto-read*, explicit instruction "read it only if debugging" prevents the model from preloading the script content into context.
- *Medium freedom*, the script is fixed, but the integration into CHANGELOG.md needs the model's judgment about formatting matching.

---

## Example 5: Path-conditional skill with subagent integration

**When to use this shape.** Skills relevant to a subset of files in a polyglot repo, that should not bloat the description listing for unrelated work.

**File**: `.claude/skills/flutter-conventions/SKILL.md`

```markdown
---
name: flutter-conventions
description: Applies Flutter and Dart conventions for this app. Triggers on Dart files under `lib/` and `test/`, on widget/state-management requests, and on questions about routing, theming, or state. Use even when the user does not say "Flutter" if the work is in `lib/` or `test/` and uses Dart.
paths:
  - "lib/**/*.dart"
  - "test/**/*.dart"
  - "pubspec.yaml"
---

# Flutter Conventions

Apply to every Dart file in this app.

## Architecture
- BLoC for state management, `flutter_bloc` package, one BLoC per feature.
- Repository layer between BLoC and data sources. BLoCs never call APIs directly.
- Dependency injection via `get_it` and `injectable`.
- Routing via `go_router`. Routes declared in `lib/router/app_router.dart`.

## File layout
- `lib/features/<feature>/`, feature module
  - `bloc/`, BLoC, events, states
  - `data/`, repository + data sources
  - `domain/`, entities + use cases
  - `presentation/`, pages + widgets

## Code style
- Always-explicit types on public API; `final` everywhere by default.
- `const` constructors when widget tree allows.
- One widget = one file. Private widgets in the same file as their parent are fine.

## Testing
- Widget tests for every screen.
- BLoC tests with `bloc_test` for every state transition.
- Mocks via `mocktail`.

## When you need details
- For full BLoC patterns we use, read `${CLAUDE_SKILL_DIR}/references/bloc-patterns.md`.
- For routing examples (deep links, guards), read `${CLAUDE_SKILL_DIR}/references/routing.md`.
- For theming and the design tokens, read `${CLAUDE_SKILL_DIR}/references/theme.md`.
```

**Bundled at**:
- `.claude/skills/flutter-conventions/references/bloc-patterns.md` (~150 lines, with TOC)
- `.claude/skills/flutter-conventions/references/routing.md`
- `.claude/skills/flutter-conventions/references/theme.md`

**Annotations.**

- *`paths:` for activation*, the skill is invisible until the model touches a Dart file. Cleans up the listing for sessions that are all backend or frontend non-Flutter work.
- *Project scope*, Flutter conventions are repo-specific.
- *Reference content body with explicit drilldown pointers*, body has the high-level rules; details live in `references/` with explicit "read this when X" anchors.
- *No checklists, no fork, no allowed-tools*, this is purely lens-setting.
- *One-level-deep references*, the body links each reference file directly. None of the reference files link to each other.
- *TOC inside `bloc-patterns.md`*, over 100 lines, so the file starts with a contents list to survive partial reads.

---

## Example 6: Plugin-distributed skill (`${CLAUDE_SKILL_DIR}` discipline)

**When to use this shape.** Distributing a skill to others via a plugin marketplace. The install destination is unknown at author time, so bundled files must resolve via `${CLAUDE_SKILL_DIR}`.

**File**: `<plugin>/skills/pdf-extractor/SKILL.md`

```markdown
---
name: pdf-extractor
description: Extracts text and tables from PDF files, fills PDF forms, merges multi-page PDFs. Use when the user mentions PDFs, says "extract from this PDF", "parse the PDF", "fill the form in <file>.pdf", or pastes a path to a `.pdf` file. Use even when the user does not say the word "extract" but the request implies reading PDF content.
allowed-tools: Read Bash(python:*)
---

# PDF Extractor

Extract structured content from PDF files using the bundled `pypdfium2`-backed script.

## Goal
For text extraction, return clean text per page. For tables, return CSV. For forms, return a field-name to value mapping.

## Workflow

### 1. Detect the input
Resolve `$ARGUMENTS` to a PDF path. If the path does not exist or does not end in `.pdf`, stop and tell the user.

### 2. Pick the extraction mode
- Text-only request, run the text mode.
- Table mentioned, run the table mode.
- Form filling or extraction mentioned, run the form mode.

### 3. Run the script

```!
python ${CLAUDE_SKILL_DIR}/scripts/extract.py --mode=$mode "$pdf_path"
```

The script writes output to `${CLAUDE_SKILL_DIR}/scratch/output.<ext>` and prints the path on stdout.

### 4. Read and present
Read the output file. For text, paste the content. For CSV, render the first 20 rows in a markdown table and link the full file. For forms, render the field map.

## When you need details
- For OCR (scanned PDFs), read `${CLAUDE_SKILL_DIR}/references/ocr.md`. The default extractor does not OCR; if the page yields zero text, follow that guide.
- For encrypted PDFs, read `${CLAUDE_SKILL_DIR}/references/encrypted.md`.

## Verify
Confirm the output file exists and is non-empty before presenting. If the script exits non-zero, read its stderr and report the specific error rather than improvising.
```

**Bundled at**:
- `<plugin>/skills/pdf-extractor/scripts/extract.py`
- `<plugin>/skills/pdf-extractor/references/ocr.md`
- `<plugin>/skills/pdf-extractor/references/encrypted.md`

**Annotations.**

- *Plugin scope*, the skill is shipped as part of a plugin and auto-namespaced as `<plugin>:pdf-extractor`.
- *`${CLAUDE_SKILL_DIR}` everywhere*, the script, scratch file, and references resolve correctly regardless of install destination. Repo-relative paths would break.
- *Pushy description*, covers synonyms ("extract", "parse", "fill"), example phrasings, and the "even when the user does not say 'extract'" undertrigger hedge.
- *Narrow `allowed-tools`*, only `Read` (to read the output file) and `Bash(python:*)` (the script). The bash injection runs via the preprocessor, but the body can also call the script via Bash if it needs interactive feedback.
- *Verification step*, the model checks the output before presenting; the script does not have to be perfect.
- *Drilldown for edge cases*, OCR and encryption are non-default flows; the model loads those references only when needed.
- *Plugin invocation form*, the user types `/<plugin>:pdf-extractor /path/to/file.pdf`; the model invokes via the Skill tool with the fully qualified name.
