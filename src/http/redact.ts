// Scrubs the application password out of any string before it leaves the fetch door.
//
// Forms covered, for the password as typed and without its spaces (WordPress accepts
// both): raw, URL-encoded (%20 or +, any hex case), base64 and base64url of the
// password alone and of `user:password` (the Basic header), also at byte offsets 1 and 2
// inside a longer base64 blob. The user name alone is not a secret and is kept.

export const REDACTED = "[redacted]";

function forms(user: string | undefined, password: string): string[] {
	const out = new Set<string>();
	const passwords = new Set([password, password.replaceAll(" ", "")]);
	for (const p of passwords) {
		if (p === "") continue;
		out.add(p);
		out.add(encodeURIComponent(p));
		out.add(encodeURIComponent(p).replaceAll("%20", "+"));
		out.add(p.replaceAll(" ", "+"));
		for (const plain of user === undefined ? [p] : [p, `${user}:${p}`]) {
			const buf = Buffer.from(plain, "utf8");
			out.add(buf.toString("base64"));
			out.add(buf.toString("base64").replace(/=+$/, ""));
			out.add(buf.toString("base64url"));
			// Inside a longer blob the secret can start at byte offset 0, 1 or 2 of a 3-byte
			// group, which encodes differently. Keep only the characters that the secret's
			// bytes alone decide, so any surrounding bytes still match.
			for (const k of [0, 1, 2]) {
				const enc = Buffer.concat([Buffer.alloc(k), buf]).toString("base64").replace(/=+$/, "");
				const core = enc.slice(Math.ceil((k * 8) / 6), Math.floor(((k + buf.length) * 8) / 6));
				if (core.length >= 8) {
					out.add(core);
					out.add(core.replaceAll("+", "-").replaceAll("/", "_"));
				}
			}
		}
	}
	// Longest first, so a form that contains another is replaced whole.
	return [...out].sort((a, b) => b.length - a.length);
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Returns a function that replaces every known form of the secret with [redacted]. */
export function makeRedactor(user: string | undefined, password: string | undefined): (s: string) => string {
	if (password === undefined || password === "") return (s) => s;
	const pattern = new RegExp(
		forms(user, password)
			.map((f) => escape(f).replace(/%[0-9A-F]{2}/g, (hex) => `%${hex.slice(1).replace(/[A-F]/g, (c) => `[${c}${c.toLowerCase()}]`)}`))
			.join("|"),
		"g",
	);
	return (s) => s.replace(pattern, REDACTED);
}
