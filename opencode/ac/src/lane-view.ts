import { laneStatus } from "./coordinate.ts"

/** One row of the TUI's Lanes panel. */
export interface LaneRow {
    readonly sessionID: string
    readonly bundle: string
    readonly coordSlug: string
    /** The status of the lane's last relayed LANE STATUS block; undefined until the first park. */
    readonly status?: string
    /** `failed` when the lane session itself errored, from the relay's `state`. */
    readonly state?: string
}

interface SessionLike {
    readonly id: string
    readonly parentID?: string
    readonly metadata?: unknown
    readonly time?: { readonly created?: number }
}

interface MessageLike {
    readonly type: string
    readonly metadata?: unknown
    readonly text?: unknown
}

interface Relay {
    readonly status?: string
    readonly state?: string
}

function laneMeta(metadata: unknown): { coordinator_session: string; bundle: string; coord_slug: string } | undefined {
    const lane = (metadata as { ac_lane?: unknown } | undefined)?.ac_lane
    if (typeof lane !== "object" || lane === null) return undefined
    const { coordinator_session, bundle, coord_slug } = lane as Record<string, unknown>
    if (typeof coordinator_session !== "string" || typeof bundle !== "string" || typeof coord_slug !== "string") {
        return undefined
    }
    return { coordinator_session, bundle, coord_slug }
}

/**
 * The lane status relayed in one coordinator message, or undefined when the message is not a lane relay. The plugin
 * tags every relay with `metadata.source = "ac_lane"` (src/coordinate.ts), so other synthetic messages never match.
 */
export function relayOf(message: MessageLike): ({ lane: string } & Relay) | undefined {
    const metadata = message.metadata as Record<string, unknown> | undefined
    if (message.type !== "synthetic" || metadata?.source !== "ac_lane" || typeof metadata.lane !== "string") {
        return undefined
    }
    const text = typeof message.text === "string" ? message.text : ""
    return {
        lane: metadata.lane,
        status: laneStatus(text),
        state: typeof metadata.state === "string" ? metadata.state : undefined,
    }
}

/**
 * The lanes a coordinator started, oldest first, each with its last relayed status. Lanes are root sessions, so the
 * host's own subagent view never lists them; a session with a parent inherited the metadata and is skipped.
 */
export function laneRows(
    sessions: readonly SessionLike[],
    coordinatorID: string,
    messages: readonly MessageLike[],
): LaneRow[] {
    const relays = new Map<string, Relay>()
    for (const message of messages) {
        const relay = relayOf(message)
        if (relay) relays.set(relay.lane, { status: relay.status, state: relay.state })
    }

    return sessions
        .filter((session) => session.parentID === undefined)
        .map((session) => ({ session, meta: laneMeta(session.metadata) }))
        .filter(({ meta }) => meta?.coordinator_session === coordinatorID)
        .sort((a, b) => (a.session.time?.created ?? 0) - (b.session.time?.created ?? 0))
        .map(({ session, meta }) => ({
            sessionID: session.id,
            bundle: meta?.bundle as string,
            coordSlug: meta?.coord_slug as string,
            ...relays.get(session.id),
        }))
}
