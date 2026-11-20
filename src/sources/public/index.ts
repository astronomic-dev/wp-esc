// Level 1: what a public URL shows. Discovery, then REST, sitemaps and HTML, in that
// order, all through one SiteFetch. Requests run one at a time so results repeat.
//
// Requests made, relative to the site base <b> and API root <r> (recorders must match):
//   GET <b>                                  home page (Link header, HTML <link>)
//   GET <r> | <b>wp-json/ | <b>?rest_route=/  API index
//   GET <r>wp/v2/types, <r>wp/v2/taxonomies
//   GET <r><ns>/<rest_base>?per_page=100&page=N   every type, media, taxonomy and users, N = 1..X-WP-TotalPages
//   GET /robots.txt, then each Sitemap: line, else <b>wp-sitemap.xml | <b>sitemap_index.xml | <b>?sitemap=index
//   GET every child sitemap on the site
//   GET up to 3 pages per type (lowest IDs first), 30 pages in all with the home page
//   GET <b><segment>/ once per custom type whose entries all sit under one first path segment
// With a ?rest_route= root, a route is <path>?rest_route=/wp/v2/posts&per_page=100&page=N.
// A redirect to another site is never followed; it fails that one request, and a "site"
// coverage line names the target. After the readers, derive.ts adds the date archives,
// later list pages and feeds no list names (no requests).

import type { SiteFetch } from "../../contracts/fetch.ts";
import { SiteFetchError } from "../../http/site-fetch.ts";
import type { Inventory } from "../../contracts/inventory.ts";
import { cover, createCollector, toInventory, type Collector } from "./collect.ts";
import { discover } from "./discover.ts";
import { readRest } from "./rest.ts";
import { readSitemaps } from "./sitemaps.ts";
import { readHtml } from "./html.ts";
import { deriveUrls } from "./derive.ts";

type Door = SiteFetch & { setApiRoot?: (root: string) => void };

export interface PublicOptions {
	/** The most URLs the ledger keeps (default 50,000). */
	maxUrls?: number;
	/** The most items all REST lists read together (default 200,000). */
	maxListItems?: number;
	/** The most bytes all REST list pages read together (default 512 MB). */
	maxListBytes?: number;
}

export async function readPublic(fetch: Door, siteUrl: string, opts: PublicOptions = {}): Promise<Inventory> {
	const c = createCollector(siteUrl, opts);
	// Notes every redirect to another site. The readers treat it as one failed request.
	const door: SiteFetch = async (path, o) => {
		try {
			return await fetch(path, o);
		} catch (e) {
			if (e instanceof SiteFetchError && e.code === "origin" && e.target !== undefined && !c.offsite.has(path)) c.offsite.set(path, e.target);
			throw e;
		}
	};
	const d = await discover(door, c);
	// Auth is scoped under this root, so only a root that answered as an API (or is locked) counts.
	if (d.apiRoot && (d.index || d.status === 401 || d.status === 403) && fetch.setApiRoot) fetch.setApiRoot(d.apiRoot);
	await readRest(door, c, d);
	await readSitemaps(door, c);
	await readHtml(door, c, d);
	deriveUrls(c);
	coverRedirects(c, d.homeRedirect);
	coverTypesOutsideRest(c);
	return toInventory(c);
}

/** A coverage line for each type the REST API did not list, naming the sources that saw it. */
function coverTypesOutsideRest(c: Collector): void {
	const where: Record<string, string> = { sitemap: "the sitemap", html: "the HTML sample" };
	for (const t of [...c.types.values()].sort((a, b) => (a.slug < b.slug ? -1 : 1))) {
		if (t.sources.includes("rest")) continue;
		const n = [...c.urls.values()].filter((u) => u.type === t.slug && (u.kind === "post" || u.kind === "page" || u.kind === "custom")).length;
		const seen = t.sources.map((s) => where[s] ?? s).join(" and ");
		const why = c.restTypes ? "The REST API does not list it" : "The REST API was not readable";
		cover(c, `type:${t.slug}`, t.sources.includes("sitemap") ? "sitemap" : "html", "partial", `${why}. Seen in ${seen} (${n} URL${n === 1 ? "" : "s"}), so there is no count or field data.`);
	}
}

/** One "site" coverage line when any request redirected to another site. */
function coverRedirects(c: Collector, home: string | undefined): void {
	if (home !== undefined) {
		cover(c, "site", "html", "failed", [
			`The site address ${c.base.href} redirects to ${home}. The redirect was not followed, so nothing on that site was read.`,
			"WordPress Address and Site Address (Settings > General) may differ.",
			`If ${home} is the real site, run again with --url ${home}.`,
			"An export file can still be read with --wxr.",
		].join(" "));
		return;
	}
	if (c.offsite.size === 0) return;
	const [from, to] = [...c.offsite][0] as [string, string];
	const n = c.offsite.size;
	cover(c, "site", "html", "partial", `${n} ${n === 1 ? "request" : "requests"} redirected to another site and ${n === 1 ? "was" : "were"} not followed (first: ${from} to ${to}). WordPress Address and Site Address (Settings > General) may differ.`);
}

export { discover } from "./discover.ts";
export { scanHtml } from "./html.ts";
export { parseSitemap, guessFromSitemap } from "./sitemaps.ts";
