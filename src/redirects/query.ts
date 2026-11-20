// query-redirects.json and its handler: the no-limit way to redirect old query URLs.
//
// cloudflare-rules.json needs one Single Redirect rule per query URL, and Cloudflare's Free
// plan allows 10. The map plus a small handler in the new site has no such limit:
// - Astro target (a static build on Cloudflare Workers static assets): a Worker in front of
//   the assets, run first only on the paths that held query URLs (run_worker_first), which
//   answers known query URLs and hands every other request to env.ASSETS.fetch, so
//   _redirects and the static files work as before.
// - EmDash target (runs on the server): an Astro middleware. EmDash 1.4's own redirects
//   cannot do this: its middleware matches the pathname only (emdash
//   src/astro/middleware/redirect.ts, matchRedirect and onRequest), so a query never counts.
//   That middleware runs before the site's src/middleware.ts, and so does _redirects on
//   Cloudflare, and both match by path only: a /site/ line there would catch /site/?p=26.
//   So the EmDash map also holds the path-only redirect for each path that held query URLs,
//   and the setup notes say to keep those paths out of EmDash's redirects and _redirects when
//   the handler is used. _redirects leaves them out itself only when the handler is the default
//   (more than 10 rules); with the rules as the default it keeps their lines.
//
// Keys and lookups are in query-handler.ts. Only resolved rows (status 301, a site path)
// go in the map; review rows stay in redirects.csv.

import { readFileSync } from "node:fs";
import { safePath } from "./cloudflare.ts";
import { isSiteRelative, type Row, type Target } from "./plan.ts";
import { queryKey, queryParams, safeTarget, type QueryMap } from "./query-handler.ts";

export const MAP_FILE = "query-redirects.json";
export const WORKER_FILE = "query-redirects.worker.ts";
export const MIDDLEWARE_FILE = "query-redirects.middleware.ts";

export interface QueryFiles {
	map: string; // query-redirects.json
	handler: string; // the Worker (astro) or the middleware (emdash)
	handlerFile: string;
	queryCount: number; // query URLs in the map
	paths: string[]; // the paths that held query URLs
	answered: string[]; // emdash: the old path-only URLs the map answers, which stay out of _redirects
	params: string[]; // the query params of the URLs in the map, for example ["p", "page_id"]
}

const BASE = "http://example.com";

function mapFor(rows: Row[], target: Target): { map: QueryMap; queryCount: number; paths: string[]; answered: string[]; params: string[] } {
	const ok = rows.filter((r) => r.status === "301" && r.old.startsWith("/") && isSiteRelative(r.new) && safeTarget(safePath(r.new)));
	const map: QueryMap = {};
	const paths = new Set<string>();
	const params = new Set<string>();
	let queryCount = 0;
	for (const r of ok) {
		if (!r.old.includes("?")) continue;
		const url = new URL(safePath(r.old), BASE);
		const key = queryKey(url, queryParams([r.old]));
		if (!key || key in map) continue;
		map[key] = safePath(r.new);
		for (const name of url.searchParams.keys()) params.add(name);
		paths.add(url.pathname);
		queryCount++;
	}
	const answered: string[] = [];
	if (target === "emdash") {
		for (const r of ok) {
			if (r.old.includes("?")) continue;
			const path = new URL(safePath(r.old), BASE).pathname;
			const bare = path.length > 1 ? path.replace(/\/$/, "") : path;
			if ([...paths].some((p) => p === path || (p.length > 1 && p.replace(/\/$/, "") === bare))) {
				map[path] = safePath(r.new);
				answered.push(r.old);
			}
		}
	}
	const sorted: QueryMap = {};
	for (const k of Object.keys(map).sort()) sorted[k] = map[k]!;
	return { map: sorted, queryCount, paths: [...paths].sort(), answered: answered.sort(), params: [...params].sort() };
}

function handlerCode(): string {
	const text = readFileSync(new URL("./query-handler.ts", import.meta.url), "utf8");
	const marker = "// --- handler ---\n";
	return text.slice(text.indexOf(marker) + marker.length).replace(/^export /gm, "");
}

const routes = (paths: string[]): string[] => [...new Set(paths.flatMap((p) => (p.length > 1 ? [p, p.endsWith("/") ? p.slice(0, -1) : `${p}/`] : [p])))].sort();

function keyNote(): string {
	return [
		"// Lookup: the request's path plus only the known query params (the names in the map's keys),",
		"// sorted, decoded and re-encoded, so ?p=26&utm_source=x finds the ?p=26 entry. Other params are",
		"// not carried over. Exact key lookups only, and a target must be a path on this site: anything",
		"// else is passed on, never redirected. Answers are 301s.",
	].join("\n");
}

/** query-redirects.json and its handler for one plan, or null when the plan has no query URLs to redirect. */
export function toQueryRedirects(rows: Row[], target: Target): QueryFiles | null {
	const { map, queryCount, paths, answered, params } = mapFor(rows, target);
	if (!queryCount) return null;
	const json = `${JSON.stringify({ about: target === "emdash" ? `Old WordPress query URLs for ${MIDDLEWARE_FILE}. Goes in src/${MAP_FILE}, beside src/middleware.ts.` : `Old WordPress query URLs for ${WORKER_FILE}. Goes in worker/${MAP_FILE}, beside worker/query-redirects.ts.`, redirects: map }, null, "\t")}\n`;
	const runFirst = JSON.stringify(routes(paths));
	let handler: string;
	let handlerFile: string;
	if (target === "emdash") {
		handlerFile = MIDDLEWARE_FILE;
		handler = [
			"// wp-redirect-plan for the emdash target: redirects old WordPress query URLs from query-redirects.json.",
			`// Goes in src/middleware.ts, with ${MAP_FILE} in src/. If the site has a src/middleware.ts already, add this`,
			"// onRequest to it with sequence() from astro:middleware.",
			`// EmDash's own redirects and a _redirects file both run before this and match by path only: keep ${paths.join(", ")}`,
			"// out of them (the map holds the path-only redirect for those paths, and this file answers them).",
			`// On Cloudflare Workers, also set "run_worker_first": ${runFirst} under "assets" in wrangler.jsonc.`,
			keyNote(),
			'import type { MiddlewareHandler } from "astro";',
			`import map from "./${MAP_FILE}" with { type: "json" };`,
			"",
			handlerCode(),
			"const redirect = createQueryRedirect(map.redirects);",
			"",
			"export const onRequest: MiddlewareHandler = (context, next) => redirect(context.request) ?? next();",
			"",
		].join("\n");
	} else {
		handlerFile = WORKER_FILE;
		handler = [
			"// wp-redirect-plan for the astro target: a Worker in front of the static site that redirects old WordPress",
			`// query URLs from ${MAP_FILE} and hands every other request to the static assets untouched.`,
			`// Goes in worker/query-redirects.ts at the site root, with ${MAP_FILE} beside it in worker/.`,
			`// Setup, in wrangler.jsonc: "main": "worker/query-redirects.ts", and under "assets": "binding": "ASSETS", "run_worker_first": ${runFirst}.`,
			"// The Worker runs first only on those paths; env.ASSETS.fetch still applies _redirects to whatever it passes on.",
			keyNote(),
			`import map from "./${MAP_FILE}" with { type: "json" };`,
			"",
			handlerCode(),
			"const redirect = createQueryRedirect(map.redirects);",
			"",
			"export default {",
			"\tfetch(request: Request, env: { ASSETS: { fetch(request: Request): Promise<Response> } }): Response | Promise<Response> {",
			"\t\treturn redirect(request) ?? env.ASSETS.fetch(request);",
			"\t},",
			"};",
			"",
		].join("\n");
	}
	return { map: json, handler, handlerFile, queryCount, paths, answered, params };
}
