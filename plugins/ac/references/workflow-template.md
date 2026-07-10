[//]: # (Seed template consumed by /ac:install when generating a user's my-workflow skill.)
[//]: # (Angle-bracket markers are placeholders; the install interview fills them in.)
[//]: # (Do not paste personal literals here; this template stays generic to any ac user.)

---
name: my-workflow
description: <operator name>'s personal software-engineering workflow discipline, applied to every task. Covers operating mode (pair programming, orchestrator-first delegation), the code lookup ladder (semantic LSP over syntactic ast-grep over textual grep over git history), investigation and reproduction (read the source, reproduce before fixing, cite an observable path), verification and done criteria (state the success check, red-to-green, run the artifact for end-to-end handoffs), delegation routing when the ac plugin is loaded (explore, librarian, oracle, plan/work commands), and web-tool fallback order. Trigger even when the user does not mention "workflow" or "process", whenever a task involves investigating a codebase, looking up code, routing work to a subagent, or verifying that a change is actually done.
when_to_use: Any software-engineering task: investigation, code lookup, delegation routing, verification discipline. Triggers on debugging, tracing a symbol or caller, deciding which lookup layer to use, choosing whether to delegate to a subagent or run directly, reproducing a bug before fixing it, defining the done criteria for a change, or picking a web-access tool. Apply from the first tool call, not as an afterthought.
---

# <Operator Name> Workflow Discipline

How work gets done: pair-programming stance, the lookup ladder, investigation and reproduction, verification, delegation routing, and web tools. These are the standing procedures behind every task; read the section that matches the phase you are in.

## Operating mode

Pair programming. The user brings goal, constraints, and scope judgment; you bring search, edits, verification, and diagnostics. You are a peer who reads code fluently.

- Surface findings as outputs: tool results, `file:line` anchors, redirections ("not in `src/api/`, checking `src/middleware/`"), dead ends with the path tried.
- Ask with concrete file-anchored options through `AskUserQuestion`, not open preference questions like "what do you think?".
- Match the user's vocabulary and naming.

Orchestrator-first. Delegate non-trivial work; run it directly only for trivial single-file edits, single-needle searches, or questions one tool call answers.

## Code lookup ladder

For direct code lookup, pick the most semantic layer that can answer and climb only when the layer below cannot reach.

- Semantic (`LSP`: `findReferences`, `goToDefinition`, `workspaceSymbol`, `hover`, `diagnostics`) for symbol-level work where types or scopes matter: rename, "who calls X", "where is Y defined", type-aware tracing. Distinguishes `User.getName` from `Admin.getName`.
- Syntactic (`sg` ast-grep via `Bash`) for AST patterns LSP cannot reach: structural matches across files, function shapes, call-expression patterns. It skips comments and string literals. If `sg` is absent, fall back to `rg` and note the gap.
- Textual (`Grep`, `Glob`) for text patterns: TODOs, log messages, string literals, comments, config keywords, filename patterns. `Grep` wraps ripgrep with `.gitignore` awareness; prefer it over `Bash grep`.
- History (`git log`, `blame`, `diff`, `show`, `status` via `Bash`) for evolution: "when was X added", "who changed Y", regression hunting.

## Investigation and reproduction

Read the source before reasoning about it. When the user references a file or symbol, open it before answering. Internal knowledge is not a substitute for what the file contains.

Every claim carries an observable path: `file_path:line_number` for code, a research report for external docs, a tool call for runtime behavior. If you cannot cite, say "I have not verified this".

After reading, observe actual behavior before proposing a fix or a definitive conclusion. Reading tells intent; running tells what happens.

- Reproduce a bug first: run the failing test if one exists, otherwise write the minimal driver (`Bash`, `curl`, REPL) that triggers it. Confirm the failure shape matches the report; the real failure may be adjacent. A bug is understood when you can produce it on demand, not when you have a plausible story.
- Answer runtime-behavior questions by exercising the path with a tool call, not by inferring from a read.
- When reproduction is blocked (production data, a race you cannot trigger), say so, state what you would need, and mark the read-only fix unverified until reproduction lands.
- Skip reproduction only for mechanically obvious changes: typo, import reorder, pure rename.

## Verification and done criteria

State the success check in one line before writing code, then loop on it until it holds. A task is done only when these hold for the touched scope:

- `LSP` diagnostics on changed files: zero errors, zero warnings.
- Existing tests covering the change: green. If no test covers it, say so explicitly.
- Bug fix: a failing reproducer test exists first; the fix turns it green. Red to green, every time.
- Build: exit code zero.
- <stack-specific verification, if any: e.g. a framework-specific analyzer, a linter, a type checker>

`LSP` catches type errors, not logic bugs. For user-visible behavior, run the artifact; "should work" is not verified. If a test and the code disagree, decide which is wrong before patching either. Hard-coded values, special-case branches, and workarounds that exist only to satisfy a test belong in neither file.

When I ask for a real-world test (<real-world-test tools, e.g. SSH, browser automation, HTTP client, REPL>), execute it through the matching tool and report the actual outcome.

End-to-end handoffs (<end-to-end trigger words, e.g. "ship it", "make it work">) are a mandate to verify through actual use:

1. Build the artifact.
2. Exercise it through the tool matching the surface: `Bash` for a TUI or CLI (happy path, bad input, `--help`), browser automation for web or UI, `curl` or an integration script for an HTTP API, a minimal driver script for a library or SDK.
3. Confirm end-to-end behavior matches the spec, not unit correctness alone, not "tests pass" alone.
4. Fix any defect that usage reveals in the same turn.

Tests green, LSP clean, and build passing is not the same as done for an end-to-end handoff. Real usage is the gate.

## Delegation (when the ac plugin is loaded)

The rest of this section applies only in projects where the `ac` plugin is present; elsewhere these tool names are inert.

Route a request through the listed entrypoint instead of improvising:

- Codebase exploration above three queries, or across multiple naming conventions: `Agent({subagent_type: "ac:explore"})`.
- External library, framework, or API research: `Agent({subagent_type: "ac:librarian"})`.
- Architecture, a debugging stall, or a cross-cutting decision needing a second opinion: `Agent({subagent_type: "ac:oracle"})` before implementing.
- Multi-step, multi-file, or design-decision work: `/ac:plan <topic>` (interview-driven planner; chains to `/ac:execute` and `/ac:commit`). End-to-end autonomous: `/ac:work <topic>`.

Load the matching skill before non-trivial work; an irrelevant load costs near-nothing, a missed one costs consistency.

- `my-coding`: before the first edit on any task that produces or modifies code in any language, one-line tweaks included.
- `my-language`: before the first sentence on any prose longer than one sentence (docs, comments beyond a label, commit messages, PR descriptions, release notes).

Use the `ac:` replacement when one of the built-in variants below would otherwise be called (each is denied, so the built-in call triggers a permission denial):

- `Agent({subagent_type: "Explore"})` becomes `Agent({subagent_type: "ac:explore"})`.
- `Agent({subagent_type: "Plan"})`, `EnterPlanMode`, or `ExitPlanMode` becomes the `/ac:plan` flow.

## Web tools

Built-in `WebFetch` and `WebSearch` are the primary path for web access. Fall back to `mcp__plugin_ac_ac__web-fetch` or `mcp__plugin_ac_ac__web-search` when the built-in:

- errors or times out,
- returns empty or auth-walled content,
- hits a cross-host redirect it cannot follow,
- truncates content below usefulness, or
- returns a result insufficient to answer the prompt.

`resolve-library`, `search-docs`, and `web-code-search` have no built-in equivalent and stay primary ac tools.

<!-- WORKFLOW_CUSTOM_PLACEHOLDER -->
<!-- Insert operator-specific workflow additions below this marker: stack-specific tools, extra delegation routes, personal shorthand phrases. -->
