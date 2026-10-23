import type { SessionInfo } from "@opencode/client"
import { Plugin } from "@opencode/plugin/tui"
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { type LaneRow, laneRows, relayOf } from "./src/lane-view.ts"

/** How often the panel re-reads the session list while it is mounted; a lane relay refreshes it at once. */
const REFRESH_MS = 10_000

/** The host keys lane sessions by title (`lane <slug>/<bundle>`, src/coordinate.ts), which narrows the list call. */
const LANE_TITLE_SEARCH = "lane "

type Context = Plugin.Context

/**
 * A "Lanes" section in the coordinator session's sidebar. Lanes are root sessions in their own worktrees, so the
 * host's subagent view, which follows the parentID family, never shows them; this lists the lanes the session
 * started, their last relayed LANE STATUS, and opens a lane's session on click.
 */
function LanesPanel(props: { context: Context; sessionID: string }) {
    const { context } = props
    const theme = context.theme
    const [sessions, setSessions] = createSignal<readonly SessionInfo[]>([])

    const refresh = (): void => {
        context.client.session
            .list({ parentID: null, search: LANE_TITLE_SEARCH, limit: 100 })
            .then((page) => setSessions(page.data))
            .catch((error: unknown) => console.error("ac lanes panel: session list failed", error))
    }
    refresh()
    const timer = setInterval(refresh, REFRESH_MS)
    const stop = context.data.on("session.synthetic", (event) => {
        if (event.data.sessionID === props.sessionID && event.data.metadata?.source === "ac_lane") refresh()
    })
    onCleanup(() => {
        clearInterval(timer)
        stop()
    })

    const rows = createMemo(() =>
        laneRows(sessions(), props.sessionID, context.data.session.message.list(props.sessionID)),
    )

    // A tab keeps the coordinator one keystroke away; without tabs the session route replaces it.
    const open = (row: LaneRow): void => {
        if (context.ui.tabs.focus(row.sessionID)) return
        context.ui.router.navigate({ type: "session", sessionID: row.sessionID })
    }
    const running = (row: LaneRow): boolean => context.data.session.status(row.sessionID) === "running"

    return (
        <Show when={rows().length > 0}>
            <box>
                <text fg={theme.text.base}>
                    <b>Lanes</b>
                    <span style={{ fg: theme.text.muted }}> ({rows()[0]?.coordSlug})</span>
                </text>
                <For each={rows()}>
                    {(row) => (
                        <box flexDirection="row" gap={1} onMouseDown={() => open(row)}>
                            <text fg={running(row) ? theme.text.base : theme.text.muted}>
                                {running(row) ? "●" : "○"}
                            </text>
                            <text fg={theme.text.base}>{row.bundle}</text>
                            <text fg={row.state === "failed" ? theme.text.base : theme.text.muted}>
                                {row.state === "failed" ? "session failed" : (row.status ?? "started")}
                            </text>
                        </box>
                    )}
                </For>
                <text fg={theme.text.faint}>click a lane to open its session</text>
            </box>
        </Show>
    )
}

export default Plugin.define({
    id: "ac.lanes",
    setup(context) {
        context.ui.slot({
            append: "sidebar.content",
            render: (props) => <LanesPanel context={context} sessionID={props.sessionID} />,
        })

        // A lane park also shows as a toast; when the lane's session is not open, the toast offers to open it.
        const stop = context.data.on("session.synthetic", (event) => {
            const relay = relayOf({ type: "synthetic", metadata: event.data.metadata, text: event.data.text })
            if (!relay) return
            const bundle = typeof event.data.metadata?.bundle === "string" ? event.data.metadata.bundle : "lane"
            context.ui.toast.show({
                title: `Lane ${bundle}`,
                message: relay.state === "failed" ? "session failed" : (relay.status ?? "parked"),
                sessionID: relay.lane,
            })
        })
        return () => stop()
    },
})
