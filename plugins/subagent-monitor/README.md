# subagent-monitor

Live iTerm2 panes for Claude Code in-process subagents. When Claude spawns a
subagent (`ac:explore`, `ac:librarian`, plan workers, etc.), a pane opens on the
right of the current iTerm2 window and tails that subagent's transcript live.
The pane closes shortly after the subagent finishes.

## Requirements

- macOS only.
- iTerm2 with **Settings > General > Magic > Enable Python API** turned on.
- Python 3 available at `python3` (used once during bootstrap to create the venv).

## How it works

```
SessionStart hook  --> bootstrap.sh --> lazy venv build (first run only)
SubagentStart hook --> on_start.sh  --> monitor.py open  --.
SubagentStop  hook --> on_stop.sh   --> monitor.py close   |  iTerm2 Python API
UserPromptSubmit   --> reap.sh      --> monitor.py reap  --'  (split/resize/close)
                                             |
                                 each pane runs watch_agent.sh
                                 (tail -F the transcript, format with jq)
```

- `scripts/monitor.py` owns all iTerm2 pane lifecycle and the state file. State is
  keyed by anchor (the claude pane's iTerm2 session GUID) so multiple concurrent
  Claude sessions each get their own column and never stack into each other.
- `scripts/watch_agent.sh` runs inside each pane: shows a header (agent + short id),
  the task prompt, then the live transcript formatted with per-tool icons. On
  completion it prints `done (Ns)` and waits to be closed.
- `scripts/on_start.sh`, `scripts/on_stop.sh`, and `scripts/reap.sh` are thin hook
  adapters that parse the hook JSON payload and call monitor.py.
- `reap` runs on the next user prompt (not on `Stop`) so it only cleans up panes
  from interrupted subagents and never closes a pane while its subagent is still
  running.

## Install

The local `ac` marketplace is already registered via `/plugin marketplace add`.
Install the plugin with:

```
/plugin install subagent-monitor@ac
```

Then confirm it is enabled in `/plugin list`.

## First-run bootstrap

On the first `SessionStart` after installation, `scripts/bootstrap.sh` lazily
creates a Python virtual environment under the plugin data directory:

```
~/.claude/plugins/data/ac-subagent-monitor/venv/
```

It installs `iterm2` and `pyobjc-framework-Cocoa` into that venv. Subsequent
sessions skip bootstrap if the venv already exists. The bootstrap step happens
before any subagent fires, so there is no race on first use.

After install, restart Claude Code once so the hooks take effect, then spawn a
subagent to confirm a pane opens.

## Data directory

All mutable state lives under `${CLAUDE_PLUGIN_DATA}`, which resolves to:

```
~/.claude/plugins/data/ac-subagent-monitor/
```

| Path | Purpose |
|------|---------|
| `venv/` | Python venv built by bootstrap.sh on first run |
| `state.json` | Active pane registry (anchor -> window/session ids). Safe to delete when no panes are open. |
| `monitor.lock` | Prevents concurrent monitor.py invocations on the same session |
| `done/` | Tombstone files left by on_stop.sh, consumed by reap.sh |
| `debug.log` | All monitor activity, auto-trimmed at 1 MB |

## Config knobs

Edit the scripts directly to tune behavior. No restart is needed for on_stop.sh
changes; a Claude Code restart is needed for monitor.py changes to take effect.

| File | Knob | Default | Meaning |
|------|------|---------|---------|
| `scripts/monitor.py` | `RIGHT_FRACTION` | `0.40` | Subagent column width as a fraction of the claude pane |
| `scripts/monitor.py` | `WATCHDOG_SECS` | `20` | Hard timeout; aborts a hung invocation so it never blocks a hook |
| `scripts/on_stop.sh` | `LINGER` | `4` | Seconds the done line stays before the pane closes |

## Debug

Everything is logged to `~/.claude/plugins/data/ac-subagent-monitor/debug.log`.

Successful operations log `OPEN/CLOSE/REAP ok`. Problems log `SPLIT failed`,
`RESIZE/REBALANCE skipped`, `ERROR`, or `WATCHDOG`. Every monitor failure is
swallowed and logged; the hook always exits 0, so a broken monitor never affects
the subagent itself. If iTerm2's API is unreachable or the watchdog fires, the
subagent simply runs without a pane.

To close all open panes manually:

```sh
~/.claude/plugins/data/ac-subagent-monitor/venv/bin/python \
  /path/to/plugins/subagent-monitor/scripts/monitor.py close_all
```

## Migrating from the manual ~/.claude/subagent-monitor setup

If you previously wired the tool directly via `~/.claude/settings.json`, follow
these steps to cut over to the plugin. Running both the old hooks and the plugin
at the same time causes double panes (one from each), so remove the old hooks
before or at the same time as you enable the plugin.

1. Open `~/.claude/settings.json` in your editor and remove the three hook
   blocks for `SubagentStart`, `SubagentStop`, and `UserPromptSubmit` that
   reference the old `~/.claude/subagent-monitor/` scripts. Save the file.

2. Run `/plugin install subagent-monitor@ac` inside Claude Code and confirm the
   plugin appears as enabled in `/plugin list`.

3. Restart Claude Code completely (quit and reopen, or `/restart`).

4. Spawn a subagent (for example, start a plan or ask Claude to explore a file)
   and confirm a pane opens on the right of your iTerm2 window.

5. Once you are satisfied the plugin is working, delete the old directory:
   ```sh
   rm -rf ~/.claude/subagent-monitor
   ```
