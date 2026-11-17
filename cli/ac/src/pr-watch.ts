import { execFile, type ExecFileException } from "node:child_process";

/**
 * One watch over one pull request. Every duration is in seconds; `head` is the full SHA the caller
 * pushed, and the verdict is only ever about that commit.
 */
export interface PrWatchOptions {
    readonly pr: string;
    /** `owner/name`; when absent the watch uses gh's `{owner}/{repo}` placeholders and passes no `-R`. */
    readonly repo?: string;
    readonly head: string;
    /** Checks whose name matches are reported but are not a gate. */
    readonly ignore?: RegExp;
    readonly intervalSeconds: number;
    readonly startWaitSeconds: number;
    readonly queueLimitSeconds: number;
    readonly botsWaitSeconds: number;
    /** Emit the comments that already exist when the watch starts instead of recording them as a baseline. */
    readonly includeExisting: boolean;
}

export interface GhResult {
    readonly code: number;
    readonly stdout: string;
    readonly stderr: string;
}

export interface PrWatchDeps {
    /** Runs the gh binary. A spawn failure (ENOENT) resolves to `{ code: 127 }`; it never rejects. */
    gh(args: readonly string[]): Promise<GhResult>;
    /** Wall clock in milliseconds. */
    now(): number;
    sleep(ms: number): Promise<void>;
    /** One event line, without a trailing newline. */
    write(line: string): void;
}

type Exit = 0 | 1 | 2;
type StuckReason =
    | "gh-unavailable"
    | "gh-failing"
    | "head-never-appeared"
    | "no-checks"
    | "pr-not-found"
    | "queued"
    | "superseded";
type CommentKind = "comment" | "inline" | "review";

interface Check {
    readonly name: string;
    readonly bucket: string;
    readonly state: string;
    /** gh keeps one entry per name, workflow and event, so two entries can share a name. */
    readonly workflow: string;
    readonly event: string;
}

interface Failure {
    readonly failure: string;
    /** No later tick can fare better (gh missing, not logged in, no such pull request): the watch ends with this reason. */
    readonly fatal?: StuckReason;
}

interface Verdict {
    readonly exit: Exit;
}

type Outcome = Verdict | Failure | undefined;

type Fetched =
    | { readonly kind: "unchanged" }
    | { readonly kind: "ok"; readonly body: unknown }
    | { readonly kind: "failed"; readonly detail: string; readonly fatal?: StuckReason };

interface CommentEndpoint {
    readonly kind: CommentKind;
    readonly path: string;
}

interface CommentEvent {
    readonly id: number;
    readonly key: string;
    readonly line: string;
}

interface HttpResponse {
    readonly status: number;
    readonly etag: string | undefined;
    readonly hasNext: boolean;
    readonly body: string;
}

// gh exits 4 when a command needs authentication (`gh help exit-codes`); 127 is what `runGh` reports when
// the binary is not on PATH. `gh auth status` is not used instead: it exits 1 when any other account or
// host has a problem, even though the active account works.
const GH_AUTH_REQUIRED_CODE = 4;
const GH_MISSING_CODE = 127;
const GH_TIMEOUT_MILLIS = 30_000;
const GH_MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const BODY_LIMIT = 300;
const EVENTS_PER_TICK = 25;
const FAILURE_FIRST_NOTE = 3;
const FAILURE_NOTE_EVERY = 15;
const FAILURE_DETAIL_LIMIT = 160;

/**
 * Watches one pull request until its head commit is green, red or cannot be gated, writing one event
 * line per check settle, comment, review, gate result and verdict. The verdict line is always the last
 * line written. A gh failure is a handled result, never a throw; the caller's `timeout` bounds the run.
 *
 * @returns 0 green, 1 red, 2 stuck (gh unavailable, head never appeared or superseded, no checks, queued).
 */
export async function runPrWatch(options: PrWatchOptions, deps: PrWatchDeps): Promise<Exit> {
    return new PrWatch(options, deps).run();
}

export function defaultPrWatchDeps(): PrWatchDeps {
    return {
        gh: runGh,
        now: () => Date.now(),
        sleep: (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)),
        write: (line: string): void => {
            process.stdout.write(`${line}\n`);
        },
    };
}

/**
 * Flattens a comment body to one line: HTML comments and `<picture>` blocks removed, whitespace runs
 * collapsed, cut to 300 characters plus `...`. An empty result reads `(no text)`.
 */
export function formatBody(body: string): string {
    const text = body
        .replace(/<!--[\s\S]*?-->/g, " ")
        .replace(/<picture\b[\s\S]*?<\/picture>/gi, " ")
        .replace(/\s+/g, " ")
        .trim();
    if (text === "") {
        return "(no text)";
    }

    const characters = Array.from(text);

    return characters.length > BODY_LIMIT ? `${characters.slice(0, BODY_LIMIT).join("")}...` : text;
}

class PrWatch {
    private readonly options: PrWatchOptions;
    private readonly deps: PrWatchDeps;
    private readonly headPath: string;
    private readonly endpoints: readonly CommentEndpoint[];
    private readonly etags = new Map<string, string>();
    private readonly paginated = new Set<string>();
    private readonly settled = new Map<string, string>();
    private readonly seen = new Set<string>();
    private readonly baselines = new Map<CommentKind, number>();
    private began = 0;
    private lastHead: string | undefined;
    private headMatched = false;
    private gateSeen = false;
    private queuedSince: number | undefined;
    private gateAt: number | undefined;
    private failures = 0;
    private readonly sweepFailures = new Map<CommentKind, number>();

    constructor(options: PrWatchOptions, deps: PrWatchDeps) {
        this.options = options;
        this.deps = deps;
        const slug = options.repo ?? "{owner}/{repo}";
        this.headPath = `repos/${slug}/pulls/${options.pr}`;
        this.endpoints = [
            {
                kind: "comment",
                path: `repos/${slug}/issues/${options.pr}/comments?per_page=100`,
            },
            {
                kind: "inline",
                path: `repos/${slug}/pulls/${options.pr}/comments?per_page=100`,
            },
            {
                kind: "review",
                path: `repos/${slug}/pulls/${options.pr}/reviews?per_page=100`,
            },
        ];
    }

    async run(): Promise<Exit> {
        this.deps.write(`WATCH pr=${this.options.pr} head=${short(this.options.head)}`);
        this.began = this.deps.now();

        for (;;) {
            const exit = await this.tick();
            if (exit !== undefined) {
                return exit;
            }
            await this.deps.sleep(this.options.intervalSeconds * 1000);
        }
    }

    private async tick(): Promise<Exit | undefined> {
        // 1. Head pin and checks decide the verdict; a failure there leaves every gate state untouched.
        const outcome = await this.gateHead();
        if (outcome !== undefined && "exit" in outcome) {
            return outcome.exit;
        }

        // 2. Only head and checks count toward the failure note; a failed sweep is just skipped.
        if (outcome !== undefined && outcome.fatal !== undefined) {
            return this.stuck(this.options.head, outcome.fatal).exit;
        }
        if (outcome === undefined) {
            this.failures = 0;
        } else {
            this.recordFailure(outcome.failure);
            // Like the head that never shows: before the first gate check, a gh that keeps failing is a CI that
            // cannot be read, and the caller should not wait out its whole timeout to hear it.
            if (!this.gateSeen && this.deps.now() - this.began >= this.options.startWaitSeconds * 1000) {
                return this.stuck(this.options.head, "gh-failing").exit;
            }
        }

        // 3. Comments are swept whatever the gate said, so review text arrives while CI runs.
        await this.sweep();

        return undefined;
    }

    private async gateHead(): Promise<Outcome> {
        const head = await this.readHead();
        if (typeof head !== "string") {
            return head;
        }

        if (head !== this.options.head) {
            if (this.headMatched) {
                return this.stuck(head, "superseded");
            }

            const expired = this.deps.now() - this.began >= this.options.startWaitSeconds * 1000;

            return expired ? this.stuck(this.options.head, "head-never-appeared") : undefined;
        }

        this.headMatched = true;
        const checks = await this.readChecks();
        if ("failure" in checks) {
            return checks;
        }

        return this.gate(checks);
    }

    private async gate(checks: readonly Check[]): Promise<Outcome> {
        const now = this.deps.now();
        for (const check of checks) {
            this.reportCheck(check);
        }

        const gates = checks.filter((check) => !this.ignored(check.name));
        if (gates.length === 0) {
            const expired = !this.gateSeen && now - this.began >= this.options.startWaitSeconds * 1000;

            return expired ? this.stuck(this.options.head, "no-checks") : undefined;
        }
        this.gateSeen = true;

        if (gates.some((check) => check.bucket === "fail" || check.bucket === "cancel")) {
            await this.sweep();

            return this.settle("red");
        }

        const pendingGates = gates.filter((check) => check.bucket === "pending");
        if (pendingGates.length > 0) {
            return this.watchQueue(pendingGates, now);
        }
        this.queuedSince = undefined;

        return this.settleGreen(checks, now);
    }

    private watchQueue(pendingGates: readonly Check[], now: number): Outcome {
        // A job no runner picks up stays QUEUED forever; anything actually running resets the clock.
        const queued = pendingGates.every((check) => check.state === "QUEUED" || check.state === "WAITING");
        if (!queued) {
            this.queuedSince = undefined;

            return undefined;
        }

        this.queuedSince ??= now;

        return now - this.queuedSince >= this.options.queueLimitSeconds * 1000
            ? this.stuck(this.options.head, "queued")
            : undefined;
    }

    private async settleGreen(checks: readonly Check[], now: number): Promise<Outcome> {
        if (this.gateAt === undefined) {
            this.deps.write("GATE green");
            this.gateAt = now;
        }

        const bots = checks.filter((check) => this.ignored(check.name) && check.bucket === "pending");
        if (bots.length > 0) {
            if (now - this.gateAt < this.options.botsWaitSeconds * 1000) {
                return undefined;
            }
            this.deps.write(`NOTE bots still pending: ${bots.map((check) => check.name).join(", ")}`);
        }

        // A push between the checks read and now would make this green belong to the previous head.
        const head = await this.readHead();
        if (typeof head !== "string") {
            return head;
        }
        if (head !== this.options.head) {
            return this.stuck(head, "superseded");
        }

        await this.sweep();

        return this.settle("green");
    }

    private reportCheck(check: Check): void {
        const key = `${check.name}\u0000${check.workflow}\u0000${check.event}`;
        if (check.bucket === "pending" || this.settled.get(key) === check.bucket) {
            return;
        }

        this.settled.set(key, check.bucket);
        const suffix = this.ignored(check.name) ? " (not a gate)" : "";
        this.deps.write(`CHECK ${check.name}: ${check.bucket}${suffix}`);
    }

    private ignored(name: string): boolean {
        return this.options.ignore?.test(name) ?? false;
    }

    private async readHead(): Promise<string | Failure> {
        const fetched = await this.fetch(this.headPath);
        if (fetched.kind === "failed") {
            return { failure: fetched.detail, fatal: fetched.fatal };
        }

        if (fetched.kind === "ok") {
            const body = fetched.body;
            const sha = isRecord(body) && isRecord(body.head) ? body.head.sha : undefined;
            if (typeof sha !== "string") {
                return { failure: `no head.sha in gh api ${this.headPath}` };
            }
            this.lastHead = sha;
        }

        return this.lastHead ?? { failure: `no head.sha in gh api ${this.headPath}` };
    }

    private async readChecks(): Promise<readonly Check[] | Failure> {
        const repo = this.options.repo === undefined ? [] : ["-R", this.options.repo];
        const result = await this.deps.gh([
            "pr",
            "checks",
            this.options.pr,
            ...repo,
            "--json",
            "name,bucket,state,workflow,event",
        ]);

        // `gh pr checks --json` exits 0 with failing checks; non-zero means the call itself went wrong,
        // except for a PR that has no check yet.
        if (result.code !== 0) {
            if (unusable(result.code)) {
                return { failure: failureDetail(result, "gh is unavailable"), fatal: "gh-unavailable" };
            }
            if (`${result.stdout}\n${result.stderr}`.includes("no checks reported")) {
                return [];
            }

            return { failure: failureDetail(result, "gh pr checks failed") };
        }

        const parsed = parseJson(result.stdout);
        if (!Array.isArray(parsed) || !parsed.every(isCheck)) {
            return { failure: "unreadable gh pr checks reply" };
        }

        return parsed.map((check) => ({
            name: check.name,
            bucket: check.bucket,
            state: check.state,
            workflow: typeof check.workflow === "string" ? check.workflow : "",
            event: typeof check.event === "string" ? check.event : "",
        }));
    }

    private async sweep(): Promise<void> {
        let shown = 0;
        let hidden = 0;

        for (const endpoint of this.endpoints) {
            const fetched = await this.fetch(endpoint.path);
            this.noteSweep(endpoint.kind, fetched);
            if (fetched.kind !== "ok" || !Array.isArray(fetched.body)) {
                continue;
            }

            const events = commentEvents(endpoint.kind, fetched.body);
            const fresh = events.filter((event) => !this.seen.has(event.key));
            for (const event of fresh) {
                this.seen.add(event.key);
            }

            if (!this.baselines.has(endpoint.kind)) {
                this.baselines.set(endpoint.kind, events.length);
                if (!this.options.includeExisting) {
                    this.writeBaselineWhenComplete();
                    continue;
                }
            }

            for (const event of fresh) {
                if (shown < EVENTS_PER_TICK) {
                    this.deps.write(event.line);
                    shown += 1;
                } else {
                    hidden += 1;
                }
            }
        }

        if (hidden > 0) {
            this.deps.write(`NOTE ${hidden} more comment events not shown, read them with gh api`);
        }
    }

    // A sweep that keeps failing (gh without --slurp, a 403 on one endpoint) would otherwise lose that kind of
    // comment without a word; one note per run of failures is enough.
    private noteSweep(kind: CommentKind, fetched: Fetched): void {
        if (fetched.kind !== "failed") {
            this.sweepFailures.set(kind, 0);

            return;
        }

        const failures = (this.sweepFailures.get(kind) ?? 0) + 1;
        this.sweepFailures.set(kind, failures);
        if (failures === FAILURE_FIRST_NOTE) {
            this.deps.write(`NOTE ${kind} sweep failing: ${fetched.detail.slice(0, FAILURE_DETAIL_LIMIT)}`);
        }
    }

    private writeBaselineWhenComplete(): void {
        if (this.baselines.size !== this.endpoints.length) {
            return;
        }

        const comments = this.baselines.get("comment") ?? 0;
        const inline = this.baselines.get("inline") ?? 0;
        const reviews = this.baselines.get("review") ?? 0;
        this.deps.write(`BASELINE comments=${comments} inline=${inline} reviews=${reviews}`);
    }

    /**
     * Conditional GET of one API path. A stored etag turns an unchanged resource into a 304 that costs
     * no rate limit; a paginated resource is read whole from then on, since page 1 cannot vouch for the
     * pages after it.
     */
    private async fetch(path: string): Promise<Fetched> {
        if (this.paginated.has(path)) {
            return this.fetchAllPages(path);
        }

        const etag = this.etags.get(path);
        const conditional = etag === undefined ? [] : ["-H", `If-None-Match: ${etag}`];
        const result = await this.deps.gh(["api", "-i", ...conditional, path]);
        if (unusable(result.code)) {
            return { kind: "failed", detail: failureDetail(result, "gh is unavailable"), fatal: "gh-unavailable" };
        }

        const response = parseHttpResponse(result.stdout);

        // gh exits non-zero on a 304, so the status line decides, not the exit code.
        if (response === undefined) {
            return { kind: "failed", detail: failureDetail(result, `no HTTP status from gh api ${path}`) };
        }
        if (response.status === 304) {
            return { kind: "unchanged" };
        }
        if (response.status !== 200) {
            const detail = failureDetail(result, `HTTP ${response.status} from gh api ${path}`);

            return response.status === 404
                ? { kind: "failed", detail, fatal: "pr-not-found" }
                : { kind: "failed", detail };
        }
        if (response.hasNext) {
            this.paginated.add(path);

            return this.fetchAllPages(path);
        }

        const body = parseJson(response.body);
        if (body === undefined) {
            return { kind: "failed", detail: `unreadable reply from gh api ${path}` };
        }
        if (response.etag !== undefined) {
            this.etags.set(path, response.etag);
        }

        return { kind: "ok", body };
    }

    private async fetchAllPages(path: string): Promise<Fetched> {
        const result = await this.deps.gh(["api", "--paginate", "--slurp", path]);
        if (result.code !== 0) {
            return { kind: "failed", detail: failureDetail(result, `gh api --paginate ${path} failed`) };
        }

        const pages = parseJson(result.stdout);
        if (!Array.isArray(pages) || !pages.every((page) => Array.isArray(page))) {
            return { kind: "failed", detail: `unreadable reply from gh api --paginate ${path}` };
        }

        return { kind: "ok", body: pages.flat() };
    }

    private recordFailure(detail: string): void {
        this.failures += 1;
        const due = this.failures === FAILURE_FIRST_NOTE
            || (this.failures > FAILURE_FIRST_NOTE && (this.failures - FAILURE_FIRST_NOTE) % FAILURE_NOTE_EVERY === 0);
        if (due) {
            this.deps.write(`NOTE gh failing: ${detail.slice(0, FAILURE_DETAIL_LIMIT)}`);
        }
    }

    private settle(verdict: "green" | "red"): Verdict {
        this.deps.write(`VERDICT ${verdict} head=${short(this.options.head)}`);

        return { exit: verdict === "green" ? 0 : 1 };
    }

    private stuck(head: string, reason: StuckReason): Verdict {
        this.deps.write(`VERDICT stuck head=${short(head)} reason=${reason}`);

        return { exit: 2 };
    }
}

function commentEvents(kind: CommentKind, items: readonly unknown[]): CommentEvent[] {
    const events: CommentEvent[] = [];
    for (const item of items) {
        if (!isRecord(item) || typeof item.id !== "number") {
            continue;
        }

        const line = describeComment(kind, item.id, item);
        if (line !== undefined) {
            events.push({
                id: item.id,
                key: `${kind}:${item.id}`,
                line,
            });
        }
    }

    return events.sort((left, right) => left.id - right.id);
}

function describeComment(kind: CommentKind, id: number, item: Record<string, unknown>): string | undefined {
    const login = isRecord(item.user) && typeof item.user.login === "string" ? item.user.login : "ghost";
    const body = typeof item.body === "string" ? item.body : "";
    const text = formatBody(body);

    switch (kind) {
        case "comment":
            return `COMMENT ${id} ${login}: ${text}`;
        case "inline": {
            const line = numberOrNull(item.line) ?? numberOrNull(item.original_line) ?? 0;
            const path = typeof item.path === "string" ? item.path : "";

            return `INLINE ${id} ${login} ${path}:${line}: ${text}`;
        }
        case "review": {
            const state = typeof item.state === "string" ? item.state : "";
            // A PENDING review is an unsubmitted draft; a blank COMMENTED one only wraps inline comments.
            if (state === "PENDING" || (state === "COMMENTED" && body.trim() === "")) {
                return undefined;
            }

            return `REVIEW ${id} ${login} ${state}: ${text}`;
        }
    }
}

function parseHttpResponse(stdout: string): HttpResponse | undefined {
    // gh prints the headers with LF line ends and the separating blank line as CRLF.
    const separator = /\r?\n\r?\n/.exec(stdout);
    const head = separator === null ? stdout : stdout.slice(0, separator.index);
    const body = separator === null ? "" : stdout.slice(separator.index + separator[0].length);
    const [statusLine = "", ...headers] = head.split(/\r?\n/);
    const status = /^HTTP\/\S+\s+(\d{3})/.exec(statusLine);
    if (status === null) {
        return undefined;
    }

    let etag: string | undefined;
    let hasNext = false;
    for (const header of headers) {
        const match = /^([^:]+):\s*(.*)$/.exec(header);
        const name = match?.[1]?.toLowerCase();
        const value = match?.[2]?.trim() ?? "";
        if (name === "etag") {
            etag = value;
        } else if (name === "link" && value.includes('rel="next"')) {
            hasNext = true;
        }
    }

    return {
        status: Number(status[1]),
        etag,
        hasNext,
        body,
    };
}

/** @returns the parsed value, or `undefined` when the text is not JSON (JSON itself never yields `undefined`). */
function parseJson(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch (error) {
        if (error instanceof SyntaxError) {
            return undefined;
        }
        throw error;
    }
}

function unusable(code: number): boolean {
    return code === GH_AUTH_REQUIRED_CODE || code === GH_MISSING_CODE;
}

function failureDetail(result: GhResult, fallback: string): string {
    const line = result.stderr.split("\n").map((part) => part.trim()).find((part) => part !== "");

    return line ?? fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCheck(value: unknown): value is Record<string, unknown> & Pick<Check, "name" | "bucket" | "state"> {
    return isRecord(value)
        && typeof value.name === "string"
        && typeof value.bucket === "string"
        && typeof value.state === "string";
}

function numberOrNull(value: unknown): number | null {
    return typeof value === "number" ? value : null;
}

function short(sha: string): string {
    return sha.slice(0, 7);
}

function runGh(args: readonly string[]): Promise<GhResult> {
    return new Promise((resolve) => {
        execFile(
            "gh",
            args,
            {
                encoding: "utf8",
                timeout: GH_TIMEOUT_MILLIS,
                maxBuffer: GH_MAX_BUFFER_BYTES,
            },
            (error, stdout, stderr) => {
                resolve({
                    code: exitCode(error),
                    stdout,
                    stderr: error?.killed === true ? `gh timed out after ${GH_TIMEOUT_MILLIS / 1000}s` : stderr,
                });
            },
        );
    });
}

function exitCode(error: ExecFileException | null): number {
    if (error === null) {
        return 0;
    }
    if (typeof error.code === "number") {
        return error.code;
    }

    return error.code === "ENOENT" ? 127 : 1;
}
