// The canonical URL form for the ledger. Frozen after Chunk 0a.
//
// - Scheme and host are lowercase; default ports (80 for http, 443 for https) are dropped.
// - The path is kept as served: case, percent-encoding and trailing slash are not touched.
//   `/a` and `/a/` are different keys; a redirect between them is a fact for the ledger.
// - Query parameters are sorted by key; repeated keys keep their order. Values are not re-encoded.
// - The fragment is dropped.

export function normalizeUrl(input: string): string {
	const m = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(\?[^#]*)?/i.exec(input);
	if (!m) throw new Error(`not an absolute URL: ${input}`);
	const scheme = (m[1] as string).toLowerCase();
	let host = (m[2] as string).toLowerCase();
	if ((scheme === "https" && host.endsWith(":443")) || (scheme === "http" && host.endsWith(":80"))) {
		host = host.slice(0, host.lastIndexOf(":"));
	}
	const path = m[3] || "/";
	const query = (m[4] ?? "").slice(1);
	let search = "";
	if (query !== "") {
		const params = query.split("&").filter((p) => p !== "");
		const key = (p: string): string => p.split("=")[0] as string;
		params.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
		search = params.length ? `?${params.join("&")}` : "";
	}
	return `${scheme}://${host}${path}${search}`;
}
