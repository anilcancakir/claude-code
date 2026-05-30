#!/usr/bin/env bash
# Live view of one Claude Code subagent transcript inside an iTerm2 pane.
# Args: <agent_id> <agent_type> [transcript_path|-] <data_dir>
# Renders a header (agent + short id), the task prompt, then the live transcript.
# When the SubagentStop hook drops a sentinel, shows "✓ done (Ns)" and waits to
# be closed by monitor.py.
#
# The iTerm2 pane does NOT inherit the plugin env vars, so the mutable data dir
# arrives as an explicit positional argument and the sentinel path is derived
# from it instead of recomputing a hardcoded base.

set -u

agent_id="${1:-unknown}"
agent_type="${2:-agent}"
tpath="${3:--}"
DATA="${4:-}"
projects="$HOME/.claude/projects"
jq_bin="$(command -v jq || echo /usr/bin/jq)"
sentinel="$DATA/done/$agent_id"
rm -f "$sentinel"
start_ts=$SECONDS

esc=$'\033'
dim="${esc}[2m"; txt="${esc}[37m"; tool="${esc}[36m"; ok="${esc}[1;32m"; off="${esc}[0m"

printf '%s\xe2\x96\xb6 %s%s  %s%s%s\n' "${esc}[1;35m" "$agent_type" "$off" "$dim" "${agent_id:0:8}" "$off"

# Locate the transcript. Prefer the exact path passed by the hook; otherwise
# scan ~/.claude/projects. Either way it may not exist yet right after start.
file=""
if [ "$tpath" != "-" ] && [ -n "$tpath" ]; then
  for _ in $(seq 1 150); do
    [ -f "$tpath" ] && { file="$tpath"; break; }
    [ -f "$sentinel" ] && break
    sleep 0.2
  done
fi
if [ -z "$file" ]; then
  for _ in $(seq 1 50); do
    file="$(find "$projects" -maxdepth 5 -name "agent-${agent_id}.jsonl" 2>/dev/null | head -1)"
    [ -n "$file" ] && break
    [ -f "$sentinel" ] && break
    sleep 0.2
  done
fi

tailpid=""
if [ -n "$file" ] && [ -f "$file" ]; then
  # Task prompt: first user message (a plain string) in the subagent transcript.
  task="$(grep -m1 '"type":"user"' "$file" 2>/dev/null | "$jq_bin" -r '
    if (.message.content | type) == "string" then .message.content
    else (.message.content[]? | select(.type == "text") | .text) end' 2>/dev/null \
    | tr '\n' ' ' | cut -c1-240)"
  [ -n "$task" ] && printf '%s%s%s\n\n' "$dim" "$task" "$off"

  format='
    def t(n): if (. | length) > n then .[0:n] + "…" else . end;
    def short: (.name // "tool") | split("__") | last;
    def icon:
      { "Bash":"🖥️","Read":"📖","Write":"📝","Edit":"✏️","MultiEdit":"✏️",
        "NotebookEdit":"📓","Grep":"🔍","Glob":"🗂️","LS":"🗂️","LSP":"🧭",
        "web-fetch":"🌐","WebFetch":"🌐","web-search":"🔎","WebSearch":"🔎",
        "web-code-search":"💻","search-docs":"📚","resolve-library":"📚",
        "ToolSearch":"🧰","Task":"🤖","Agent":"🤖","TodoWrite":"✅",
        "TaskCreate":"✅","TaskUpdate":"✅" }[short] // "🔧";
    def arg:
      (.input // {}) as $i
      | ($i.command // $i.file_path // $i.path // $i.pattern // $i.url
         // $i.query // $i.prompt // $i.description) as $v
      | (if $v == null then ($i | tojson) else ($v | tostring) end)
      | gsub("\\s+"; " ") | t(150);
    if .type == "assistant" then
      (.message.content[]? |
        if .type == "thinking" then $dim + "  · " + ((.thinking // "") | gsub("\\s+"; " ") | t(140)) + $off
        elif .type == "text" then $txt + ((.text // "") | gsub("[ \\t]+$"; "")) + $off
        elif .type == "tool_use" then $tool + icon + " " + short + $off + "  " + $dim + arg + $off
        else empty end)
    else empty end
  '

  ( tail -n +1 -F "$file" 2>/dev/null | while IFS= read -r line; do
      printf '%s' "$line" | "$jq_bin" -r \
        --arg dim "$dim" --arg txt "$txt" --arg tool "$tool" --arg ok "$ok" --arg off "$off" \
        "$format" 2>/dev/null
    done ) &
  tailpid=$!
else
  printf '%s(transcript not found yet for %s)%s\n' "$dim" "${agent_id:0:8}" "$off"
fi

# Wait for the SubagentStop hook to signal completion.
while [ ! -f "$sentinel" ]; do sleep 0.3; done

if [ -n "$tailpid" ]; then
  pkill -P "$tailpid" 2>/dev/null
  kill "$tailpid" 2>/dev/null
fi
elapsed=$((SECONDS - start_ts))
printf '\n%s✓ done (%ss)%s\n' "$ok" "$elapsed" "$off"
rm -f "$sentinel"

# Hold the pane open until monitor.py closes it.
exec sleep 86400
