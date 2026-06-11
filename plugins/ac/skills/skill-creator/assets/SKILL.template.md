---
description: <Third-person summary of what this skill does and when to use it. Front-load the use case. Include trigger phrases. Be specific. Combined description + when_to_use must stay under 1,536 characters; past that the listing truncates and trailing text becomes invisible to the trigger decision.>
when_to_use: <Optional. A separate slot for trigger phrases and example requests when `description` is busy. Counts toward the same 1,536-char cap.>
---

# <Skill Title>

<One-paragraph Overview: what the skill does, when it fires, what it leaves behind. The model reads this first; make sure the shape is clear before any steps.>

## Goal

<What "done" looks like. Concrete, observable. For reference skills, replace this with "Scope" and describe what the rules apply to.>

## Workflow

<Optional checklist for multi-step skills, copy this when there are 5+ steps:>

```
- [ ] Step 1: <name>
- [ ] Step 2: <name>
- [ ] Step 3: <name>
```

### 1. <Step name>

<What to do. Be specific. Use commands, file paths, exact tool calls when low-freedom; principles and heuristics when high-freedom.>

**Success criterion**: <how you know this step is done, required for every step in a workflow>

### 2. <Step name>

<...>

### 3. <Step name>

<...>

## Rules

<Standing instructions that apply throughout the skill, not turn-scoped. For reference skills, this is the body of the skill.>

- <Rule 1, with explanation of why it matters when not obvious>
- <Rule 2>
- <Rule 3>

## When you need details

<One-level-deep references with explicit drilldown anchors. Use ${CLAUDE_SKILL_DIR} for paths.>

- For <topic>, read `${CLAUDE_SKILL_DIR}/references/<file>.md`.
- For <topic>, read `${CLAUDE_SKILL_DIR}/references/<file>.md`.

## Bundled scripts

<Only if the skill ships executables. Make execution intent clear, "run", not "see".>

- `${CLAUDE_SKILL_DIR}/scripts/<name>.<ext>`, <what it does, args, output location>

<!--
This minimal template covers most skills. Add any of the optional fields below to the frontmatter ONLY when the skill has a specific reason. Cargo-culting every optional field hurts more than it helps.

---
description: ...
when_to_use: ...

# Add only when the answer to "does the skill need this?" is yes:
# name: <override-only-if-different-from-directory-name>     # rarely needed; default = directory name
# argument-hint: "[arg1] [arg2]"                              # skill takes positional input
# arguments: [arg1, arg2]                                     # named-positional substitutions in body
# disable-model-invocation: true                              # irreversible side effects (deploy/commit/send)
# user-invocable: false                                       # background reference; not a meaningful slash-menu command
# allowed-tools: Bash(gh pr view:*) Read Grep                 # body chains tool calls you want pre-approved (narrow patterns only)
# context: fork                                               # body is a bounded actionable task, run isolated
# agent: Explore                                              # subagent type when forked (Explore | Plan | general-purpose | <custom>)
# paths:                                                      # path-conditional activation (polyglot repos)
#   - "lib/**/*.dart"
# model: claude-opus-4-8                                      # override session model for this skill's run
# effort: high                                                # override session effort (low | medium | high | xhigh | max)
# hooks:                                                      # skill-scoped deterministic enforcement
#   PreToolUse: ...
# shell: bash                                                 # default; powershell on Windows when CLAUDE_CODE_USE_POWERSHELL_TOOL=1
# version: "0.1.0"                                            # free-form bookkeeping
---
-->
