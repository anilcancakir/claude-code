import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendToFixture, buildFixtureCorpus } from "./history-fixtures.ts";
import type { FixtureCorpus } from "./history-fixtures.ts";
import { openHistoryStore } from "./history-store.ts";
import type { HistoryStore } from "./history-store.ts";
import { runSearch } from "./history-search.ts";
import type { HistorySearchDeps } from "./history-search.ts";

/**
 * The composed sync-query-render path, against a real sqlite archive built from the Step 1 fixture.
 *
 * This suite runs under `node --experimental-strip-types --test`, never under `bun test`: bun 1.3.10
 * cannot resolve `node:sqlite` the moment the binding is used, which is why the filename ends in
 * `.node-check.ts`. Its counterpart `history-search.test.ts` proves the argument gate and the mode
 * dispatch against a fake store; what only this file can prove is that the four modes actually
 * execute against the real schema, that `sessions` mode renders a title resolved out of the
 * `sessions` table, and that a session id taken out of `content` output opens that same conversation
 * in `read` mode, which is the chain a caller actually walks.
 */

/** The title appended to the second project's session, so a title assertion has something to find. */
const FIXTURE_TITLE = "ZRQPHX-B-TITLE";

const roots: string[] = [];
const stores: HistoryStore[] = [];

after(() => {
    for (const store of stores) {
        store.close();
    }
    for (const root of roots) {
        rmSync(root, { force: true, recursive: true });
    }
});

interface Harness {
    readonly corpus: FixtureCorpus;
    readonly deps: HistorySearchDeps;
}

let harness: Promise<Harness> | undefined;

/**
 * Builds the fixture corpus and a real archive beside it, once for the whole suite.
 *
 * Shared on purpose: every `runSearch` call syncs first, so the second and later tests exercise the
 * warm no-change pass over an already-ingested corpus rather than only the cold build.
 */
function setup(): Promise<Harness> {
    if (harness !== undefined) {
        return harness;
    }

    harness = (async (): Promise<Harness> => {
        const root = mkdtempSync(join(tmpdir(), "ac-history-search-"));
        roots.push(root);

        const projectsRoot = join(root, "projects");
        mkdirSync(projectsRoot, { recursive: true });
        const corpus = buildFixtureCorpus(projectsRoot);

        // The second project's file ends on a newline, so appending a `custom-title` record gives
        // that session a resolvable title without disturbing the main file's deliberately torn tail.
        appendToFixture(corpus.projectBSessionPath, [
            JSON.stringify({
                type: "custom-title",
                uuid: "00000000-0000-4000-8000-000000000302",
                sessionId: corpus.projectBSessionId,
                timestamp: "2026-08-01T00:00:00.000Z",
                customTitle: FIXTURE_TITLE,
            }),
        ]);

        const store = await openHistoryStore({
            dir: join(root, "archive"),
            busyTimeoutMs: 1000,
        });
        stores.push(store);

        return {
            corpus,
            deps: {
                store,
                projectsRoot,
            },
        };
    })();

    return harness;
}

test("content mode returns real hits from a freshly synced archive", async () => {
    const { corpus, deps } = await setup();

    const text = await runSearch({ pattern: "ZRQPHX" }, deps);

    assert.ok(text.length > 0);
    assert.match(text, /session:/);
    assert.ok(text.includes(corpus.mainSessionId) || text.includes(corpus.projectBSessionId));
});

test("count mode reports more matches than sessions across the fixture corpus", async () => {
    const { deps } = await setup();

    const text = await runSearch({ pattern: "ZRQPHX", output_mode: "count" }, deps);

    const parsed = /^(\d+) match\(es\) across (\d+) session\(s\) in (\d+) project\(s\)/.exec(text);
    assert.ok(parsed !== null, `unexpected count output: ${text}`);
    const matches = Number(parsed[1]);
    const sessions = Number(parsed[2]);
    assert.ok(matches > 0, "the fixture corpus must produce matches");
    assert.ok(sessions > 0);
    assert.ok(matches > sessions, "a session holds several matching turns, so matches must exceed sessions");
});

test("sessions mode emits one entry per session even when a session holds many hits", async () => {
    const { corpus, deps } = await setup();

    const text = await runSearch({ pattern: "ZRQPHX", output_mode: "sessions" }, deps);

    assert.ok(text.length > 0);
    const occurrences = text.split(`session:${corpus.mainSessionId}`).length - 1;
    assert.equal(occurrences, 1);
});

test("sessions mode renders the title resolved out of the sessions table", async () => {
    const { corpus, deps } = await setup();

    const text = await runSearch({ pattern: "ZRQPHX-PROJECT-B-PROSE", output_mode: "sessions" }, deps);

    assert.ok(text.includes(`session:${corpus.projectBSessionId}`), `missing session: ${text}`);
    assert.ok(text.includes(FIXTURE_TITLE), `title not resolved: ${text}`);
    assert.ok(!text.includes("(untitled session)"));
});

test("a session id taken from content output opens that conversation in read mode", async () => {
    const { deps } = await setup();

    const content = await runSearch({ pattern: "ZRQPHX-SUBAGENT-PROSE" }, deps);
    const found = /session:([0-9a-f-]{36})/.exec(content);
    assert.ok(found !== null, `no session id in content output: ${content}`);
    const sessionId = found[1];
    assert.ok(sessionId !== undefined);

    const read = await runSearch({ output_mode: "read", session_id: sessionId }, deps);

    assert.match(read, new RegExp(`^session:${sessionId} \\| turns 1-\\d+ of \\d+`));
    assert.match(read, /ZRQPHX/);
    // The hit that produced the id came from a subagent transcript, so the window it opens has to
    // contain that turn's own body rather than merely being a session that exists.
    assert.match(read, /ZRQPHX-SUBAGENT-PROSE/);
});

test("read mode on an unknown session states that nothing was found", async () => {
    const { deps } = await setup();

    const text = await runSearch(
        { output_mode: "read", session_id: "00000000-0000-4000-8000-ffffffffffff" },
        deps,
    );

    assert.match(text, /No turns found/);
    assert.match(text, /Applied filters:/);
});

test("query text that breaks a raw MATCH is escaped end to end", async () => {
    const { deps } = await setup();

    // Passed raw, `node:sqlite` throws "no such column: node" and `C++` throws "syntax error near
    // +". Both must come back as an ordinary result through the composed path.
    const colon = await runSearch({ pattern: "node:sqlite", output_mode: "count" }, deps);
    const plus = await runSearch({ pattern: "C++", output_mode: "count" }, deps);

    assert.match(colon, /match\(es\)/);
    assert.match(plus, /match\(es\)/);
});

test("a filter that matches nothing names itself in the answer", async () => {
    const { deps } = await setup();

    const text = await runSearch({ pattern: "ZRQPHX", path: "/tmp/no-such-project" }, deps);

    assert.match(text, /No matches/);
    assert.match(text, /\/tmp\/no-such-project/);
});
