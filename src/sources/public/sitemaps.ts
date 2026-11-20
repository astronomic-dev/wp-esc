// Reads sitemaps: the ones robots.txt names, else the first index that answers among
// <base>wp-sitemap.xml (core), <base>sitemap_index.xml (Yoast, Rank Math) and
// <base>?sitemap=index (core with plain permalinks). Follows every child sitemap on the
// site and adds each URL to the ledger with a kind and type guessed from the sitemap
// name. Types and taxonomies the REST API did not list are added with sources
// ["sitemap"] and no count.

import { SaxesParser } from "saxes";
import type { SiteFetch } from "../../contracts/fetch.ts";
import type { UrlEntry, UrlKind } from "../../contracts/inventory.ts";
import type { Collector } from "./collect.ts";
import { addUrl, cover, guessStructure, onSite, relPath, setRank, taxonomyOf, typeOf } from "./collect.ts";
import { soft } from "./rest.ts";

const MAX_SITEMAPS = 500;
/** The sitemap protocol's own limit of entries per file. */
const MAX_LOCS = 50_000;

/** `error`: the XML did not parse cleanly. `over`: locs past MAX_LOCS, not kept. */
export interface SitemapDoc { kind: "index" | "urlset" | "other"; locs: string[]; error: boolean; over: number }

/** Parses a sitemap or sitemap index. Malformed XML gives what was read before the error. */
export function parseSitemap(xml: string): SitemapDoc {
	const parser = new SaxesParser();
	const out: SitemapDoc = { kind: "other", locs: [], error: false, over: 0 };
	let depth = 0;
	let inLoc = false;
	let text = "";
	let parentIsEntry = false;
	const stack: string[] = [];
	parser.on("opentag", (t) => {
		const name = t.name.replace(/^.*:/, "");
		if (depth === 0) out.kind = name === "sitemapindex" ? "index" : name === "urlset" ? "urlset" : "other";
		parentIsEntry = stack.at(-1) === "sitemap" || stack.at(-1) === "url";
		stack.push(name);
		depth++;
		if (name === "loc" && parentIsEntry) {
			inLoc = true;
			text = "";
		}
	});
	parser.on("text", (t) => {
		if (inLoc) text += t;
	});
	parser.on("cdata", (t) => {
		if (inLoc) text += t;
	});
	parser.on("closetag", () => {
		const name = stack.pop();
		depth--;
		if (name === "loc" && inLoc) {
			inLoc = false;
			const loc = text.trim();
			if (loc && out.locs.length < MAX_LOCS) out.locs.push(loc);
			else if (loc) out.over++;
		}
	});
	try {
		parser.write(xml).close();
	} catch {
		out.error = true; // keep what was read
	}
	return out;
}

/** The Sitemap: lines of a robots.txt. */
export function robotsSitemaps(text: string): string[] {
	return [...text.matchAll(/^[ \t]*sitemap[ \t]*:[ \t]*(\S+)/gim)].map((m) => m[1] as string);
}

/** What a child sitemap lists, from its name. */
export interface Guess { kind: UrlKind; type?: string; taxonomy?: string }

export function guessFromSitemap(sitemapUrl: URL, knownTaxonomies: Set<string>): Guess | undefined {
	const q = sitemapUrl.searchParams;
	const name = sitemapUrl.pathname.split("/").at(-1) ?? "";
	let group: string | undefined;
	let sub: string | undefined;
	let m: RegExpExecArray | null;
	if (q.get("sitemap")) {
		group = q.get("sitemap") ?? undefined;
		sub = q.get("sitemap-subtype") ?? undefined;
	} else if ((m = /^wp-sitemap-(posts|taxonomies)-(.+)-\d+\.xml$/.exec(name))) {
		group = m[1];
		sub = m[2];
	} else if (/^wp-sitemap-users-\d+\.xml$/.test(name)) {
		group = "users";
	} else if ((m = /^(.+)-sitemap\d*\.xml$/.exec(name))) {
		// Yoast and Rank Math: <type|taxonomy>-sitemap.xml, author-sitemap.xml
		const x = m[1] as string;
		if (x === "author") group = "users";
		else if (x === "category" || x === "post_tag" || knownTaxonomies.has(x)) [group, sub] = ["taxonomies", x];
		else [group, sub] = ["posts", x];
	}
	if (group === "users") return { kind: "author" };
	if (group === "posts" && sub) return { kind: sub === "post" ? "post" : sub === "page" ? "page" : "custom", type: sub };
	if (group === "taxonomies" && sub) return { kind: sub === "category" ? "category" : sub === "post_tag" ? "tag" : "term", taxonomy: sub };
	return undefined;
}

async function get(fetch: SiteFetch, path: string): Promise<{ status: number; text: string; url: string }> {
	try {
		const res = await fetch(path);
		return { status: res.status, text: res.status === 200 ? await res.text() : "", url: res.url };
	} catch (e) {
		if (soft(e)) return { status: 0, text: "", url: "" };
		throw e;
	}
}

const pathOf = (u: URL): string => u.pathname + u.search;

export async function readSitemaps(fetch: SiteFetch, c: Collector): Promise<void> {
	const knownTax = new Set(c.taxonomies.keys());
	const droppedBefore = c.dropped;
	const starts: URL[] = [];
	const robots = await get(fetch, "/robots.txt");
	if (robots.status === 200) {
		for (const loc of robotsSitemaps(robots.text)) {
			const u = onSite(c, loc) ?? sameOrigin(c, loc);
			if (u && !starts.some((s) => s.href === u.href)) starts.push(u);
		}
	}
	// Traversed by index; a child is queued only while the cap has room.
	const queue: { url: URL; guess?: Guess }[] = starts.slice(0, MAX_SITEMAPS).map((url) => ({ url }));
	const queued = new Set<string>(queue.map((q) => q.url.href));
	const seen = new Set<string>();
	/** Sitemaps with URLs; an index is not one of them. */
	let read = 0;
	const indexes: string[] = [];
	let failed = 0;
	let offSite = 0;
	let overCap = Math.max(0, starts.length - MAX_SITEMAPS);
	let broken = 0;
	let overLocs = 0;
	const found: string[] = [];

	const visit = async (u: URL, guess?: Guess): Promise<SitemapDoc | undefined> => {
		if (seen.has(u.href)) return undefined;
		seen.add(u.href);
		const r = await get(fetch, pathOf(u));
		if (r.status !== 200) {
			failed++;
			return undefined;
		}
		if (r.url) seen.add(r.url);
		const doc = parseSitemap(r.text);
		if (doc.kind === "other") {
			failed++;
			return undefined;
		}
		if (doc.kind === "index") indexes.push(pathOf(u));
		else read++;
		if (doc.error) broken++;
		if (doc.kind === "index") overCap += doc.over;
		else overLocs += doc.over;
		found.push(pathOf(u));
		if (doc.kind === "index") {
			for (const loc of doc.locs) {
				const child = sameOrigin(c, loc);
				if (!child) {
					offSite++;
					continue;
				}
				if (queued.has(child.href) || seen.has(child.href)) continue;
				if (queue.length >= MAX_SITEMAPS) {
					overCap++;
					continue;
				}
				queued.add(child.href);
				queue.push({ url: child, guess: guessFromSitemap(child, knownTax) });
			}
		} else {
			const g = guess ?? guessFromSitemap(u, knownTax);
			doc.locs.forEach((loc, place) => {
				addListed(c, loc, g);
				if (onSite(c, loc)) setRank(c, loc, place);
			});
		}
		return doc;
	};

	if (queue.length === 0) {
		for (const p of ["wp-sitemap.xml", "sitemap_index.xml", "?sitemap=index"]) {
			const before = failed;
			const doc = await visit(new URL(p, c.base));
			failed = before; // a probe that misses is not a failed sitemap
			if (doc) break;
		}
	}
	for (let i = 0; i < queue.length; i++) {
		const next = queue[i] as { url: URL; guess?: Guess };
		await visit(next.url, next.guess);
	}

	if (read === 0 && indexes.length === 0) {
		cover(c, "sitemaps", "sitemap", "failed", "No sitemap answered (robots.txt, wp-sitemap.xml, sitemap_index.xml, ?sitemap=index).");
		return;
	}
	const dropped = c.dropped - droppedBefore;
	const status = failed === 0 && offSite === 0 && overCap === 0 && broken === 0 && overLocs === 0 && dropped === 0 ? "complete" : "partial";
	const extra = [
		failed ? `${failed} did not answer` : "",
		broken ? `${broken} did not parse cleanly (only the entries before the error were read)` : "",
		offSite ? `${offSite} on another site, skipped` : "",
		overCap ? `${overCap} child sitemap${overCap === 1 ? "" : "s"} not read: the cap of ${MAX_SITEMAPS} sitemaps was reached` : "",
		overLocs ? `${overLocs} entries past ${MAX_LOCS} in one file not read` : "",
		dropped ? `${dropped} URLs not kept: the ledger cap of ${c.maxUrls} URLs was reached` : "",
	].filter(Boolean).join("; ");
	const from = indexes.length > 0 ? `listed in the index at ${indexes[0]}${indexes.length > 1 ? ` and ${indexes.length - 1} more ${indexes.length === 2 ? "index" : "indexes"}` : ""}` : `starting at ${found[0]}`;
	cover(c, "sitemaps", "sitemap", status, `Read ${read} sitemap${read === 1 ? "" : "s"} ${from}${extra ? `; ${extra}` : ""}.`);

	if (c.permalinks.source !== "rest") {
		const post = [...c.urls.values()].filter((u) => u.kind === "post" && u.source.includes("sitemap")).sort((a, b) => (a.url < b.url ? -1 : 1))[0];
		const s = post ? guessStructure(c, post.url) : undefined;
		if (s !== undefined) c.permalinks = { structure: s, source: "sitemap", confidence: "low" };
	}
}

function addListed(c: Collector, loc: string, g: Guess | undefined): void {
	const u = onSite(c, loc);
	if (!u) return;
	const rel = relPath(c, u.href);
	const isHome = u.search === "" && rel === "";
	const entry: UrlEntry = { url: u.href, kind: isHome ? "home" : (g?.kind ?? "other"), source: ["sitemap"], evidence: "listed" };
	if (!isHome && g) {
		const last = rel?.split("/").at(-1);
		if (g.type) {
			entry.type = g.type;
			const t = typeOf(c, g.type, "sitemap");
			if (!c.types.get(g.type)?.sources.includes("rest") && c.restTypes) t.inRest = false;
			if (last) entry.slug = last;
			if (g.kind === "page" && rel) entry.path = rel;
		}
		if (g.taxonomy) {
			entry.taxonomy = g.taxonomy;
			taxonomyOf(c, g.taxonomy, "sitemap");
			if (last) entry.slug = last;
			// Nested terms: /category/trips/coast/ -> path "trips/coast"
			if (rel && g.kind === "category") {
				const parts = rel.split("/");
				if (parts.length > 2) entry.path = parts.slice(1).join("/");
			}
		}
		if (g.kind === "author" && last) entry.slug = last;
	}
	addUrl(c, entry);
}

function sameOrigin(c: Collector, href: string): URL | undefined {
	try {
		const u = new URL(href, c.base);
		u.hash = "";
		return u.origin === c.origin ? u : undefined;
	} catch {
		return undefined;
	}
}
