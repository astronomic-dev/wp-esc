// inventory.json + model.json -> the redirect plan: one row per old URL in the ledger.
//
// The model names each collection's and taxonomy's WordPress source in `from`, so old
// entries are matched by post type and taxonomy through `from`, never by the new slug.
//
// Targets:
//   astro   the model's routes as written ({path} keeps nested pages nested).
//   emdash  entries use the seed's urlPattern (urlPatternFor): EmDash has no {path}, so
//           child pages move to /<slug>, and patterns have no trailing slash. Other
//           pages (archives, terms, feed) keep the model's routes, which the site's own
//           Astro pages serve, with the same rule: no path but / ends in a slash.
//
// Menu links to a post type archive that the ledger does not list are planned too
// (propose.ts menuArchives), so the archive the menu links to gets its redirect.
//
// Nothing is guessed silently: anything the plan cannot place is `review` with a reason.
// Two different old entries or terms that land on one new path are both `review`.
// Rows come out sorted by the old path, so the same facts give the same bytes.

import type { Inventory, UrlEntry, UrlKind } from "../contracts/inventory.ts";
import type { Collection, Model, ModelTaxonomy } from "../contracts/model.ts";
import { normalizeUrl } from "../contracts/url.ts";
import { urlPatternFor } from "../model/seed.ts";
import { collectionSlugFor, menuArchives } from "../model/propose.ts";

/** EmDash's URL rule: no path but / ends in a slash. */
export const noTrailingSlash = (p: string): string => (p.length > 1 && p.endsWith("/") ? p.replace(/\/+$/, "") || "/" : p);

/**
 * The collection a post type's entries land in: the one that comes from it, else the one
 * EmDash names it (post types EmDash names alike share one collection; propose.ts mergeRepeats).
 */
const collectionOfType = (ctx: { collections: Collection[] }, type: string): Collection | undefined => ctx.collections.find((x) => x.from === type) ?? ctx.collections.find((x) => x.slug === collectionSlugFor(type));

export type Target = "astro" | "emdash";
export type Status = "301" | "same" | "review";

export interface Row {
	old: string; // the old path and query, or the full URL when it is not on the site
	new: string; // the new path; empty for review
	status: Status;
	kind: UrlKind;
	note: string;
}

export interface PlanOptions {
	target: Target;
}

type Result = { path: string; note: string; id?: string } | { review: string };

const CONTENT: UrlKind[] = ["post", "page", "custom"];
const TERMS: UrlKind[] = ["category", "tag", "term"];
const byKey = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// Characters kept as they are in a filled-in slug. `%` stays so WordPress's own
// percent-encoded slugs are not encoded twice. Everything else is percent-encoded,
// so old-site text cannot add spaces, newlines, quotes, `*` or `:` to a target.
const SAFE = /^[A-Za-z0-9\-._~!$&'()+,;=@%]$/;

function encodeChar(c: string): string {
	return [...new TextEncoder().encode(c)].map((b) => `%${b.toString(16).toUpperCase().padStart(2, "0")}`).join("");
}

/** One path segment, safe for _redirects and Cloudflare rules. */
export function encodeSegment(s: string): string {
	let out = "";
	for (const c of s) out += SAFE.test(c) ? c : encodeChar(c);
	return out;
}

const encodePath = (p: string): string => p.split("/").map(encodeSegment).join("/");

// Old-site slugs and paths that could point a redirect off the site or up a level:
// backslashes, empty or dot segments (so no leading `//`), and encoded `.`, `/` or `\`.
function unsafeInput(s: string): boolean {
	if (s.includes("\\") || /%(2e|2f|5c)/i.test(s)) return true;
	return s.split("/").some((seg) => seg === "" || seg === "." || seg === "..");
}

function decoded(seg: string): string {
	try {
		return decodeURIComponent(seg);
	} catch {
		return seg;
	}
}

/** True when a new path stays on the site: one leading `/`, no backslash, no dot segment. */
export function isSiteRelative(p: string): boolean {
	if (!/^\/(?![/\\])/.test(p) || p.includes("\\") || /%5c/i.test(p)) return false;
	return !p.split("/").some((seg) => {
		const d = decoded(seg);
		return d === "." || d === ".." || d.includes("\\") || d.startsWith("/");
	});
}

const LEAVES = "The new path would leave the site or climb out of a folder; check this entry's slug and path by hand.";

interface Context {
	inv: Inventory;
	model: Model;
	target: Target;
	origin: string;
	prefixes: Map<string, string>;
	ledger: Map<string, UrlEntry>;
	byId: Map<number, UrlEntry[]>;
	collections: Collection[];
	taxonomies: ModelTaxonomy[];
	base: string; // the old site's base path, for example "/" or "/site/"
	frontId?: number; // the page ID of the front page, when the root resolves to a page
	homeListsPosts: boolean; // the old root is the post list (a home entry with no page)
}

const HOME_NOTE = "Home page.";
const MENU_ONLY = "Not in the inventory: a menu links to this archive, so it gets a row too.";
/** Marks a query row's note; writeRedirectPlan replaces it with the file that holds the row by default. */
export const QUERY_NOTE = "Query URL.";

function withPrefix(ctx: Context, path: string, locale: string | undefined): string {
	const prefix = locale ? ctx.prefixes.get(locale) : undefined;
	return prefix ? `/${encodeSegment(prefix)}${path}` : path;
}

function routeOf(ctx: Context, kind: string): string | undefined {
	return [...ctx.model.routes].filter((r) => r.kind === kind).map((r) => r.pattern).sort(byKey)[0];
}

const kindWord = (kind: UrlKind): string => (kind === "post" ? "Post" : kind === "page" ? "Page" : "Entry");

/** A post, page or custom entry, by its type and slug (or full path). */
function content(ctx: Context, e: { kind: UrlKind; type?: string; id?: number; slug?: string; path?: string; locale?: string }): Result {
	if (!e.type) return { review: "The inventory does not say which post type this is." };
	const c = collectionOfType(ctx, e.type);
	if (!c) return { review: `No collection in model.json comes from the post type ${e.type}.` };
	if (!c.route) return { review: `The ${c.slug} collection has no page of its own on the new site.` };
	if (!e.slug) return { review: "The inventory has no slug for this entry." };
	if (unsafeInput(e.slug) || (e.path !== undefined && unsafeInput(e.path))) return { review: LEAVES };
	const id = `entry:${e.type}:${e.id ?? e.path ?? e.slug}`;
	const word = kindWord(e.kind);
	if (ctx.target === "emdash") {
		const pattern = urlPatternFor(c.route);
		const nested = c.route.includes("{path}") && (e.path ?? e.slug).includes("/");
		const slug = encodeSegment(e.slug);
		const path = pattern.replace("{slug}", () => slug);
		return { path: withPrefix(ctx, path, e.locale), note: nested ? `${word} by slug; EmDash has no nested page URLs, so it moves to /<slug>.` : `${word} by slug.`, id };
	}
	const usesPath = c.route.includes("{path}");
	const slug = encodeSegment(e.slug);
	const full = encodePath(e.path ?? e.slug);
	const path = c.route.replace("{slug}", () => slug).replace("{path}", () => full);
	return { path: withPrefix(ctx, path, e.locale), note: usesPath ? `${word} by path.` : `${word} by slug.`, id };
}

/** Does the ledger list a child of this term (by parent ID or by path)? */
function hasChildTerm(ctx: Context, e: { taxonomy?: string; termId?: number; slug?: string; path?: string }): boolean {
	const own = e.path ?? e.slug;
	return [...ctx.ledger.values()].some((u) => TERMS.includes(u.kind) && u.taxonomy === e.taxonomy && ((e.termId !== undefined && u.parentId === e.termId) || (!!own && !!u.path && u.path.startsWith(`${own}/`))));
}

function term(ctx: Context, e: { taxonomy?: string; termId?: number; slug?: string; path?: string; locale?: string; count?: number }): Result {
	if (!e.taxonomy) return { review: "The inventory does not say which taxonomy this term is in." };
	const t = ctx.taxonomies.find((x) => x.from === e.taxonomy);
	if (!t) return { review: `No taxonomy in model.json comes from ${e.taxonomy}.` };
	if (!t.route) return { review: `The ${t.slug} taxonomy has no term pages on the new site.` };
	if (!e.slug) return { review: "The inventory has no slug for this term." };
	if (unsafeInput(e.slug) || (e.path !== undefined && unsafeInput(e.path))) return { review: LEAVES };
	const slug = encodeSegment(e.slug);
	// EmDash finds a term by its slug only, so on EmDash a nested term moves to /<base>/<slug>.
	const flat = ctx.target === "emdash" && t.route.includes("{path}");
	const full = flat ? slug : encodePath(e.path ?? e.slug);
	const path = t.route.replace("{slug}", () => slug).replace("{path}", () => full);
	// WordPress counts only a term's own entries. An empty term with no child terms has an
	// empty page, which the new site may not serve; one with children lists theirs.
	let note = flat ? `Term in ${t.slug} by slug. EmDash serves terms by slug.` : `Term in ${t.slug} by ${t.route.includes("{path}") ? "path" : "slug"}.`;
	if (e.count === 0) {
		const shown = withPrefix(ctx, path, e.locale);
		if (!hasChildTerm(ctx, e)) return { review: `The term holds no entries of its own and has no child terms; check the page ${ctx.target === "emdash" ? noTrailingSlash(shown) : shown} exists on the new site, or pick another page by hand.` };
		note += " It holds no entries of its own, only its child terms' entries; check the new page lists them.";
	}
	return { path: withPrefix(ctx, path, e.locale), note, id: `term:${e.taxonomy}:${e.termId ?? e.path ?? e.slug}` };
}

/**
 * The old entry with this WordPress ID, from the non-query part of the ledger. A page set
 * as the front page or the posts page is listed as home or archive, under the page's ID.
 */
function entryById(ctx: Context, id: number, type?: string): UrlEntry | undefined {
	const list = (ctx.byId.get(id) ?? []).filter((u) => u.kind !== "query" && (!type || u.type === type || u.kind === "home" || u.kind === "archive"));
	return list.find((u) => CONTENT.includes(u.kind) || u.kind === "attachment") ?? list.find((u) => u.kind === "home" || u.kind === "archive");
}

function query(ctx: Context, e: UrlEntry, params: URLSearchParams, depth: number): Result {
	// Plain permalinks: feeds, date archives and later list pages are query URLs too.
	if (params.has("feed")) return resolve(ctx, { ...e, kind: "feed" }, depth + 1);
	const date = params.get("m") ?? params.get("year");
	if (date !== null && /^\d{4,14}$/.test(date) && !params.has("p") && !params.has("page_id")) return resolve(ctx, { ...e, kind: "date" }, depth + 1);
	if (params.has("paged") && [...params.keys()].every((k) => k === "paged")) return resolve(ctx, { ...e, kind: "paged" }, depth + 1);
	if (e.type === "attachment") {
		// ?attachment_id=10: the attachment page, sent to its parent like any attachment page.
		const parentId = e.parentId ?? (e.id !== undefined ? (ctx.byId.get(e.id) ?? []).find((u) => u.parentId !== undefined)?.parentId : undefined);
		return resolve(ctx, { ...e, kind: "attachment", parentId }, depth + 1);
	}
	if (e.type && e.slug) return content(ctx, { ...e, kind: e.type === "page" ? "page" : e.type === "post" ? "post" : "custom" });
	// ?author=2 carries the author's slug (no id: that field is a post ID), so it goes where /author/<slug>/ goes.
	if (!e.type && e.slug && params.has("author")) return resolve(ctx, { ...e, kind: "author" }, depth + 1);
	if (e.taxonomy && e.termId !== undefined) {
		const found = [...ctx.ledger.values()].find((u) => TERMS.includes(u.kind) && u.taxonomy === e.taxonomy && u.termId === e.termId);
		return found ? resolve(ctx, found, depth + 1) : { review: `No term with ID ${e.termId} in ${e.taxonomy} was found in the inventory.` };
	}
	const idParam = params.has("p") ? "p" : params.has("page_id") ? "page_id" : params.has("attachment_id") ? "attachment_id" : undefined;
	const raw = e.id !== undefined ? String(e.id) : idParam ? (params.get(idParam) ?? "") : undefined;
	if (raw !== undefined) {
		if (!/^\d+$/.test(raw)) return { review: `The ID in this query URL is not a number.` };
		const found = entryById(ctx, Number(raw), idParam === "page_id" ? "page" : undefined);
		if (!found && e.type && e.id !== undefined) return { review: `The inventory has this ${e.type} (ID ${raw}) only by its query URL, with no slug, so its new path is unknown; pick it by hand.` };
		if (!found) return { review: `No entry with ID ${raw} was found in the inventory.` };
		return resolve(ctx, found, depth + 1);
	}
	const cat = params.get("cat");
	if (cat !== null) {
		const found = /^\d+$/.test(cat) ? [...ctx.ledger.values()].find((u) => TERMS.includes(u.kind) && u.taxonomy === "category" && u.termId === Number(cat)) : undefined;
		return found ? resolve(ctx, found, depth + 1) : { review: `No category with ID ${cat} was found in the inventory.` };
	}
	const tag = params.get("tag");
	if (tag !== null) return term(ctx, { taxonomy: "post_tag", slug: tag, locale: e.locale });
	for (const c of ctx.collections) {
		const slug = params.get(c.from);
		if (slug !== null && slug !== "") return content(ctx, { kind: c.from === "page" ? "page" : c.from === "post" ? "post" : "custom", type: c.from, slug, locale: e.locale });
	}
	// ?post_type=service alone: the post type archive.
	const postType = params.get("post_type");
	if (postType && [...params.keys()].every((k) => k === "post_type" || k === "paged")) return resolve(ctx, { ...e, kind: "archive", type: postType }, depth + 1);
	return { review: "A query URL the plan does not understand; pick its new page by hand." };
}

function resolve(ctx: Context, e: UrlEntry, depth = 0): Result {
	if (depth > 4) return { review: "The inventory links this URL in a loop." };
	const url = new URL(normalizeUrl(e.url));
	if (url.origin !== ctx.origin) return { review: "Not on the old site's address." };
	// The site root is never sent to another page: it is the home page, at / on the new site.
	// So is a page that is the front page (the root's page ID), or, with no front page ID
	// known, a top-level page with the slug "home".
	if (e.kind !== "home" && e.kind !== "query" && !url.search && url.pathname === ctx.base) return { path: withPrefix(ctx, "/", e.locale), note: HOME_NOTE, id: `home:${e.locale ?? ""}` };
	if (e.kind === "page" || (e.kind === "query" && e.type === "page")) {
		if (ctx.frontId !== undefined && e.id === ctx.frontId) return { path: withPrefix(ctx, "/", e.locale), note: "The front page; it is the home page on the new site.", id: `home:${e.locale ?? ""}` };
		if (ctx.frontId === undefined && e.slug === "home" && (e.path ?? e.slug) === "home") return { path: withPrefix(ctx, "/", e.locale), note: "Probably the front page (its slug is home), so sent to the home page. Check this.", id: `home:${e.locale ?? ""}` };
	}
	switch (e.kind) {
		case "home":
			return { path: withPrefix(ctx, "/", e.locale), note: HOME_NOTE, id: `home:${e.locale ?? ""}` };
		case "post":
		case "page":
		case "custom":
			return content(ctx, e);
		case "category":
		case "tag":
		case "term":
			return term(ctx, e);
		case "archive": {
			const c = e.type ? collectionOfType(ctx, e.type) : undefined;
			const r = c ? ctx.model.routes.find((x) => x.kind === "archive" && x.collection === c.slug) : undefined;
			if (!r) return { review: `No archive page for the post type ${e.type ?? "(unknown)"} in model.json.` };
			return { path: withPrefix(ctx, r.pattern, e.locale), note: "Post type archive.", id: `archive:${c?.slug}:${e.locale ?? ""}` };
		}
		case "author": {
			const r = routeOf(ctx, "author");
			if (r && e.slug) {
				if (unsafeInput(e.slug)) return { review: LEAVES };
				const slug = encodeSegment(e.slug);
				return { path: withPrefix(ctx, r.replace("{slug}", () => slug), e.locale), note: "Author page by slug." };
			}
			return { path: withPrefix(ctx, "/", e.locale), note: "No author pages on the new site; sent to the home page." };
		}
		case "date": {
			const r = routeOf(ctx, "blog");
			if (r) return { path: withPrefix(ctx, r, e.locale), note: "Date archive; sent to the blog index." };
			return { path: withPrefix(ctx, "/", e.locale), note: "Date archive; the new site has no blog index, so sent to the home page." };
		}
		case "feed": {
			// The comments feed has no match on the new site: plain Astro has no comments.
			const feedParam = url.searchParams.get("feed");
			// ?p=20&feed=rss2 (plain permalinks): the feed of one entry, sent to the entry.
			const entryId = url.searchParams.get("p") ?? url.searchParams.get("page_id");
			if (feedParam !== null && entryId !== null && /^\d+$/.test(entryId)) {
				const found = entryById(ctx, Number(entryId));
				const r = found ? resolve(ctx, found, depth + 1) : undefined;
				if (r && !("review" in r)) return { path: r.path, note: "The feed of one entry; sent to the entry." };
			}
			if (feedParam?.startsWith("comments") || url.pathname.slice(ctx.base.length).replace(/\/$/, "") === "comments/feed") return { path: withPrefix(ctx, "/", e.locale), note: "The comments feed. The new site has no comments feed, so it is sent to the home page." };
			// A post's own feed (its comments) goes to the post.
			const owner = url.pathname.replace(/\/feed(\/(rss2?|atom|rdf))?\/?$/, "/");
			if (owner !== url.pathname && owner !== ctx.base) {
				const found = ctx.ledger.get(normalizeUrl(`${ctx.origin}${owner}`));
				if (found && CONTENT.includes(found.kind)) {
					const r = resolve(ctx, found, depth + 1);
					if (!("review" in r)) return { path: r.path, note: "The feed of one entry; sent to the entry." };
				}
			}
			const r = routeOf(ctx, "feed");
			if (r) return { path: withPrefix(ctx, r, e.locale), note: "Feed; sent to the new feed." };
			return { review: "A feed, but model.json has no feed route." };
		}
		case "attachment": {
			const parent = e.parentId !== undefined ? entryById(ctx, e.parentId) : undefined;
			if (!parent || parent.kind === "attachment") return { review: e.file ? `An attachment page with no known parent entry. Its file is ${e.file}; send the page there if the new site keeps that file path.` : "An attachment page with no known parent entry." };
			const r = resolve(ctx, parent, depth + 1);
			return "review" in r ? { review: `An attachment page; its parent cannot be placed: ${r.review}` } : { path: r.path, note: "Attachment page; sent to its parent entry." };
		}
		case "paged": {
			const base = new URL(url.href);
			base.searchParams.delete("paged");
			base.pathname = base.pathname.replace(/\/page\/\d+\/?$/, "/");
			const found = ctx.ledger.get(normalizeUrl(base.href));
			if (!found || found.kind === "paged") return { review: "A later page of a list whose first page is not in the inventory." };
			const blog = routeOf(ctx, "blog");
			if (ctx.homeListsPosts && blog && new URL(found.url).pathname === ctx.base) return { path: withPrefix(ctx, blog, e.locale), note: "A later page of the post list on the old home page; sent to the blog index." };
			const r = resolve(ctx, found, depth + 1);
			return "review" in r ? { review: `A later page of a list that cannot be placed: ${r.review}` } : { path: r.path, note: "A later page of a list; sent to page 1." };
		}
		case "query":
			return query(ctx, e, url.searchParams, depth);
		default:
			return { review: "The inventory could not tell what this URL is; pick its new page by hand." };
	}
}

/** The old site's base path, and what its root is: a page (by ID) or the post list. */
function front(site: URL, ledger: Map<string, UrlEntry>): { base: string; frontId?: number; homeListsPosts: boolean } {
	const base = siteBase(site);
	const entries = [...ledger.values()];
	const root = entries.find((u) => {
		const x = new URL(u.url);
		return x.origin === site.origin && x.pathname === base && !x.search;
	});
	const home = entries.find((u) => u.kind === "home" && u.id !== undefined);
	const frontId = root?.id !== undefined && (root.kind === "home" || root.type === "page") ? root.id : home?.id;
	return { base, ...(frontId !== undefined ? { frontId } : {}), homeListsPosts: root?.kind === "home" && root.id === undefined && !root.type };
}

/** The site's base path, ending in a slash: "/" or, for a subfolder install, "/site/". */
export function siteBase(site: URL): string {
	return site.pathname.endsWith("/") ? site.pathname : `${site.pathname}/`;
}

/** The redirect plan for one target, one row per old URL, sorted by the old path. */
export function planRedirects(inv: Inventory, model: Model, options: PlanOptions): Row[] {
	return planWithClashes(inv, model, options).rows;
}

/** The new paths two or more different old entries or terms land on (all marked review in the plan). */
export function clashingPaths(inv: Inventory, model: Model, options: PlanOptions): string[] {
	return planWithClashes(inv, model, options).clashes;
}

function planWithClashes(inv: Inventory, model: Model, options: PlanOptions): { rows: Row[]; clashes: string[] } {
	const site = new URL(inv.site.url);
	const ledger = new Map<string, UrlEntry>();
	for (const u of [...inv.urls].sort((a, b) => byKey(normalizeUrl(a.url), normalizeUrl(b.url)))) {
		const key = normalizeUrl(u.url);
		if (!ledger.has(key)) ledger.set(key, u);
	}
	for (const a of menuArchives(inv)) {
		let key: string;
		try {
			key = normalizeUrl(a.url);
		} catch {
			continue;
		}
		if (!ledger.has(key)) ledger.set(key, { url: key, kind: "archive", type: a.type, source: [], evidence: "linked" });
	}
	const byId = new Map<number, UrlEntry[]>();
	for (const u of ledger.values()) if (u.id !== undefined) byId.set(u.id, [...(byId.get(u.id) ?? []), u]);
	const prefixes = new Map<string, string>();
	for (const l of model.locales.length ? model.locales : inv.site.locales) if (l.prefix) prefixes.set(l.code, l.prefix);
	const ctx: Context = {
		inv,
		model,
		target: options.target,
		origin: site.origin,
		prefixes,
		ledger,
		byId,
		collections: [...model.collections].sort((a, b) => byKey(a.slug, b.slug)),
		taxonomies: [...model.taxonomies].sort((a, b) => byKey(a.slug, b.slug)),
		...front(site, ledger),
	};

	const listed = new Set(inv.urls.map((u) => normalizeUrl(u.url)));
	const planned: { row: Row; id?: string }[] = [];
	for (const [key, e] of ledger) {
		const url = new URL(key);
		const old = url.origin === ctx.origin ? key.slice(ctx.origin.length) : key;
		let r = resolve(ctx, e);
		if (!("review" in r) && ctx.target === "emdash") r = { ...r, path: noTrailingSlash(r.path) };
		if (!("review" in r) && !isSiteRelative(r.path)) r = { review: LEAVES };
		if ("review" in r) {
			planned.push({ row: { old, new: "", status: "review", kind: e.kind, note: listed.has(key) ? r.review : `${r.review} ${MENU_ONLY}` } });
			continue;
		}
		const same = r.path === old;
		let note = same ? `${r.note} Same path on the new site; no redirect needed.` : url.search ? `${r.note} ${QUERY_NOTE}` : r.note;
		if (!listed.has(key)) note += ` ${MENU_ONLY}`;
		planned.push({ row: { old, new: r.path, status: same ? "same" : "301", kind: e.kind, note }, id: r.id });
	}

	// Two different old entries or terms on one new path: neither can redirect there.
	const owners = new Map<string, Set<string>>();
	for (const p of planned) if (p.id) owners.set(p.row.new, (owners.get(p.row.new) ?? new Set()).add(p.id));
	const clashes = [...owners].filter(([, set]) => set.size > 1).map(([path]) => path).sort(byKey);
	for (const p of planned) {
		const set = p.id ? owners.get(p.row.new) : undefined;
		if (!set || set.size < 2) continue;
		p.row.note = `${set.size} different old pages land on ${p.row.new}; give one a new slug, then map it by hand.`;
		p.row.new = "";
		p.row.status = "review";
	}

	return { rows: settleGraph(planned.map((p) => p.row).sort((a, b) => byKey(a.old, b.old))), clashes };
}

/**
 * Settles the redirect graph. A redirect whose new path is another old URL that also
 * redirects is a chain: it is collapsed to the final target, since every hop is a
 * mapped 301. A chain that ends on an old URL marked review, or that runs in a loop,
 * becomes review. Rows keep their order.
 */
export function settleGraph(rows: Row[]): Row[] {
	const byOld = new Map(rows.map((r) => [r.old, r]));
	return rows.map((row) => {
		if (row.status !== "301") return { ...row };
		const seen = [row.old];
		const via: string[] = [];
		let cur = row.new;
		for (;;) {
			const next = byOld.get(cur);
			if (!next || next.status === "same") break;
			if (next.status === "review") return { ...row, new: "", status: "review", note: `Leads to ${cur}, an old URL that needs review; settle that one first.` };
			if (seen.includes(next.old)) return { ...row, new: "", status: "review", note: `Part of a redirect loop (${[...seen, next.old].join(" -> ")}); pick the right page by hand.` };
			seen.push(next.old);
			via.push(cur);
			cur = next.new;
		}
		if (!via.length) return { ...row };
		return { ...row, new: cur, note: `${row.note} Collapsed a chain via ${via.join(", ")}.` };
	});
}
