import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { IMAGE_TOOL_NAME } from "./image-result.ts";

/** The parameter the model sees: a file on this machine. The proxy turns it into the remote's inline base64. */
export const REFERENCE_PATH_PARAM = "reference_image_path";

const REFERENCE_URL_PARAM = "reference_image_url";
const REFERENCE_BASE64_PARAM = "reference_image_base64";

/**
 * Largest picture sent inline, in bytes.
 *
 * The remote's `reference_image_base64` parameter takes at most 1,000,000 characters once its Tool row sets the
 * highest ceiling a row may declare, and base64 is a third larger than the bytes, so 740,000 bytes (986,668
 * characters) fits.
 */
export const MAX_REFERENCE_BYTES = 740_000;

/**
 * The sentence added to the tool description only when the remote takes a reference.
 *
 * Kept out of the base description so a remote that does not take one yet never tells the model to send one:
 * a reference the remote drops would come back as a fresh picture that looks like an edit.
 */
export const REFERENCE_TOOL_TEXT = "To edit or restyle a picture pass it as a reference: a local file "
    + `(${REFERENCE_PATH_PARAM}) or the image_url a previous call returned (${REFERENCE_URL_PARAM}). Without a `
    + "chat_id each call is independent, so a follow-up edit passes the reference again.";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** A reference the proxy refuses before anything is sent, so no picture was generated or counted. */
export class ReferenceImageError extends Error {}

/**
 * Whether the call names a reference at all (a local path, a link, or inline bytes); `null` counts as absent.
 */
export function asksForReference(args: Record<string, unknown> | undefined): boolean {
    return [REFERENCE_PATH_PARAM, REFERENCE_URL_PARAM, REFERENCE_BASE64_PARAM]
        .some((key) => args?.[key] !== undefined && args[key] !== null);
}

/**
 * Whether the remote's image tool takes a reference, read off its own schema: it declares the inline parameter.
 */
export function declaresInlineReference(remoteTools: readonly Tool[]): boolean {
    const properties = remoteTools.find((tool) => tool.name === IMAGE_TOOL_NAME)?.inputSchema.properties;

    return properties !== undefined && REFERENCE_BASE64_PARAM in properties;
}

/**
 * The arguments of a `generate_image` call with a local reference file turned into the remote's inline base64.
 *
 * The model names a file; the proxy reads it. The inline parameter is the proxy's alone: base64 a model wrote
 * into its own call is dropped, so a picture nobody chose never rides the request. The file must be a real PNG,
 * JPEG or WebP (read off its first bytes, never its name) within the inline ceiling.
 *
 * @throws ReferenceImageError when the path cannot be used; nothing has been sent then
 */
export async function inlineReference(
    args: Record<string, unknown> | undefined,
): Promise<Record<string, unknown> | undefined> {
    if (args === undefined) {
        return undefined;
    }

    const next = { ...args };
    const file = next[REFERENCE_PATH_PARAM];
    const link = next[REFERENCE_URL_PARAM];

    delete next[REFERENCE_BASE64_PARAM];
    delete next[REFERENCE_PATH_PARAM];

    if (file === undefined || file === null) {
        return next;
    }

    if (typeof file !== "string" || file === "") {
        throw new ReferenceImageError(`${REFERENCE_PATH_PARAM} must be a file path.`);
    }

    if (link !== undefined && link !== null) {
        throw new ReferenceImageError(`Pass either ${REFERENCE_PATH_PARAM} or ${REFERENCE_URL_PARAM}, not both.`);
    }

    next[REFERENCE_BASE64_PARAM] = (await readPicture(file)).toString("base64");

    return next;
}

/**
 * The remote tool as the model sees it: the inline base64 parameter is hidden, a local path parameter takes its
 * place and the description gains the sentence that explains references.
 *
 * Only when the remote declares the inline parameter: a remote whose tool does not take a reference yet must
 * not advertise one the call would then lose.
 */
export function withLocalReference(tool: Tool): Tool {
    const properties = tool.inputSchema.properties as Record<string, object> | undefined;

    if (properties === undefined || !(REFERENCE_BASE64_PARAM in properties)) {
        return tool;
    }

    const next: Record<string, object> = {};

    for (const [name, property] of Object.entries(properties)) {
        if (name !== REFERENCE_BASE64_PARAM) {
            next[name] = property;
        }
    }

    next[REFERENCE_PATH_PARAM] = {
        type: "string",
        description: "Optional reference picture to edit or restyle: the absolute path (or ~/...) of a local PNG, "
            + `JPEG or WebP file of at most ${MAX_REFERENCE_BYTES} bytes. Send it or ${REFERENCE_URL_PARAM}, not both.`,
    };

    return {
        ...tool,
        description: `${tool.description ?? ""} ${REFERENCE_TOOL_TEXT}`.trim(),
        inputSchema: { ...tool.inputSchema, properties: next },
    };
}

/** The `isError` result for a refused reference: it says nothing was sent, so repeating a fixed call is safe. */
export function referenceErrorResult(err: ReferenceImageError): CallToolResult {
    return {
        isError: true,
        content: [{
            type: "text",
            text: `${err.message} Nothing was sent, so no picture was generated or counted against the quota.`,
        }],
    };
}

async function readPicture(file: string): Promise<Buffer> {
    // `~` expands the way a shell does: from $HOME, then the account's home directory.
    const resolved = file.startsWith("~/") ? path.join(process.env["HOME"] || homedir(), file.slice(2)) : file;

    // 1. Only an absolute path: a relative one would resolve against whatever directory the proxy started in.
    if (!path.isAbsolute(resolved)) {
        throw new ReferenceImageError(`${REFERENCE_PATH_PARAM} must be an absolute path or start with ~/.`);
    }

    // 2. One open handle for every check and the read, so the file cannot change between them. O_NONBLOCK keeps
    //    a FIFO from blocking the open; it is then refused as not a regular file.
    const handle = await open(resolved, constants.O_RDONLY | constants.O_NONBLOCK).catch(
        (err: NodeJS.ErrnoException) => {
            throw new ReferenceImageError(`${file} cannot be read (${err.code ?? "error"}).`);
        },
    );

    try {
        const info = await handle.stat();

        if (!info.isFile()) {
            throw new ReferenceImageError(`${file} is not a file.`);
        }

        if (info.size > MAX_REFERENCE_BYTES) {
            throw new ReferenceImageError(`${file} is ${info.size} bytes; the limit is ${MAX_REFERENCE_BYTES} bytes.`);
        }

        // 3. Read one byte past the ceiling, so a file that grew after the stat is still refused.
        const buffer = Buffer.alloc(MAX_REFERENCE_BYTES + 1);
        let total = 0;

        while (total <= MAX_REFERENCE_BYTES) {
            const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);

            if (bytesRead === 0) {
                break;
            }

            total += bytesRead;
        }

        if (total > MAX_REFERENCE_BYTES) {
            throw new ReferenceImageError(`${file} is larger than ${MAX_REFERENCE_BYTES} bytes.`);
        }

        const bytes = buffer.subarray(0, total);

        // 4. The type is read off the bytes, so a text file named .png is refused.
        if (!isPicture(bytes)) {
            throw new ReferenceImageError(`${file} is not a PNG, JPEG or WebP picture.`);
        }

        return bytes;
    } finally {
        await handle.close();
    }
}

function isPicture(bytes: Buffer): boolean {
    const png = bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);
    const jpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    const webp = bytes.length >= 12
        && bytes.toString("latin1", 0, 4) === "RIFF"
        && bytes.toString("latin1", 8, 12) === "WEBP";

    return png || jpeg || webp;
}
