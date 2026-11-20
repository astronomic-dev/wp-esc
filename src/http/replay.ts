// Serves a recorded fixture through the same door as a live site (SiteFetch), so the
// readers run the same code in tests: same redirects, same auth scoping, no network.
//
// Fixture format, test/fixtures/<site>/manifest.json:
//   { "origin": "http://localhost:4601",
//     "entries": [ { "method": "GET" | "HEAD", "path": "<path + query as requested>",
//                    "auth": boolean, "status": number,
//                    "headers": { "<lowercase name>": "<value>" }, "body": "bodies/<file>.txt" } ] }
// `body` may be left out (empty body). An entry matches on method, auth (whether the
// door sent the auth header) and path; the path matches exactly first, then with its
// query keys sorted and percent-decoded. A request with no entry gets a 404 and is
// listed in `misses`.

import { readFileSync } from "node:fs";
import { createSiteFetch, type BoundSiteFetch, type RawResponse, type Transport } from "./site-fetch.ts";

export interface ManifestEntry {
	method: "GET" | "HEAD";
	path: string;
	auth: boolean;
	status: number;
	headers: Record<string, string>;
	body?: string;
}
export interface Manifest { origin: string; entries: ManifestEntry[] }

export type ReplayFetch = BoundSiteFetch & { readonly misses: string[] };

/** The loose form of a path: query keys sorted, values percent-decoded. */
export function loosePath(path: string): string {
	const i = path.indexOf("?");
	if (i === -1) return path;
	const params = path
		.slice(i + 1)
		.split("&")
		.filter((p) => p !== "")
		.map((p) => {
			try {
				return decodeURIComponent(p.replaceAll("+", " "));
			} catch {
				return p;
			}
		});
	const key = (p: string): string => p.split("=")[0] as string;
	params.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
	return `${path.slice(0, i)}?${params.join("&")}`;
}

/** Fake credentials, so auth entries can be replayed; never real ones. */
const REPLAY_ENV = { WPM_ALLOW_HTTP_LOCALHOST: "1", WPM_WP_USER: "replay", WPM_WP_APP_PASSWORD: "replay-password" };

export function createReplayFetch(dir: URL | string): ReplayFetch {
	const base = typeof dir === "string" ? new URL(`file://${dir.endsWith("/") ? dir : `${dir}/`}`) : dir;
	const manifest = JSON.parse(readFileSync(new URL("manifest.json", base), "utf8")) as Manifest;
	const exact = new Map<string, ManifestEntry>();
	const loose = new Map<string, ManifestEntry>();
	for (const e of manifest.entries) {
		const k = `${e.method} ${e.auth} `;
		if (!exact.has(k + e.path)) exact.set(k + e.path, e);
		if (!loose.has(k + loosePath(e.path))) loose.set(k + loosePath(e.path), e);
	}
	const misses: string[] = [];
	const bodies = new Map<string, string>();
	const body = (file: string | undefined): string => {
		if (file === undefined) return "";
		let text = bodies.get(file);
		if (text === undefined) {
			text = readFileSync(new URL(file, base), "utf8");
			bodies.set(file, text);
		}
		return text;
	};

	const transport: Transport = async (req): Promise<RawResponse> => {
		const path = req.url.pathname + req.url.search;
		const k = `${req.method} ${req.headers.authorization !== undefined} `;
		const e = exact.get(k + path) ?? loose.get(k + loosePath(path));
		if (!e) {
			misses.push(`${req.method} ${path}${req.headers.authorization ? " (auth)" : ""}`);
			return { status: 404, headers: { "content-type": "text/plain" }, body: "" };
		}
		return { status: e.status, headers: e.headers, body: req.method === "HEAD" ? "" : body(e.body) };
	};

	const fetch = createSiteFetch({
		url: manifest.origin,
		env: REPLAY_ENV,
		transport,
		resolve: async () => ["127.0.0.1"],
		rate: Infinity,
		maxRequests: 100_000,
		sleep: async () => {},
	}) as ReplayFetch;
	Object.defineProperty(fetch, "misses", { value: misses, enumerable: true });
	return fetch;
}
