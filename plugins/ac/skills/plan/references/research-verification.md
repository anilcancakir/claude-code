# Research Verification Procedure

Read at Stage 2 entry, once per run. The skill body carries the rule and the log path; this file carries the procedure.

## Why this exists

A subagent report is a claim, not a finding. Reports arrive fluent, well-formatted, and confident whether or not they are right, and the failure mode is not fabrication so much as drift: a line anchor off by one, a range that runs past the block it names, a synthesis sentence that contradicts the report's own table. None of that is visible without checking, and all of it propagates into the plan if it goes unchecked.

## The procedure

Run this after every subagent returns and before any of its claims enters a decision.

1. **Separate load-bearing claims from color.** A claim is load-bearing when a plan decision, a step's scope, or an acceptance criterion would change if it were false. Everything else can be read and left alone. Verifying everything is as wrong as verifying nothing: it burns the run's budget on claims that do not matter.

2. **Check each load-bearing claim against the source, not against another report.** A `file:line` anchor gets opened and read. A line range gets its boundaries checked, because a range that starts one line early swallows a closing tag and a range that ends one line late pulls in the next section. A count gets recounted with a command. A quote gets grepped for verbatim. Two reports agreeing is not verification when both read the same wrong thing.

3. **Check the report against itself.** A report whose synthesis contradicts its own table has one of the two wrong, and the table is usually right. This is a cheap check and it catches the class of error where a subagent assembles correct evidence and then draws the opposite conclusion from it.

4. **Record what failed.** Append every refuted or corrected claim to `.ac/plans/<slug>/research/verification-log.md` with the claim, the check that was run, and the verdict. Three reasons: the plan cites verified facts rather than reported ones, a later stage can tell which reports were reliable, and the record keeps a refuted claim from being re-adopted after a compaction has summarized away the memory of refuting it.

5. **Use the corrected version.** When a claim is refuted, the corrected fact goes into the plan and the report's version does not. When a claim cannot be checked, it enters the plan labelled as unverified or it does not enter at all.

## What this is not

This is not a second reviewing agent. Verification is the orchestrator's own work, on the main thread, against the source. Delegating the check to another subagent reproduces the problem it solves: a second claim about the first claim, with the same drift and no ground truth.

## Briefing consequence

Workers ship with their own retrieval budgets and output templates, so a brief that does not lift them gets a thin single-pass answer with no leads. State the depth the brief needs explicitly, and say what to return when the answer is a negative: a definitive "no such thing exists, here is where I looked" is a usable result, while silence on a question is not.
