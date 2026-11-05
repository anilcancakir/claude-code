import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/**
 * HTTP statuses that mean the host is restarting or overloaded, not that the request was wrong.
 *
 * 502, 503 and 504 are what the kodizm host answers while a deploy swaps its workers; 520, 521, 522 and 524
 * are Cloudflare reporting that the origin sent nothing usable, refused the connection, did not accept it in
 * time, or did not finish in time. A plain 500 is left out: it is as likely to be a real bug as a restart.
 */
const TRANSIENT_STATUSES: ReadonlySet<number> = new Set([502, 503, 504, 520, 521, 522, 524]);

/**
 * Waits between attempts to a remote tool call, in milliseconds: one retry after 2 s and one more after 6 s.
 *
 * A deploy outlasts this window, so the delays only absorb a worker swap or a dropped connection; the hint
 * below is what carries the model across a longer outage.
 */
export const REMOTE_RETRY_DELAYS_MS: readonly number[] = [2_000, 6_000];

/**
 * Instruction appended to a remote failure that kept failing through every retry.
 *
 * The model cannot sleep in a foreground call, so it is told to spend the wait on other work and to retry
 * exactly once; "do not retry in a tight loop" is what stops a failing remote from being hammered.
 */
export const TRANSIENT_OUTAGE_HINT =
    "The kodizm remote looks temporarily unavailable (often a deploy, back within a minute or two). "
    + "Do not retry in a tight loop: do other work first, retry this exact call once after about 60 seconds, "
    + "and if it fails again continue with another source.";

/**
 * Whether a failed remote call is worth repeating unchanged.
 *
 * A transient HTTP status from the SDK transport, or one of undici's two connection failures: `fetch failed`
 * for a connection refused, reset or dropped before the response headers, `terminated` for one cut while the
 * body was still arriving. A timeout is not transient: repeating it spends the whole timeout again.
 */
export function isTransientRemoteError(err: unknown): boolean {
    if (err instanceof StreamableHTTPError) {
        return err.code !== undefined && TRANSIENT_STATUSES.has(err.code);
    }

    return err instanceof TypeError && (err.message === "fetch failed" || err.message === "terminated");
}

/**
 * Runs `call`, repeating it after each delay while it keeps failing with a transient error.
 *
 * Only idempotent reads belong here: every proxied remote tool is one. The last error is rethrown once the
 * delays are spent, and a non-transient error is rethrown at once, so the caller sees the failure that ended
 * the run, not the first one.
 */
export async function withTransientRetry<T>(
    call: () => Promise<T>,
    options: {
        delaysMs?: readonly number[];
        sleep?: (ms: number) => Promise<void>;
    } = {},
): Promise<T> {
    const delaysMs = options.delaysMs ?? REMOTE_RETRY_DELAYS_MS;
    const sleep = options.sleep ?? ((ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)));

    for (let attempt = 0; ; attempt++) {
        try {
            return await call();
        } catch (err) {
            const delayMs = delaysMs[attempt];

            if (delayMs === undefined || !isTransientRemoteError(err)) {
                throw err;
            }

            await sleep(delayMs);
        }
    }
}
