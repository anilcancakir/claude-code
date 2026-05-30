#!/usr/bin/env bash
# bootstrap.sh -- SessionStart(startup) hook for subagent-monitor.
#
# Idempotently ensures the plugin venv is ready with iterm2 + pyobjc installed.
# Detects whether the iTerm2 Python API is enabled and, once, tells the user
# how to turn it on. Always exits 0; never blocks session startup.

# 1. macOS-only: silently no-op on any other platform.
if [[ "$OSTYPE" != darwin* ]]; then
    exit 0
fi

# 2. Require the env vars the plugin host injects; bail gracefully if absent.
if [[ -z "$CLAUDE_PLUGIN_ROOT" || -z "$CLAUDE_PLUGIN_DATA" ]]; then
    echo "subagent-monitor bootstrap: CLAUDE_PLUGIN_ROOT or CLAUDE_PLUGIN_DATA unset, skipping." >&2
    exit 0
fi

VENV_DIR="$CLAUDE_PLUGIN_DATA/venv"
REQ_FILE="$CLAUDE_PLUGIN_ROOT/requirements.txt"
HASH_FILE="$CLAUDE_PLUGIN_DATA/.req-hash"

# 3. Compute the fast-path hash check (near-instant when warm).
current_hash="$(shasum "$REQ_FILE" 2>/dev/null | awk '{print $1}')"
stored_hash="$(cat "$HASH_FILE" 2>/dev/null || true)"

if [[ -d "$VENV_DIR" && -n "$current_hash" && "$current_hash" == "$stored_hash" ]]; then
    # Warm path: venv is present and requirements unchanged. Skip install entirely.
    :
else
    # 4. Cold/stale path: run install in the background so the hook returns immediately.
    (
        # Create the data directory if it doesn't exist yet.
        mkdir -p "$CLAUDE_PLUGIN_DATA"

        # Recreate the venv when it is missing.
        if [[ ! -d "$VENV_DIR" ]]; then
            if ! python3 -m venv "$VENV_DIR" 2>>"$CLAUDE_PLUGIN_DATA/bootstrap.log"; then
                echo "subagent-monitor bootstrap: venv creation failed, see $CLAUDE_PLUGIN_DATA/bootstrap.log" >&2
                exit 0
            fi
        fi

        # Install (or update) dependencies quietly.
        if ! "$VENV_DIR/bin/pip" install -q -r "$REQ_FILE" 2>>"$CLAUDE_PLUGIN_DATA/bootstrap.log"; then
            echo "subagent-monitor bootstrap: pip install failed (network issue?), see $CLAUDE_PLUGIN_DATA/bootstrap.log" >&2
            exit 0
        fi

        # Record the hash only after a successful install.
        echo "$current_hash" > "$HASH_FILE"
    ) &
    # Disown so the background job survives even if the parent shell exits.
    disown $! 2>/dev/null || true
fi

# 5. Detect iTerm2 Python API and emit a one-time notice if it is not enabled.
NOTICE_MARKER="$CLAUDE_PLUGIN_DATA/.api-notice-shown"
if [[ ! -f "$NOTICE_MARKER" ]]; then
    api_enabled="$(defaults read com.googlecode.iterm2 EnableAPIServer 2>/dev/null || echo 0)"
    if [[ "$api_enabled" != "1" ]]; then
        mkdir -p "$CLAUDE_PLUGIN_DATA"
        echo "subagent-monitor: iTerm2 Python API is not enabled." >&2
        echo "  Enable it in iTerm2: Settings > General > Magic > Enable Python API" >&2
        touch "$NOTICE_MARKER"
    fi
fi

exit 0
