import { describe, expect, test } from "bun:test";
import { formatBody, runPrWatch, type GhResult, type PrWatchDeps, type PrWatchOptions } from "./pr-watch.ts";

const HEAD = "a".repeat(40);
const OTHER = "b".repeat(40);
const HEAD_PATH = "repos/o/r/pulls/42";
const COMMENTS_PATH = "repos/o/r/issues/42/comments?per_page=100";
const INLINE_PATH = "repos/o/r/pulls/42/comments?per_page=100";
const REVIEWS_PATH = "repos/o/r/pulls/42/reviews?per_page=100";

type Row = Record<string, unknown>;

interface CheckRow {
    readonly name: string;
    readonly bucket: string;
    readonly state: string;
    readonly workflow: string;
    readonly event: string;
}

function check(name: string, bucket: string, state: string, workflow = "", event = ""): CheckRow {
    return {
        name,
        bucket,
        state,
        workflow,
        event,
    };
}

function comment(id: number, body: string, login = "kodizm[bot]"): Row {
    return {
        id,
        user: { login },
        body,
    };
}

function inlineComment(id: number, path: string, line: number | null, originalLine: number | null): Row {
    return {
        id,
        user: { login: "coderabbitai[bot]" },
        path,
        line,
        original_line: originalLine,
        body: "nit",
    };
}

function review(id: number, state: string, body: string): Row {
    return {
        id,
        user: { login: "kodizm[bot]" },
        state,
        body,
    };
}

function failed(stderr: string): GhResult {
    return {
        code: 1,
        stdout: "",
        stderr,
    };
}

const PASS = [check("ci", "pass", "SUCCESS")];
const RUNNING = [check("ci", "pending", "IN_PROGRESS")];

// Takes the next fixture, repeating the last one once the queue is down to it.
function next<T>(queue: T[]): T {
    const value = queue.length > 1 ? queue.shift() : queue[0];
    if (value === undefined) {
        throw new Error("empty fixture queue");
    }

    return value;
}

// A gh stand-in that answers `gh api -i` the way the real one does (status line, LF headers, a CRLF
// blank line, then the body; a 304 with exit 1), keyed on a hash of the page it would return.
class FakeGitHub {
    heads: string[] = [HEAD];
    checks: (readonly CheckRow[] | GhResult)[] = [RUNNING];
    comments: Row[] = [];
    inline: Row[] = [];
    reviews: Row[] = [];
    pageSize = 100;
    intercept: ((args: readonly string[]) => GhResult | undefined) | undefined;
    onSleep: ((tick: number) => void) | undefined;
    clock = 0;
    linesAtFirstCall: number | undefined;
    readonly calls: string[][] = [];
    readonly lines: string[] = [];
    readonly sleeps: number[] = [];

    deps(): PrWatchDeps {
        return {
            gh: (args) => Promise.resolve(this.answer(args)),
            now: () => this.clock,
            sleep: (ms) => {
                this.sleeps.push(ms);
                if (this.sleeps.length > 500) {
                    throw new Error("the watch never settled");
                }
                this.clock += ms;
                this.onSleep?.(this.sleeps.length);

                return Promise.resolve();
            },
            write: (line) => {
                this.lines.push(line);
            },
        };
    }

    callsTo(path: string): string[][] {
        return this.calls.filter((call) => call[0] === "api" && call[call.length - 1] === path);
    }

    private answer(args: readonly string[]): GhResult {
        this.calls.push([...args]);
        this.linesAtFirstCall ??= this.lines.length;

        const intercepted = this.intercept?.(args);
        if (intercepted !== undefined) {
            return intercepted;
        }
        if (args[0] === "pr") {
            const checks = next(this.checks);

            return "code" in checks ? checks : { code: 0, stdout: JSON.stringify(checks), stderr: "" };
        }

        return this.answerApi(args);
    }

    private answerApi(args: readonly string[]): GhResult {
        const path = (args[args.length - 1] ?? "").replace("{owner}/{repo}", "o/r");
        const resource = this.resource(path);

        if (args.includes("--paginate")) {
            const rows = Array.isArray(resource) ? resource : [];
            const pages: Row[][] = [];
            for (let start = 0; start < rows.length; start += this.pageSize) {
                pages.push(rows.slice(start, start + this.pageSize));
            }

            return { code: 0, stdout: JSON.stringify(pages.length === 0 ? [[]] : pages), stderr: "" };
        }

        const page = Array.isArray(resource) ? resource.slice(0, this.pageSize) : resource;
        const json = JSON.stringify(page);
        const etag = `W/"${Bun.hash(json)}"`;
        const sent = args.find((arg) => arg.startsWith("If-None-Match: "))?.slice("If-None-Match: ".length);
        if (sent === etag) {
            return {
                code: 1,
                stdout: `HTTP/2.0 304 Not Modified\nEtag: ${etag.slice(2)}\nX-Xss-Protection: 0\n\r\n`,
                stderr: "gh: HTTP 304",
            };
        }

        const more = Array.isArray(resource) && resource.length > this.pageSize;
        const link = more ? `Link: <https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=2>; rel="last"\n` : "";

        return {
            code: 0,
            stdout: `HTTP/2.0 200 OK\nContent-Type: application/json; charset=utf-8\nEtag: ${etag}\n${link}\r\n${json}`,
            stderr: "",
        };
    }

    private resource(path: string): Row | Row[] {
        switch (path) {
            case HEAD_PATH:
                return { number: 42, head: { sha: next(this.heads) } };
            case COMMENTS_PATH:
                return this.comments;
            case INLINE_PATH:
                return this.inline;
            case REVIEWS_PATH:
                return this.reviews;
        }
        throw new Error(`unexpected path ${path}`);
    }
}

async function watch(fake: FakeGitHub, overrides: Partial<PrWatchOptions> = {}): Promise<number> {
    return runPrWatch(
        {
            pr: "42",
            repo: "o/r",
            head: HEAD,
            intervalSeconds: 20,
            startWaitSeconds: 300,
            queueLimitSeconds: 900,
            botsWaitSeconds: 600,
            includeExisting: false,
            ...overrides,
        },
        fake.deps(),
    );
}

function notes(fake: FakeGitHub, prefix: string): string[] {
    return fake.lines.filter((line) => line.startsWith(prefix));
}

describe("rule 1: line shapes", () => {
    test("a green run prints the documented lines, the watch line before any gh call", async () => {
        const fake = new FakeGitHub();
        fake.checks = [[
            check("Kodizm CI", "pass", "SUCCESS"),
            check("Kodizm review", "skipping", "NEUTRAL"),
        ]];
        fake.comments = [comment(1, "summary")];
        fake.reviews = [review(2, "APPROVED", "ok"), review(3, "APPROVED", "ok")];

        expect(await watch(fake)).toBe(0);
        expect(fake.linesAtFirstCall).toBe(1);
        expect(fake.lines).toEqual([
            "WATCH pr=42 head=aaaaaaa",
            "CHECK Kodizm CI: pass",
            "CHECK Kodizm review: skipping",
            "GATE green",
            "BASELINE comments=1 inline=0 reviews=2",
            "VERDICT green head=aaaaaaa",
        ]);
    });
});

describe("rule 2: gh that cannot work", () => {
    const STUCK = [
        "WATCH pr=42 head=aaaaaaa",
        "VERDICT stuck head=aaaaaaa reason=gh-unavailable",
    ];

    test("a gh that is not installed (127) is stuck on the first call", async () => {
        const fake = new FakeGitHub();
        fake.intercept = () => ({ code: 127, stdout: "", stderr: "spawn gh ENOENT" });

        expect(await watch(fake)).toBe(2);
        expect(fake.calls).toHaveLength(1);
        expect(fake.lines).toEqual(STUCK);
    });

    test("a gh that is not logged in (exit 4) is stuck on the first call", async () => {
        const fake = new FakeGitHub();
        fake.intercept = () => ({ code: 4, stdout: "", stderr: "To get started with GitHub CLI, please run:  gh auth login" });

        expect(await watch(fake)).toBe(2);
        expect(fake.calls).toHaveLength(1);
        expect(fake.lines).toEqual(STUCK);
    });

    test("a login that expires mid-watch is stuck on the checks call as well", async () => {
        const fake = new FakeGitHub();
        fake.intercept = (args) => (args[0] === "pr" ? { code: 4, stdout: "", stderr: "gh auth login" } : undefined);

        expect(await watch(fake)).toBe(2);
        expect(fake.lines).toEqual(STUCK);
    });

    test("no gh auth status call is made: it exits 1 for a problem on any other account", async () => {
        const fake = new FakeGitHub();
        fake.checks = [PASS];

        expect(await watch(fake)).toBe(0);
        expect(fake.calls.some((call) => call[0] === "auth")).toBe(false);
    });
});

describe("rule 3: head pin", () => {
    test("skips the checks while the PR shows another head, keeps sweeping, then gates on the pushed head", async () => {
        const fake = new FakeGitHub();
        fake.heads = [OTHER, HEAD];
        fake.checks = [PASS];

        expect(await watch(fake)).toBe(0);
        expect(fake.calls.slice(0, 5).map((call) => call[0])).toEqual(["api", "api", "api", "api", "api"]);
        expect(fake.lines).toEqual([
            "WATCH pr=42 head=aaaaaaa",
            "BASELINE comments=0 inline=0 reviews=0",
            "CHECK ci: pass",
            "GATE green",
            "VERDICT green head=aaaaaaa",
        ]);
    });

    test("never reads a green result off a previous head: stuck with head-never-appeared after start-wait", async () => {
        const fake = new FakeGitHub();
        fake.heads = [OTHER];
        fake.checks = [PASS];

        expect(await watch(fake, { startWaitSeconds: 60 })).toBe(2);
        expect(fake.clock).toBe(60_000);
        expect(fake.calls.some((call) => call[0] === "pr")).toBe(false);
        expect(fake.lines.at(-1)).toBe("VERDICT stuck head=aaaaaaa reason=head-never-appeared");
    });

    test("a new head after the pushed one matched is stuck with superseded, naming the new head", async () => {
        const fake = new FakeGitHub();
        fake.heads = [HEAD, OTHER];

        expect(await watch(fake)).toBe(2);
        expect(fake.lines.at(-1)).toBe("VERDICT stuck head=bbbbbbb reason=superseded");
    });

    test("without a repo it uses gh's placeholders and passes no -R", async () => {
        const fake = new FakeGitHub();
        fake.checks = [PASS];

        expect(await watch(fake, { repo: undefined })).toBe(0);
        expect(fake.calls[0]).toEqual(["api", "-i", "repos/{owner}/{repo}/pulls/42"]);
        expect(fake.calls[1]).toEqual(["pr", "checks", "42", "--json", "name,bucket,state,workflow,event"]);
    });
});

describe("rule 4: checks", () => {
    test("reads red from the bucket, since gh pr checks --json exits 0 with failing checks", async () => {
        const fake = new FakeGitHub();
        fake.checks = [[check("ci", "fail", "FAILURE")]];

        expect(await watch(fake)).toBe(1);
        expect(fake.calls[1]).toEqual(["pr", "checks", "42", "-R", "o/r", "--json", "name,bucket,state,workflow,event"]);
    });

    test("a no checks reported exit is an empty list, not a failed call", async () => {
        const fake = new FakeGitHub();
        fake.checks = [failed("no checks reported on the 'feature' branch")];

        expect(await watch(fake, { startWaitSeconds: 40 })).toBe(2);
        expect(notes(fake, "NOTE gh failing")).toEqual([]);
        expect(fake.lines.at(-1)).toBe("VERDICT stuck head=aaaaaaa reason=no-checks");
    });
});

describe("rule 5: CHECK lines", () => {
    test("one line when a check settles and another when a rerun changes its bucket, none while pending", async () => {
        const fake = new FakeGitHub();
        fake.checks = [
            [check("ci", "pending", "IN_PROGRESS"), check("CodeRabbit", "pending", "IN_PROGRESS")],
            [check("ci", "pending", "IN_PROGRESS"), check("CodeRabbit", "fail", "FAILURE")],
            [check("ci", "pending", "IN_PROGRESS"), check("CodeRabbit", "pending", "QUEUED")],
            [check("ci", "pending", "IN_PROGRESS"), check("CodeRabbit", "pass", "SUCCESS")],
            [check("ci", "pass", "SUCCESS"), check("CodeRabbit", "pass", "SUCCESS")],
        ];

        expect(await watch(fake, { ignore: /CodeRabbit/ })).toBe(0);
        expect(fake.lines.filter((line) => !line.startsWith("BASELINE"))).toEqual([
            "WATCH pr=42 head=aaaaaaa",
            "CHECK CodeRabbit: fail (not a gate)",
            "CHECK CodeRabbit: pass (not a gate)",
            "CHECK ci: pass",
            "GATE green",
            "VERDICT green head=aaaaaaa",
        ]);
    });

    test("two checks that share a name in different workflows each settle once, not once per tick", async () => {
        const fake = new FakeGitHub();
        const builds = [
            check("build", "pass", "SUCCESS", "pr.yml", "pull_request"),
            check("build", "skipping", "SKIPPED", "push.yml", "push"),
        ];
        fake.checks = [
            [check("ci", "pending", "IN_PROGRESS"), ...builds],
            [check("ci", "pending", "IN_PROGRESS"), ...builds],
            [check("ci", "pass", "SUCCESS"), ...builds],
        ];

        expect(await watch(fake)).toBe(0);
        expect(notes(fake, "CHECK build:")).toEqual(["CHECK build: pass", "CHECK build: skipping"]);
    });
});

describe("rule 6: red", () => {
    test("the first failed gate ends the watch: CHECK lines, then the final sweep, then the verdict", async () => {
        const fake = new FakeGitHub();
        fake.checks = [[check("Kodizm CI", "fail", "FAILURE"), check("lint", "pending", "IN_PROGRESS")]];
        fake.comments = [comment(5, "fix the test")];

        expect(await watch(fake, { ignore: /CodeRabbit/, includeExisting: true })).toBe(1);
        expect(fake.sleeps).toEqual([]);
        expect(fake.lines).toEqual([
            "WATCH pr=42 head=aaaaaaa",
            "CHECK Kodizm CI: fail",
            "COMMENT 5 kodizm[bot]: fix the test",
            "VERDICT red head=aaaaaaa",
        ]);
    });

    test("a cancelled check is red", async () => {
        const fake = new FakeGitHub();
        fake.checks = [[check("ci", "cancel", "CANCELLED"), check("e2e", "pass", "SUCCESS")]];

        expect(await watch(fake)).toBe(1);
        expect(fake.lines.at(-1)).toBe("VERDICT red head=aaaaaaa");
    });
});

describe("rule 7: green", () => {
    test("waits for a pending non-gate check to finish when it finishes inside bots-wait", async () => {
        const fake = new FakeGitHub();
        fake.checks = [
            [check("ci", "pass", "SUCCESS"), check("CodeRabbit", "pending", "IN_PROGRESS")],
            [check("ci", "pass", "SUCCESS"), check("CodeRabbit", "pass", "SUCCESS")],
        ];

        expect(await watch(fake, { ignore: /CodeRabbit/ })).toBe(0);
        expect(fake.sleeps).toHaveLength(1);
        expect(notes(fake, "GATE green")).toHaveLength(1);
        expect(notes(fake, "NOTE")).toEqual([]);
        expect(fake.lines.at(-1)).toBe("VERDICT green head=aaaaaaa");
    });

    test("a slow bot holds the watch only for bots-wait, then a NOTE names it and the verdict is green", async () => {
        const fake = new FakeGitHub();
        fake.checks = [[
            check("ci", "pass", "SUCCESS"),
            check("CodeRabbit", "pending", "IN_PROGRESS"),
            check("Copilot", "pending", "QUEUED"),
        ]];

        expect(await watch(fake, { ignore: /CodeRabbit|Copilot/, botsWaitSeconds: 60 })).toBe(0);
        expect(fake.clock).toBe(60_000);
        expect(fake.lines.slice(-2)).toEqual([
            "NOTE bots still pending: CodeRabbit, Copilot",
            "VERDICT green head=aaaaaaa",
        ]);
    });

    test("confirms the head before calling green, so a push during the read is superseded", async () => {
        const fake = new FakeGitHub();
        fake.heads = [HEAD, OTHER];
        fake.checks = [PASS];

        expect(await watch(fake)).toBe(2);
        expect(fake.lines.slice(-2)).toEqual([
            "GATE green",
            "VERDICT stuck head=bbbbbbb reason=superseded",
        ]);
    });
});

describe("rule 8: start-wait and queue limit", () => {
    test("no check ever appearing is stuck with no-checks after start-wait", async () => {
        const fake = new FakeGitHub();
        fake.checks = [[]];

        expect(await watch(fake, { startWaitSeconds: 40 })).toBe(2);
        expect(fake.clock).toBe(40_000);
        expect(fake.lines.at(-1)).toBe("VERDICT stuck head=aaaaaaa reason=no-checks");
    });

    test("an ignore that leaves no gate behind counts as CI that never started", async () => {
        const fake = new FakeGitHub();
        fake.checks = [[check("CodeRabbit", "pass", "SUCCESS")]];

        expect(await watch(fake, { ignore: /CodeRabbit/, startWaitSeconds: 0 })).toBe(2);
        expect(fake.lines.slice(-2)).toEqual([
            "CHECK CodeRabbit: pass (not a gate)",
            "VERDICT stuck head=aaaaaaa reason=no-checks",
        ]);
    });

    test("every gate check queued or waiting past the limit is stuck with queued", async () => {
        const fake = new FakeGitHub();
        fake.checks = [[check("ci", "pending", "QUEUED"), check("e2e", "pending", "WAITING")]];

        expect(await watch(fake, { queueLimitSeconds: 40 })).toBe(2);
        expect(fake.clock).toBe(40_000);
        expect(fake.lines.at(-1)).toBe("VERDICT stuck head=aaaaaaa reason=queued");
    });

    test("a running check resets the queue timer", async () => {
        const queued = [check("ci", "pending", "QUEUED")];
        const fake = new FakeGitHub();
        fake.checks = [queued, queued, [check("ci", "pending", "IN_PROGRESS")], queued];

        expect(await watch(fake, { queueLimitSeconds: 40 })).toBe(2);
        expect(fake.clock).toBe(100_000);
    });

    test("does not call a queue dead while one gate check is running", async () => {
        const fake = new FakeGitHub();
        fake.checks = [[check("ci", "pending", "IN_PROGRESS"), check("e2e", "pending", "QUEUED")], PASS];

        expect(await watch(fake, { queueLimitSeconds: 0 })).toBe(0);
    });
});

describe("rule 9: comments", () => {
    test("existing comments are a silent baseline; new ones emit in ascending id order", async () => {
        const fake = new FakeGitHub();
        fake.checks = [RUNNING, PASS];
        fake.comments = [comment(10, "old")];
        fake.inline = [inlineComment(11, "a.ts", 3, 3)];
        fake.reviews = [review(12, "APPROVED", "old")];
        fake.onSleep = () => {
            fake.comments.push(comment(30, "second"), comment(20, "first"));
        };

        expect(await watch(fake)).toBe(0);
        expect(fake.lines).toEqual([
            "WATCH pr=42 head=aaaaaaa",
            "BASELINE comments=1 inline=1 reviews=1",
            "CHECK ci: pass",
            "GATE green",
            "COMMENT 20 kodizm[bot]: first",
            "COMMENT 30 kodizm[bot]: second",
            "VERDICT green head=aaaaaaa",
        ]);
    });

    test("with includeExisting the existing comments emit in ascending id order and no BASELINE is written", async () => {
        const fake = new FakeGitHub();
        fake.checks = [PASS];
        fake.comments = [comment(9, "later"), comment(4, "earlier")];

        expect(await watch(fake, { includeExisting: true })).toBe(0);
        expect(notes(fake, "BASELINE")).toEqual([]);
        expect(notes(fake, "COMMENT")).toEqual([
            "COMMENT 4 kodizm[bot]: earlier",
            "COMMENT 9 kodizm[bot]: later",
        ]);
    });

    test("an edited comment is not emitted again", async () => {
        const fake = new FakeGitHub();
        fake.checks = [RUNNING, RUNNING, PASS];
        fake.comments = [comment(1, "first")];
        fake.onSleep = (tick) => {
            fake.comments = [comment(1, tick === 1 ? "first, edited" : "first, edited twice")];
        };

        expect(await watch(fake, { includeExisting: true })).toBe(0);
        expect(notes(fake, "COMMENT")).toEqual(["COMMENT 1 kodizm[bot]: first"]);
    });

    test("reviews skip drafts and blank COMMENTED wrappers; inline lines fall back to original_line, then 0", async () => {
        const fake = new FakeGitHub();
        fake.checks = [PASS];
        fake.reviews = [
            review(1, "PENDING", "draft"),
            review(2, "COMMENTED", "  \n"),
            review(3, "COMMENTED", "see inline"),
            review(4, "CHANGES_REQUESTED", ""),
        ];
        fake.inline = [
            inlineComment(5, "src/a.ts", 12, 10),
            inlineComment(6, "src/b.ts", null, 7),
            inlineComment(7, "src/c.ts", null, null),
        ];

        expect(await watch(fake, { includeExisting: true })).toBe(0);
        expect(fake.lines.filter((line) => /^(INLINE|REVIEW)/.test(line))).toEqual([
            "INLINE 5 coderabbitai[bot] src/a.ts:12: nit",
            "INLINE 6 coderabbitai[bot] src/b.ts:7: nit",
            "INLINE 7 coderabbitai[bot] src/c.ts:0: nit",
            "REVIEW 3 kodizm[bot] COMMENTED: see inline",
            "REVIEW 4 kodizm[bot] CHANGES_REQUESTED: (no text)",
        ]);
    });

    test("at most 25 comment lines per tick; the rest are recorded as seen behind one NOTE", async () => {
        const fake = new FakeGitHub();
        fake.checks = [RUNNING, RUNNING, PASS];
        fake.onSleep = (tick) => {
            if (tick === 1) {
                fake.comments = Array.from({ length: 30 }, (_, index) => comment(index + 1, `c${index + 1}`));
            }
        };

        expect(await watch(fake)).toBe(0);
        const shown = notes(fake, "COMMENT");
        expect(shown).toHaveLength(25);
        expect(shown.at(-1)).toBe("COMMENT 25 kodizm[bot]: c25");
        expect(notes(fake, "NOTE")).toEqual(["NOTE 5 more comment events not shown, read them with gh api"]);
    });

    test("a failed sweep call is skipped, recorded nothing and does not count as a gh failure", async () => {
        const fake = new FakeGitHub();
        fake.checks = [RUNNING, RUNNING, RUNNING, RUNNING, PASS];
        fake.comments = [comment(1, "old")];
        fake.intercept = (args) => {
            return fake.sleeps.length < 3 && args.at(-1) === COMMENTS_PATH ? failed("gh: HTTP 502") : undefined;
        };

        expect(await watch(fake)).toBe(0);
        expect(fake.lines).toEqual([
            "WATCH pr=42 head=aaaaaaa",
            "NOTE comment sweep failing: gh: HTTP 502",
            "BASELINE comments=1 inline=0 reviews=0",
            "CHECK ci: pass",
            "GATE green",
            "VERDICT green head=aaaaaaa",
        ]);
        expect(notes(fake, "NOTE gh failing")).toEqual([]);
    });
});

describe("rule 9: formatBody", () => {
    test("drops HTML comments across lines and picture blocks, collapses whitespace", () => {
        const body = "<!-- walkthrough\nstart -->\n## Summary\n\n<picture><source srcset=\"x\"><img></picture>  all   good\n";

        expect(formatBody(body)).toBe("## Summary all good");
    });

    test("cuts past 300 characters with an ellipsis and keeps exactly 300", () => {
        expect(formatBody("x".repeat(301))).toBe(`${"x".repeat(300)}...`);
        expect(formatBody("x".repeat(300))).toBe("x".repeat(300));
    });

    test("an empty result reads (no text)", () => {
        expect(formatBody("<!-- only a marker -->\n  ")).toBe("(no text)");
    });
});

describe("rule 10: conditional GETs", () => {
    test("later reads send the stored etag and a 304 counts as unchanged, not a failure", async () => {
        const fake = new FakeGitHub();
        fake.checks = [RUNNING, RUNNING, RUNNING, RUNNING, PASS];

        expect(await watch(fake)).toBe(0);
        const reads = fake.callsTo(HEAD_PATH);
        expect(reads[0]).toEqual(["api", "-i", HEAD_PATH]);
        expect(reads.slice(1).every((call) => call[2] === "-H" && call[3]?.startsWith("If-None-Match: W/\""))).toBe(true);
        expect(notes(fake, "NOTE")).toEqual([]);
        expect(fake.lines.at(-1)).toBe("VERDICT green head=aaaaaaa");
    });

    test("a paginated endpoint is read whole with --paginate --slurp from the first page on", async () => {
        const fake = new FakeGitHub();
        fake.pageSize = 2;
        fake.checks = [RUNNING, PASS];
        fake.comments = [comment(1, "one"), comment(2, "two"), comment(3, "three")];
        fake.onSleep = () => {
            fake.comments.push(comment(4, "four"));
        };

        expect(await watch(fake, { includeExisting: true })).toBe(0);
        expect(notes(fake, "COMMENT").map((line) => line.split(" ")[1])).toEqual(["1", "2", "3", "4"]);
        const reads = fake.callsTo(COMMENTS_PATH);
        expect(reads[0]).toEqual(["api", "-i", COMMENTS_PATH]);
        expect(reads.slice(1).every((call) => call[1] === "--paginate" && call[2] === "--slurp")).toBe(true);
    });

    test("a status other than 200, 304 or 404, or an unreadable body, is a failed call", async () => {
        const fake = new FakeGitHub();
        fake.checks = [PASS];
        fake.intercept = (args) => {
            if (args.at(-1) !== HEAD_PATH || fake.sleeps.length >= 6) {
                return undefined;
            }
            if (fake.sleeps.length < 3) {
                return { code: 1, stdout: "HTTP/2.0 502 Bad Gateway\n\r\n{}", stderr: "gh: Bad Gateway (HTTP 502)" };
            }

            return { code: 0, stdout: "HTTP/2.0 200 OK\nEtag: W/\"x\"\n\r\n{not json", stderr: "" };
        };

        expect(await watch(fake)).toBe(0);
        expect(notes(fake, "NOTE gh failing")).toEqual(["NOTE gh failing: gh: Bad Gateway (HTTP 502)"]);
        expect(fake.sleeps).toHaveLength(6);
    });
});

describe("rule 11: failures", () => {
    test("notes at the 3rd consecutive failure and every 15th after, with the stderr line cut to 160", async () => {
        const fake = new FakeGitHub();
        const failure = failed(`${"x".repeat(200)}\nsecond line`);
        fake.checks = [...Array.from({ length: 18 }, () => failure), PASS];

        expect(await watch(fake, { startWaitSeconds: 10_000 })).toBe(0);
        expect(notes(fake, "NOTE gh failing")).toEqual([
            `NOTE gh failing: ${"x".repeat(160)}`,
            `NOTE gh failing: ${"x".repeat(160)}`,
        ]);
        expect(fake.lines.at(-1)).toBe("VERDICT green head=aaaaaaa");
    });

    test("a successful head and checks resets the counter", async () => {
        const fake = new FakeGitHub();
        const failure = failed("gh: HTTP 502");
        fake.checks = [failure, failure, RUNNING, failure, failure, PASS];

        expect(await watch(fake)).toBe(0);
        expect(notes(fake, "NOTE")).toEqual([]);
    });

    test("a gh call that fails with an ordinary exit 1 keeps the loop polling instead of throwing", async () => {
        const fake = new FakeGitHub();
        fake.intercept = (args) => {
            return fake.sleeps.length < 4 && args[0] === "api" && !args.some((arg) => arg.endsWith("/comments?per_page=100"))
                ? { code: 1, stdout: "", stderr: "gh: Post https://api.github.com: connection reset" }
                : undefined;
        };
        fake.checks = [PASS];

        expect(await watch(fake, { startWaitSeconds: 10_000 })).toBe(0);
        expect(notes(fake, "NOTE gh failing")).toEqual(["NOTE gh failing: gh: Post https://api.github.com: connection reset"]);
    });
});

describe("rule 11: a watch that cannot read anything", () => {
    test("before the first gate check, a gh that keeps failing ends as stuck gh-failing at the start wait", async () => {
        const fake = new FakeGitHub();
        fake.checks = [failed("gh: HTTP 502")];

        expect(await watch(fake, { startWaitSeconds: 100 })).toBe(2);
        expect(notes(fake, "NOTE gh failing")).toEqual(["NOTE gh failing: gh: HTTP 502"]);
        expect(fake.lines.at(-1)).toBe("VERDICT stuck head=aaaaaaa reason=gh-failing");
        expect(fake.sleeps.length).toBe(5);
    });

    test("after a gate check was seen, the same failures stay transient", async () => {
        const fake = new FakeGitHub();
        fake.checks = [RUNNING, failed("gh: HTTP 502"), failed("gh: HTTP 502"), failed("gh: HTTP 502"), PASS];

        expect(await watch(fake, { startWaitSeconds: 40 })).toBe(0);
        expect(fake.lines.at(-1)).toBe("VERDICT green head=aaaaaaa");
    });

    test("a 404 on the pull request is stuck pr-not-found at once, not after the start wait", async () => {
        const fake = new FakeGitHub();
        fake.intercept = () => ({
            code: 1,
            stdout: 'HTTP/2.0 404 Not Found\nContent-Type: application/json\n\r\n{"message":"Not Found"}',
            stderr: "gh: Not Found (HTTP 404)",
        });

        expect(await watch(fake)).toBe(2);
        expect(fake.calls).toHaveLength(1);
        expect(fake.lines).toEqual([
            "WATCH pr=42 head=aaaaaaa",
            "VERDICT stuck head=aaaaaaa reason=pr-not-found",
        ]);
    });

    test("one endpoint whose sweep keeps failing is noted once and does not stop the others", async () => {
        const fake = new FakeGitHub();
        fake.intercept = (args) => (args.at(-1) === INLINE_PATH ? failed("gh: HTTP 403") : undefined);
        fake.comments = [comment(1, "hello")];
        fake.checks = [RUNNING, RUNNING, RUNNING, RUNNING, PASS];

        expect(await watch(fake, { includeExisting: true })).toBe(0);
        expect(notes(fake, "NOTE inline sweep failing")).toEqual(["NOTE inline sweep failing: gh: HTTP 403"]);
        expect(notes(fake, "COMMENT 1")).toEqual(["COMMENT 1 kodizm[bot]: hello"]);
    });
});

describe("rule 12: loop", () => {
    test("sleeps the interval in milliseconds between ticks and returns right after the verdict", async () => {
        const fake = new FakeGitHub();
        fake.checks = [RUNNING, RUNNING, PASS];

        expect(await watch(fake, { intervalSeconds: 7 })).toBe(0);
        expect(fake.sleeps).toEqual([7000, 7000]);
        expect(fake.lines.filter((line) => line.startsWith("VERDICT"))).toEqual(["VERDICT green head=aaaaaaa"]);
        expect(fake.lines.at(-1)).toBe("VERDICT green head=aaaaaaa");
    });
});
