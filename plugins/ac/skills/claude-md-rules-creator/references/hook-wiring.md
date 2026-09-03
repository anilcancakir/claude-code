# Wiring a linter hook that provably fires

A CLAUDE.md note cannot make anything happen in response to an event. That is a hook. This file is the construction and verification procedure for one specific hook: run the project's linter after Claude writes a file, and report the result where it can be seen.

The flow below reproduces the first-party seven-step procedure carried in the shipped Claude Code binary (2.1.259, symbol `nn`, loaded by the built-in `/init` when it invokes `update-config` with `[hooks-only]`), whose opening line is the reason each step exists: "Each step catches a different failure class - a hook that silently does nothing is worse than no hook." Field-level claims below come from `https://code.claude.com/docs/en/hooks.md`.

## What this hook cannot do

State these to the user rather than implying otherwise:

- **A `PostToolUse` hook cannot block a write.** It runs after the tool completes, so the edit is already on disk. Exit 2 shows stderr to Claude but the tool already ran, and a `decision: "block"` only annotates the result. Preventing a write needs `PreToolUse` with `hookSpecificOutput.permissionDecision: "deny"`. This hook is a reporter, not a gate.
- **It does not fire when a `Bash` command rewrites the same file.** The docs are explicit: Claude Code does not run a `PostToolUse` hook matching `Edit|Write` when a `Bash` command, or any process outside Claude Code, rewrites the file. `FileChanged` is the event that watches the disk instead.
- **A matcher takes the regex path only when it contains something outside `[A-Za-z0-9_- ,|]`.** A plain list such as `Write|Edit` is matched exactly, so it does not catch `NotebookEdit`. Add any other character and it becomes an unanchored `RegExp.prototype.test`, where the docs' own hazard example is `Edit.*` matching `NotebookEdit`. Anchor when you go there.
- **A mistyped script path exits around 127**, which lands in the same non-blocking bucket as exit 0. A dead hook and a passing hook look identical from the transcript. That is the failure the verification steps exist to catch.

## The seven steps

1. **Dedup.** Read the target settings file first. If a hook already exists on the same event plus matcher, show the user its command and ask: keep, replace, or add alongside. If the file is already malformed, stop and report; do not repair a malformation this command did not create.

2. **Resolve the executable against a fixed allowlist.** Repository content never names the executable. You choose the tool name and bake it into the script as a literal. At runtime it resolves in this order, first hit wins: `node_modules/.bin/<tool>`, `vendor/bin/<tool>`, `.venv/bin/<tool>`, then a bare name already on `PATH`. The resolved file has to exist and be executable before anything runs. When the invocation goes through npm, use `npx --no-install` (or the equivalent `npm exec --no --`) so a miss fails loudly. Measured on npm 10.9.2: for a package that is not installed locally, both exit 1 with "npx canceled due to missing packages and no YES option" and create no `node_modules`. They still perform a registry metadata lookup for an unknown name; what they will not do is fetch it and run it.

3. **Take approval before the first execution.** The pipe-test is the first time the target repository's own tooling runs on this machine. Print the exact command string you are about to execute and take one `AskUserQuestion` on it. One gate for the whole procedure, not one per step.

4. **Pipe-test the raw command** by synthesising the stdin payload against a real file:

   ```sh
   echo '{"tool_name":"Edit","tool_input":{"file_path":"<a real file>"}}' | <cmd>
   ```

   Stay raw here: no `|| true`, no stderr redirection. Check the exit code and the side effect. Wrapping comes after the test passes, and for this hook the wrapping is a JSON report rather than suppression.

5. **Emit a script, not a JSON one-liner.** Write `.claude/hooks/lint-changed.sh`, `chmod +x` it, and reference it in exec form with `"args": []`. A JSON-escaped one-liner is one bad backslash away from a malformed settings file, and what that costs depends on the session: interactively Claude Code shows a dialog offering to fix the file, while a `-p` or CI run shows no dialog and skips the broken file or the broken values silently. So the person who writes the hook sees a clear error and the teammate running it in CI sees nothing. A script is also reviewable in a diff.

6. **Validate syntax and schema in one shot**, then read the file back.

7. **Prove it fires, then clean up and hand off.** Steps 4, 6 and 7 are three independent proofs, and the third is the only one that exercises the live wiring.

## The script

Read the path with `jq -r` into a quoted variable and pass `--` before it. Do not use `{ read -r f; ...; }`: verified locally, a path containing a newline is truncated at the newline by `read`, while command substitution into a quoted variable keeps it whole.

```sh
#!/bin/sh
# Lint the file Claude just wrote, and report a failure instead of hiding it.
#
# Why a script rather than a settings one-liner: a JSON-escaped command is where a malformed
# settings file comes from, and a malformed one is skipped silently in -p and CI runs.
#
# Why the linter call is not wrapped to discard stderr and swallow the exit code: a suppressed
# hook is indistinguishable from a hook that never fired, which is the failure this whole
# procedure exists to catch. A real linter failure is reported through additionalContext instead.
#
# `set -e` is deliberately absent: the linter's nonzero exit is the case worth reporting, and
# -e would exit before the report is written. Every condition the hook cannot judge exits 0.

set -u

TOOL=eslint          # baked in at construction time, never read from repository content
CHECK_ARGS=''        # baked in with TOOL: the flag that makes this tool REPORT rather than rewrite

command -v jq >/dev/null 2>&1 || exit 0
payload=$(cat) || exit 0
file=$(printf '%s' "$payload" | jq -r '.tool_input.file_path // empty') || exit 0
[ -n "$file" ] || exit 0

# file_path is absolute, but nothing promises `..` is collapsed or symlinks resolved. Resolve
# BOTH sides the same way before comparing: `cd` collapses `..` and `pwd -P` resolves symlinks.
# Resolving only the file path rejects legitimate files whenever the project root itself sits
# behind a symlink, which on macOS it routinely does (/tmp is /private/tmp).
root=$(cd "${CLAUDE_PROJECT_DIR:-.}" && pwd -P) || exit 0
dir=$(cd -- "$(dirname -- "$file")" && pwd -P) || exit 0
real="$dir/$(basename -- "$file")"

case "$real" in
    "$root"/*) ;;                                   # the trailing slash stops /root-evil matching
    *) exit 0 ;;
esac
case "$real" in
    */.git/*|*/.env|*/.env.*|*/node_modules/*|*.pem|*.key|*id_rsa*) exit 0 ;;
esac
# Generated at construction time from the linter chosen in the interview, exactly like TOOL.
# The list below is the eslint case. A Python, PHP or Dart project needs its own extensions here,
# and shipping this one unchanged gives that project a hook that exits 0 on every file it was
# built for: a dead hook that looks identical to a working one.
case "$real" in
    *.ts|*.tsx|*.js|*.jsx) ;;
    *) exit 0 ;;
esac

bin=''
for candidate in "node_modules/.bin/$TOOL" "vendor/bin/$TOOL" ".venv/bin/$TOOL"; do
    if [ -x "$root/$candidate" ]; then bin="$root/$candidate"; break; fi
done
[ -n "$bin" ] || bin=$(command -v "$TOOL") || exit 0

# CHECK_ARGS is baked in per tool at construction time, like TOOL. Getting it wrong is the
# quiet failure this file exists to prevent: bare `prettier <file>` prints the formatted text
# to stdout and exits 0, so the hook reports nothing and the live proof passes on a file that
# was never checked. Known-good forms: prettier --check, eslint, ruff check, pint --test.
# `--` is not universal either; include it only for tools that accept it.
output=$(cd "$root" && "$bin" $CHECK_ARGS "$real" 2>&1)
status=$?
[ "$status" -eq 0 ] && exit 0

printf '%s' "$output" | head -c 4000 | jq -Rs --arg f "$real" \
    '{hookSpecificOutput: {hookEventName: "PostToolUse",
      additionalContext: ("Linter failed on \($f):\n" + .)}}'
exit 0
```

Adding `--fix` to the invocation turns it into a corrector as well as a reporter. Leave it off until the user asks, because it rewrites files Claude just wrote.

## The registration

Write to `.claude/settings.local.json`, not `.claude/settings.json`. The committed file executes on every teammate's machine and in every `-p` and CI session with no trust prompt. `settings.local.json` is gitignored only when Claude Code itself saves a setting to it, so add the `.gitignore` entry yourself.

Merge with `jq` into a temporary file and `mv` it into place, after a timestamped backup. Never hand-write the whole file.

Seed the file before merging. `jq` on an EMPTY file exits 0 and prints nothing, so the `&&` fires
and `mv` installs a zero-byte settings file, losing whatever was there and the hook with it. On a
MISSING file `jq` exits 2 and leaves an empty `.tmp` behind. Both states are ordinary on a first
run, and the empty one destroys data silently rather than erroring.

```sh
[ -s .claude/settings.local.json ] || printf '{}' > .claude/settings.local.json
cp .claude/settings.local.json ".claude/settings.local.json.bak.$(date +%Y%m%d%H%M%S)"
jq '.hooks.PostToolUse += [{
      matcher: "^(Write|Edit|MultiEdit)$",
      hooks: [{ type: "command",
                command: "${CLAUDE_PROJECT_DIR}/.claude/hooks/lint-changed.sh",
                args: [], timeout: 60 }]
    }]' .claude/settings.local.json > .claude/settings.local.json.tmp \
  && mv .claude/settings.local.json.tmp .claude/settings.local.json
```

`jq` creates `.hooks` when it is absent, so the same expression works on a settings file that has never carried a hook.

## Proving it

```sh
jq -e '.hooks.PostToolUse[] | select(.matcher == "^(Write|Edit|MultiEdit)$")
       | .hooks[] | select(.type == "command") | .command' .claude/settings.local.json
```

Exit 0 with your command printed means correct. Exit 2 means the file is missing or unreadable. Exit 4 means the selector matched nothing, which is a matcher mismatch OR an empty file, so check the file has content before concluding the matcher is wrong. Exit 5 means malformed JSON or wrong nesting.

Then prove the live wiring: use `Edit` to introduce a violation the linter actually reports (a missing semicolon, bad indentation), and confirm the failure comes back as context. Not trailing whitespace, which `Edit` strips before writing. Clean up the violation afterwards whether the proof passed or failed.

If the proof fails while the pipe-test and `jq -e` both passed, the hook is written correctly and the settings watcher is not watching `.claude/`; it only watches directories that had a settings file when the session started. Opening `/hooks` once, or restarting, picks it up. Say which of the two states the user is in when handing off, and point at `/hooks` for later edits: the UI shows "Ran N hooks" only when a hook errors or is slow, so silent success is invisible by design.
