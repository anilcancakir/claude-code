# Final output (6d)

Print this at the end of the run.

One block per emitted file:

```
<absolute-path>
  lines: <count>
  sections: <comma-separated H2 headings>
  anti-pattern check: <pass | <one-line description of remaining issue>>
```

Then the placement table, one row per convention: the convention, its destination (root `CLAUDE.md` / hook / `.claude/rules/<topic>.md`), and which of the two 2c questions sent it there. Then one line each for the permission rules (each rule, its target file, and that deny rules apply as soon as the settings reload and do not fence `grep -r` or a script, only the sandbox does), the other settings keys (key, file, the signal that justified it), the hook (kind, tools, target file, whether the three proofs passed), the language server (plugin, marketplace, which server answered the probe), and the 3e review (findings fixed, findings dismissed with the reason, or "skipped" with the flag that skipped it).

End with a single line that states a check rather than announcing a step ("`/context` in a new session in this project lists the new files under Memory files", not "Next step: ..."), because the report is the end of the run and a closing next-step line reads as unfinished work. When proposed sidecars remain, the line names the files waiting in `.proposed` and that `--force-overwrite` applies them; otherwise it states the `/memory` check, and that `/doctor prompt-audit` (2.1.283 and later) checks the files for patterns written for older models, stale paths and commands, and files that contradict each other, while `/doctor`'s CLAUDE.md trim check (2.1.206 and later) proposes cuts once the codebase moves on.

Name the related skills the findings call for above that line, one each with its reason: `ac:project-md-writer` when the project has no `PROJECT.md` and the interview surfaced scope, non-goals or decisions that belong in one; `ac:design-md-writer` when architecture or UI tokens surfaced that belong in a `DESIGN.md`; `ac:frontend-design` when the project has a UI and no committed design direction; `/ac:product` when the user described a feature still to be specified.

Skill candidates from 2c and 1c go above that line too, one each with the procedure it would carry, for `ac:skill-creator`; this command writes no skill.

Under `PROPOSE_ONLY`, list every file under `.ac/init/proposed/` with its target and line counts before and after, and say they are applied by copying each over its target after review, or by re-running `/ac:init-project` without the flag.

When the live-fire hook proof failed while the pipe-test and `jq -e` passed, add the check line from `hook-wiring.md` and point at `/hooks`.
