import { expect, test } from "bun:test";
import { isPrivateOrLoopback, stripIpv6Brackets, canonicalAddress } from "./ip-classifier.ts";

// isPrivateOrLoopback — IPv4 private / loopback ranges

test("isPrivateOrLoopback IPv4 loopback 127.0.0.1", () => {
    expect(isPrivateOrLoopback("127.0.0.1", 4)).toBe(true);
});

test("isPrivateOrLoopback IPv4 RFC1918 10.0.0.1", () => {
    expect(isPrivateOrLoopback("10.0.0.1", 4)).toBe(true);
});

test("isPrivateOrLoopback IPv4 RFC1918 172.16.0.1", () => {
    expect(isPrivateOrLoopback("172.16.0.1", 4)).toBe(true);
});

test("isPrivateOrLoopback IPv4 RFC1918 192.168.1.1", () => {
    expect(isPrivateOrLoopback("192.168.1.1", 4)).toBe(true);
});

// 169.254.169.254 is the cloud-metadata endpoint covered by the 169.254/16 link-local branch.
test("isPrivateOrLoopback IPv4 link-local 169.254.169.254 (cloud metadata endpoint)", () => {
    expect(isPrivateOrLoopback("169.254.169.254", 4)).toBe(true);
});

test("isPrivateOrLoopback IPv4 unspecified 0.0.0.0", () => {
    expect(isPrivateOrLoopback("0.0.0.0", 4)).toBe(true);
});

// isPrivateOrLoopback — IPv6 private / loopback ranges

test("isPrivateOrLoopback IPv6 loopback ::1", () => {
    expect(isPrivateOrLoopback("::1", 6)).toBe(true);
});

test("isPrivateOrLoopback IPv6 link-local fe80::1", () => {
    expect(isPrivateOrLoopback("fe80::1", 6)).toBe(true);
});

test("isPrivateOrLoopback IPv6 unique-local fc00::1", () => {
    expect(isPrivateOrLoopback("fc00::1", 6)).toBe(true);
});

test("isPrivateOrLoopback IPv6 IPv4-mapped ::ffff:127.0.0.1", () => {
    expect(isPrivateOrLoopback("::ffff:127.0.0.1", 6)).toBe(true);
});

// isPrivateOrLoopback — public addresses must return false

test("isPrivateOrLoopback IPv4 public 8.8.8.8 returns false", () => {
    expect(isPrivateOrLoopback("8.8.8.8", 4)).toBe(false);
});

test("isPrivateOrLoopback IPv4 public 1.1.1.1 returns false", () => {
    expect(isPrivateOrLoopback("1.1.1.1", 4)).toBe(false);
});

test("isPrivateOrLoopback IPv6 public 2606:4700:4700::1111 returns false", () => {
    expect(isPrivateOrLoopback("2606:4700:4700::1111", 6)).toBe(false);
});

// stripIpv6Brackets

test("stripIpv6Brackets removes brackets from bracketed IPv6", () => {
    expect(stripIpv6Brackets("[::1]")).toBe("::1");
});

test("stripIpv6Brackets leaves non-bracketed address unchanged", () => {
    expect(stripIpv6Brackets("::1")).toBe("::1");
});

test("stripIpv6Brackets leaves IPv4 address unchanged", () => {
    expect(stripIpv6Brackets("127.0.0.1")).toBe("127.0.0.1");
});

// canonicalAddress

test("canonicalAddress lowercases and expands IPv6", () => {
    expect(canonicalAddress("::1")).toBe("0:0:0:0:0:0:0:1");
});

test("canonicalAddress leaves IPv4 address unchanged", () => {
    expect(canonicalAddress("8.8.8.8")).toBe("8.8.8.8");
});
