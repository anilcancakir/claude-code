---
description: <Third-person summary of what this command does and when to invoke it. Front-load the use case. Include trigger phrases. Be specific. Combined description + when_to_use must stay under 1,536 characters.>
when_to_use: <Optional. A separate slot for trigger phrases and example invocations when `description` is busy. Counts toward the same 1,536-char cap.>
---

# <Command Title>

<One-line statement of what this command achieves for the user. The model reads this first; make sure the shape is clear before any phases.>

## Phase 1: Context

**Goal**: Read the state needed to proceed.

**Actions**:

1. Parse `$ARGUMENTS`. Detect any flags. Strip them from the working argument list.
2. Gather live state via shell injection. For example:

```!
git status
git diff --stat
git branch --show-current
```

3. Read relevant project files (config, CLAUDE.md, plan files).

## Phase 2: Plan

**Goal**: Decide what to do based on Phase 1.

**Actions**:

1. <decision logic>
2. <branching: if X, do A; if Y, do B>

## Phase 3: Approve (skip in auto mode)

**Goal**: Confirm with the user before side effects.

If `--interactive` was detected in `$ARGUMENTS` OR if any condition needs user input:

Call AskUserQuestion with concrete options.

Auto mode (default): proceed with sensible defaults; do not prompt.

## Phase 4: Execute

**Goal**: Perform the action.

**Actions**:

1. <specific tool call, file edit, or bash command>
2. <next step>

**Success criterion**: <observable signal the step worked>

## Phase 5: Report

**Goal**: Tell the user what happened.

Output format (one-line summary):

```
<result format>
```

## Error Handling

- **<error case>**: <what to do>
- **<another case>**: <what to do>

<!--
This minimal template covers most commands. Add any of the optional frontmatter fields below ONLY when the command has a specific reason. Cargo-culting hurts more than it helps.

---
description: ...
when_to_use: ...

# Add only when the answer to "does the command need this?" is yes:
# argument-hint: "[arg1] [arg2]"                  # command takes positional input
# arguments: [arg1, arg2]                          # named-positional substitutions in body
# disable-model-invocation: true                   # user-only; irreversible side effects (deploy/commit/send)
# user-invocable: false                            # very rare for commands; pure background context
# allowed-tools: Bash(gh pr view:*) Read Grep      # body chains tool calls you want pre-approved (narrow patterns only)
# context: fork                                    # body is a bounded actionable task, run isolated
# agent: Explore                                   # subagent type when forked (Explore | Plan | general-purpose | <custom>)
# model: claude-opus-4-7                           # override session model for this command's run
# effort: high                                     # override session effort (low | medium | high | xhigh | max)
# shell: bash                                      # default; powershell on Windows when CLAUDE_CODE_USE_POWERSHELL_TOOL=1
# version: "0.1.0"                                 # free-form bookkeeping
---

For commands that need bundled files (references, scripts, assets), use the skill-directory format instead: `<scope>/.claude/skills/<name>/SKILL.md`. Then ${CLAUDE_SKILL_DIR} resolves to the directory and you can reference bundled files via `${CLAUDE_SKILL_DIR}/references/X.md`. See command-creator's command-vs-skill.md for the migration path.
-->
