// Secret redaction applied before any transcript body is persisted to the archive.
// The archive is permanent and the source transcript ages out after ~30 days, so redaction
// cannot be applied retroactively. Over-redaction of ordinary prose is exactly as permanent
// as under-redaction of a real secret, hence a near-miss negative test for every kind below.

/** The set of secret shapes this module recognizes. */
export type RedactKind =
    | "github-pat"
    | "anthropic-key"
    | "openai-key"
    | "aws-key"
    | "kodizm-token"
    | "gitlab-pat"
    | "slack-token"
    | "google-key"
    | "jwt"
    | "bearer"
    | "db-url-credentials"
    | "private-key";

/** The rewritten text plus a per-kind hit count. Never carries the matched secret text. */
export interface RedactResult {
    readonly text: string;
    readonly counts: Partial<Record<RedactKind, number>>;
}

interface RedactRule {
    readonly kind: RedactKind;
    readonly pattern: RegExp;
    // Optional extra check beyond the pattern, run against the raw match. Returning false
    // leaves the match untouched instead of counting it as a hit.
    readonly isValid?: (match: string) => boolean;
}

// One character of a secret's body, for every rule whose match is anchored on a known prefix.
//
// A secret's charset is not knowable, so the TERMINATOR defines the match rather than an alphabet.
// The first version of the `bearer` rule allowlisted base64url; the second widened that class to add
// `+/=` and was called fixed. Then a real token carrying `|` matched only up to the pipe, so the
// marker landed and rows of the shipped archive kept 46 characters of live token immediately after
// `[REDACTED:bearer]`, reading as sanitised while leaking: 13 rows across 3 sessions when the defect
// was found, 18 across 4 by the time the archive was rebuilt to cure it. Widening an
// allowlist cannot fix that in principle: the next token brings a character nobody enumerated. So
// every prefix-anchored rule consumes up to a DELIMITER instead, meaning whitespace, either quote,
// or a backslash, which is where a pasted token actually ends in surrounding text.
//
// The cost is symmetrical and deliberate: greed towards a delimiter is safer against a leak and
// more dangerous against prose, so the prefix anchors and the per-rule length floors are what keep
// it off ordinary text and neither may be weakened to let a pattern match.
//
// The `(?!\[REDACTED:)` temper is the one exception carved out of that greed. Rules run in order, so
// a marker an earlier rule wrote is already sitting in the text: `Bearer [REDACTED:kodizm-token]` is
// a real shape here, since the kodizm token travels as a bearer credential. Untempered, the bearer
// rule would swallow that marker and collapse it into `[REDACTED:bearer]`, re-redacting a marker and
// losing the more specific kind. The guard is marker-shaped rather than charset-shaped on purpose.
const SECRET_CHAR = "(?:(?!\\[REDACTED:)[^\\s\"'\\\\])";

/**
 * Builds a prefix-anchored rule pattern, so no rule can be left behind on a change to
 * {@link SECRET_CHAR}, which is how the `bearer` class came to differ from its siblings twice.
 *
 * @param anchor Regex fragment for the literal prefix, a character class included (`xox[bpsar]-`).
 * @param minLength Floor on the body, in characters. What keeps the delimiter-terminated greed off
 *        ordinary prose, so it may be raised but never lowered.
 * @param maxLength Ceiling on the body. Delimiter termination stops only at whitespace, a quote or a
 *        backslash, so a chance prefix hit inside a long delimiter-free run consumes the whole run:
 *        measured at 185,792 characters for one `AIza` hit over raw corpus strings. Nothing
 *        structural bounds it, since bodies are not truncated before redaction and the largest
 *        stored body is 882,668 characters; what limits it today is only that the longest
 *        delimiter-free run in any stored body happens to be 2,230 characters. A ceiling turns that
 *        luck into a guarantee, and no published credential format approaches it.
 */
function prefixAnchored(anchor: string, minLength: number, maxLength: number): RegExp {
    return new RegExp(`\\b${anchor}${SECRET_CHAR}{${minLength},${maxLength}}`, "g");
}

// Delimiter-terminated greed reaches into exactly the text this archive exists to search: measured
// over a fifth of the corpus, the false positives were a shell `grep` whose regex begins `kdz-[`, a
// config filename, and a listing of these very patterns. A brace or a bracket inside a match is the
// signal, since no published key format contains one, while `${VAR}` placeholders and regex sources
// are full of them. This is a VETO rather than a charset change on purpose: a real token carrying a
// character nobody enumerated still redacts whole, which is the property the delimiter shape bought.
const STRUCTURAL_CHARACTERS = /[[\]{}]/;

function holdsStructuralCharacter(match: string): boolean {
    return STRUCTURAL_CHARACTERS.test(match);
}

// A PEM body is bounded so that a `BEGIN` whose own `END` is missing cannot reach a later block's
// footer and swallow every line between. 8 KB clears an 8192-bit RSA body (about 6.5 KB) with room.
const PRIVATE_KEY_BODY_LIMIT = 8000;

const PRIVATE_KEY_BEGIN = "-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----";

const PRIVATE_KEY_END = "-----END(?: [A-Z0-9]+)* PRIVATE KEY-----";

// Order matters: anthropic-key is tried before openai-key, or "sk-ant-..." would be captured
// by the looser openai-key shape. The negative lookahead in openai-key's pattern also guards
// this independently, but the ordering is kept explicit because the plan calls it out.
const RULES: readonly RedactRule[] = [
    {
        kind: "github-pat",
        pattern: new RegExp(
            `\\b(?:ghp_${SECRET_CHAR}{36,512}|github_pat_${SECRET_CHAR}{22,512})`,
            "g",
        ),
    },
    {
        kind: "anthropic-key",
        pattern: prefixAnchored("sk-ant-", 20, 512),
    },
    {
        // Tightened past the prototype's "sk- plus 32 alphanumerics", which fired 154 times on
        // the real corpus: at least 40 characters after the prefix, and the match must contain
        // at least one digit, since a real API key is never all letters.
        kind: "openai-key",
        pattern: new RegExp(`\\bsk-(?!ant-)${SECRET_CHAR}{40,512}`, "g"),
        isValid: (match) => /\d/.test(match),
    },
    {
        // Not delimiter-terminated, and correctly so: `AKIA` plus exactly 16 uppercase-or-digit
        // characters is a fixed-width published format, not a charset guess, so there is no tail
        // for a stray character to leave behind.
        kind: "aws-key",
        pattern: /\bAKIA[A-Z0-9]{16}\b/g,
    },
    {
        kind: "kodizm-token",
        pattern: prefixAnchored("kdz-", 20, 512),
    },
    {
        kind: "gitlab-pat",
        pattern: prefixAnchored("glpat-", 20, 512),
    },
    {
        kind: "slack-token",
        pattern: prefixAnchored("xox[bpsar]-", 10, 512),
    },
    {
        kind: "google-key",
        pattern: /\bAIza[A-Za-z0-9_-]{35}/g,
    },
    {
        // The two dots are the anchor here rather than a prefix alphabet: `eyJ` plus three
        // dot-separated runs is the shape, and each run consumes to the delimiter.
        //
        // Each run carries its own floor because a dot is itself a legal secret character, so
        // without one an ellipsis satisfies the shape: measured on the real corpus, the prose
        // "`Bearer eyJhbGciOi...`)" matched and swallowed the closing backtick and paren with it.
        // 10 clears the shortest possible encoded JWT header (`{"alg":"HS256"}` is 20 characters
        // encoded), while 4 on the payload and the signature keeps a truncated paste in scope.
        kind: "jwt",
        pattern: new RegExp(
            `\\beyJ${SECRET_CHAR}{10,2048}\\.${SECRET_CHAR}{4,2048}\\.${SECRET_CHAR}{4,2048}`,
            "g",
        ),
    },
    {
        // Case-sensitive "Bearer" so ordinary prose using the lowercase word is left alone.
        // Bounded for the same reason as every other delimiter-terminated rule: without a ceiling a
        // `Bearer ` followed by one long delimiter-free run consumes the whole run.
        kind: "bearer",
        pattern: new RegExp(`\\bBearer\\s+${SECRET_CHAR}{20,512}`, "g"),
    },
    {
        // Header through footer as one match. Matching the header alone left the base64 body and
        // the `-----END-----` line in the archive, so a pasted key read as sanitised while
        // remaining whole and usable. The footer group stays OPTIONAL: a truncated paste that
        // carries no footer must still lose its header rather than escape the rule entirely.
        kind: "private-key",
        pattern: new RegExp(
            PRIVATE_KEY_BEGIN
            + `(?:[\\s\\S]{0,${PRIVATE_KEY_BODY_LIMIT}}?${PRIVATE_KEY_END})?`,
            "g",
        ),
    },
];

// Connection-string schemes whose "user:pass@" span is the only part worth redacting; the
// scheme and host stay in the output because they are not secrets and are useful context. The
// terminator here is already delimiter-shaped, the `@`, so this rule needs no inversion.
//
// It does need the same marker temper as the prefix-anchored rules: `[REDACTED` `:`
// `db-url-credentials]` `@` satisfies its own `user:pass@` shape, so a second pass over its own
// output counted a phantom hit. Measured on 4 rows of the shipped archive. The rewritten text was
// identical either way, so this cost a count rather than any content.
const DB_URL_PATTERN =
    /\b(postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/(?!\[REDACTED:)[^/\s:@]+:[^/\s@]+@/g;

function increment(counts: Partial<Record<RedactKind, number>>, kind: RedactKind): void {
    counts[kind] = (counts[kind] ?? 0) + 1;
}

function applyRule(
    text: string,
    rule: RedactRule,
    counts: Partial<Record<RedactKind, number>>,
): string {
    return text.replace(rule.pattern, (match: string): string => {
        // The structural veto runs for every rule, not per-rule, because no published credential
        // format contains a brace or a bracket, base64 and base64url included, so there is no rule
        // it could wrongly exempt. It is what keeps delimiter-terminated greed out of the technical
        // text this archive exists to search: measured over a fifth of the corpus, the false
        // positives were a shell `grep` whose regex begins `kdz-[`, a config filename, a listing of
        // these very patterns, and `Bearer ${process.env.TOKEN}` swallowed whole.
        if (holdsStructuralCharacter(match)) {
            return match;
        }
        if (rule.isValid && !rule.isValid(match)) {
            return match;
        }
        increment(counts, rule.kind);
        return `[REDACTED:${rule.kind}]`;
    });
}

function applyDbUrlRule(text: string, counts: Partial<Record<RedactKind, number>>): string {
    return text.replace(DB_URL_PATTERN, (_match: string, scheme: string): string => {
        increment(counts, "db-url-credentials");
        return `${scheme}://[REDACTED:db-url-credentials]@`;
    });
}

/**
 * Rewrites `text`, replacing every recognized secret shape with `[REDACTED:<kind>]`, and
 * returns a per-kind hit count alongside the rewritten text. Never returns or logs the
 * matched secret itself, and never re-redacts anything already inside a `[REDACTED:...]`
 * marker: the delimiter-terminated rules are tempered against that literal bracketed form by
 * {@link SECRET_CHAR}, and the two rules that are not delimiter-terminated cannot reach it.
 */
export function redact(text: string): RedactResult {
    const counts: Partial<Record<RedactKind, number>> = {};
    let result = text;

    // 1. Pattern-only rules, applied in the fixed order declared above.
    for (const rule of RULES) {
        result = applyRule(result, rule, counts);
    }

    // 2. The database-credential rule keeps the scheme and host, so it needs its own
    //    replacement shape rather than the whole-match "[REDACTED:<kind>]" of the rules above.
    result = applyDbUrlRule(result, counts);

    return { text: result, counts };
}
