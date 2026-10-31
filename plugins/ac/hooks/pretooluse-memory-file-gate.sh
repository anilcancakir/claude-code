#!/bin/sh
# PreToolUse gate for memory-file writes, every session and every subagent.
#
# CLAUDE.md, CLAUDE.local.md, AGENTS.md, .claude/rules/*.md, PROJECT.md and DESIGN.md are loaded into
# every turn that reads them, so what an agent appends is paid for again and again. Left alone, agents
# append without the writer skill's rules (scope, size budget, one home per fact, paths: for anything
# file-specific): one project reached 33 rule files and 470 KB, one file 706 lines, written straight
# from main threads and subagents with no skill loaded. Before a Write, Edit or MultiEdit of one of
# these files this hook checks the session transcript for proof the matching writer skill was loaded,
# and when there is none it denies with the skill to load. A deny raises no prompt: the model reads
# the reason, loads the skill and retries.
#
# The skill counts as loaded when the transcript holds a Skill tool call for it, a Read of its
# SKILL.md (the plan workers have no Skill tool and read the body instead), or a slash command that
# runs it (/ac:init-project invokes ac:claude-md-rules-creator). Auto-memory, vendored trees,
# references/, installed plugins and the skills' own templates under plugins/ac/skills/ pass. It
# fails open on a missing tool, an unreadable payload and a transcript it cannot read.
#
# Knob, read from the environment (settings.json `env` reaches hooks):
#   AC_MEMORY_FILE_GATE=0          turns the hook off

set -u

[ "${AC_MEMORY_FILE_GATE:-}" = "0" ] && exit 0

# 0. Read the payload. jq is the only parser; without it, or without a payload, allow.
input="$(cat 2>/dev/null)" || exit 0
[ -n "$input" ] || exit 0
command -v jq >/dev/null 2>&1 || exit 0

file="$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty' 2>/dev/null)" || exit 0
[ -n "$file" ] || exit 0

# 1. Classify the file. Paths whose content is not this project's own memory pass first.
case "$file" in
    */.claude/projects/* | */node_modules/* | */vendor/* | */references/* | */.claude/plugins/* | \
        */plugins/ac/skills/*)
        exit 0
        ;;
esac

case "$file" in
    */.claude/rules/*.md)
        skill="ac:claude-md-rules-creator"
        dir="claude-md-rules-creator"
        ;;
    *)
        case "${file##*/}" in
            CLAUDE.md | CLAUDE.local.md | AGENTS.md)
                skill="ac:claude-md-rules-creator"
                dir="claude-md-rules-creator"
                ;;
            PROJECT.md)
                skill="ac:project-md-writer"
                dir="project-md-writer"
                ;;
            DESIGN.md)
                skill="ac:design-md-writer"
                dir="design-md-writer"
                ;;
            *) exit 0 ;;
        esac
        ;;
esac

transcript="$(printf '%s' "$input" | jq -r '.transcript_path // empty' 2>/dev/null)" || exit 0
[ -r "$transcript" ] || exit 0

# Inside a subagent the payload's transcript_path names the session, while the subagent's own turns
# (where a worker Reads the SKILL.md) sit beside it under <session>/subagents/agent-<agent_id>.jsonl.
# Search both, so a proof in either counts.
agent_id="$(printf '%s' "$input" | jq -r '.agent_id // empty' 2>/dev/null)"
agent_transcript=""
if [ -n "$agent_id" ]; then
    agent_transcript="${transcript%.jsonl}/subagents/agent-${agent_id}.jsonl"
    # No readable transcript of its own means no proof could ever show up: fail open, never loop.
    [ -r "$agent_transcript" ] || exit 0
fi

# Print the transcript this payload proves the skill from. Inside a subagent that is its own transcript
# only: the parent having loaded the skill teaches the worker nothing. A slash command is the one proof
# that stays on the session transcript, since it is the parent's run that drives the subagent.
transcripts() {
    if [ -n "$agent_id" ]; then
        cat "$agent_transcript" 2>/dev/null
    else
        cat "$transcript" 2>/dev/null
    fi
}

# 2. Look for proof the skill was loaded. Transcript lines are compact JSON, but both spellings of
#    the key separator are accepted.
skill_called() {
    transcripts | grep -F -e '"name":"Skill"' -e '"name": "Skill"' \
        | grep -q -F -e "\"skill\":\"$1\"" -e "\"skill\": \"$1\""
}

skill_read() {
    transcripts | grep -F -e '"name":"Read"' -e '"name": "Read"' \
        | grep -q -F -e "/skills/$1/SKILL.md\""
}

# A slash command is a user line whose content opens with the command marker; the same text quoted in a
# tool result or a file the session read sits inside other content, with escaped quotes, and does not count.
# A transcript of any size holds a few hundred such lines, so one fixed-string scan collects them and the
# anchored pattern then runs over those lines only.
typed_commands="$(grep -F '"role":"user","content":"<command-' "$transcript" 2>/dev/null)"

command_run() {
    printf '%s\n' "$typed_commands" \
        | grep -q -E "\"role\":\"user\",\"content\":\"<command-(message>|name>/)$1</command-"
}

skill_called "$skill" && exit 0
skill_read "$dir" && exit 0
command_run "$skill" && exit 0
[ "$dir" = "claude-md-rules-creator" ] && command_run "ac:init-project" && exit 0
# /ac:install writes the user's global CLAUDE.md block from its own template.
[ "$dir" = "claude-md-rules-creator" ] && command_run "ac:install" && exit 0

# 3. Not loaded: deny, naming the skill and the SKILL.md a skill-less agent can Read.
skill_path="$(cd "$(dirname "$0")/.." && pwd)/skills/${dir}/SKILL.md"
reason="${file} is a memory file the ${skill} skill governs: scope, size budget, one home per fact, paths: for"
reason="${reason} anything file-specific. Load it first with the Skill tool (${skill}), or, if you have no Skill"
reason="${reason} tool, Read ${skill_path}, then retry this write following it."

jq -n --arg reason "$reason" '{
    hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: $reason
    }
}' 2>/dev/null
exit 0
