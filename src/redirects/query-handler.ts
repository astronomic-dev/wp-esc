// The query redirect handler: the code that runs in the new site and answers old WordPress
// query URLs (?p=26, ?page_id=16, ?cat=3, ?post_type=service and the like) from
// query-redirects.json, with no rule limit. Everything below the marker line is copied
// into the written query-redirects.worker.ts (Astro target) and
// query-redirects.middleware.ts (EmDash target), with `export` dropped, so the files the
// buyer copies need nothing from this package.
//
// The lookup key, used both when the map is written and when a request is looked up:
//   <path>?<name>=<value>&...
// <path> is the URL's pathname as the URL parser gives it. Only the query params the map
// knows (the names in its keys) go into the key, sorted by name and then value, each name
// and value decoded and then encoded with encodeURIComponent. Any other param (utm_source,
// fbclid and the like) is left out of the key and is not carried to the new URL. A request
// with none of the known params is never looked up by query.

// --- handler ---
export type QueryMap = Record<string, string>;

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** A path on this site: one leading slash, no scheme, no `//` or `/\` start, no backslash, no control characters. */
export function safeTarget(target: unknown): target is string {
	return typeof target === "string" && target.startsWith("/") && target[1] !== "/" && !target.includes("\\") && !/%5c/i.test(target) && !CONTROL_CHARS.test(target);
}

/** The query param names the map's keys use. */
export function queryParams(keys: Iterable<string>): Set<string> {
	const names = new Set<string>();
	for (const key of keys) {
		const q = key.indexOf("?");
		if (q !== -1) for (const name of new URLSearchParams(key.slice(q + 1)).keys()) names.add(name);
	}
	return names;
}

/** The lookup key for a URL, or null when it has none of the known params. */
export function queryKey(url: URL, known: Set<string>): string | null {
	const pairs: string[] = [];
	for (const [name, value] of url.searchParams) if (known.has(name)) pairs.push(`${encodeURIComponent(name)}=${encodeURIComponent(value)}`);
	if (!pairs.length) return null;
	return `${url.pathname}?${pairs.sort().join("&")}`;
}

/**
 * A handler for one map: a 301 to the mapped path, or null to pass the request on.
 * Exact key lookups only. A request with known params is looked up by query; one without
 * them is looked up by path only (the map holds path keys only where the handler must
 * answer a path itself). Both are tried with and without a trailing slash. A target that is
 * not a path on this site is never sent.
 */
export function createQueryRedirect(map: QueryMap): (request: Request) => Response | null {
	const table = new Map<string, string>(Object.entries(map).filter(([key, target]) => key.startsWith("/") && safeTarget(target)));
	const known = queryParams(table.keys());
	return (request) => {
		if (request.method !== "GET" && request.method !== "HEAD") return null;
		const url = new URL(request.url);
		const query = queryKey(url, known);
		const path = url.pathname;
		const paths = path.length > 1 ? [path, path.endsWith("/") ? path.slice(0, -1) : `${path}/`] : [path];
		for (const p of paths) {
			const target = table.get(query ? `${p}${query.slice(path.length)}` : p);
			if (target === undefined) continue;
			if (new URL(target, url).origin !== url.origin) return null;
			return new Response(null, { status: 301, headers: { Location: target } });
		}
		return null;
	};
}
