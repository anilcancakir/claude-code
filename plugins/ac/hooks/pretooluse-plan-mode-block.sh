#!/bin/sh
# PreToolUse plan-mode block for ac plan execution.
#
# Steers native plan mode toward /ac:plan. The hooks.json matcher
# (EnterPlanMode|ExitPlanMode) scopes this hook to the plan-mode tools, so the
# script blocks unconditionally once invoked: it prints a steering message to
# stderr and exits 2. Every uncertainty fails OPEN (exit 0, no block): missing
# jq, empty stdin, or a payload that does not parse as JSON, so a broken
# invocation never bricks a tool call (mirror session-start-plan-state.sh:1-12).
# permissions.deny remains the load-bearing block; this hook adds the steer.

set -u

# jq parses the payload; without it we cannot confirm a real invocation, so allow.
command -v jq >/dev/null 2>&1 || exit 0

# Empty stdin is uncertainty, so allow.
input="$(cat 2>/dev/null)" || exit 0
[ -n "$input" ] || exit 0

# A payload that does not parse as JSON is uncertainty, so allow.
printf '%s' "$input" | jq -e . >/dev/null 2>&1 || exit 0

# Confirmed a plan-mode tool invocation (the matcher scopes us here). Steer to the
# working rules' sizing and block: ac:flow for M and L work, /ac:plan only when the
# user asked for a written plan.
printf '%s\n' "Native plan mode blocked. Size the request as the working rules say and run the ac:flow skill for M or L work; /ac:plan (writes to .ac/plans/) only when the user asks for a written plan." >&2
exit 2
