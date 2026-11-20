// URLs the site answers that no list names, added after the readers ran:
// - date archives (/<front>/YYYY/ and /<front>/YYYY/MM/) from post dates, when the
//   permalink structure holds %year%; with plain links, ?m=YYYYMM and ?m=YYYY;
// - later pages of a list (/page/2/ to the last page), for the home page when it lists
//   posts, the posts page, each term and author with a post count, each post type
//   archive with a count, and every list the HTML linked a later page of. The last page
//   comes from the counts at WordPress's default 10 posts per page, or the highest page
//   linked, whichever is more. A term's count holds its child terms' posts too, as the
//   archive lists them;
// - feeds of each term, author and post type archive (<list>feed/, or &feed=rss2 on a
//   query URL), and with plain links each post's ?p=N&feed=rss2.
// Each family is bounded (src/sources/limits.ts), and so is the ledger as a whole. The
// `urls` coverage line is always written; its numbers are the ledger's entries by kind.

import type { UrlEntry } from "../../contracts/inventory.ts";
import { normalizeUrl } from "../../contracts/url.ts";
import { DEFAULT_PER_PAGE, MAX_DERIVED_FEEDS, MAX_DERIVED_URLS, MAX_PAGES_PER_LIST } from "../limits.ts";
import type { Collector } from "./collect.ts";
import { addUrl, cover, onSite } from "./collect.ts";

const TERMS = new Set(["category", "tag", "term"]);
const n = (count: number, one: string, many = `${one}s`): string => `${count} ${count === 1 ? one : many}`;
const join = (parts: string[]): string => (parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`);

/** The list URL and page number of a later-page URL, or undefined. */
export function pageOf(url: string): { list: string; page: number } | undefined {
	const u = new URL(url);
	const paged = u.searchParams.get("paged");
	if (paged !== null) {
		if (!/^\d+$/.test(paged)) return undefined;
		u.searchParams.delete("paged");
		return { list: normalizeUrl(u.href), page: Number(paged) };
	}
	const m = /^(.*\/)page\/(\d+)\/?$/.exec(u.pathname);
	if (!m) return undefined;
	u.pathname = m[1] as string;
	return { list: normalizeUrl(u.href), page: Number(m[2]) };
}

/** Page `page` of the list at `list`: /page/N/ on a path, ?paged=N on a query URL or with plain permalinks. */
export function pageUrl(list: string, page: number, slash: boolean, plain = false): string {
	const u = new URL(list);
	if (u.search !== "" || plain) {
		u.searchParams.set("paged", String(page));
		return u.href;
	}
	if (!u.pathname.endsWith("/")) u.pathname += "/";
	u.pathname += `page/${page}${slash ? "/" : ""}`;
	return u.href;
}

/** The feed of the list at `list`: <list>feed/ on a path, &feed=rss2 on a query URL or with plain permalinks. */
export function feedUrl(list: string, slash: boolean, plain = false): string {
	const u = new URL(list);
	if (u.search !== "" || plain) {
		u.searchParams.set("feed", "rss2");
		return u.href;
	}
	if (!u.pathname.endsWith("/")) u.pathname += "/";
	u.pathname += `feed${slash ? "/" : ""}`;
	return u.href;
}

/** Each term's post count with its child terms' posts added, as a category archive lists them. */
function termTotals(c: Collector): Map<string, number> {
	const terms = [...c.urls.values()].filter((e) => TERMS.has(e.kind) && e.count !== undefined);
	const key = (taxonomy: string | undefined, id: number): string => `${taxonomy ?? ""}\n${id}`;
	const children = new Map<string, UrlEntry[]>();
	for (const e of terms) {
		if (e.parentId === undefined) continue;
		const k = key(e.taxonomy, e.parentId);
		const list = children.get(k) ?? [];
		list.push(e);
		children.set(k, list);
	}
	const memo = new Map<UrlEntry, number>();
	const total = (e: UrlEntry, seen: Set<UrlEntry>): number => {
		const known = memo.get(e);
		if (known !== undefined) return known;
		if (seen.has(e)) return 0;
		seen.add(e);
		let sum = e.count ?? 0;
		if (e.termId !== undefined) for (const k of children.get(key(e.taxonomy, e.termId)) ?? []) sum += total(k, seen);
		memo.set(e, sum);
		return sum;
	};
	const out = new Map<string, number>();
	for (const e of terms) out.set(normalizeUrl(e.url), total(e, new Set()));
	return out;
}

export function deriveUrls(c: Collector): void {
	let room = MAX_DERIVED_URLS;
	let full = false;
	const added = { date: 0, paged: 0, feed: 0 };
	const add = (e: UrlEntry & { kind: keyof typeof added }): boolean => {
		if (room <= 0 || c.urls.size >= c.maxUrls) {
			full = true;
			return false;
		}
		const had = c.urls.has(normalizeUrl(e.url));
		addUrl(c, e);
		if (had) return false;
		room--;
		added[e.kind]++;
		return true;
	};
	const structure = c.permalinks.structure;
	const plain = structure === "";
	const slash = structure === undefined || plain || structure.endsWith("/");

	// Date archives.
	const years = new Set<string>();
	for (const ym of c.months) years.add(ym.slice(0, 4));
	if (structure && structure.includes("%year%")) {
		const front = structure.slice(0, structure.indexOf("%year%")).replace(/^\/+/, "");
		const end = slash ? "/" : "";
		for (const ym of [...c.months].sort()) {
			const [y, m] = ym.split("-") as [string, string];
			add({ url: new URL(`${front}${y}/${m}${end}`, c.base).href, kind: "date", source: ["rest"], evidence: "listed" });
		}
		for (const y of [...years].sort()) add({ url: new URL(`${front}${y}${end}`, c.base).href, kind: "date", source: ["rest"], evidence: "listed" });
	} else if (plain) {
		for (const ym of [...c.months].sort()) add({ url: new URL(`?m=${ym.replace("-", "")}`, c.base).href, kind: "date", source: ["rest"], evidence: "listed" });
		for (const y of [...years].sort()) add({ url: new URL(`?m=${y}`, c.base).href, kind: "date", source: ["rest"], evidence: "listed" });
	}

	// Later pages: the last page each list has.
	const last = new Map<string, number>();
	const want = (list: string, page: number): void => {
		if (page >= 2) last.set(list, Math.max(last.get(list) ?? 0, Math.min(page, MAX_PAGES_PER_LIST + 1)));
	};
	const pages = (count: number): number => Math.ceil(count / DEFAULT_PER_PAGE);
	const posts = c.types.get("post")?.count;
	const home = normalizeUrl(c.base.href);
	const totals = termTotals(c);
	const feeds: string[] = [];
	if (c.homeLists && posts !== undefined) want(home, pages(posts));
	for (const e of [...c.urls.values()]) {
		const at = normalizeUrl(e.url);
		if (TERMS.has(e.kind) && onSite(c, e.url)) {
			const total = totals.get(at);
			if (total !== undefined) want(at, pages(total));
			if (total === undefined || total > 0) feeds.push(at);
		}
		if (e.kind === "author" && onSite(c, e.url)) {
			const count = c.authorCounts.get(at);
			if (count !== undefined) want(at, pages(count));
			feeds.push(at);
		}
		if (e.kind === "archive" && e.type && onSite(c, e.url) && at !== home) {
			const count = c.types.get(e.type)?.count;
			if (count !== undefined) want(at, pages(count));
			feeds.push(at);
		}
		if (e.kind === "paged") {
			const p = pageOf(e.url);
			if (!p || !(c.urls.has(p.list) || p.list === home)) continue;
			want(p.list, p.page);
			// A page that links its own later pages lists posts: it is the posts page.
			const kind = c.urls.get(p.list)?.kind ?? "home";
			if (posts !== undefined && (kind === "page" || kind === "home" || kind === "archive")) want(p.list, pages(posts));
		}
	}
	for (const [list, max] of [...last].sort(([a], [b]) => (a < b ? -1 : 1))) {
		for (let page = 2; page <= max; page++) add({ url: pageUrl(list, page, slash, plain), kind: "paged", source: ["rest"], evidence: "listed" });
	}

	// Feeds: each list's own, and with plain links each post's.
	let feedRoom = MAX_DERIVED_FEEDS;
	const feed = (url: string): void => {
		if (feedRoom <= 0) {
			full = true;
			return;
		}
		if (add({ url, kind: "feed", source: ["rest"], evidence: "listed" })) feedRoom--;
	};
	for (const list of feeds.sort()) feed(feedUrl(list, slash, plain));
	if (plain) for (const id of [...c.postIds].sort((a, b) => a - b)) feed(new URL(`?p=${id}&feed=rss2`, c.base).href);

	coverUrls(c, added, { full, plain });
}

/** The `urls` coverage line: always written, its numbers the ledger's entries by kind. */
function coverUrls(c: Collector, added: { date: number; paged: number; feed: number }, o: { full: boolean; plain: boolean }): void {
	const kinds = [["date", "date archive"], ["paged", "later list page"], ["feed", "feed"]] as const;
	const all = [...c.urls.values()];
	const inLedger = kinds.map(([k, one]) => ({ k, one, total: all.filter((e) => e.kind === k).length, html: all.filter((e) => e.kind === k && e.source.includes("html")).length }));
	const sum = added.date + added.paged + added.feed;
	const out: string[] = [];
	out.push(sum === 0 ? "Added no URLs from post dates and counts." : `Added ${n(sum, "URL")} that no content list names, from post dates and counts.`);
	const has = inLedger.filter((x) => x.total > 0);
	if (has.length === 0) out.push("The ledger has no date archives, later list pages or feeds.");
	else {
		out.push(`The ledger has ${join(has.map((x) => n(x.total, x.one)))}.`);
		const seen = has.filter((x) => x.html > 0);
		if (seen.length > 0) out.push(`Of these, ${join(seen.map((x) => n(x.html, x.one)))} ${seen.length === 1 && seen[0]?.html === 1 ? "was" : "were"} also seen in the page HTML.`);
	}
	if (added.paged > 0) out.push(`The last page of a list is a guess at ${DEFAULT_PER_PAGE} posts per page (the WordPress default). A category's list also holds the posts of its child categories.`);
	if (o.plain) out.push("With plain links, the old site also answers query URLs that no ledger can list in full: ?m=YYYYMM, ?paged=N and ?p=N&feed=rss2. The ones that post dates and counts imply were added.");
	if (o.full) out.push(`Stopped at the cap of ${MAX_DERIVED_URLS} added URLs (${MAX_DERIVED_FEEDS} feeds) or the ledger cap of ${c.maxUrls} URLs.`);
	cover(c, "urls", "rest", o.full || o.plain ? "partial" : "complete", out.join(" "));
}
