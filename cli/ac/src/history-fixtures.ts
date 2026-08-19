import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The seventeen control record types Step 5's distiller allowlists. A transcript line whose
 * `type` matches one of these is classified as `control`, never as a failure, because these are
 * Claude Code's own session bookkeeping records rather than conversational turns. Sourced from
 * the plan's Step 5 allowlist (`interview-log.md` decision N7).
 */
export const CONTROL_TYPES = [
    "mode",
    "permission-mode",
    "last-prompt",
    "ai-title",
    "queue-operation",
    "atis-latch",
    "relocated",
    "attachment",
    "system",
    "pr-link",
    "custom-title",
    "agent-name",
    "agent-color",
    "agent-setting",
    "worktree-state",
    "summary",
    "tag",
] as const;

/** A control record type this build has never seen, proving the unknown-type path stays `control` rather than `quarantine`. */
export const FUTURE_CONTROL_TYPE = "quantum-flux-marker" as const;

/**
 * The row counts a correct distiller pass over the whole fixture corpus (both projects plus the
 * nested subagent transcript) must reproduce exactly. Tests assert against these numbers instead
 * of against the live machine's real archive.
 */
export interface FixtureCounts {
    proseRows: number;
    toolUseRows: number;
    errorRows: number;
    quarantineRows: number;
    controlLinesSkipped: number;
}

/** Paths plus expected counts for a fixture corpus built by {@link buildFixtureCorpus}. */
export interface FixtureCorpus {
    root: string;
    projectADir: string;
    projectBDir: string;
    mainSessionId: string;
    mainSessionPath: string;
    projectBSessionId: string;
    projectBSessionPath: string;
    subagentSessionDir: string;
    subagentId: string;
    subagentTranscriptPath: string;
    subagentMetaPath: string;
    expected: FixtureCounts;
}

/**
 * Builds a deterministic UUID-shaped id from a small integer seed.
 *
 * A real `crypto.randomUUID()` would make every test run assert against a different id, which
 * defeats the point of a fixture with known truth. The shape still satisfies the standard
 * `xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx` UUID pattern Claude Code validates session ids against.
 */
function fixtureUuid(seed: number): string {
    const suffix = seed.toString(16).padStart(12, "0");
    return `00000000-0000-4000-8000-${suffix}`;
}

/**
 * Builds a deterministic subagent id in the shape the real corpus actually uses.
 *
 * Measured across all 1,841 subagent transcripts in `~/.claude/projects`: every id is exactly 17
 * characters and starts with `a`, for example `a785fd22804a8c9c8`. It is NOT a UUID, so a fixture
 * using a UUID here would let a walker that matches the real shape skip the fixture entirely and
 * report green over zero subagent files.
 */
function fixtureAgentId(seed: number): string {
    return `a${seed.toString(16).padStart(16, "0")}`;
}

/** Serializes a transcript record as one well-formed JSONL line, with no trailing newline. */
function jsonLine(record: Record<string, unknown>): string {
    return JSON.stringify(record);
}

/**
 * Builds the main session's well-formed lines: plain-string prose, an array-content turn mixing
 * text and a failed tool result, an assistant turn mixing text, thinking and a `Bash` tool use, a
 * compact-summary prose line, two shapes of textless `user` line, and one line per control type.
 */
function buildMainSessionLines(sessionId: string): string[] {
    const timestamp = "2026-08-01T00:00:00.000Z";

    const prosePlain = jsonLine({
        type: "user",
        uuid: fixtureUuid(101),
        sessionId,
        timestamp,
        cwd: "/tmp/proj-a",
        message: {
            role: "user",
            content: "ZRQPHX-PROSE-PLAIN token for plain string content extraction",
        },
    });

    const proseArrayWithFailedToolResult = jsonLine({
        type: "user",
        uuid: fixtureUuid(102),
        sessionId,
        timestamp,
        message: {
            role: "user",
            content: [
                { type: "text", text: "ZRQPHX-PROSE-ARRAY token inside an array-content user turn" },
                {
                    type: "tool_result",
                    tool_use_id: "toolu_ZRQPHX01",
                    is_error: true,
                    content: "ZRQPHX-TOOLERROR token: command failed",
                },
            ],
        },
    });

    const assistantWithThinkingAndBashToolUse = jsonLine({
        type: "assistant",
        uuid: fixtureUuid(103),
        sessionId,
        timestamp,
        message: {
            role: "assistant",
            content: [
                { type: "thinking", thinking: "ZRQPHX-THINKING token, never indexed" },
                { type: "text", text: "ZRQPHX-ASSISTANT-PROSE token in an assistant reply" },
                {
                    type: "tool_use",
                    id: "toolu_ZRQPHX02",
                    name: "Bash",
                    input: {
                        command: "echo ZRQPHX-BASH-COMMAND",
                        description: "ZRQPHX-BASH-DESC",
                    },
                },
            ],
        },
    });

    const compactSummaryProse = jsonLine({
        type: "user",
        uuid: fixtureUuid(104),
        sessionId,
        timestamp,
        isCompactSummary: true,
        message: {
            role: "user",
            content: "ZRQPHX-COMPACTSUMMARY token on a compact-summary user line",
        },
    });

    const imageOnlyContent = jsonLine({
        type: "user",
        uuid: fixtureUuid(105),
        sessionId,
        timestamp,
        message: {
            role: "user",
            content: [
                {
                    type: "image",
                    source: { type: "base64", media_type: "image/png", data: "ZRQPHX-IMAGE-DATA" },
                },
            ],
        },
    });

    const successfulToolResultOnly = jsonLine({
        type: "user",
        uuid: fixtureUuid(106),
        sessionId,
        timestamp,
        message: {
            role: "user",
            content: [
                {
                    type: "tool_result",
                    tool_use_id: "toolu_ZRQPHX03",
                    content: "ZRQPHX-SUCCESSFUL-TOOLRESULT token, never indexed",
                },
            ],
        },
    });

    const controlLines = [...CONTROL_TYPES, FUTURE_CONTROL_TYPE].map((controlType, index) =>
        jsonLine({
            type: controlType,
            uuid: fixtureUuid(200 + index),
            sessionId,
            timestamp,
            note: `ZRQPHX-CONTROL-${controlType}`,
        }),
    );

    // A malformed line must still contain the literal `"type":"user"` substring: the distiller's
    // cheap prefilter routes on that substring before it ever calls `JSON.parse`, so a malformed
    // line missing it would be misclassified as `control` instead of reaching the `quarantine` path.
    const malformedJson =
        `{"type":"user","uuid":"${fixtureUuid(150)}","sessionId":"${sessionId}",` +
        `"message":{"role":"user","content":"ZRQPHX-MALFORMED-JSON token, deliberately unterminated`;

    return [
        prosePlain,
        proseArrayWithFailedToolResult,
        assistantWithThinkingAndBashToolUse,
        compactSummaryProse,
        imageOnlyContent,
        successfulToolResultOnly,
        ...controlLines,
        malformedJson,
    ];
}

/**
 * Builds the final, deliberately torn line: an assistant turn cut mid-object with no closing
 * brackets. It carries the `"type":"assistant"` substring for realism but is never meant to reach
 * `JSON.parse`; the byte cursor must discard it as an incomplete trailing fragment instead.
 */
function buildTornTailLine(sessionId: string): string {
    return (
        `{"type":"assistant","uuid":"${fixtureUuid(199)}","sessionId":"${sessionId}",` +
        `"message":{"role":"assistant","content":[{"type":"text","text":"ZRQPHX-TORN-TAIL token before the cut"`
    );
}

/** Builds the second project's one well-formed prose line, so cross-project search has something to cross. */
function buildProjectBLines(sessionId: string): string[] {
    return [
        jsonLine({
            type: "user",
            uuid: fixtureUuid(301),
            sessionId,
            timestamp: "2026-08-01T00:00:00.000Z",
            cwd: "/tmp/proj-b",
            message: {
                role: "user",
                content: "ZRQPHX-PROJECT-B-PROSE token in the second project",
            },
        }),
    ];
}

/**
 * Builds the nested subagent transcript's two lines: a plain prose turn and a `Grep` tool use.
 *
 * Both carry `cwd`, because the real corpus does: every line sampled from a real
 * `subagents/agent-*.jsonl` carries it. Omitting it here would leave `projectPath` empty for every
 * subagent row and silently skip project filtering for exactly the rows that make up half the
 * archive.
 */
function buildSubagentLines(parentSessionId: string): string[] {
    const timestamp = "2026-08-01T00:00:00.000Z";
    return [
        jsonLine({
            type: "user",
            uuid: fixtureUuid(401),
            sessionId: parentSessionId,
            timestamp,
            cwd: "/tmp/proj-a",
            isSidechain: true,
            message: {
                role: "user",
                content: "ZRQPHX-SUBAGENT-PROSE token inside a nested subagent transcript",
            },
        }),
        jsonLine({
            type: "assistant",
            uuid: fixtureUuid(402),
            sessionId: parentSessionId,
            timestamp,
            cwd: "/tmp/proj-a",
            isSidechain: true,
            message: {
                role: "assistant",
                content: [
                    { type: "text", text: "ZRQPHX-SUBAGENT-ASSISTANT-PROSE token" },
                    {
                        type: "tool_use",
                        id: "toolu_ZRQPHX04",
                        name: "Grep",
                        input: { pattern: "ZRQPHX-GREP-PATTERN", path: "/tmp/proj-a" },
                    },
                ],
            },
        }),
    ];
}

/**
 * Writes a miniature but structurally faithful `projects/` tree under `root` and returns its
 * paths plus the expected row counts, so tests assert against known truth instead of the live
 * machine's own `~/.claude/projects`.
 *
 * The tree matches the real corpus's measured shape (`research/00-directory-survey.md`,
 * `research/verification-log.md` Round 3): a session file sits directly under a project
 * directory named after the working directory, and a subagent transcript lives at
 * `<session-uuid>/subagents/agent-<id>.jsonl` beside a one-per-file `.meta.json`.
 */
export function buildFixtureCorpus(root: string): FixtureCorpus {
    // 1. Lay out the directory tree: two project directories, one of them holding a session
    //    directory that itself holds a `subagents/` folder.
    const projectADir = join(root, "-tmp-proj-a");
    const projectBDir = join(root, "-tmp-proj-b");
    const mainSessionId = fixtureUuid(1);
    const projectBSessionId = fixtureUuid(2);
    const subagentId = fixtureAgentId(3);

    const mainSessionPath = join(projectADir, `${mainSessionId}.jsonl`);
    const projectBSessionPath = join(projectBDir, `${projectBSessionId}.jsonl`);
    const subagentSessionDir = join(projectADir, mainSessionId);
    const subagentsDir = join(subagentSessionDir, "subagents");
    const subagentTranscriptPath = join(subagentsDir, `agent-${subagentId}.jsonl`);
    const subagentMetaPath = join(subagentsDir, `agent-${subagentId}.meta.json`);

    mkdirSync(projectADir, { recursive: true });
    mkdirSync(projectBDir, { recursive: true });
    mkdirSync(subagentsDir, { recursive: true });

    // 2. Assemble each file's lines. The main session file ends with a torn, newline-less tail;
    //    every other file is well-formed.
    const mainCompleteLines = buildMainSessionLines(mainSessionId);
    const mainTornTail = buildTornTailLine(mainSessionId);
    const mainContent = mainCompleteLines.map((line) => `${line}\n`).join("") + mainTornTail;

    const projectBContent = buildProjectBLines(projectBSessionId)
        .map((line) => `${line}\n`)
        .join("");

    const subagentContent = buildSubagentLines(mainSessionId)
        .map((line) => `${line}\n`)
        .join("");

    // 3. Write every file. The subagent's sibling `.meta.json` carries the exact key set the
    //    real corpus was measured to use (`verification-log.md` Round 3).
    writeFileSync(mainSessionPath, mainContent, "utf8");
    writeFileSync(projectBSessionPath, projectBContent, "utf8");
    writeFileSync(subagentTranscriptPath, subagentContent, "utf8");
    writeFileSync(
        subagentMetaPath,
        JSON.stringify({
            agentType: "ac:librarian",
            description: "ZRQPHX-SUBAGENT-DESCRIPTION token",
            toolUseId: "toolu_ZRQPHX-META",
            spawnDepth: 1,
        }),
        "utf8",
    );

    // 4. State the expected counts a correct distiller pass produces across the whole corpus:
    //    main session (4 prose, 1 tool_use, 1 error, 3 quarantine, 18 control) plus project B
    //    (1 prose) plus the subagent transcript (2 prose, 1 tool_use). The torn tail is excluded:
    //    it never reaches the distiller, because the byte cursor discards it as an incomplete
    //    trailing fragment.
    const expected: FixtureCounts = {
        proseRows: 4 + 1 + 2,
        toolUseRows: 1 + 1,
        errorRows: 1,
        quarantineRows: 3,
        controlLinesSkipped: CONTROL_TYPES.length + 1,
    };

    return {
        root,
        projectADir,
        projectBDir,
        mainSessionId,
        mainSessionPath,
        projectBSessionId,
        projectBSessionPath,
        subagentSessionDir,
        subagentId,
        subagentTranscriptPath,
        subagentMetaPath,
        expected,
    };
}

/**
 * Appends well-formed JSONL lines to an existing fixture file, so cursor tests can grow a
 * session file between two `syncArchive` passes and assert only the delta was ingested.
 */
export function appendToFixture(path: string, lines: readonly string[]): void {
    const content = lines.map((line) => `${line}\n`).join("");
    appendFileSync(path, content, "utf8");
}
