# Built-in Agent Catalog

Case studies from real Claude Code built-in agents. Read this when designing a custom agent to extract patterns worth copying, or to check whether a built-in already fits your need.

Source of truth: `tools/AgentTool/built-in/*.ts` in the CC source, `tools/AgentTool/builtInAgents.ts` for the registration.

## Contents

- Built-in agent inventory
- Explore (file search, read-only)
- Plan (architect, read-only)
- general-purpose (multi-step, all tools)
- claude-code-guide (docs Q&A, web-fetch)
- statusline-setup
- verification (feature-flagged)
- Patterns worth copying

## Built-in agent inventory

From `tools/AgentTool/builtInAgents.ts:getBuiltInAgents`:

| Agent | Model | Tools | When active |
|-------|-------|-------|-------------|
| `general-purpose` | inherit (via `getDefaultSubagentModel`) | All tools | Always |
| `statusline-setup` | Sonnet | (specific) | Always |
| `claude-code-guide` | Haiku | Glob, Grep, Read, WebFetch, WebSearch | Non-SDK entrypoints |
| `Explore` | Haiku (external) / inherit (ant) | All except Agent, ExitPlanMode, FileEdit, FileWrite, NotebookEdit | Feature `BUILTIN_EXPLORE_PLAN_AGENTS` on |
| `Plan` | inherit | Same as Explore (read-only) | Feature `BUILTIN_EXPLORE_PLAN_AGENTS` on |
| `verification` | (varies) | (varies) | Feature `VERIFICATION_AGENT` on, `tengu_hive_evidence` flag |

Bundled additions for coordinator mode (`CLAUDE_CODE_COORDINATOR_MODE` set with `COORDINATOR_MODE` feature): coordinator agents replace the standard set.

## Explore (file search, read-only)

**Source**: `tools/AgentTool/built-in/exploreAgent.ts`.

**Frontmatter** (effective, from source):

```yaml
name: Explore
description: Fast agent specialized for exploring codebases. Use this when you need to quickly find files by patterns (eg. "src/components/**/*.tsx"), search code for keywords (eg. "API endpoints"), or answer questions about the codebase (eg. "how do API endpoints work?"). When calling this agent, specify the desired thoroughness level: "quick" for basic searches, "medium" for moderate exploration, or "very thorough" for comprehensive analysis across multiple locations and naming conventions.
disallowedTools: Agent, ExitPlanMode, FileEdit, FileWrite, NotebookEdit
model: haiku   # external build; ant uses inherit
omitClaudeMd: true   # internal flag; not user-settable in custom agents
```

**Body patterns to copy**:

1. **Aggressive read-only enforcement.** The body opens with a "CRITICAL: READ-ONLY MODE" section explicitly listing prohibited operations (Write, Edit, mkdir, touch, rm, cp, mv, redirect operators, heredocs, system-state-changing commands). The frontmatter's `disallowedTools` covers the tool-level block; the body anchors behavior at the model level.

2. **Tool-by-tool guidance.** "Use Glob for broad file patterns. Use Grep for regex content search. Use Read when you know the path. Use Bash ONLY for read-only operations (ls, git status, git log, git diff, find, cat, head, tail)."

3. **Thoroughness levels passed in the invocation prompt.** Caller specifies "quick", "medium", or "very thorough"; the agent adapts search depth. This pushes a knob to the orchestrator without adding frontmatter.

4. **Speed-focused output instructions.** "Communicate your final report directly as a regular message. Do NOT attempt to create files." Closes the loop.

5. **Parallel tool use.** "Wherever possible you should try to spawn multiple parallel tool calls for grepping and reading files."

**Lesson**: even when tools are restricted at the frontmatter level, redundant body-level constraints help the model stay in scope under edge cases.

## Plan (architect, read-only)

**Source**: `tools/AgentTool/built-in/planAgent.ts`.

**Frontmatter** (effective):

```yaml
name: Plan
description: Software architect agent for designing implementation plans. Use this when you need to plan the implementation strategy for a task. Returns step-by-step plans, identifies critical files, and considers architectural trade-offs.
disallowedTools: Agent, ExitPlanMode, FileEdit, FileWrite, NotebookEdit
tools: (inherits Explore's tools)
model: inherit
omitClaudeMd: true
```

**Body patterns to copy**:

1. **Five-section process explicit in the body.** Understand Requirements -> Explore Thoroughly -> Design Solution -> Detail the Plan -> Required Output.

2. **Locked Output Format with required section.** "End your response with: ### Critical Files for Implementation. List 3-5 files." The orchestrator parses this section; subsequent worker agents read those files first.

3. **Same read-only enforcement pattern as Explore.** Bashing the rule home for code-modification-adjacent agents.

4. **Designed for nesting prevention.** The body says nothing about spawning subagents; subagents cannot spawn other subagents anyway. The Plan agent exists specifically so plan-mode does not nest infinitely.

**Lesson**: when an agent has a strict deliverable shape, lock the Output Format section verbatim.

## general-purpose (multi-step, all tools)

**Source**: `tools/AgentTool/built-in/generalPurposeAgent.ts`.

**Frontmatter** (effective):

```yaml
name: general-purpose
description: General-purpose agent for researching complex questions, searching for code, and executing multi-step tasks. When you are searching for a keyword or file and are not confident that you will find the right match in the first few tries use this agent to perform the search for you.
tools: ['*']   # all tools
model: (default subagent model)
```

**Body** (short and direct):

```markdown
You are an agent for Claude Code, Anthropic's official CLI for Claude. Given the user's message, you should use the tools available to complete the task. Complete the task fully, do not gold-plate but do not leave it half-done. When you complete the task, respond with a concise report covering what was done and any key findings; the caller will relay this to the user, so it only needs the essentials.

Your strengths:
- Searching for code, configurations, and patterns across large codebases
- Analyzing multiple files to understand system architecture
- Investigating complex questions that require exploring many files
- Performing multi-step research tasks

Guidelines:
- For file searches: search broadly when you don't know where something lives. Use Read when you know the specific file path.
- For analysis: Start broad and narrow down. Use multiple search strategies if the first doesn't yield results.
- Be thorough: Check multiple locations, consider different naming conventions, look for related files.
- NEVER create files unless they're absolutely necessary for achieving your goal. ALWAYS prefer editing an existing file to creating a new one.
- NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested.
```

**Body patterns to copy**:

1. **Identity opens the body.** One paragraph: who, what to return.
2. **Strengths section signals scope.** Tells the model what kind of task fits.
3. **Guidelines section is a checklist.** Each line is a heuristic, not a rule.
4. **Two "NEVER" rules at the end.** Reserved for hard prohibitions (do not create files unless necessary; do not create docs unsolicited). Use sparingly; modern Claude reads aggressive caps too literally.

**Lesson**: simple agents can skip the five-section pattern. Identity + Strengths + Guidelines is enough when the work itself is open-ended.

## claude-code-guide (docs Q&A, web-fetch)

**Source**: `tools/AgentTool/built-in/claudeCodeGuideAgent.ts`.

**Frontmatter** (effective):

```yaml
name: claude-code-guide
description: Use this agent when the user asks questions ("Can Claude...", "Does Claude...", "How do I...") about: (1) Claude Code (the CLI tool) - features, hooks, slash commands, MCP servers, settings, IDE integrations, keyboard shortcuts; (2) Claude Agent SDK - building custom agents; (3) Claude API (formerly Anthropic API) - API usage, tool use, Anthropic SDK usage. **IMPORTANT:** Before spawning a new agent, check if there is already a running or recently completed claude-code-guide agent that you can continue via SendMessage.
tools: Bash, Read, WebFetch, WebSearch    # ant build; non-ant uses Glob, Grep, Read, WebFetch, WebSearch
model: haiku
permissionMode: dontAsk
```

**Body patterns to copy**:

1. **Domain-routing logic at the top.** "Your expertise spans three domains: Claude Code, Claude Agent SDK, Claude API." The body explicitly lists which doc URL to fetch for each domain.

2. **Hard-coded doc URLs.** Two literal URLs in the body so the agent does not have to discover them: `code.claude.com/docs/en/claude_code_docs_map.md` and `platform.claude.com/llms.txt`.

3. **Approach section is numbered.** "1. Determine which domain. 2. Use WebFetch. 3. Identify URL. 4. Fetch the page. 5. Provide guidance. 6. Use WebSearch if docs don't cover. 7. Reference local files."

4. **Dynamic context injection at spawn.** The `getSystemPrompt` function reads the user's installed skills, custom agents, MCP servers, plugin commands, and settings.json, then appends them to the system prompt as a "User's Current Configuration" section. The agent answers questions with the user's setup in mind.

5. **`permissionMode: dontAsk`.** The agent is read-only (WebFetch, Read, search); no need to prompt for new permissions.

**Lesson**: when an agent's role is to answer questions, embed the canonical knowledge URLs in the body. Dynamic context injection (from app state) keeps the answer relevant without re-prompting.

## statusline-setup

**Source**: `tools/AgentTool/built-in/statuslineSetup.ts`. Sonnet model, configures the status line via the `/statusline` command. Specialized task; not a pattern most custom agents need.

## verification (feature-flagged)

**Source**: `tools/AgentTool/built-in/verificationAgent.ts`. The "runtime observation" agent. Feature-flagged behind `VERIFICATION_AGENT` + `tengu_hive_evidence`. Body emphasizes "build the app, run it, observe what happens. That is the evidence. Nothing else is." See `references/claude-code-system-prompts/system-prompts/skill-verify-skill.md` for the body extracted from a related skill.

**Pattern to copy**: opinionated stance section at the top. "Verification is X. Don't do Y." Sharp, repeated rules.

## Patterns worth copying (cross-cutting)

After reviewing the built-ins, these patterns recur and earn their place:

| Pattern | Where seen | Use when |
|---------|------------|----------|
| Identity paragraph at the top | All | Always |
| Strengths section listing concrete task types | general-purpose, Explore | The agent's scope is broad enough to need clarification |
| Aggressive read-only enforcement in the body | Explore, Plan | The agent must not modify files; frontmatter alone is not enough |
| Numbered step-by-step process | Plan, claude-code-guide | The work has a fixed sequence |
| Locked Output Format with required final section | Plan ("Critical Files for Implementation") | The orchestrator parses the output |
| Hard-coded resource URLs in the body | claude-code-guide | The agent needs to reach specific external resources every run |
| Dynamic context injection via `getSystemPrompt` | claude-code-guide | The agent's behavior should adapt to the user's current setup |
| `permissionMode: dontAsk` for read-only agents | claude-code-guide | The agent never writes; prompting is friction |
| Speed-focused closing instructions | Explore ("respond as a regular message, do NOT create files") | The agent has a tendency the body needs to counter |
| Body-level redundancy of frontmatter restrictions | Explore, Plan | Modern Claude reads literally; redundant constraints help under edge cases |

When designing a custom agent, look at the closest built-in and copy its structure. If you find yourself adding a section that does not appear in any built-in, ask whether it earns its tokens.
