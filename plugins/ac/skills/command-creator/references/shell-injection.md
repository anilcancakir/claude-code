# Shell Injection in Command Bodies

Pre-execution of shell commands whose output is inlined into the prompt before the model reads anything. This is the defining technique that grounds a command in live state. Read this when you are adding context gathering to a command body, or when you are debugging a command that executes the wrong thing.

Source of truth: `utils/promptShellExecution.ts` in the CC source.

## Contents

- TL;DR
- The two forms (inline and fenced)
- Exact regexes
- When injection runs
- The permission model
- The footgun (and how to avoid it)
- Performance gates
- MCP and policy disable
- Eight copy-paste recipes
- Documentation escape

## TL;DR

Two syntaxes for embedding shell output into a command body:

- Inline: `` \!`<cmd>` `` runs `<cmd>` and replaces the entire token with its stdout.
- Fenced: ` \```\! ... \``` ` runs the multi-line block as one shell script and replaces the block with its stdout.

Both run BEFORE the body is injected to the model. The model receives the rendered prompt with shell output already inlined. Permissions still apply.

(This doc file is read raw, so the literal `!` syntax would work here. The `\!` escape shown above is for compatibility with the parent SKILL.md body. When you copy these patterns into your command, use a plain `!`.)

## The two forms (inline and fenced)

### Inline

```markdown
Current git status: !`git status`
PR diff: !`gh pr diff $pr_number`
Recent commits: !`git log --oneline -10`
```

Each `!`<cmd>`` is run as a single shell command. The token is replaced with the command's stdout.

### Fenced

````markdown
## Environment

```!
node --version
npm --version
git status --short
```
````

The block opens with ` ```! ` and closes with ` ``` `. Everything between runs as a single shell script. Replaced with the script's stdout.

Use fenced when you have multiple commands that depend on each other or share environment (working directory, env vars). Use inline for single-command context grabs.

## Exact regexes

From `utils/promptShellExecution.ts`:

```js
const BLOCK_PATTERN = /```!\s*\n?([\s\S]*?)\n?```/g
const INLINE_PATTERN = /(?<=^|\s)!`([^`]+)`/gm
```

Key properties:

- Inline requires whitespace or start-of-line before `!`. The positive lookbehind `(?<=^|\s)` prevents matches inside `!!`, inside `foo`!`bar`, and inside shell vars like `$!`.
- Inline command body is everything between the first `!`` and the next ``: cannot contain backticks.
- Fenced is non-greedy (`[\s\S]*?`), so the first ``` after `!` closes the block.
- Fenced is permissive on whitespace after `!` and around newlines.

## When injection runs

Per `loadSkillsDir.ts:createSkillCommand`:

1. The skill/command body is parsed (frontmatter stripped).
2. `substituteArguments` runs first (replaces `$ARGUMENTS`, `$N`, `$<name>`).
3. `${CLAUDE_SKILL_DIR}` and `${CLAUDE_SESSION_ID}` are substituted.
4. THEN `executeShellCommandsInPrompt` scans for injection patterns and runs each one.
5. The fully rendered text becomes ONE user message in the conversation.

Substitutions run BEFORE injection. This means `!`gh pr diff $pr_number`` works: `$pr_number` is replaced first, then the resolved `gh pr diff 123` is executed.

## The permission model

Each shell command goes through `hasPermissionsToUseTool` before execution (line 98-113):

- `allowed-tools` patterns in the command's frontmatter are auto-applied during injection. A command with `allowed-tools: Bash(git:*)` does not prompt the user when its injection runs `git status`.
- Deny rules still block. A command cannot pre-approve a tool the user has explicitly denied; the deny wins.
- Permission failure throws `MalformedCommandError` and the injection aborts (the entire command's render fails).

This means injection is safe in the sense that it cannot escape the user's existing permission boundary, but the command author should set `allowed-tools` precisely to avoid the user being prompted mid-render.

## The footgun (and how to avoid it)

If you write a literal `!`<cmd>`` or ` ```! ... ``` ` block in your command body for ANY reason (documentation example, comment, embedded snippet), it WILL execute on every invocation. The preprocessor scans the body bytes; markdown fences do not protect (the regex does not know what a code block is).

Real consequences of accidental injection in a body:

- Every invocation runs the command. If you wrote `!`gh pr view`` as an example, `gh pr view` fires every time the command loads.
- If the command lacks permission, every invocation errors out before the model sees anything.
- If the command produces output, the rendered body has unexpected text where the documentation example should have been.

The escape: write `\!` instead of `!` in any DOCUMENTATION context. The byte before `!` becomes `\`, breaking the inline regex's `(?<=^|\s)` lookbehind (since `\` is neither `^` nor whitespace) and the fenced regex's literal `\`\`\`!` start (since `\` interrupts).

CommonMark renders `\!` as `!` outside code spans, so users reading the rendered markdown see `!` while the loader sees `\!` and skips substitution. Inside code spans the backslash stays visible; that is the price of not-executing-by-accident.

For LIVE use (real injection in a real command), write a plain `!`. The backslash escape is only for documentation.

## Performance gates

The inline regex has a positive lookbehind, which makes it ~100x slower than the fenced regex on large bodies (265µs vs 2µs on 17KB skills, per the source comment line 86-90).

To avoid paying this cost on every command load, `executeShellCommandsInPrompt` gates the inline scan on a cheap substring check (line 90):

```js
const inlineMatches = text.includes('!`') ? text.matchAll(INLINE_PATTERN) : []
```

If your body has no `!`` substring anywhere, the inline scan is skipped entirely. 93% of skills (per the source comment) have no inline injection.

The fenced regex is always scanned (no `!`` literal required to start it), so commands using only fenced injection still pay the fenced cost.

## MCP and policy disable

Two situations where injection does not run:

1. **MCP-loaded commands.** Remote and untrusted. The runtime skips `executeShellCommandsInPrompt` entirely (per `SkillTool.ts` and the loader's `loadedFrom !== 'mcp'` guard).
2. **Policy disable.** Setting `"disableSkillShellExecution": true` in settings disables injection for user, project, plugin, and `--add-dir` sources. Each command is replaced with `[shell command execution disabled by policy]`. Bundled and managed skills are unaffected. This is most useful in managed (enterprise) settings where users cannot override.

If you ship a command that relies on injection, document this so users disabling injection know to expect different behavior.

## Eight copy-paste recipes

Use these as starting points. Each is a real pattern from built-in or community commands. (Use plain `!` in your real command; the `\!` here is for compatibility with the parent SKILL.md.)

### 1. Git state grab (for /commit, /review, /pr-create)

```markdown
## Context

- Current git status: \!`git status`
- Current diff (staged and unstaged): \!`git diff HEAD`
- Current branch: \!`git branch --show-current`
- Recent commits: \!`git log --oneline -10`
- Upstream tracking: \!`git rev-parse --abbrev-ref @{upstream} 2>/dev/null || echo NO_UPSTREAM`
```

### 2. PR data fetch (for /pr-summary, /pr-review)

```markdown
## Pull request context

- PR diff: \!`gh pr diff`
- PR description and review threads: \!`gh pr view --comments`
- Changed files: \!`gh pr diff --name-only`
- Failing checks (if any): \!`gh pr checks --required --watch=0 || true`
```

### 3. Environment detection (for /init, /diagnose)

````markdown
## Environment

```\!
node --version 2>&1 || echo "node not installed"
python3 --version 2>&1 || echo "python3 not installed"
which uv 2>&1 || echo "uv not installed"
ls package.json pyproject.toml go.mod Cargo.toml 2>&1 | grep -v "No such"
```
````

### 4. File presence sanity check (for /diagnose, /audit)

```markdown
## Project files detected

- README: \!`test -f README.md && echo present || echo missing`
- Tests: \!`ls tests test __tests__ spec 2>/dev/null | head -3`
- Config files: \!`ls .eslintrc* .prettierrc* tsconfig.json 2>/dev/null`
```

### 5. Test runner discovery (for /test-suggest, /coverage)

```markdown
## Test setup

- Test command from package.json: \!`jq -r '.scripts.test // "none"' package.json 2>/dev/null || echo NO_PACKAGE_JSON`
- pytest config: \!`test -f pyproject.toml && grep -A5 '\[tool.pytest' pyproject.toml | head -10 || echo NO_PYTEST_CONFIG`
- Go test files: \!`find . -name '*_test.go' -not -path './vendor/*' | head -5`
```

### 6. Recent activity (for /briefing, /session-recap)

```markdown
## Last 24 hours

- Commits today: \!`git log --since=midnight --oneline`
- Files edited today: \!`git diff --name-only $(git log --since=midnight --format=%H | tail -1)~1..HEAD 2>/dev/null || echo NONE`
- Open PRs: \!`gh pr list --author @me --json number,title,updatedAt -q '.[] | "\(.number) \(.title)"' 2>/dev/null || echo "gh not available"`
```

### 7. Worktree / branch overview (for monorepo commands)

```markdown
## Worktree map

\!`git worktree list 2>/dev/null || echo "no worktrees"`

## Branch comparison

- Behind main: \!`git rev-list --count HEAD..origin/main 2>/dev/null || echo "no origin/main"`
- Ahead of main: \!`git rev-list --count origin/main..HEAD 2>/dev/null || echo "no origin/main"`
```

### 8. Conditional default (for /deploy, /publish)

```markdown
## Target environment

\!`echo "${TARGET_ENV:-staging}"`

Resolved target: see above. Override with `/deploy production` to deploy to production instead.
```

The shell defaults handle missing args (`${TARGET_ENV:-staging}` falls back to "staging"). Combine with `$ARGUMENTS` parsing for full flexibility.

## Documentation escape

To document the injection syntax inside a command body (rare, but happens in command-creator-style meta-commands), use `\!`:

```markdown
The shell-injection syntax uses backtick-bang-command-backtick. For example, you would write `\!`git status`` in your command body, and the loader replaces it with the output of `git status` at injection time.
```

Bytes are `\!`, which CommonMark renders as `!` outside code spans (rendered output shows the right syntax to the user), but the byte before `!` is `\` not whitespace, so the inline regex `(?<=^|\s)!\`` does not match. Safe from self-execution.

For fenced syntax, the equivalent escape is `\```\!` (backslash before the first backtick of the triple and before the bang). The fenced regex `\`\`\`!` literally matches three backticks then bang; inserting a backslash breaks the literal match.
