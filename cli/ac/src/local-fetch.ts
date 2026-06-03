import { Buffer } from "node:buffer";
import { promises as dnsPromises } from "node:dns";
import type { LookupAddress } from "node:dns";
import { isIP } from "node:net";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { NodeHtmlMarkdown } from "node-html-markdown";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { isPrivateOrLoopback, stripIpv6Brackets } from "./ip-classifier.ts";

const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 25_000;

// Chrome desktop fingerprint, copied verbatim so the local fetch presents as a real browser.
const CHROME_HEADERS: Readonly<Record<string, string>> = {
    "accept":
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
    "accept-language": "en-GB,en;q=0.9",
    "sec-ch-ua": "\"Chromium\";v=\"148\", \"Google Chrome\";v=\"148\", \"Not/A)Brand\";v=\"99\"",
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": "\"macOS\"",
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
    "sec-fetch-site": "none",
    "sec-fetch-user": "?1",
    "upgrade-insecure-requests": "1",
    "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
} as const;

export type LookupFn = (hostname: string) => Promise<readonly LookupAddress[]>;

export type FetchFn = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface LocalFetchDeps {
    readonly lookup?: LookupFn;
    readonly fetch?: FetchFn;
}

interface ParsedArticle {
    readonly content: string;
}

interface ReadabilityInstance {
    parse(): ParsedArticle | null;
}

interface ReadabilityConstructor {
    new (document: unknown): ReadabilityInstance;
}

// 1. Retype Readability so its constructor accepts the linkedom document. Readability is typed
//    against `globalThis.Document` from lib.dom, which this project's tsconfig does not include.
const ReadabilityCtor: ReadabilityConstructor = Readability as unknown as ReadabilityConstructor;

const defaultLookup: LookupFn = async (hostname: string): Promise<readonly LookupAddress[]> => {
    return await dnsPromises.lookup(hostname, {
        all: true,
        verbatim: true,
    });
};

export const LOCAL_WEB_FETCH_TOOL_DEFINITION: Tool = {
    name: "web-fetch",
    description:
        "Fetch a URL from this machine using a real browser header set and return the page as markdown. "
        + "Validates the URL against an SSRF guard (no private, loopback, link-local, or cloud-metadata "
        + "targets) and does not follow redirects.",
    inputSchema: {
        type: "object",
        properties: {
            url: {
                type: "string",
                description: "Absolute http(s) URL to fetch.",
            },
            format: {
                type: "string",
                enum: ["markdown"],
                default: "markdown",
                description: "Output format. Only markdown is produced; the field exists for remote-shape parity.",
            },
        },
        required: ["url"],
    },
};

/**
 * Fetches a URL from the local machine with browser headers and returns its rendered markdown.
 *
 * The pipeline is hardened against SSRF: the scheme and port are constrained, every resolved
 * address is classified, redirects are surfaced as errors rather than followed, and the body is
 * capped at 5MB. All internal failures throw a plain Error; the caller's race layer treats those
 * as local non-results.
 *
 * @param url  Absolute http(s) URL to fetch.
 * @param deps Optional injected `lookup` / `fetch` for testing; defaults to DNS + global fetch.
 * @returns A CallToolResult carrying a single markdown text block.
 * @throws Error on a disallowed scheme/port, private/unresolvable host, redirect, oversize body,
 *         or any fetch failure.
 */
export async function runLocalFetch(url: string, deps: LocalFetchDeps = {}): Promise<CallToolResult> {
    // 1. Validate scheme: only http(s) may reach the network.
    const parsed = new URL(url);
    const scheme = parsed.protocol.replace(/:$/, "");
    if (scheme !== "http" && scheme !== "https") {
        throw new Error(`scheme not allowed: ${scheme}`);
    }

    // 2. Validate port: only the scheme default is permitted (URL.port is "" for the default).
    const port = parsed.port;
    const isDefaultPort = port === ""
        || (scheme === "http" && port === "80")
        || (scheme === "https" && port === "443");
    if (!isDefaultPort) {
        throw new Error(`port not allowed: ${port}`);
    }

    // 3. Resolve the host. Literal IPs skip DNS and classify directly; names go through lookup.
    const rawHostname = stripIpv6Brackets(parsed.hostname);
    const literalFamily = isIP(rawHostname);
    const lookup = deps.lookup ?? defaultLookup;
    const resolved: readonly LookupAddress[] = literalFamily !== 0
        ? [
            {
                address: rawHostname,
                family: literalFamily,
            },
        ]
        : await lookup(rawHostname);

    if (resolved.length === 0) {
        throw new Error(`URL resolves to no addresses: ${rawHostname}`);
    }

    // 4. Reject if ANY resolved address is private / loopback / link-local / metadata. Pinning to a
    //    single record would leave a round-robin DNS answer with one private member exploitable.
    for (const entry of resolved) {
        if (isPrivateOrLoopback(entry.address, entry.family)) {
            throw new Error(`URL resolves to private/loopback address: ${entry.address}`);
        }
    }

    // 5. Issue the request with a manual timeout. redirect:"manual" keeps the SDK out of redirect
    //    handling; the user's curl has no -L, so a 3xx is a non-result, not a hop to follow.
    const fetchImpl = deps.fetch ?? (globalThis.fetch as FetchFn);
    const controller = new AbortController();
    const timer = setTimeout((): void => {
        controller.abort();
    }, DEFAULT_TIMEOUT_MS);

    try {
        const response = await fetchImpl(url, {
            method: "GET",
            headers: { ...CHROME_HEADERS },
            redirect: "manual",
            signal: controller.signal,
        });

        // 6. A 3xx is surfaced as a thrown error so the race layer keeps waiting for the remote.
        if (response.status >= 300 && response.status < 400) {
            throw new Error("redirect not followed");
        }
        if (!response.ok) {
            throw new Error(`fetch failed with status ${response.status}`);
        }

        // 7. Stream the body and enforce the 5MB cap on accumulated bytes (NOT Content-Length).
        const body = response.body;
        if (body === null) {
            throw new Error("response has no body");
        }
        const chunks: Uint8Array[] = [];
        let total = 0;
        const iterator = body as unknown as AsyncIterable<Uint8Array>;
        for await (const chunk of iterator) {
            total += chunk.byteLength;
            if (total > MAX_RESPONSE_BYTES) {
                controller.abort();
                throw new Error("response exceeds 5MB limit");
            }
            chunks.push(chunk);
        }

        // 8. Decode UTF-8 and render to markdown.
        const html = new TextDecoder().decode(Buffer.concat(chunks));
        const markdown = renderMarkdown(html);
        return {
            content: [
                {
                    type: "text",
                    text: markdown,
                },
            ],
        };
    } finally {
        clearTimeout(timer);
    }
}

function sanitizeMarkdownSchemes(markdown: string): string {
    // 1. Neutralise inline markdown links like [text](javascript:...) → [text](#sanitized-link).
    const inlineSanitized = markdown.replace(
        /\]\((?:javascript|data|vbscript|file):[^)]*\)/gi,
        "](#sanitized-link)",
    );
    // 2. Neutralise autolinks like <javascript:...> → <#sanitized-link>.
    return inlineSanitized.replace(/<(?:javascript|data|vbscript|file):[^>]*>/gi, "<#sanitized-link>");
}

function sanitizeHtmlSchemes(html: string): string {
    // 1. Pre-rewrite dangerous href / src targets at the HTML level. node-html-markdown drops a
    //    javascript: href entirely, which would silently bypass the markdown post-pass; rewriting
    //    at HTML-time guarantees a visible placeholder survives the conversion.
    return html.replace(
        /(href|src)\s*=\s*(['"])\s*(?:javascript|data|vbscript|file):[^'"]*\2/gi,
        "$1=$2#sanitized-link$2",
    );
}

function renderMarkdown(html: string): string {
    // 1. Sanitise dangerous URL schemes at the HTML layer first (see sanitizeHtmlSchemes).
    const safeHtml = sanitizeHtmlSchemes(html);
    const { document } = parseHTML(safeHtml);

    // 2. Run Readability for main-content extraction. linkedom returns a structurally-compatible
    //    Document at runtime; ReadabilityCtor retypes the constructor to accept it.
    const article = new ReadabilityCtor(document).parse();
    const content = article?.content ?? safeHtml;

    // 3. Convert the extracted HTML to markdown.
    const markdown = new NodeHtmlMarkdown(
        {
            bulletMarker: "-",
            codeBlockStyle: "fenced",
        },
    ).translate(content);

    // 4. Defence in depth: strip any dangerous scheme that slipped through into markdown.
    return sanitizeMarkdownSchemes(markdown);
}
