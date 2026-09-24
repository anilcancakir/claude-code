# Counts the in-flight work that will wake this session, read from a Stop payload.
#
# Claude Code 2.1.280 sends `background_tasks` ("in-flight background work ... lets hooks
# distinguish 'session is done' from 'session is paused waiting for background work to wake
# it'") and `session_crons`. When a background task finishes, its task-notification starts the
# next turn, so ending the turn while one is in flight is the correct way to wait. A guard that
# blocks that stop leaves the model nothing to do but poll in the foreground.
#
# The `type` label comes from the binary's task map: local_agent "subagent", local_workflow
# "workflow", local_bash "shell" (a Bash run_in_background AND a command Monitor, which is a
# local_bash task with kind "monitor"), monitor_mcp and monitor_ws "monitor" (only the MCP one
# carries `server`), mcp_task "MCP task", remote_agent "cloud session", and three that wake
# nothing on the user's behalf: "teammate", "dream", "auto-mode scan".
#
# Two modes, passed as `--arg mode strict|loose`:
#   strict (stop-guard.sh, stop-guard-auto.sh): a wrong allow switches a run's guard off for as
#     long as the task lives, so only an allowlist counts: subagent, workflow, MCP task, cloud
#     session, and a shell whose command is a recognised finite job (a test, build, analyze or
#     lint run, an install, a `gh run watch`), found by a positive list rather than by guessing
#     which of the endless long-running commands a stack might start. A shell with `until` or
#     `while` anywhere in it does not count (an evidence-file wait whose file never appears never ends,
#     and parsing where the loop condition stops is where a regex gets it wrong), nor a log
#     follow (a Monitor can be `persistent`, with no timeout), nor anything long-lived. An unknown
#     future task type, a monitor and a recurring cron do not count either. A wrong block here
#     costs one turn; a wrong allow costs the run.
#   loose (stop-guard-announce.sh): a wrong allow costs one stop, so a wait loop and a log follow
#     always count (a wait loop's pattern often names the server it waits on, "until grep 'Flutter
#     run key' log"), any other shell counts unless it is long-lived, and every cron counts.
#
# Known limits: in loose mode an opaque wrapper script (tool/dev/run.sh) cannot be classified and
# counts as finite (strict mode leaves it out, since it is not on the finite list), and the binary clips `command` at 1000 characters, so a loop keyword past that is
# invisible. A websocket Monitor the model armed arrives as "monitor" with no `server`, exactly like
# an ambient one, so it never counts; no transcript so far arms one.
#
# Prints an integer. Every caller passes --arg mode and exits 0 (allows the stop) when jq fails.

def strict: $mode == "strict";

def finite:
  test(
    "\\b(test|tests|spec|build|analyze|analyse|lint|check|typecheck|tsc|compile|install|audit|format)\\b"
    + "|\\b(pytest|phpunit|pest|jest|vitest|rspec|pint|phpstan|larastan|eslint|ruff|mypy)\\b"
    + "|\\bgh +run +watch\\b|\\bgh +pr +checks\\b");

def loops:
  test("\\b(until|while)\\b|\\bsleep +infinity\\b");

def follows:
  test(
    "\\btail\\b[^|;&\\n]*\\s-[a-zA-Z0-9]*[fF]\\b|--follow\\b|\\blogcat\\b|--console\\b"
    + "|\\b(journalctl|logs)\\b[^|;&\\n]*\\s-f\\b|\\bwatch +-|\\bidevicesyslog\\b"
    + "|\\b(flutter|adb) +logs?\\b|\\b(inotifywait|fswatch|watchexec)\\b|\\b(build_runner|cargo) +watch\\b|\\bkubectl\\b[^|;&\\n]*\\s-w\\b"
    + "|\\bstripe +listen\\b|\\bssh\\b[^|;&\\n]*\\s-[a-zA-Z]*N"
    + "|\\b(tsc|vitest|jest|bun)\\b[^|;&\\n]*\\s--watch\\b|\\b(npm|pnpm|yarn|bun)( +run)? +watch\\b");

def long_lived:
  test(
    "\\b(npm|bun|pnpm|yarn|composer)( +run)? +(dev|start|serve|preview)\\b"
    + "|\\b(next|nuxt|astro|remix|expo|wrangler) +(dev|start)\\b"
    + "|\\bvite(?= *($|[;&|]| +(dev|serve|preview|--)))"
    + "|\\bartisan +(serve|queue:work|queue:listen|horizon|reverb:start|pail|schedule:work)\\b"
    + "|\\b(caddy +run|emulator +-avd|octane:start|sail +up|phx\\.server|hugo +server)\\b|\\b(uvicorn|gunicorn|hypercorn|nodemon|ngrok|redis-server)\\b|\\brails +(s|server)\\b"
    + "|\\brunserver\\b|http\\.server|\\bphp\\b[^|;&\\n]*\\s-S\\b|\\bnpx +serve\\b|flutter +run\\b"
    + "|\\bdocker( +compose)?\\b[^|;&\\n]* up\\b(?![^|;&\\n]*( -d\\b|--detach))"
    + "|\\b(node|bun|deno|tsx|python3?|php) +\\S*server\\S*\\.(c?m?[jt]s|py|php)\\b");

# A command that runs under `timeout N` ends by construction, whatever it wraps: an opaque wait
# script, an `until` loop, a log follow. The finite list cannot see into `timeout 110 zsh
# /tmp/wait-step.sh`, and missing it blocked a real execute run twice (2026-09-23) until the model
# waited in the foreground. Only the first simple command is bounded, so a `;`, `&`, `|` or newline
# outside quotes disqualifies it, and so does a clipped command whose tail cannot be seen. N must
# lie in (0, 1 hour]: `timeout 0` disables the limit, and `timeout 86400 npm run dev` is a dev
# server that would switch the run guard off for a day.
def bounded:
  (gsub("'[^']*'"; "''") | gsub("\"(\\\\.|[^\"\\\\])*\""; "\"\"")) as $bare
  | ([$bare | capture(
      "^\\s*([A-Za-z_][A-Za-z0-9_]*=\\S*\\s+)*g?timeout"
      + "(\\s+(-k\\s*\\S+|--kill-after=\\S+|-s\\s*\\S+|--signal=\\S+|--foreground|--preserve-status|-v|--verbose))*"
      + "\\s+(?<n>[0-9]+(\\.[0-9]+)?)(?<u>[smhd]?)\\s")] | first) as $t
  | $t != null
    and (($t.n | tonumber) * {"": 1, "s": 1, "m": 60, "h": 3600, "d": 86400}[$t.u] | . > 0 and . <= 3600)
    and ($bare | test("[;&|\\n]") | not)
    and (test("\\[\\+[0-9]+ chars\\]$") | not);

def wakes:
  if .type == "shell" then
    (.command // "") as $c
    | if strict then ($c | bounded)
        or (($c | finite) and ($c | loops | not) and ($c | follows | not) and ($c | long_lived | not))
      else ($c | loops) or ($c | follows) or ($c | long_lived | not)
      end
  else
    (.type // "") as $t
    | if strict then (["subagent", "workflow", "MCP task", "cloud session"] | index($t)) != null
      elif $t == "monitor" then has("server")
      else (["teammate", "dream", "auto-mode scan"] | index($t)) == null
      end
  end;

([ (.background_tasks // [])[] | select(wakes) ] | length)
+ ([ (.session_crons // [])[] | select((strict and (.recurring // false)) | not) ] | length)
