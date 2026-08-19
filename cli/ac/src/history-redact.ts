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

// Order matters: anthropic-key is tried before openai-key, or "sk-ant-..." would be captured
// by the looser openai-key shape. The negative lookahead in openai-key's pattern also guards
// this independently, but the ordering is kept explicit because the plan calls it out.
const RULES: readonly RedactRule[] = [
    {
        kind: "github-pat",
        pattern: /\b(?:ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{22,})\b/g,
    },
    {
        kind: "anthropic-key",
        pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
    },
    {
        // Tightened past the prototype's "sk- plus 32 alphanumerics", which fired 154 times on
        // the real corpus: at least 40 characters after the prefix, and the match must contain
        // at least one digit, since a real API key is never all letters.
        kind: "openai-key",
        pattern: /\bsk-(?!ant-)[A-Za-z0-9]{40,}\b/g,
        isValid: (match) => /\d/.test(match),
    },
    {
        kind: "aws-key",
        pattern: /\bAKIA[A-Z0-9]{16}\b/g,
    },
    {
        kind: "kodizm-token",
        pattern: /\bkdz-[A-Za-z0-9_-]{20,}\b/g,
    },
    {
        kind: "gitlab-pat",
        pattern: /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
    },
    {
        kind: "slack-token",
        pattern: /\bxox[bpsar]-[A-Za-z0-9-]{10,}\b/g,
    },
    {
        kind: "google-key",
        pattern: /\bAIza[A-Za-z0-9_-]{35}\b/g,
    },
    {
        kind: "jwt",
        pattern: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
    },
    {
        kind: "bearer",
        // Case-sensitive "Bearer" so ordinary prose using the lowercase word is left alone.
        // The character class carries `+`, `/` and `=` alongside base64url's own alphabet: a
        // standard-base64 token containing them would otherwise match only up to the first `+` or
        // `/`, redacting the head and leaving the tail sitting in the archive in clear. The
        // `Bearer ` prefix anchors the match, so widening the class cannot reach ordinary prose.
        pattern: /\bBearer\s+[A-Za-z0-9._+/=-]{20,}/g,
    },
    {
        kind: "private-key",
        pattern: /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----/g,
    },
];

// Connection-string schemes whose "user:pass@" span is the only part worth redacting; the
// scheme and host stay in the output because they are not secrets and are useful context.
const DB_URL_PATTERN =
    /\b(postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^/\s:@]+:[^/\s@]+@/g;

function increment(counts: Partial<Record<RedactKind, number>>, kind: RedactKind): void {
    counts[kind] = (counts[kind] ?? 0) + 1;
}

function applyRule(
    text: string,
    rule: RedactRule,
    counts: Partial<Record<RedactKind, number>>,
): string {
    return text.replace(rule.pattern, (match: string): string => {
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
 * marker, because none of the patterns below can match that literal bracketed form.
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
