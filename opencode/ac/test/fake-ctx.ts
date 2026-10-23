import type { Plugin } from "@opencode/plugin"
import type { CommandDefinition, CommandEditor } from "@opencode/plugin/promise/command"
import type { PermissionHooks } from "@opencode/plugin/promise/permission"
import type { SessionHooks } from "@opencode/plugin/promise/session"
import type { Info, ToolEditor } from "@opencode/plugin/promise/tool"

type Context = Plugin.Context
type SessionApi = Context["session"]
type ToolHookCallback = Parameters<Parameters<Context["tool"]["hook"]>[1]>[0]
type ToolEntry = Info & { id: string }
type Subscribed = ReturnType<Context["event"]["subscribe"]> extends AsyncIterable<infer E> ? E : never
type Handler = (input: unknown) => Promise<void> | void

/** Hook inputs per name, derived from the SDK so a renamed hook breaks the fake at typecheck time. */
export interface ToolHookInputs {
    "execute.before": Exclude<ToolHookCallback, { status: unknown }>
    "execute.after": Extract<ToolHookCallback, { status: unknown }>
}

/** Hook inputs as tests write them: branded ids and nested SDK objects are supplied as plain strings. */
type Loose<T> = { [K in keyof T]?: T[K] extends string ? string : T[K] }

export interface FakeSession {
    id: string
    parentID?: string
}

export interface FakeCtxInput {
    options?: Readonly<Record<string, unknown>>
    /** Scripted answers for `session.get`, keyed by session id. */
    sessions?: Record<string, FakeSession>
}

export interface FakeCtx {
    /** The fake cast once to the SDK context; modules take `Plugin.Context` and never see the cast. */
    readonly ctx: Context
    readonly fire: {
        /** Runs every registered `session.hook` callback for `name`; resolves with the (possibly mutated) input. */
        session<N extends keyof SessionHooks>(name: N, input: Loose<SessionHooks[N]>): Promise<SessionHooks[N]>
        permission<N extends keyof PermissionHooks>(
            name: N,
            input: Loose<PermissionHooks[N]>,
        ): Promise<PermissionHooks[N]>
        tool<N extends keyof ToolHookInputs>(name: N, input: Loose<ToolHookInputs[N]>): Promise<ToolHookInputs[N]>
    }
    /** Feeds one event to every live `event.subscribe` iterator. */
    pushEvent(event: { type: string } & Record<string, unknown>): void
    /** Re-runs every registered `tool.transform` and `command.transform` callback against fresh editors. */
    applyTransforms(): void
    readonly tools: ReadonlyMap<string, ToolEntry>
    readonly commands: readonly CommandDefinition[]
    readonly calls: {
        readonly synthetic: Parameters<SessionApi["synthetic"]>[0][]
        readonly prompt: Parameters<SessionApi["prompt"]>[0][]
        readonly switchModel: Parameters<SessionApi["switchModel"]>[0][]
        readonly get: Parameters<SessionApi["get"]>[0][]
    }
}

class HookRegistry {
    private readonly handlers = new Map<string, Handler[]>()

    register(name: string, handler: Handler): { dispose: () => Promise<void> } {
        this.handlers.set(name, [...(this.handlers.get(name) ?? []), handler])
        return {
            dispose: async () => {
                this.handlers.set(
                    name,
                    (this.handlers.get(name) ?? []).filter((candidate) => candidate !== handler),
                )
            },
        }
    }

    async fire<Input>(name: string, input: Input): Promise<Input> {
        for (const handler of this.handlers.get(name) ?? []) await handler(input)
        return input
    }
}

interface Subscriber {
    queue: Subscribed[]
    wake?: () => void
    closed: boolean
}

function toolId(tool: Info): string {
    const namespace = tool.options?.namespace
    return namespace === undefined ? tool.name : `${namespace.replaceAll(".", "_")}_${tool.name}`
}

export function createFakeCtx(input: FakeCtxInput = {}): FakeCtx {
    const sessionHooks = new HookRegistry()
    const permissionHooks = new HookRegistry()
    const toolHooks = new HookRegistry()
    const toolTransforms: Array<(editor: ToolEditor) => void> = []
    const commandTransforms: Array<(editor: CommandEditor) => void> = []
    const subscribers = new Set<Subscriber>()
    const tools = new Map<string, ToolEntry>()
    const commands: CommandDefinition[] = []
    const calls: FakeCtx["calls"] = { synthetic: [], prompt: [], switchModel: [], get: [] }

    const toolEditor: ToolEditor = {
        list: () => [...tools.values()],
        get: (id) => tools.get(id),
        namespace: () => {},
        add: (tool) => {
            tools.set(toolId(tool), { ...tool, id: toolId(tool) })
        },
        update: (id, update) => {
            const entry = tools.get(id)
            if (entry) update(entry)
        },
        remove: (id) => {
            tools.delete(id)
        },
    }
    const commandEditor: CommandEditor = { add: (definition) => void commands.push(definition) }

    const close = (subscriber: Subscriber): void => {
        subscriber.closed = true
        subscribers.delete(subscriber)
        subscriber.wake?.()
    }

    const subscribe = (options?: { signal?: AbortSignal }): AsyncIterable<Subscribed> => {
        const subscriber: Subscriber = { queue: [], closed: false }
        subscribers.add(subscriber)
        options?.signal?.addEventListener("abort", () => close(subscriber))
        return {
            [Symbol.asyncIterator]: () => ({
                next: async () => {
                    while (subscriber.queue.length === 0 && !subscriber.closed) {
                        await new Promise<void>((resolve) => (subscriber.wake = resolve))
                    }
                    const event = subscriber.queue.shift()
                    return event === undefined
                        ? { done: true as const, value: undefined }
                        : { done: false as const, value: event }
                },
                return: async () => {
                    close(subscriber)
                    return { done: true as const, value: undefined }
                },
            }),
        }
    }

    const session = {
        hook: async (name: string, callback: Handler) => sessionHooks.register(name, callback),
        get: async (query: { sessionID: string }) => {
            calls.get.push(query as Parameters<SessionApi["get"]>[0])
            const scripted = input.sessions?.[query.sessionID]
            if (!scripted) throw new Error(`fake ctx: no scripted session "${query.sessionID}"`)
            return scripted
        },
        synthetic: async (call: Parameters<SessionApi["synthetic"]>[0]) => void calls.synthetic.push(call),
        prompt: async (call: Parameters<SessionApi["prompt"]>[0]) => void calls.prompt.push(call),
        switchModel: async (call: Parameters<SessionApi["switchModel"]>[0]) => void calls.switchModel.push(call),
    }

    const ctx = {
        options: input.options ?? {},
        session,
        permission: { hook: async (name: string, callback: Handler) => permissionHooks.register(name, callback) },
        tool: {
            hook: async (name: string, callback: Handler) => toolHooks.register(name, callback),
            transform: async (callback: (editor: ToolEditor) => void) => {
                toolTransforms.push(callback)
                return { dispose: async () => {} }
            },
        },
        command: {
            transform: async (callback: (editor: CommandEditor) => void) => {
                commandTransforms.push(callback)
                return { dispose: async () => {} }
            },
        },
        event: { subscribe },
    } as unknown as Context

    return {
        ctx,
        fire: {
            session: (name, payload) => sessionHooks.fire(name, payload as SessionHooks[typeof name]),
            permission: (name, payload) => permissionHooks.fire(name, payload as PermissionHooks[typeof name]),
            tool: (name, payload) => toolHooks.fire(name, payload as ToolHookInputs[typeof name]),
        },
        pushEvent: (event) => {
            for (const subscriber of subscribers) {
                subscriber.queue.push(event as unknown as Subscribed)
                subscriber.wake?.()
            }
        },
        applyTransforms: () => {
            tools.clear()
            commands.length = 0
            for (const transform of toolTransforms) transform(toolEditor)
            for (const transform of commandTransforms) transform(commandEditor)
        },
        tools,
        commands,
        calls,
    }
}
