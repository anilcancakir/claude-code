# Built-in Command Catalog

Case studies from real Claude Code commands. Read this when you want to see how Anthropic-shipped commands solve specific problems, and to extract patterns worth copying.

## Contents

- `/commit` (built-in)
- `/init` (built-in)
- `/sync-claude-code` (real-world project command)
- `/skillify` (bundled skill, captures session as skill)
- `/verify` (bundled skill, runtime observation)
- Patterns worth copying

## `/commit` (built-in)

**Source**: `commands/commit.ts` in the CC source.

**Frontmatter** (built-in, not a markdown file, but the rendered shape):

```yaml
type: prompt
name: commit
description: Create a git commit
allowedTools: [Bash(git add:*), Bash(git status:*), Bash(git commit:*)]
contentLength: 0  # dynamic body
progressMessage: creating commit
source: builtin
```

**Body shape**:

```markdown
## Context

- Current git status: \!`git status`
- Current git diff (staged and unstaged changes): \!`git diff HEAD`
- Current branch: \!`git branch --show-current`
- Recent commits: \!`git log --oneline -10`

## Git Safety Protocol

- NEVER update the git config
- NEVER skip hooks (--no-verify, --no-gpg-sign, etc) unless the user explicitly requests it
- CRITICAL: ALWAYS create NEW commits. NEVER use git commit --amend, unless the user explicitly requests it
- Do not commit files that likely contain secrets (.env, credentials.json, etc). Warn the user if they specifically request to commit those files
- If there are no changes to commit (i.e., no untracked files and no modifications), do not create an empty commit
- Never use git commands with the -i flag (like git rebase -i or git add -i) since they require interactive input which is not supported

## Your task

Based on the above changes, create a single git commit:

1. Analyze all staged changes and draft a commit message:
   - Look at the recent commits above to follow this repository's commit message style
   - Summarize the nature of the changes (new feature, enhancement, bug fix, refactoring, test, docs, etc.)
   - Ensure the message accurately reflects the changes and their purpose
   - Draft a concise (1-2 sentences) commit message that focuses on the "why" rather than the "what"

2. Stage relevant files and create the commit using HEREDOC syntax:
   ```
   git commit -m "$(cat <<'EOF'
   Commit message here.
   EOF
   )"
   ```

You have the capability to call multiple tools in a single response. Stage and create the commit using a single message. Do not use any other tools or do anything else.
```

**Patterns to copy**:

1. **Context block at the top via shell injection.** Four `\!`git ...`` lines gather all the state the model needs. No need for the model to issue these commands itself.
2. **Safety protocol section.** Named rules, explicit "NEVER" prohibitions. This is where the built-in does use aggressive caps for safety-critical rules; the trade-off is judged worth it for a command operating on git state.
3. **HEREDOC pattern for multi-line commit messages.** Avoids the quoting hell of inline `-m "..."`.
4. **Explicit closing instruction.** "Do not use any other tools or do anything else." Constrains scope.

**Anti-patterns the built-in shows by exception**:

- The built-in IS allowed `disable-model-invocation: false` (the model can fire it). For user-shipped commands with side effects, prefer `disable-model-invocation: true`. The built-in trusts the model judgment more than most teams will want.

## `/init` (built-in)

**Source**: `commands/init.ts` (NEW_INIT_PROMPT).

**Frontmatter**: prompt-type, registered as a builtin. The body is a multi-phase interview followed by file generation.

**Body shape (abbreviated)**:

```markdown
Set up a minimal CLAUDE.md (and optionally skills and hooks) for this repo. CLAUDE.md is loaded into every Claude Code session, so it must be concise: only include what Claude would get wrong without it.

## Phase 1: Ask what to set up

Use AskUserQuestion to find out what the user wants:

- "Which CLAUDE.md files should /init set up?"
  Options: "Project CLAUDE.md" | "Personal CLAUDE.local.md" | "Both project + personal"
  Description for project: "Team-shared instructions checked into source control..."

- "Also set up skills and hooks?"
  Options: "Skills + hooks" | "Skills only" | "Hooks only" | "Neither, just CLAUDE.md"

## Phase 2: Explore the codebase

Launch a subagent to survey the codebase: manifest files (package.json, Cargo.toml, ...), README, Makefile, CI config, existing CLAUDE.md, ...

Detect:
- Build, test, lint commands
- Languages, frameworks, package manager
- Code style rules that differ from defaults
- Non-obvious gotchas

## Phase 3: Fill in the gaps

Use AskUserQuestion to gather what code can't answer.

If user chose project CLAUDE.md: ask about codebase practices.
If user chose personal CLAUDE.local.md: ask about user role, preferences, sandbox URLs.

Synthesize a proposal from Phase 2 findings and the gap-fill answers.

## Phase 4: Write CLAUDE.md
... (writes files based on the synthesized plan)

## Phase 5: Write CLAUDE.local.md (if chosen)
... 

## Phase 6: Suggest skills

## Phase 7: Suggest hooks

## Phase 8: Summary
```

**Patterns to copy**:

1. **Multi-round AskUserQuestion.** Each round answers high-level shape (Round 1) or details (Round 2-3). Conditional logic based on prior answers.
2. **Subagent for codebase exploration.** The Phase 2 subagent doesn't gather context inline; it explores and reports back. Frees the main conversation from holding the exploration in context.
3. **Synthesis step.** Phase 3 produces a "proposal" structure that's presented to the user before any files are written.
4. **Phase-by-phase commitment.** Each phase has a clear Goal and a hand-off to the next.
5. **Constraints based on Phase 1 answers.** "Respect Phase 1's skills+hooks choice as a hard filter", the user's earlier choices restrict what later phases can suggest.

**Anti-patterns the built-in avoids**:

- Does NOT ask everything upfront. Each round is bounded; previous answers shape the next.
- Does NOT silently write files. The proposal is presented before action.

## `/sync-claude-code` (project command)

**Source**: `references/claude-code-cli-source-code/.claude/commands/sync-claude-code.md`.

**Frontmatter**:

```yaml
description: "Re-sync this decompiled Claude Code source tree against the latest @anthropic-ai/claude-code npm release..."
argument-hint: "[platform]"
effort: high
```

**Body shape**: 8 phases, ~440 lines, includes per-phase Goal/Actions, AskUserQuestion approval gates, error handling.

**Patterns to copy**:

1. **`argument-hint` with optional default.** "optional platform suffix. Default `darwin-arm64`." Body resolves `${ARGUMENTS:-darwin-arm64}`.
2. **Pre-flight verification.** Phase 1 verifies that required scripts and binaries exist; fails early if anything is missing.
3. **`effort: high` set explicitly.** This is a long, complex command that benefits from heavy reasoning. Most commands inherit; this one overrides.
4. **AskUserQuestion approval BEFORE expensive work.** Phase 1 confirms with the user before downloading ~64 MB.
5. **Heavy use of bash blocks for sequential setup.** `export PROJECT_ROOT="$(pwd)"` set early, used throughout.
6. **Phase-by-phase artifact production.** Each phase writes specific files; later phases consume them.
7. **Final "Notes for the agent executing this command" section.** Tells the model the meta-rules: "You are not running an opaque script. You are doing reverse-engineering work yourself with tools."
8. **Error handling section at the end.** Named failure modes with specific responses.

## `/skillify` (bundled skill)

**Source**: `skills/bundled/skillify.ts` in the CC source.

**Purpose**: Capture the current session's repeatable process as a reusable skill.

**Frontmatter**:

```yaml
name: skillify
description: "Capture this session's repeatable process into a skill..."
allowed-tools: [Read, Write, Edit, Glob, Grep, AskUserQuestion, Bash(mkdir:*)]
user-invocable: true
disable-model-invocation: true
argument-hint: "[description of the process you want to capture]"
```

**Body shape (abbreviated)**:

```markdown
You are capturing this session's repeatable process as a reusable skill.

## Your Session Context

Here is the session memory summary:
<session_memory>
{{sessionMemory}}
</session_memory>

Here are the user's messages during this session:
<user_messages>
{{userMessages}}
</user_messages>

## Your Task

### Step 1: Analyze the Session

Before asking any questions, analyze the session to identify:
- What repeatable process was performed
- What the inputs/parameters were
- The distinct steps (in order)
- The success artifacts/criteria for each step
- Where the user corrected or steered you
- What tools and permissions were needed
- What agents were used

### Step 2: Interview the User

Use AskUserQuestion for ALL questions! Never ask via plain text.

**Round 1: High level confirmation**
- Suggest a name and description for the skill
- Suggest high-level goal(s) and specific success criteria

**Round 2: More details**
- Present the high-level steps as a numbered list
- Suggest arguments based on what you observed
- Ask if the skill should run inline or forked
- Ask where the skill should be saved (this repo vs personal)

**Round 3: Breaking down each step**
For each major step:
- What does this step produce that later steps need?
- What proves this step succeeded?
- Should the user confirm before proceeding?
- Are any steps independent and could run in parallel?

### Step 3: Write the SKILL.md
... (template provided)
```

**Patterns to copy**:

1. **Pre-rendered context placeholders.** `{{sessionMemory}}` and `{{userMessages}}` are filled in by the loader before the body runs. The model gets actual session content inlined.
2. **Multi-round interview with clear round purposes.** Round 1 = shape, Round 2 = details, Round 3 = per-step depth.
3. **"Use AskUserQuestion for ALL questions! Never ask via plain text."** Explicit override of the model's default chat tendency.
4. **Per-step annotations.** "Success criteria", "Execution", "Artifacts", "Human checkpoint", "Rules". Vocabulary for the model to use when writing the new skill.
5. **`disable-model-invocation: true`.** This is a meta-skill the user must explicitly choose to run; the model deciding to skillify on its own is the wrong default.

## `/verify` (bundled skill)

**Source**: System prompt extraction at `references/claude-code-system-prompts/system-prompts/skill-verify-skill.md`.

**Purpose**: Verify that a code change does what it says by running the app and observing behavior.

**Patterns worth copying**:

1. **Opinionated stance.** "Verification is runtime observation. You build the app, run it, drive it to where the changed code executes, and capture what you see. That capture is your evidence. Nothing else is."
2. **"Don't" rules.** "Don't run tests. Don't typecheck. Don't import-and-call." Each rule explains why. The body teaches the model what verification IS by stating what it ISN'T.
3. **Surface table.** "Where a change reaches" mapped to "the surface" and "what you do":
   ```
   | Change reaches | Surface | You |
   | CLI / TUI | terminal | type the command, capture the pane |
   | Server / API | socket | send the request, capture the response |
   ```
4. **Explicit verdict vocabulary.** PASS / FAIL / BLOCKED / SKIP, each with a definition.
5. **"Push on it" section.** "The claim checked out. That's the first half. Confirming is step one, not the job." Encourages probing beyond the happy path.
6. **Report format locked.** Specific markdown structure for the final output. The user knows what to expect.

## Patterns worth copying (cross-cutting)

After reading the catalog, these patterns appear across multiple commands and earn their place in your own commands:

| Pattern | Where seen | Use when |
|---------|------------|----------|
| Context block at top via shell injection | `/commit`, `/pr-summary`, `/sync` | The command needs live state to ground its decisions |
| Multi-round AskUserQuestion with conditional logic | `/init`, `/skillify` | The command needs structured user input that depends on prior answers |
| Subagent for codebase exploration | `/init`, large `/audit` workflows | Exploration would otherwise pollute the main conversation |
| Phase-by-phase Goal + Actions | `/sync`, `/init`, `/ac:commit` | The workflow has more than 2 distinct steps |
| `argument-hint` with default fallback | `/sync` | The command takes optional input with a sensible default |
| `effort: high` only when needed | `/sync` | The command needs deep reasoning, not the session default |
| Approval gate before expensive or irreversible work | `/sync` Phase 1, `/commit` Phase 4 | The action is hard to undo |
| Named error-handling section | All multi-phase commands | Failure modes are predictable and worth documenting |
| Per-step "Success criterion" | `/sync`, `/ac:commit`, `/ac:cherry-pick` | The model needs an observable stop condition |
| Output format locked in the report phase | `/verify` (verdict + steps), `/commit` (hash + branch) | The user needs to find specific info in the output |

When in doubt, look at how `/commit` and `/init` do it. They are the two most-used built-in commands and have the longest production track record.
