#!/usr/bin/env python3
"""iTerm2 split-pane monitor for Claude Code in-process subagents.

Each claude session (identified by its iTerm2 pane GUID = "anchor") grows its
OWN right-hand column and stacks one pane per running subagent inside it. State
is keyed by anchor so concurrent claude sessions never stack into each other's
window. Panes rebalance to equal heights on each add (fits many, looks even),
close on SubagentStop (after a short linger), and are reaped per-anchor on the
next user prompt.

Usage:
  monitor.py open  <agent_id> <agent_type> [anchor_id] [transcript_path]
  monitor.py close <agent_id>
  monitor.py reap  [anchor_id]      # close this session's leftover panes
  monitor.py close_all              # close every pane (manual cleanup)
  monitor.py selftest [anchor_id]

Design notes:
- A SIGALRM watchdog aborts the process if it ever exceeds WATCHDOG_SECS so a
  hung iTerm2 API call can never block a Claude Code hook indefinitely.
- All state access is serialized with an fcntl lock.
- Every failure path is swallowed and logged; the caller (a hook) always
  continues. The subagent itself is never affected by monitor failures.
"""

import sys
import os
import json
import fcntl
import shlex
import signal
import traceback

# Plugin path contract: DATA holds mutable state (persists across plugin
# updates), ROOT locates the read-only script copy for this plugin version.
DATA = os.environ["CLAUDE_PLUGIN_DATA"]
ROOT = os.environ["CLAUDE_PLUGIN_ROOT"]
STATE = os.path.join(DATA, "state.json")
LOCK = os.path.join(DATA, "monitor.lock")
LOG = os.path.join(DATA, "debug.log")
DONE_DIR = os.path.join(DATA, "done")
WATCH = os.path.join(ROOT, "scripts", "watch_agent.sh")

RIGHT_FRACTION = 0.40   # subagent column width as a fraction of the claude pane
WATCHDOG_SECS = 20      # hard upper bound on a single monitor invocation
LOG_MAX_BYTES = 1_000_000
LOG_KEEP_LINES = 400


def log(msg: str) -> None:
    try:
        if os.path.exists(LOG) and os.path.getsize(LOG) > LOG_MAX_BYTES:
            with open(LOG) as f:
                tail = f.readlines()[-LOG_KEEP_LINES:]
            with open(LOG, "w") as f:
                f.writelines(tail)
    except Exception:
        pass
    with open(LOG, "a") as f:
        f.write(msg.rstrip("\n") + "\n")


def load_state() -> dict:
    try:
        with open(STATE) as f:
            state = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        state = {}
    state.setdefault("sessions", {})  # anchor_id -> {"order": [...], "window_id": None}
    state.setdefault("panes", {})     # agent_id  -> iTerm2 session_id
    return state


def save_state(state: dict) -> None:
    tmp = STATE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(state, f)
    os.replace(tmp, STATE)


def clear_sentinel(agent_id: str) -> None:
    try:
        os.remove(os.path.join(DONE_DIR, agent_id))
    except OSError:
        pass


def watch_command(agent_id: str, agent_type: str, transcript_path: str) -> str:
    # The iTerm2 pane does NOT inherit plugin env vars, so the DATA dir is baked
    # into the command as an explicit positional argument; watch_agent.sh derives
    # its sentinel path from it.
    return "{} {} {} {} {}".format(
        shlex.quote(WATCH), shlex.quote(agent_id),
        shlex.quote(agent_type), shlex.quote(transcript_path or "-"),
        shlex.quote(DATA))


def command_profile(agent_id: str, agent_type: str, transcript_path: str):
    import iterm2

    profile = iterm2.LocalWriteOnlyProfile()
    profile.set_use_custom_command("Yes")
    profile.set_command(watch_command(agent_id, agent_type, transcript_path))
    # Pin the pane title to the agent name instead of the running job ("tail").
    profile.set_name(agent_type)
    profile.set_title_components([iterm2.TitleComponents.SESSION_NAME])
    profile.set_allow_title_setting(False)
    return profile


async def find_tab(app, session_id: str):
    for window in app.terminal_windows:
        for tab in window.tabs:
            for session in tab.sessions:
                if session.session_id == session_id:
                    return tab
    return None


async def resize_right_column(app, left_session, right_session) -> None:
    """Best-effort: make the new column about RIGHT_FRACTION of the width."""
    import iterm2

    try:
        left_id, right_id = left_session.session_id, right_session.session_id
        await app.async_refresh()  # sync the layout tree after the split (avoids WRONG_TREE)
        left = app.get_session_by_id(left_id)
        right = app.get_session_by_id(right_id)
        if left is None or right is None:
            return
        total = int(left.grid_size.width) + int(right.grid_size.width)
        if total <= 0:
            return
        right_w = max(20, int(total * RIGHT_FRACTION))
        left.preferred_size = iterm2.Size(max(20, total - right_w), int(left.grid_size.height))
        right.preferred_size = iterm2.Size(right_w, int(right.grid_size.height))
        tab = await find_tab(app, right_id)
        if tab is not None:
            await tab.async_update_layout()
    except Exception:
        log("RESIZE skipped\n" + traceback.format_exc())


async def rebalance_column(app, anchor_id, session_ids) -> None:
    """Equalize column pane heights AND pin the claude pane to its current width.

    Pinning the anchor is essential: async_update_layout redistributes the whole
    tab from preferred_size, so if the claude pane has no pinned size the vertical
    divider drifts a little on every add and the claude pane keeps shrinking.
    Widths are read live each call, so manual window/pane resizing is respected.
    """
    import iterm2

    try:
        await app.async_refresh()  # sync the layout tree after the split (avoids WRONG_TREE)
        sessions = [app.get_session_by_id(sid) for sid in session_ids]
        sessions = [s for s in sessions if s is not None]
        if not sessions:
            return

        anchor = app.get_session_by_id(anchor_id) if anchor_id else None
        if anchor is not None:
            # Hold the divider exactly where it is now.
            anchor.preferred_size = iterm2.Size(int(anchor.grid_size.width), int(anchor.grid_size.height))

        # Keep the column at its current width; split its current height evenly.
        # (A fixed large value would be read as an absolute target and grow the window.)
        col_w = int(sessions[0].grid_size.width)
        total_h = sum(int(s.grid_size.height) for s in sessions)
        each_h = max(2, total_h // len(sessions))
        for s in sessions:
            s.preferred_size = iterm2.Size(col_w, each_h)

        tab = await find_tab(app, sessions[0].session_id)
        if tab is not None:
            await tab.async_update_layout()
    except Exception:
        log("REBALANCE skipped\n" + traceback.format_exc())


async def create_fallback_window(connection, profile, col: dict):
    """No iTerm2 anchor: open a separate window pinned to the right of the screen."""
    import iterm2

    window = await iterm2.Window.async_create(connection, profile_customizations=profile)
    if window is None:
        raise RuntimeError("Window.async_create returned None")
    try:
        import AppKit

        vf = AppKit.NSScreen.mainScreen().visibleFrame()
        ox, oy = float(vf.origin.x), float(vf.origin.y)
        sw, sh = float(vf.size.width), float(vf.size.height)
        await window.async_set_frame(iterm2.Frame(
            origin=iterm2.Point(int(ox + sw * (1 - RIGHT_FRACTION)), int(oy)),
            size=iterm2.Size(int(sw * RIGHT_FRACTION), int(sh)),
        ))
    except Exception:
        log("FALLBACK frame skipped\n" + traceback.format_exc())
    col["window_id"] = window.window_id
    return window.tabs[0].sessions[0]


async def close_session_obj(app, session_id: str) -> None:
    session = app.get_session_by_id(session_id)
    if session is not None:
        try:
            await session.async_close(force=True)
        except Exception:
            pass


async def close_window_obj(app, window_id: str) -> None:
    window = app.get_window_by_id(window_id)
    if window is not None:
        try:
            await window.async_close(force=True)
        except Exception:
            pass


async def prune_dead_columns(app, state: dict) -> None:
    """Drop columns whose claude pane (anchor) no longer exists."""
    for anchor_id in list(state["sessions"].keys()):
        col = state["sessions"][anchor_id]
        if col.get("window_id"):
            continue  # fallback-window column, not anchored to a pane
        if app.get_session_by_id(anchor_id) is None:
            for agent_id in col.get("order", []):
                sid = state["panes"].pop(agent_id, None)
                if sid:
                    await close_session_obj(app, sid)
                clear_sentinel(agent_id)
            del state["sessions"][anchor_id]


async def do_open(connection, agent_id: str, agent_type: str, anchor_id: str, transcript_path: str) -> None:
    import iterm2

    app = await iterm2.async_get_app(connection)
    state = load_state()
    await prune_dead_columns(app, state)

    col = state["sessions"].get(anchor_id) or {"order": [], "window_id": None}
    profile = command_profile(agent_id, agent_type, transcript_path)

    session = None
    if col["order"]:
        # This session already has a column: stack a pane below its last one.
        last_sid = state["panes"].get(col["order"][-1])
        last = app.get_session_by_id(last_sid) if last_sid else None
        if last is not None:
            try:
                session = await last.async_split_pane(
                    vertical=False, before=False, profile_customizations=profile)
            except Exception:
                log("SPLIT failed (column full) agent_id={}\n{}".format(agent_id, traceback.format_exc()))
                return
    else:
        # First pane for this session: split the claude (anchor) pane to the right.
        anchor = app.get_session_by_id(anchor_id) if anchor_id else None
        if anchor is not None:
            try:
                session = await anchor.async_split_pane(
                    vertical=True, before=False, profile_customizations=profile)
                await resize_right_column(app, anchor, session)
            except Exception:
                log("ANCHOR split failed agent_id={}\n{}".format(agent_id, traceback.format_exc()))
                return
        else:
            session = await create_fallback_window(connection, profile, col)

    if session is None:
        return

    state["panes"][agent_id] = session.session_id
    if agent_id not in col["order"]:
        col["order"].append(agent_id)
    state["sessions"][anchor_id] = col
    await rebalance_column(app, anchor_id, [state["panes"][a] for a in col["order"]])
    save_state(state)
    log("OPEN ok agent_id={} type={} session={} anchor={} depth={}".format(
        agent_id, agent_type, session.session_id, (anchor_id or "-")[:8], len(col["order"])))


async def do_close(connection, agent_id: str) -> None:
    import iterm2

    app = await iterm2.async_get_app(connection)
    state = load_state()

    session_id = state["panes"].pop(agent_id, None)
    if session_id:
        await close_session_obj(app, session_id)
    clear_sentinel(agent_id)

    # Remove from its column and rebalance / clean up empty columns.
    for anchor_id in list(state["sessions"].keys()):
        col = state["sessions"][anchor_id]
        if agent_id in col["order"]:
            col["order"].remove(agent_id)
            if not col["order"]:
                if col.get("window_id"):
                    await close_window_obj(app, col["window_id"])
                del state["sessions"][anchor_id]
            else:
                await rebalance_column(app, anchor_id, [state["panes"][a] for a in col["order"]])
            break

    save_state(state)
    log("CLOSE ok agent_id={} session={}".format(agent_id, session_id))


async def do_reap(connection, anchor_id: str) -> None:
    """Close only THIS session's leftover panes (interrupted subagents)."""
    import iterm2

    app = await iterm2.async_get_app(connection)
    state = load_state()
    col = state["sessions"].pop(anchor_id, None)
    reaped = 0
    if col:
        for agent_id in col.get("order", []):
            sid = state["panes"].pop(agent_id, None)
            if sid:
                await close_session_obj(app, sid)
                reaped += 1
            clear_sentinel(agent_id)
        if col.get("window_id"):
            await close_window_obj(app, col["window_id"])
    save_state(state)
    log("REAP ok anchor={} reaped={}".format((anchor_id or "-")[:8], reaped))


async def do_close_all(connection) -> None:
    import iterm2

    app = await iterm2.async_get_app(connection)
    state = load_state()
    count = len(state.get("panes", {}))
    for agent_id, session_id in list(state.get("panes", {}).items()):
        await close_session_obj(app, session_id)
        clear_sentinel(agent_id)
    for col in state.get("sessions", {}).values():
        if col.get("window_id"):
            await close_window_obj(app, col["window_id"])
    save_state({"sessions": {}, "panes": {}})
    log("CLOSE_ALL ok cleared={}".format(count))


def run(coro_factory) -> None:
    import iterm2

    lock_fd = open(LOCK, "w")
    fcntl.flock(lock_fd, fcntl.LOCK_EX)
    try:
        iterm2.run_until_complete(coro_factory)
    finally:
        fcntl.flock(lock_fd, fcntl.LOCK_UN)
        lock_fd.close()


def _watchdog(signum, frame):
    log("WATCHDOG fired after {}s, aborting".format(WATCHDOG_SECS))
    os._exit(0)  # exit 0: the calling hook treats this as a clean no-op


def main() -> None:
    if len(sys.argv) < 2:
        sys.exit("usage: monitor.py open|close|reap|close_all|selftest ...")

    os.makedirs(DONE_DIR, exist_ok=True)
    signal.signal(signal.SIGALRM, _watchdog)
    signal.alarm(WATCHDOG_SECS)

    action = sys.argv[1]
    try:
        if action == "open":
            agent_id, agent_type = sys.argv[2], sys.argv[3]
            anchor_id = sys.argv[4] if len(sys.argv) > 4 else ""
            transcript_path = sys.argv[5] if len(sys.argv) > 5 and sys.argv[5] != "-" else ""
            run(lambda c: do_open(c, agent_id, agent_type, anchor_id, transcript_path))
        elif action == "close":
            agent_id = sys.argv[2]
            run(lambda c: do_close(c, agent_id))
        elif action == "reap":
            anchor_id = sys.argv[2] if len(sys.argv) > 2 else ""
            run(lambda c: do_reap(c, anchor_id))
        elif action == "close_all":
            run(do_close_all)
        elif action == "selftest":
            anchor_id = sys.argv[2] if len(sys.argv) > 2 else ""
            run(lambda c: do_open(c, "selftest-0000", "selftest", anchor_id, ""))
        else:
            sys.exit("unknown action: {}".format(action))
    except Exception:
        log("ERROR action={}\n{}".format(action, traceback.format_exc()))
    finally:
        signal.alarm(0)


if __name__ == "__main__":
    main()
