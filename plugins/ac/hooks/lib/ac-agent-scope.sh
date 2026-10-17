# Agent scope test, sourced by the hooks that act on ac subagents only.
#
# `ac_agent_in_scope "$agent_type"` returns 0 for `ac:<name>` or one of the eleven bare names (an
# agent installed unprefixed under .claude/agents/ arrives without the namespace), and 1 for
# anything else, including an empty type, which is how a main-thread payload is left alone.
#
# Plain sh, no bash-only syntax: the scripts that source this run under `#!/bin/sh`.

ac_agent_in_scope() {
  case "$1" in
    ac:* | explore | librarian | oracle | plan-worker-quick | plan-worker-junior | plan-worker-junior-high \
      | plan-worker-senior | plan-reviewer | plan-code-review | auto-verifier | qa-tester) return 0 ;;
    *) return 1 ;;
  esac
}
