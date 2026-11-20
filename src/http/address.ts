// Which IP addresses the fetch door may connect to.
//
// Public unicast only. Loopback, private, shared (CGNAT), link-local (which holds the
// cloud metadata address 169.254.169.254), multicast, documentation, benchmark and
// reserved ranges are refused.
//
// IPv6 forms that carry an IPv4 address are judged by that address, or refused whole:
// - ::ffff:0:0/96 (IPv4-mapped): the embedded IPv4 decides.
// - 64:ff9b::/96 (NAT64, well-known): the embedded IPv4 decides.
// - Any other 64:ff9b::/32 address, including the local-use 64:ff9b:1::/48: refused.
// - 2002::/16 (6to4): the embedded IPv4 (bits 16-47) decides.
// - ::/96 (IPv4-compatible, deprecated) and ::ffff:0:0:0/96 (SIIT): refused.
// - 2001::/32 (Teredo) and the rest of 2001::/23: refused.
// Past those, IPv6 is an allowlist: only 2000::/3 (global unicast) can be public, minus
// documentation (2001:db8::/32, 3fff::/20).

import { BlockList, isIP } from "node:net";

const v4blocked = new BlockList();
for (const [net, bits] of [
	["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
	["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
	["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) {
	v4blocked.addSubnet(net, bits, "ipv4");
}

/** The 8 groups of an IPv6 address, or undefined when it does not parse. */
function groups6(address: string): number[] | undefined {
	let s = address.toLowerCase();
	const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
	if (dotted) {
		const parts = (dotted[1] as string).split(".").map(Number);
		if (parts.some((p) => p > 255)) return undefined;
		const [a, b, c, d] = parts as [number, number, number, number];
		s = `${s.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
	}
	const halves = s.split("::");
	if (halves.length > 2) return undefined;
	const parse = (h: string): number[] => (h === "" ? [] : h.split(":").map((g) => parseInt(g, 16)));
	const head = parse(halves[0] as string);
	const tail = halves.length === 2 ? parse(halves[1] as string) : [];
	const fill = 8 - head.length - tail.length;
	if (halves.length === 1 ? fill !== 0 : fill < 1) return undefined;
	const out = [...head, ...new Array<number>(halves.length === 2 ? fill : 0).fill(0), ...tail];
	return out.length === 8 && out.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? out : undefined;
}

const v4 = (hi: number, lo: number): string => [hi >> 8, hi & 255, lo >> 8, lo & 255].join(".");

function publicV4(address: string): boolean {
	return !v4blocked.check(address, "ipv4");
}

function publicV6(g: number[]): boolean {
	const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [number, number, number, number, number, number, number, number];
	const zero = (...xs: number[]): boolean => xs.every((x) => x === 0);
	// IPv4 carried in IPv6 outside global unicast: judged by the IPv4 address.
	if (zero(g0, g1, g2, g3, g4) && g5 === 0xffff) return publicV4(v4(g6, g7)); // ::ffff:0:0/96
	if (g0 === 0x64 && g1 === 0xff9b && zero(g2, g3, g4, g5)) return publicV4(v4(g6, g7)); // NAT64 64:ff9b::/96
	// Allowlist: only global unicast 2000::/3 can be public. Everything else (::/96,
	// ::ffff:0:0:0/96, the rest of 64:ff9b::/32, 100::/64, 4000::/2, fc00::/7, fe80::/10, ff00::/8...) is refused.
	if ((g0 & 0xe000) !== 0x2000) return false;
	if (g0 === 0x2002) return publicV4(v4(g1, g2)); // 6to4
	if (g0 === 0x2001 && g1 < 0x200) return false; // 2001::/23 special purpose, incl. Teredo 2001::/32
	if (g0 === 0x2001 && g1 === 0xdb8) return false; // 2001:db8::/32 documentation
	if (g0 === 0x3fff && g1 < 0x1000) return false; // 3fff::/20 documentation
	return true;
}

/** True when the address is a public unicast address. Anything unparseable is not. */
export function isPublicAddress(address: string): boolean {
	const family = isIP(address);
	if (family === 4) return publicV4(address);
	if (family !== 6) return false;
	const g = groups6(address);
	return g !== undefined && publicV6(g);
}

export function isLoopback(address: string): boolean {
	const family = isIP(address);
	if (family === 4) return address.startsWith("127.");
	if (family !== 6) return false;
	const g = groups6(address);
	if (!g) return false;
	if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true;
	return g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff && (g[6] as number) >> 8 === 127;
}
