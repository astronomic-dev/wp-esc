// Finds the REST API root, the way the WordPress handbook describes discovery:
// 1. the `Link: <...>; rel="https://api.w.org/"` header on the home page,
// 2. the `<link rel="https://api.w.org/" href="...">` element in its HTML,
// 3. then `<base>wp-json/`, then `<base>?rest_route=/` (plain permalinks).
// Works for subdirectory installs: every guess is relative to the site's base path.
// A root on another origin is ignored (the door cannot go there).

import type { SiteFetch } from "../../contracts/fetch.ts";
import type { Collector } from "./collect.ts";
import { soft } from "./rest.ts";

const API_REL = "https://api.w.org/";

export interface Page { url: string; status: number; html: string; headers: Headers }

export interface Discovery {
	home?: Page;
	/** Absolute API root URL, when one answered or was announced. */
	apiRoot?: string;
	/** The parsed API index, when it answered 200 with JSON. */
	index?: Record<string, unknown>;
	/** The status of the API index request (0 when no root was found). */
	status: number;
	/** Where the home page redirected, when that was another site (not followed). */
	homeRedirect?: string;
	/** How the root was found. */
	via?: "link-header" | "html-link" | "wp-json" | "rest_route";
}

/** The API root from a Link header value, if it carries rel="https://api.w.org/". */
export function linkHeaderRoot(value: string | null): string | undefined {
	if (!value) return undefined;
	for (const m of value.matchAll(/<([^>]*)>([^,<]*)/g)) {
		const params = m[2] as string;
		if (/rel\s*=\s*"?https:\/\/api\.w\.org\/"?(?:[\s;]|$)/.test(params)) return m[1];
	}
	return undefined;
}

/** The API root from a <link rel="https://api.w.org/"> element. */
export function htmlLinkRoot(html: string): string | undefined {
	for (const m of html.matchAll(/<link\b[^<>]*>/gi)) {
		const tag = m[0];
		const rel = /\brel\s*=\s*["']?([^"'\s>]+)/i.exec(tag)?.[1];
		if (rel !== API_REL) continue;
		const href = /\bhref\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] ?? /\bhref\s*=\s*([^\s>]+)/i.exec(tag)?.[1];
		if (href) return href.replaceAll("&amp;", "&");
	}
	return undefined;
}

const pathOf = (u: URL): string => u.pathname + u.search;

async function tryIndex(fetch: SiteFetch, root: URL): Promise<{ status: number; index?: Record<string, unknown> }> {
	let res;
	try {
		res = await fetch(pathOf(root));
	} catch (e) {
		if (soft(e)) return { status: 0 };
		throw e;
	}
	if (res.status !== 200) return { status: res.status };
	try {
		const json = JSON.parse(await res.text()) as unknown;
		if (json && typeof json === "object" && !Array.isArray(json) && Array.isArray((json as { namespaces?: unknown }).namespaces)) {
			return { status: 200, index: json as Record<string, unknown> };
		}
	} catch {
		// not JSON: not an API index
	}
	return { status: 0 };
}

export async function discover(fetch: SiteFetch, c: Collector): Promise<Discovery> {
	const out: Discovery = { status: 0 };
	// The home page may redirect to another site. That is not followed; the API and
	// sitemap guesses below still run on this origin.
	let html = "";
	let link: string | null = null;
	try {
		const homeRes = await fetch(pathOf(c.base));
		html = homeRes.status === 200 ? await homeRes.text() : "";
		link = homeRes.headers.get("link");
		out.home = { url: homeRes.url, status: homeRes.status, html, headers: homeRes.headers };
	} catch (e) {
		if (!soft(e)) throw e;
		if (e.target !== undefined) out.homeRedirect = e.target;
	}

	const announced: [string | undefined, Discovery["via"]][] = [
		[linkHeaderRoot(link), "link-header"],
		[htmlLinkRoot(html), "html-link"],
	];
	// A root counts only when it answers with an API index, or is locked (401, 403): a
	// locked root is still the root, so no other is guessed. A 404 or non-JSON root is not one.
	const tried = new Set<string>();
	const candidates: [URL | undefined, Discovery["via"]][] = [
		...announced.map(([href, via]): [URL | undefined, Discovery["via"]] => [href ? sameOrigin(c, href) : undefined, via]),
		[new URL("wp-json/", c.base), "wp-json"],
		[new URL("?rest_route=/", c.base), "rest_route"],
	];
	for (const [root, via] of candidates) {
		if (!root || tried.has(root.href)) continue;
		tried.add(root.href);
		const r = await tryIndex(fetch, root);
		if (r.index || r.status === 401 || r.status === 403) {
			return { ...out, apiRoot: root.href, status: r.status, via, ...(r.index ? { index: r.index } : {}) };
		}
		if (out.status === 0) out.status = r.status;
	}
	return out;
}

function sameOrigin(c: Collector, href: string): URL | undefined {
	try {
		const u = new URL(href, c.base);
		return u.origin === c.origin ? u : undefined;
	} catch {
		return undefined;
	}
}
