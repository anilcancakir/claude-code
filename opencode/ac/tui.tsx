import type { SessionInfo } from "@opencode/client"
import { Plugin } from "@opencode/plugin/tui"
import { type Accessor, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { footerLanes, type LaneRow, laneRows, relayOf } from "./src/lane-view.ts"

/** How often the lane list is re-read while a view shows it; a lane relay refreshes it at once. */
const REFRESH_MS = 10_000

/** Lane sessions are titled `lane <slug>/<bundle>` (src/coordinate.ts), which narrows the list call. */
const LANE_TITLE_SEARCH = "lane "

type Context = Plugin.Context

/**
 * The lane sessions every view of this TUI reads, fetched by one poller that runs only while a view is mounted.
 * Lanes are root sessions in their own worktrees, so the host's subagent views, which follow the parentID family,
 * never show them, and the list has to come from the session API.
 */
function createLaneSource(context: Context) {
    const [sessions, setSessions] = createSignal<readonly SessionInfo[]>([])
    let viewers = 0
    let timer: ReturnType<typeof setInterval> | undefined

    const refresh = (): void => {
        context.client.session
            .list({ parentID: null, search: LANE_TITLE_SEARCH, limit: 100 })
            .then((page) => setSessions(page.data))
            .catch((error: unknown) => console.error("ac lanes: session list failed", error))
    }

    /** Rows for one coordinator session; call inside a component so the poller stops when the view goes. */
    const rows = (sessionID: Accessor<string | undefined>): Accessor<LaneRow[]> => {
        viewers++
        if (viewers === 1) {
            refresh()
            timer = setInterval(refresh, REFRESH_MS)
        }
        onCleanup(() => {
            viewers--
            if (viewers === 0 && timer !== undefined) clearInterval(timer)
        })
        return createMemo(() => {
            const id = sessionID()
            return id === undefined ? [] : laneRows(sessions(), id, context.data.session.message.list(id))
        })
    }

    return { refresh, rows, current: () => sessions() }
}

/** A tab keeps the coordinator one keystroke away; without tabs the session route replaces it. */
function openLane(context: Context, sessionID: string): void {
    if (context.ui.tabs.focus(sessionID)) return
    context.ui.router.navigate({ type: "session", sessionID })
}

/** One line in the prompt footer: `lanes ● b12  ○ b8 planned  3 done`; click a lane to open its session. */
function LanesFooter(props: { context: Context; source: ReturnType<typeof createLaneSource>; sessionID?: string }) {
    const { context } = props
    const theme = context.theme
    const rows = props.source.rows(() => props.sessionID)
    const view = createMemo(() => footerLanes(rows(), (id) => context.data.session.status(id) === "running"))

    return (
        <Show when={rows().length > 0}>
            <box flexDirection="row" gap={1} flexShrink={0}>
                <text fg={theme.text.muted} wrapMode="none">
                    lanes
                </text>
                <For each={view().lanes}>
                    {(lane) => (
                        <box flexShrink={0} onMouseUp={() => openLane(context, lane.sessionID)}>
                            <text fg={lane.running ? theme.text.base : theme.text.muted} wrapMode="none">
                                {lane.running ? "● " : "○ "}
                                <span style={{ fg: theme.text.base }}>{lane.bundle}</span>
                                <Show when={lane.label}> {lane.label}</Show>
                            </text>
                        </box>
                    )}
                </For>
                <Show when={view().settled > 0}>
                    <text fg={theme.text.muted} wrapMode="none">
                        {view().settled} done
                    </text>
                </Show>
            </box>
        </Show>
    )
}

/** The same lanes in the sidebar, one per row with its last relayed LANE STATUS. */
function LanesSidebar(props: { context: Context; source: ReturnType<typeof createLaneSource>; sessionID: string }) {
    const { context } = props
    const theme = context.theme
    const rows = props.source.rows(() => props.sessionID)
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
                        <box flexDirection="row" gap={1} onMouseDown={() => openLane(context, row.sessionID)}>
                            <text fg={running(row) ? theme.text.base : theme.text.muted}>
                                {running(row) ? "●" : "○"}
                            </text>
                            <text fg={theme.text.base}>{row.bundle}</text>
                            <text fg={theme.text.muted}>
                                {row.state === "failed" ? "session failed" : (row.status ?? "started")}
                            </text>
                        </box>
                    )}
                </For>
            </box>
        </Show>
    )
}

export default Plugin.define({
    id: "ac.lanes",
    setup(context) {
        const source = createLaneSource(context)

        context.ui.slot({
            append: "prompt.footer.status",
            render: (props) => <LanesFooter context={context} source={source} sessionID={props.sessionID} />,
        })
        context.ui.slot({
            append: "sidebar.content",
            render: (props) => <LanesSidebar context={context} source={source} sessionID={props.sessionID} />,
        })

        // 1. A picker for the keyboard: ctrl+p "Open a coordinate lane", or /lanes.
        const currentRows = (): LaneRow[] => {
            const route = context.ui.router.current()
            if (route.type !== "session") return []
            const messages = context.data.session.message.list(route.sessionID)
            return laneRows(source.current(), route.sessionID, messages)
        }
        context.keymap.layer(() => ({
            mode: "global",
            commands: [
                {
                    id: "ac.lanes.open",
                    title: "Open a coordinate lane",
                    description: "Jump to one of the lanes this coordinator session started",
                    group: "Session",
                    palette: true,
                    slash: { name: "lanes" },
                    async run() {
                        source.refresh()
                        const rows = currentRows()
                        if (rows.length === 0) {
                            context.ui.toast.show({ message: "This session started no coordinate lanes." })
                            return
                        }
                        const picked = await context.ui.dialog.select({
                            title: "Coordinate lanes",
                            options: rows.map((row) => ({
                                title: row.bundle,
                                value: row.sessionID,
                                description: row.state === "failed" ? "session failed" : (row.status ?? "started"),
                            })),
                        })
                        if (picked !== undefined) openLane(context, picked)
                    },
                },
            ],
        }))

        // 2. Attention only where a person is needed. templates/cli.json turns off the built-in
        //    opencode.notifications, which also fires on every session end, a lane's and every subagent's included;
        //    here a question alone notifies and plays its sound. A failed session keeps the in-app toast.
        const asked = new Set<string>()
        const stopQuestions = [
            context.data.on("form.created", (event) => {
                const form = event.data.form
                if (asked.has(form.id)) return
                asked.add(form.id)
                const session = context.data.session.get(form.sessionID)
                void context.attention.notify({
                    title: form.title ?? session?.title,
                    message: "Input needs response",
                    notification: { when: "blurred" },
                    sound: { name: "question", when: "always" },
                })
            }),
            context.data.on("form.replied", (event) => asked.delete(event.data.id)),
            context.data.on("form.cancelled", (event) => asked.delete(event.data.id)),
            context.data.on("session.execution.failed", (event) => {
                if (event.data.error.type === "provider.free-limit") return
                context.ui.toast.show({
                    sessionID: event.data.sessionID,
                    title: "Session failed",
                    message: event.data.error.message,
                    variant: "error",
                })
            }),
        ]

        // 3. A lane park also shows as a toast; when the lane's session is not open, the toast offers to open it.
        //    A relay is a synthetic inbox item, published as `session.inbox.enqueued` (core/src/session/inbox.ts:186).
        const stop = context.data.on("session.inbox.enqueued", (event) => {
            const item = event.data.item
            if (item.type !== "synthetic") return
            const metadata = item.payload.metadata
            const relay = relayOf({ type: "synthetic", metadata, text: item.payload.text })
            if (!relay) return
            source.refresh()
            const bundle = typeof metadata?.bundle === "string" ? metadata.bundle : "lane"
            context.ui.toast.show({
                title: `Lane ${bundle}`,
                message: relay.state === "failed" ? "session failed" : (relay.status ?? "parked"),
                sessionID: relay.lane,
            })
        })
        return () => {
            stop()
            for (const cleanup of stopQuestions) cleanup()
        }
    },
})
