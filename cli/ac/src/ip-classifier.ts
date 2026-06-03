import { isIP } from "node:net";

function ipv4ToUint32(address: string): number | undefined {
    const parts = address.split(".");
    if (parts.length !== 4) {
        return undefined;
    }
    let acc = 0;
    for (const part of parts) {
        if (part === undefined || part.length === 0 || part.length > 3) {
            return undefined;
        }
        if (!/^\d+$/.test(part)) {
            return undefined;
        }
        const value = Number(part);
        if (!Number.isInteger(value) || value < 0 || value > 255) {
            return undefined;
        }
        // 1. Shift left in 32-bit unsigned space; >>> 0 normalises sign.
        acc = ((acc << 8) | value) >>> 0;
    }
    return acc;
}

function isPrivateOrLoopbackIpv4(address: string): boolean {
    const value = ipv4ToUint32(address);
    if (value === undefined) {
        return false;
    }
    // 1. Normalise bitwise AND results to unsigned 32-bit ( ">>> 0" ) before comparison,
    //    since JS bitwise operators return signed Int32 and ranges 172.16/12, 192.168/16,
    //    169.254/16 sit above 2^31 and would otherwise produce false-negatives.
    const byte0 = (value >>> 24) & 0xff;
    const byte1 = (value >>> 16) & 0xff;
    // 127.0.0.0/8 — loopback.
    if (byte0 === 127) {
        return true;
    }
    // 10.0.0.0/8 — RFC1918.
    if (byte0 === 10) {
        return true;
    }
    // 172.16.0.0/12 — RFC1918.
    if (byte0 === 172 && (byte1 & 0xf0) === 16) {
        return true;
    }
    // 192.168.0.0/16 — RFC1918.
    if (byte0 === 192 && byte1 === 168) {
        return true;
    }
    // 169.254.0.0/16 — link-local.
    if (byte0 === 169 && byte1 === 254) {
        return true;
    }
    // 0.0.0.0/8 — unspecified / "this network".
    if (byte0 === 0) {
        return true;
    }
    return false;
}

function normalizeIpv6Word(word: string): number | undefined {
    if (word.length === 0 || word.length > 4) {
        return undefined;
    }
    if (!/^[0-9a-fA-F]+$/.test(word)) {
        return undefined;
    }
    return parseInt(word, 16);
}

function expandIpv6(address: string): readonly number[] | undefined {
    // 1. Strip zone identifier if present (fe80::1%eth0 → fe80::1).
    const zoneIndex = address.indexOf("%");
    const stripped = zoneIndex === -1 ? address : address.slice(0, zoneIndex);

    // 2. Handle embedded IPv4 (e.g. ::ffff:127.0.0.1).
    const lastColon = stripped.lastIndexOf(":");
    let tail = stripped;
    let trailingV4Words: readonly number[] = [];
    if (lastColon !== -1) {
        const candidate = stripped.slice(lastColon + 1);
        if (candidate.includes(".")) {
            const v4 = ipv4ToUint32(candidate);
            if (v4 === undefined) {
                return undefined;
            }
            trailingV4Words = [
                (v4 >>> 16) & 0xffff,
                v4 & 0xffff,
            ];
            tail = stripped.slice(0, lastColon);
        }
    }

    // 3. Split around the "::" abbreviation.
    const doubleColon = tail.indexOf("::");
    let head: readonly string[];
    let middle: readonly string[];
    if (doubleColon === -1) {
        head = tail.length === 0 ? [] : tail.split(":");
        middle = [];
    } else {
        const left = tail.slice(0, doubleColon);
        const right = tail.slice(doubleColon + 2);
        head = left.length === 0 ? [] : left.split(":");
        middle = right.length === 0 ? [] : right.split(":");
    }

    const explicit: number[] = [];
    for (const word of head) {
        const value = normalizeIpv6Word(word);
        if (value === undefined) {
            return undefined;
        }
        explicit.push(value);
    }
    const tailWords: number[] = [];
    for (const word of middle) {
        const value = normalizeIpv6Word(word);
        if (value === undefined) {
            return undefined;
        }
        tailWords.push(value);
    }

    const totalKnown = explicit.length + tailWords.length + trailingV4Words.length;
    if (totalKnown > 8) {
        return undefined;
    }
    const padding = doubleColon === -1 ? 0 : 8 - totalKnown;
    const padded: number[] = [
        ...explicit,
        ...Array.from(
            {
                length: padding,
            },
            (): number => 0,
        ),
        ...tailWords,
        ...trailingV4Words,
    ];
    if (padded.length !== 8) {
        return undefined;
    }
    return padded;
}

function isPrivateOrLoopbackIpv6(address: string): boolean {
    const words = expandIpv6(address);
    if (words === undefined) {
        return false;
    }
    // ::1 loopback
    if (
        words[0] === 0 &&
        words[1] === 0 &&
        words[2] === 0 &&
        words[3] === 0 &&
        words[4] === 0 &&
        words[5] === 0 &&
        words[6] === 0 &&
        words[7] === 1
    ) {
        return true;
    }
    // ::ffff:0:0/96 — IPv4-mapped IPv6; recurse into v4 classification.
    if (
        words[0] === 0 &&
        words[1] === 0 &&
        words[2] === 0 &&
        words[3] === 0 &&
        words[4] === 0 &&
        words[5] === 0xffff
    ) {
        const high = words[6] ?? 0;
        const low = words[7] ?? 0;
        const v4 = `${(high >>> 8) & 0xff}.${high & 0xff}.${(low >>> 8) & 0xff}.${low & 0xff}`;
        return isPrivateOrLoopbackIpv4(v4);
    }
    // fe80::/10 link-local — top 10 bits == 1111111010xxxxxx.
    const first = words[0] ?? 0;
    if ((first & 0xffc0) === 0xfe80) {
        return true;
    }
    // fc00::/7 unique-local — top 7 bits == 1111110xxxxxxxxx.
    if ((first & 0xfe00) === 0xfc00) {
        return true;
    }
    // :: unspecified.
    if (
        words[0] === 0 &&
        words[1] === 0 &&
        words[2] === 0 &&
        words[3] === 0 &&
        words[4] === 0 &&
        words[5] === 0 &&
        words[6] === 0 &&
        words[7] === 0
    ) {
        return true;
    }
    return false;
}

export function isPrivateOrLoopback(address: string, family: number): boolean {
    if (family === 4) {
        return isPrivateOrLoopbackIpv4(address);
    }
    if (family === 6) {
        return isPrivateOrLoopbackIpv6(address);
    }
    return false;
}

export function stripIpv6Brackets(hostname: string): string {
    if (hostname.length >= 2 && hostname.startsWith("[") && hostname.endsWith("]")) {
        return hostname.slice(1, -1);
    }
    return hostname;
}

function normaliseIpv6(address: string): string {
    const expanded = expandIpv6(address);
    if (expanded === undefined) {
        return address.toLowerCase();
    }
    return expanded.map((word: number): string => word.toString(16)).join(":");
}

export function canonicalAddress(address: string): string {
    if (isIP(address) === 6) {
        return normaliseIpv6(address);
    }
    return address;
}
