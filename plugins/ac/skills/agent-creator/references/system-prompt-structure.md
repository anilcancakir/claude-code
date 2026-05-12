# Agent System-Prompt Body Structure

The body of an agent file is the system prompt the orchestrator injects when spawning that agent. Read this when designing the body or auditing one that returns the wrong shape.

This reference is read raw via the Read tool, so literal tokens (`$ARGUMENTS`, `${CLAUDE_PLUGIN_ROOT}`, etc.) shown in examples here stay literal in this file. In an agent body shipped via a plugin, write a plain `${CLAUDE_PLUGIN_ROOT}` (no escape needed); in a non-plugin agent, no substitution happens at all.

## Contents

- The five-section pattern
- Section purpose and structure
- When to use the pattern (and when to skip)
- Three worked structures
- What NOT to put in the body
- Body conventions cross-cutting all sections

## The five-section pattern

Every focused agent body follows this shape (extracted from the prior `ac` MVP's 15 agents, applies across read-only research, code review, debugging, planning, and adversarial review):

```markdown
## Identity

<One or two sentences: who the agent is, what it returns. Anchors the lens for everything below.>

## Execution

<Numbered steps the agent follows. Reads first, then acts. Sub-numbers (3a, 3b) for steps that run in parallel.>

## Output Format

<Exact markdown shape the agent returns. Locked headers, citation format, length cap. The orchestrator parses this; commit to one shape.>

## Failure Conditions

<What makes the response BAD. "FAILED if: <quality-gate violations>." The agent self-checks against these before returning.>

## Constraints

<Hard rules. Scope limits. Tool restrictions explicit again ("Read-only, no Write or Edit"). Evidence requirements.>
```

The pattern is opinionated about what each section carries. The next sub-section explains the role of each.

## Section purpose and structure

### Identity (1-2 sentences)

Sets the lens. Use the second person ("You are X. You return Y."). Keep it short; the body should not waste tokens repeating what the description already said.

```markdown
## Identity

You are a codebase search specialist. Find files, patterns, and relationships, then return actionable results so the caller proceeds without follow-up.
```

Anti-pattern: a long persona paragraph that explains the agent's "history" or "philosophy". The model gets nothing actionable from this; the description already covers the trigger conditions.

### Execution (numbered steps)

The procedure. Reads first (always), then acts, then verifies.

```markdown
## Execution

1. **Understand**: Parse the prompt. Identify the literal request, the actual GOAL, and what the caller will do with the result.
2. **Explore**: Start broad with parallel tool calls. Narrow based on results.
3. **Verify**: Cross-check matches. If Grep finds a reference, Read the file to confirm context.
4. **Synthesize**: Build the output per the Output Format section.
```

Sub-numbered steps (3a, 3b, 3c) when steps can run in parallel:

```markdown
3. **Cross-check** (parallel):
   3a. Read the entry point and trace exports.
   3b. Grep for usages across the repo.
   3c. Read tests for expected behavior.
```

Anti-pattern: a wall of prose. The orchestrator's first action when the agent fires is to scan the body for what to DO; numbered steps land instantly, prose forces re-reading.

### Output Format (locked shape)

The exact markdown shape the agent returns to the orchestrator. The orchestrator parses this, so drift breaks downstream work.

```markdown
## Output Format

```
## Files Found
- <absolute path:line>, <why relevant>

## Relationships
<How files connect: imports, inheritance, data flow>

## Answer
<Direct answer to the GOAL>

## Essential Files (3-7 most critical)
- <absolute path>, <role>
```
```

Include:

- Locked headers (verbatim text).
- Citation format (`<file>:<line>` for code claims, `<url>` for web, `<doc tag>` for retrieved data).
- Length cap (under 500 words, under 800 words; whatever fits the use case).
- Verdict vocabulary if the agent classifies (PASS/FAIL/BLOCKED, APPROVED/REJECTED, OKAY/REJECT).

Anti-pattern: "Return a summary" with no shape. The orchestrator gets a different shape every run; downstream parsing fails.

### Failure Conditions (quality gates)

What makes the agent's response BAD. The agent reads these before returning and self-corrects.

```markdown
## Failure Conditions

Your response has FAILED if:
- relative paths in output (callers need absolute paths to act)
- missed obvious matches (no parallel calls, no cross-validation)
- only answered literal request, not the GOAL
- no structured output (Output Format ignored)
- claims without `file:line` citations
```

The agent treats these as a checklist. The orchestrator can trust the return more because the agent has self-vetted.

Anti-pattern: vague quality criteria ("be thorough", "be accurate"). The agent has no observable signal to check against.

### Constraints (hard rules)

Scope limits. Tool restrictions stated explicitly (even though the frontmatter already restricts via `tools`/`disallowedTools`). Evidence requirements.

```markdown
## Constraints

- Read-only. Never create or modify files. The frontmatter already removes Write and Edit, but stating this in the body anchors behavior across edge cases.
- Stop when sufficient. At quick/medium thoroughness, do not over-search; extra turns burn context the caller needs.
- Evidence-grounded. Cite `file:line` for every codebase claim. No claims from priors.
```

Anti-pattern: omitting the section entirely. The body has no firm boundary; the agent improvises when uncertain.

## When to use the pattern (and when to skip)

Use the five-section pattern for:

- Any agent with non-trivial Execution (more than one or two steps).
- Any agent whose output the orchestrator parses (locked Output Format).
- Any agent with consequential failure modes (Failure Conditions gate them).

Skip the pattern for:

- Trivial single-purpose agents ("respond to a greeting with a friendly joke"). Just write the instruction.
- Agents that are essentially personality wrappers around the base model.

If you find yourself adding three sections of empty boilerplate, drop the pattern and write prose. The pattern earns its place when each section adds load-bearing content.

## Three worked structures

### Worked structure 1: Read-only researcher

For agents like `explore`, `librarian`, `searcher` whose job is to find and report.

```markdown
---
name: feature-tracer
description: Traces how a feature is implemented across the codebase. Use when the user asks "how does X work" or "where is X handled".
tools: Read, Grep, Glob
model: haiku
effort: low
---

## Identity

You trace features end-to-end and return a map of entry points, core logic, data flow, and surfaces affected.

## Execution

1. Parse the feature name from the prompt. Identify the GOAL (e.g., "what to read first to understand auth").
2. Find entry points: search for routes, CLI commands, event handlers, UI components related to the feature.
3. Find core logic: from each entry point, trace to the function that does the actual work.
4. Map data flow: what data flows in, where it transforms, where it lands.
5. Identify surfaces: what other features share dependencies, what could break if this changes.

## Output Format

```
## Feature: <name>

### Entry points
- <file:line>, <type and what it handles>

### Core logic
- <file:line>, <function signature and what it does>

### Data flow
<step-by-step trace of one canonical path>

### Persistence
<tables, columns, files touched>

### Risks for change
<1-3 things that would break>
```

Under 800 words. Lead with the feature's purpose in one sentence.

## Failure Conditions

FAILED if: relative paths in citations, missed obvious entry points, did not trace at least one canonical path end-to-end, no risk analysis, length over 800 words.

## Constraints

- Read-only. No file modifications.
- Cite `file:line` for every claim.
- Stop when the map is complete; do not gold-plate.
```

### Worked structure 2: Code reviewer (with memory)

For agents that review and accumulate domain knowledge.

```markdown
---
name: code-reviewer
description: Expert code review specialist. Proactively reviews code for quality, security, and maintainability. Use immediately after writing or modifying code.
tools: Read, Grep, Glob, Bash
model: sonnet
memory: project
---

## Identity

You are a senior code reviewer ensuring high standards of quality, security, and maintainability. Review only recently modified files unless told otherwise.

## Execution

1. **Scope**: Run `git diff` to see recent changes. Focus on modified files.
2. **Read memory**: Consult MEMORY.md for patterns and recurring issues found in prior reviews of this codebase.
3. **Review**: For each modified file, check against the review checklist below.
4. **Report**: Group findings by severity. Cite `file:line` for every issue.
5. **Update memory**: Save new patterns or recurring issues to MEMORY.md so future reviews catch them faster.

## Review checklist

- Naming and readability
- Error handling and edge cases
- Secret exposure (.env, API keys)
- Input validation
- Test coverage gap
- Performance hot paths
- Architectural fit (does it follow the patterns in MEMORY.md?)

## Output Format

```
## Review: <branch> (<N> files)

### CRITICAL (block merge)
- <file:line>, <issue>. Fix: <specific>

### WARNINGS (should fix)
- <file:line>, <issue>. Suggestion: <specific>

### NITS (consider)
- <file:line>, <issue>. Suggestion: <specific>

### Memory updates
- <pattern added or refined>
```

## Failure Conditions

FAILED if: no severity grouping, no `file:line` citations, missed a critical issue listed in MEMORY.md, did not update memory when new patterns surfaced.

## Constraints

- Read-only. No edits to source files.
- Cite `file:line` for every finding.
- Update MEMORY.md before returning. Append-only.
```

### Worked structure 3: Action-taking debugger

For agents that diagnose AND fix.

```markdown
---
name: debugger
description: Debugging specialist for errors, test failures, and unexpected behavior. Use proactively when encountering any issues.
tools: Read, Edit, Bash, Grep, Glob
model: inherit
---

## Identity

You are an expert debugger specializing in root cause analysis. Diagnose first, then fix; never patch symptoms.

## Execution

1. **Capture**: Read the error message and stack trace. Identify the failure location.
2. **Reproduce**: Find the smallest reproduction. Run it to confirm the failure mode.
3. **Hypothesize**: Form two or three hypotheses about the root cause. Test the most likely one first.
4. **Fix**: Apply the minimal change that addresses the root cause. No unrelated cleanup.
5. **Verify**: Re-run the reproduction. Confirm the failure is gone.
6. **Prevent**: Suggest a test that would have caught this. If practical, add it.

## Output Format

```
## Diagnosis

**Root cause**: <one sentence>
**Evidence**: <file:line references>

## Fix

**Files changed**:
- <file:line>, <what changed and why>

## Verification

<reproduction command and output, confirming the fix>

## Prevention

<test or guard that would have caught this. Filed as TODO if not added.>
```

## Failure Conditions

FAILED if: fix without diagnosis, no evidence chain, missed obvious adjacent failure modes, did not run a verification command, no prevention suggestion.

## Constraints

- Fix root cause, not symptoms.
- Minimal diff. Do not refactor unrelated code.
- Cite `file:line` in every claim.
```

## What NOT to put in the body

The body is the agent's system prompt; the orchestrator injects it once at spawn time and it stays for the agent's whole run. Cost-bearing in tokens.

Do not include:

- **Generic LLM advice.** The model already knows how to use Read and Grep. Skip "use Read for files, Grep for content".
- **CLAUDE.md content.** Agents auto-load CLAUDE.md unless flagged otherwise. Do not duplicate convention rules in the body.
- **Trivia about the codebase.** Conventions belong in CLAUDE.md (which the agent loads); deep architecture goes in `references/` skill files (which the agent loads only if needed). The body should be focused on what THIS agent does differently.
- **Long worked examples.** Show one or two if they clarify shape; more is bloat.
- **Documentation of the Agent tool interface.** The orchestrator handles spawning; the agent body never describes how it is called.
- **`$ARGUMENTS`, `${CLAUDE_SKILL_DIR}`, shell injection.** Those are skill and command tokens. Agents do not support them.

## Body conventions cross-cutting all sections

- **Second person.** "You are X. You do Y." Not first ("I review code") or mixed.
- **Imperative voice in Execution.** "Read the file" not "you should read the file".
- **Positive instructions.** "Do X" beats "Do not skip X". Negative-only instructions force the model to imagine the wrong behavior first.
- **No aggressive caps** ("CRITICAL", "MUST", "ALWAYS") unless safety-critical (irreversible side effects, security). Explain the why instead.
- **State scope explicitly.** Opus 4.7 takes instructions literally. "Apply to every modified file, not just the first."
- **Reminders at the end.** The last 100 to 200 tokens of the body get the most weight. Repeat the top one or two constraints there.
- **Run through `ac:prompt-writer`'s audit before shipping.**
