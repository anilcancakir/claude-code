import { expect, test } from "bun:test";
import { redact } from "./history-redact.ts";

// github-pat

test("redact github-pat ghp_ variant is redacted", () => {
    const secret = `ghp_${"A".repeat(36)}`;
    const result = redact(`token=${secret}`);
    expect(result.text).toBe("token=[REDACTED:github-pat]");
    expect(result.counts).toEqual({ "github-pat": 1 });
});

test("redact github-pat github_pat_ variant is redacted", () => {
    const secret = `github_pat_${"A".repeat(22)}`;
    const result = redact(`token=${secret}`);
    expect(result.text).toBe("token=[REDACTED:github-pat]");
    expect(result.counts).toEqual({ "github-pat": 1 });
});

test("redact github-pat near-miss ghp_ one character short is untouched", () => {
    const nearMiss = `ghp_${"A".repeat(35)}`;
    const result = redact(`token=${nearMiss}`);
    expect(result.text).toBe(`token=${nearMiss}`);
    expect(result.counts).toEqual({});
});

// anthropic-key

test("redact anthropic-key sk-ant- is labelled anthropic-key, not openai-key", () => {
    const secret = `sk-ant-${"A".repeat(20)}`;
    const result = redact(`key=${secret}`);
    expect(result.text).toBe("key=[REDACTED:anthropic-key]");
    expect(result.counts).toEqual({ "anthropic-key": 1 });
});

test("redact anthropic-key near-miss below minimum length is untouched", () => {
    const nearMiss = `sk-ant-${"A".repeat(10)}`;
    const result = redact(`key=${nearMiss}`);
    expect(result.text).toBe(`key=${nearMiss}`);
    expect(result.counts).toEqual({});
});

// openai-key

test("redact openai-key is redacted when it contains a digit", () => {
    const secret = `sk-${"A1".repeat(20)}`;
    const result = redact(`key=${secret}`);
    expect(result.text).toBe("key=[REDACTED:openai-key]");
    expect(result.counts).toEqual({ "openai-key": 1 });
});

test("redact openai-key near-miss: 45 all-lowercase-letters after sk- is untouched because it has no digit", () => {
    const nearMiss = `sk-${"a".repeat(45)}`;
    const result = redact(`key=${nearMiss}`);
    expect(result.text).toBe(`key=${nearMiss}`);
    expect(result.counts).toEqual({});
});

// aws-key

test("redact aws-key AKIA plus 16 uppercase-or-digit characters is redacted", () => {
    const secret = `AKIA${"A".repeat(16)}`;
    const result = redact(`aws_key=${secret}`);
    expect(result.text).toBe("aws_key=[REDACTED:aws-key]");
    expect(result.counts).toEqual({ "aws-key": 1 });
});

test("redact aws-key near-miss one character short is untouched", () => {
    const nearMiss = `AKIA${"A".repeat(15)}`;
    const result = redact(`aws_key=${nearMiss}`);
    expect(result.text).toBe(`aws_key=${nearMiss}`);
    expect(result.counts).toEqual({});
});

// kodizm-token

test("redact kodizm-token kdz- plus 20 or more characters is redacted", () => {
    const secret = `kdz-${"A".repeat(20)}`;
    const result = redact(`internal_token=${secret}`);
    expect(result.text).toBe("internal_token=[REDACTED:kodizm-token]");
    expect(result.counts).toEqual({ "kodizm-token": 1 });
});

test("redact kodizm-token near-miss below minimum length is untouched", () => {
    const nearMiss = `kdz-${"A".repeat(10)}`;
    const result = redact(`internal_token=${nearMiss}`);
    expect(result.text).toBe(`internal_token=${nearMiss}`);
    expect(result.counts).toEqual({});
});

// gitlab-pat

test("redact gitlab-pat glpat- token is redacted", () => {
    const secret = `glpat-${"A".repeat(20)}`;
    const result = redact(`gitlab=${secret}`);
    expect(result.text).toBe("gitlab=[REDACTED:gitlab-pat]");
    expect(result.counts).toEqual({ "gitlab-pat": 1 });
});

test("redact gitlab-pat near-miss below minimum length is untouched", () => {
    const nearMiss = `glpat-${"A".repeat(5)}`;
    const result = redact(`gitlab=${nearMiss}`);
    expect(result.text).toBe(`gitlab=${nearMiss}`);
    expect(result.counts).toEqual({});
});

// slack-token

test("redact slack-token xoxb- token is redacted", () => {
    const secret = `xoxb-${"A1".repeat(5)}`;
    const result = redact(`slack=${secret}`);
    expect(result.text).toBe("slack=[REDACTED:slack-token]");
    expect(result.counts).toEqual({ "slack-token": 1 });
});

test("redact slack-token near-miss with an unlisted letter after xox is untouched", () => {
    const nearMiss = `xoxq-${"A1".repeat(5)}`;
    const result = redact(`slack=${nearMiss}`);
    expect(result.text).toBe(`slack=${nearMiss}`);
    expect(result.counts).toEqual({});
});

// google-key

test("redact google-key AIza plus 35 characters is redacted", () => {
    const secret = `AIza${"A".repeat(35)}`;
    const result = redact(`google=${secret}`);
    expect(result.text).toBe("google=[REDACTED:google-key]");
    expect(result.counts).toEqual({ "google-key": 1 });
});

test("redact google-key near-miss one character short is untouched", () => {
    const nearMiss = `AIza${"A".repeat(34)}`;
    const result = redact(`google=${nearMiss}`);
    expect(result.text).toBe(`google=${nearMiss}`);
    expect(result.counts).toEqual({});
});

// jwt

test("redact jwt three dot-separated base64url runs beginning eyJ is redacted", () => {
    const secret =
        "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2ltdWxhdGVkX3NpZ25hdHVyZQ";
    const result = redact(`auth=${secret}`);
    expect(result.text).toBe("auth=[REDACTED:jwt]");
    expect(result.counts).toEqual({ jwt: 1 });
});

test("redact jwt near-miss with only two dot-separated segments is untouched", () => {
    const nearMiss = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0";
    const result = redact(`auth=${nearMiss}`);
    expect(result.text).toBe(`auth=${nearMiss}`);
    expect(result.counts).toEqual({});
});

// bearer

test("redact bearer Bearer plus 20 or more token characters is redacted", () => {
    const secret = `Bearer ${"A1".repeat(10)}`;
    const result = redact(`header: ${secret}`);
    expect(result.text).toBe("header: [REDACTED:bearer]");
    expect(result.counts).toEqual({ bearer: 1 });
});

test("redact bearer near-miss: ordinary prose containing the word bearer is untouched", () => {
    const prose = "The bearer of this note is authorized to collect the package on my behalf.";
    const result = redact(prose);
    expect(result.text).toBe(prose);
    expect(result.counts).toEqual({});
});

// A standard-base64 token carries `+`, `/` and `=`, which base64url does not. With those outside
// the character class the match stopped at the first one, redacting the head and leaving the tail
// in the archive in clear, which reads as redacted while still leaking.
test("redact bearer consumes a standard-base64 token whole, leaving no tail behind", () => {
    const secret = "Bearer aB1+cD2/eF3+gH4/iJ5+kL6/mN7=";
    const result = redact(`authorization: ${secret}`);

    expect(result.text).toBe("authorization: [REDACTED:bearer]");
    expect(result.counts).toEqual({ bearer: 1 });
    for (const fragment of ["+", "/", "="]) {
        expect(result.text).not.toContain(fragment);
    }
});

// The live defect this file's `|` cases exist for: the shipped archive held 13 rows across 3
// sessions carrying `[REDACTED:bearer]` immediately followed by 46 characters of the real token,
// because `|` sat outside the allowlisted character class and ended the match. Widening an
// allowlist is unfixable in principle, since the next token brings a character nobody enumerated,
// so the match is terminated by a DELIMITER instead. The shape below is the real leaked one.
test("redact bearer consumes a token containing an out-of-alphabet character whole", () => {
    const secret = "Bearer aB1cD2eF3gH4iJ5kL6mN7|tzcmoO0iINf6yzxpuYc72rmILHFwX2gK";
    const result = redact(`authorization: ${secret} next`);

    expect(result.text).toBe("authorization: [REDACTED:bearer] next");
    expect(result.counts).toEqual({ bearer: 1 });
    expect(result.text).not.toContain("|");
    expect(result.text).not.toContain("tzcmoO0iINf6");
});

// A delimiter-terminated match is greedy, so it could swallow a marker an earlier rule already
// wrote: `Bearer [REDACTED:kodizm-token]` is exactly the shape this archive stores, since the
// kodizm token travels as a bearer credential. Collapsing it into `[REDACTED:bearer]` would
// re-redact a marker and lose the more specific kind, so the match is tempered against it.
test("redact bearer leaves a token an earlier rule already redacted alone", () => {
    const alreadyRedacted = "authorization: Bearer [REDACTED:kodizm-token]";
    const result = redact(alreadyRedacted);

    expect(result.text).toBe(alreadyRedacted);
    expect(result.counts).toEqual({});
});

// One case per prefix-anchored kind, each carrying a character outside the alphabet its pattern
// used to allowlist, and each followed by a space plus a word. Two failures are visible at once:
// a surviving tail proves the match stopped at the stray character, and a missing `tail` proves it
// ran past the delimiter that ends a token.
const OUT_OF_ALPHABET_CASES: readonly { kind: string; secret: string; stray: string }[] = [
    { kind: "github-pat", secret: `ghp_${"A".repeat(30)}|${"B".repeat(8)}`, stray: "|" },
    { kind: "anthropic-key", secret: `sk-ant-${"A".repeat(15)}%${"B".repeat(9)}`, stray: "%" },
    { kind: "openai-key", secret: `sk-${"a1".repeat(20)}!${"b".repeat(5)}`, stray: "!" },
    { kind: "kodizm-token", secret: `kdz-${"A".repeat(12)}#${"B".repeat(10)}`, stray: "#" },
    { kind: "gitlab-pat", secret: `glpat-${"A".repeat(12)}$${"B".repeat(10)}`, stray: "$" },
    { kind: "slack-token", secret: `xoxb-${"A".repeat(6)}*${"B".repeat(6)}`, stray: "*" },
    { kind: "jwt", secret: "eyJhbGciOiJIUzI1NiJ9^a.eyJzdWIiOiIxIn0.c2lnbmF0dXJl^b", stray: "^" },
];

// The two rules that are NOT delimiter-terminated, and correctly so: both formats publish an exact
// body length, so the pattern can match the whole credential without guessing where it ends. That
// leaves no tail for a stray character to strand, which is the only thing delimiter greed buys, and
// it avoids the over-reach greed costs. `google-key` moved here from the sweep above after review
// measured a delimiter-terminated `AIza` hit consuming 185,792 characters of one long run.
const FIXED_WIDTH_CASES: readonly { kind: string; secret: string }[] = [
    { kind: "aws-key", secret: `AKIA${"A".repeat(16)}` },
    { kind: "google-key", secret: `AIza${"A".repeat(35)}` },
];

test("redact matches a fixed-width credential exactly, without reaching past its published length", () => {
    for (const { kind, secret } of FIXED_WIDTH_CASES) {
        const result = redact(`value=${secret} tail`);

        expect(result.text, `${kind} must redact its published shape`)
            .toBe(`value=[REDACTED:${kind}] tail`);
        expect(result.counts).toEqual({ [kind]: 1 });
    }
});

test("redact leaves a fixed-width prefix alone when the body is the wrong length", () => {
    // One character short of the published body, so it is not that credential and must survive.
    for (const { kind, secret } of FIXED_WIDTH_CASES) {
        const short = secret.slice(0, -1);
        const result = redact(`value=${short} tail`);

        expect(result.text, `${kind} must not redact a short body`).toBe(`value=${short} tail`);
    }
});

test("redact consumes a secret containing an out-of-alphabet character whole, for every kind", () => {
    for (const { kind, secret, stray } of OUT_OF_ALPHABET_CASES) {
        const result = redact(`value=${secret} tail`);

        expect(result.text).toBe(`value=[REDACTED:${kind}] tail`);
        expect(result.counts).toEqual({ [kind]: 1 });
        expect(result.text).not.toContain(stray);
    }
});

// db-url-credentials

test("redact db-url-credentials replaces only the credential span, keeping the scheme and host", () => {
    const result = redact("connect to postgres://dbuser:dbpass123@db.internal:5432/appdb now");
    expect(result.text).toBe(
        "connect to postgres://[REDACTED:db-url-credentials]@db.internal:5432/appdb now",
    );
    expect(result.counts).toEqual({ "db-url-credentials": 1 });
});

test("redact db-url-credentials handles the mongodb+srv scheme", () => {
    const result = redact("uri=mongodb+srv://svcuser:svcpass@cluster0.example.mongodb.net/app");
    expect(result.text).toBe(
        "uri=mongodb+srv://[REDACTED:db-url-credentials]@cluster0.example.mongodb.net/app",
    );
    expect(result.counts).toEqual({ "db-url-credentials": 1 });
});

test("redact db-url-credentials near-miss: a URL with no embedded credentials is untouched", () => {
    const url = "postgres://db.internal:5432/appdb";
    const result = redact(`connect to ${url} now`);
    expect(result.text).toBe(`connect to ${url} now`);
    expect(result.counts).toEqual({});
});

// Found while measuring the delimiter inversion against the real archive: 4 shipped rows still
// matched this rule on a second pass, because `[REDACTED` `:` `db-url-credentials]` `@` satisfies its
// own `user:pass@` shape. The rewritten text is identical either way, so nothing leaked and nothing
// was mangled, but the hit count gained a phantom redaction the archive never performed.
test("redact db-url-credentials does not re-redact its own marker on a second pass", () => {
    const once = redact("connect to postgres://dbuser:dbpass123@db.internal:5432/appdb now");
    const twice = redact(once.text);

    expect(twice.text).toBe(once.text);
    expect(twice.counts).toEqual({});
});

// private-key

test("redact private-key BEGIN ... PRIVATE KEY header is redacted", () => {
    const result = redact("-----BEGIN RSA PRIVATE KEY-----\nMIIB...");
    expect(result.text).toBe("[REDACTED:private-key]\nMIIB...");
    expect(result.counts).toEqual({ "private-key": 1 });
});

// Matching the header alone left the base64 body and the `-----END-----` footer in the archive, so
// a pasted key read as sanitised while remaining whole and usable. The whole block is one match.
test("redact private-key redacts the header, the body and the footer as one block", () => {
    const pem = [
        "-----BEGIN OPENSSH PRIVATE KEY-----",
        "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtz",
        "c2gtZW7NTE5AAAAIA2c2ltdWxhdGVkX2tleV9ib2R5X2Zvcl90aGlzX3Rlc3Rf",
        "-----END OPENSSH PRIVATE KEY-----",
    ].join("\n");

    const result = redact(`key follows:\n${pem}\ndone`);

    expect(result.text).toBe("key follows:\n[REDACTED:private-key]\ndone");
    expect(result.counts).toEqual({ "private-key": 1 });
    expect(result.text).not.toContain("b3BlbnNzaC1rZXktdjEA");
    expect(result.text).not.toContain("-----END");
});

test("redact private-key near-miss: a BEGIN CERTIFICATE header is untouched", () => {
    const header = "-----BEGIN CERTIFICATE-----";
    const result = redact(header);
    expect(result.text).toBe(header);
    expect(result.counts).toEqual({});
});

// whole-function contract

test("redact returns the input unchanged with an empty count map when nothing matches", () => {
    const prose = "This is an ordinary paragraph of prose with no secrets embedded anywhere in it.";
    const result = redact(prose);
    expect(result.text).toBe(prose);
    expect(result.counts).toEqual({});
});

test("redact does not re-redact text already inside a [REDACTED:...] marker", () => {
    const alreadyRedacted = "previous pass left this marker: [REDACTED:openai-key] untouched";
    const result = redact(alreadyRedacted);
    expect(result.text).toBe(alreadyRedacted);
    expect(result.counts).toEqual({});
});

// The step's QA field asked for Turkish prose from this repository's own CLAUDE.md, but that file
// is English by the repository's own English-only convention, so the premise did not hold. Turkish
// prose is still the case that matters most here: this archive's owner writes in Turkish, so
// diacritic-bearing text is the bulk of what redaction will ever see, and a pattern loose enough to
// bite it would corrupt the archive permanently. Hence a real Turkish paragraph as a literal.
test("redact leaves Turkish prose with diacritics byte-identical", () => {
    const prose = [
        "Uptizm için FrankenPHP kurulumunu tamamladık, planı gözden geçirdim ve çalışıyor.",
        "Şu an yapılacak tek iş, göç dosyalarını sırayla çalıştırıp çıktıyı doğrulamak.",
        "İstanbul'daki sunucuda ölçtüğüm süre yaklaşık üç buçuk saniyeydi, ağırlıklı olarak ağ.",
        "Öğrendiğim şey şu: şifreleme anahtarını asla günlüğe yazmamak gerekiyor.",
    ].join("\n");

    const result = redact(prose);

    expect(result.text).toBe(prose);
    expect(result.counts).toEqual({});
});

// Turkish text sitting immediately around a real secret must survive intact while the secret goes.
// This is the mixed case the archive actually stores: a sentence, a pasted token, a sentence.
test("redact removes a secret embedded in Turkish prose without touching the prose", () => {
    const before = "Şu token'ı deneyelim:";
    const after = "ve sonra ölçümü tekrarla.";
    const result = redact(`${before} AKIA1234567890ABCDEF ${after}`);

    expect(result.text).toBe(`${before} [REDACTED:aws-key] ${after}`);
    expect(result.counts).toEqual({ "aws-key": 1 });
});
