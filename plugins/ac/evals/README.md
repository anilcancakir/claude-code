# Agent evals

Behavioural tests for the `ac` subagents, run by the CLI's own harness. `claude plugin validate`
checks that the plugin is structurally sound; these check that its agents actually do their job.

## Running them

```sh
CLAUDE_CODE_WALNUT_SPIRE=1 claude plugin eval plugins/ac \
  --eval-dir evals --ablation none --max-cost-usd 4 \
  --no-publish --allow-tools Bash WebSearch WebFetch --scaffold
```

Every flag earns its place:

- `CLAUDE_CODE_WALNUT_SPIRE=1` opens the early-access gate. Without it the command prints
  "`plugin eval` is currently in early access" and exits 1. Self-test: run `claude plugin eval` in
  an empty directory; "No eval cases found" means enabled.
- The target is a **path**, not the plugin name. Naming the plugin turns the baseline arm on and
  doubles the session count; `--ablation none` keeps it off either way.
- `--allow-tools` is required because `Bash`, `WebSearch` and `WebFetch` are gated off inside the
  sandbox. `ac:explore` needs `Bash`, `ac:librarian` needs the web pair.
- `--scaffold` is required because both fixtures are written by a scaffold script. It runs that
  script as you, so only pass it on cases from this repository.
- `--max-cost-usd` is a real ceiling, not a formality. A full pass costs about $1.20.

Add `--keep-temp` to debug a failure. It preserves each run's workspace and `out/trace.jsonl`; the
`home/` and `tmp/` subtrees are sealed at mode 000 and need `chmod 700` before you can read them.

## Recorded baseline

Measured 2026-09-03 on CLI 2.1.259, plugin 0.14.0.

| Case | Runs | Score | Cost |
|---|---|---|---|
| `explore-citation-accuracy` | 3 | 1.00 | $0.62 |
| `librarian-budget-adherence` | 2 | 1.00 | $0.59 |

The `ac:librarian` case replaces a manual measurement: across 414 historical runs the agent
averaged 13.32 `WebSearch` calls, and the budget clause in its body is what is supposed to bound
that. Both eval runs landed at one search against a stated ceiling of two.

## Writing another case

A case is a directory holding `prompt.md` (the prompt plus frontmatter) and `graders/*.md`, with an
optional `case.yaml` for what the frontmatter cannot express. Two things are worth knowing before
writing the third case, both measured here rather than documented:

**Fixtures go in a scaffold script, not beside the case.** `context.add_dirs` was accepted without
error and placed nothing in the run's workspace: no copy appeared anywhere in the sandbox and the
subagent correctly reported the file missing. Inlining the bytes in `scaffold.sh` removes every
path assumption. Note that an `add_dirs` path must also name something inside the case directory,
so an absolute path is rejected outright.

**Grade the trace, not just the last message.** A trace event for a subagent's own turn carries
`parent_tool_use_id`, `subagent_type` and `task_description`, and its tool inputs match the
subagent's transcript exactly. So `target: trace` grades what the agent under test wrote, while
`target: last_message` grades the orchestrator's relay of it. Use `trace` for a citation the agent
must produce, and `last_message` for something that must not survive into the answer.

Always include a `tool_used` grader asserting the delegation happened, with `min: 1, max: 1` and an
`input_match` on the agent name. Without it a case can score full marks on the orchestrator
answering by itself, which measures the wrong model entirely.

Pin line numbers in the graders and say so in the scaffold, because editing a fixture silently
invalidates the case otherwise. The sandbox workspace path is generated per run, so match on a
basename and line (`user-service.ts:7`) rather than anything absolute.

## Caveat

`claude plugin eval` is early access and has no public documentation page. The schema can change
without a changelog entry, so re-check `claude plugin eval --help` before trusting a key here. The
case files are plain markdown either way: if the command goes away, the prompts and the ground
truth they encode still stand on their own.
