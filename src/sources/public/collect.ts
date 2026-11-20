// What the level 1 readers learn, gathered in one place and turned into an Inventory.

import type {
	ContentType, Coverage, Confidence, Inventory, Locale, Plugin, Source, Taxonomy, UrlEntry, UrlKind,
} from "../../contracts/inventory.ts";
import { INVENTORY_VERSION } from "../../contracts/inventory.ts";
import { normalizeUrl } from "../../contracts/url.ts";
import { canonical } from "../../contracts/write.ts";
import { PLUGINS } from "./plugins-map.ts";
import { newBudget, type ListBudget } from "../limits.ts";

export interface Collector {
	/** The site's base URL, ending in "/". */
	base: URL;
	origin: string;
	site: Inventory["site"];
	coverage: Coverage[];
	types: Map<string, ContentType>;
	taxonomies: Map<string, Taxonomy>;
	plugins: Map<string, Plugin>;
	builders: Map<string, Set<string>>;
	shortcodes: Map<string, Set<string>>;
	blocks: Map<string, Set<string>>;
	urls: Map<string, UrlEntry>;
	authors?: Inventory["authors"];
	media?: Inventory["media"];
	comments?: Inventory["comments"];
	permalinks: Inventory["permalinks"];
	/** True when the REST API answered with its type list. */
	restTypes: boolean;
	/** A URL's place in the list that first named it (REST order, else sitemap order); picks HTML pages. */
	rank: Map<string, number>;
	/** The most URLs the ledger keeps; new URLs past it are counted in `dropped`. */
	maxUrls: number;
	dropped: number;
	/** Items and bytes all REST lists may read together. */
	budget: ListBudget;
	/** Requests that redirected to another site (not followed): path to target. */
	offsite: Map<string, string>;
	/** Items whose REST content.rendered was scanned for builders, shortcodes and blocks. */
	contentUrls: Set<string>;
	/** True when a field-group plugin left a trace (REST acf key, acf markup). */
	acf: boolean;
	/** Year and month ("2024-12") of every post REST listed. */
	months: Set<string>;
	/** True when the home page's body classes say it lists posts ("home blog"). */
	homeLists: boolean;
	/** Published posts per author ID, from the REST post list. */
	authorPosts: Map<number, number>;
	/** Published posts per author archive URL. */
	authorCounts: Map<string, number>;
	/** The ID of every published post REST listed. */
	postIds: number[];
	/** Shortcodes seen only from the HTML they print (a form, a gallery), not as [name]. */
	shortcodeOutputs: Set<string>;
}

export interface CollectorOptions { maxUrls?: number; maxListItems?: number; maxListBytes?: number }

export const MAX_URLS = 50_000;

export function createCollector(siteUrl: string, opts: CollectorOptions = {}): Collector {
	const u = new URL(siteUrl);
	u.search = "";
	u.hash = "";
	if (!u.pathname.endsWith("/")) u.pathname += "/";
	return {
		base: u,
		origin: u.origin,
		site: { url: normalizeUrl(u.href), locales: [] },
		coverage: [],
		types: new Map(),
		taxonomies: new Map(),
		plugins: new Map(),
		builders: new Map(),
		shortcodes: new Map(),
		blocks: new Map(),
		urls: new Map(),
		permalinks: { source: "html", confidence: "low" },
		restTypes: false,
		rank: new Map(),
		maxUrls: opts.maxUrls ?? MAX_URLS,
		dropped: 0,
		budget: newBudget(opts),
		offsite: new Map(),
		contentUrls: new Set(),
		acf: false,
		months: new Set(),
		homeLists: false,
		authorPosts: new Map(),
		authorCounts: new Map(),
		postIds: [],
		shortcodeOutputs: new Set(),
	};
}

export function cover(c: Collector, area: string, source: Source, status: Coverage["status"], detail: string): void {
	const i = c.coverage.findIndex((x) => x.area === area && x.source === source);
	const line = { area, source, status, detail };
	if (i === -1) c.coverage.push(line);
	else c.coverage[i] = line;
}

const addSource = (list: Source[], s: Source): void => {
	if (!list.includes(s)) list.push(s);
};

export function typeOf(c: Collector, slug: string, source: Source): ContentType {
	let t = c.types.get(slug);
	if (!t) {
		t = { slug, byStatus: {}, fields: [], taxonomies: [], sources: [] };
		c.types.set(slug, t);
	}
	addSource(t.sources, source);
	return t;
}

export function taxonomyOf(c: Collector, slug: string, source: Source): Taxonomy {
	let t = c.taxonomies.get(slug);
	if (!t) {
		t = { slug, types: [], sources: [] };
		c.taxonomies.set(slug, t);
	}
	addSource(t.sources, source);
	return t;
}

export function addPlugin(c: Collector, slug: string, source: Source, confidence: Confidence): void {
	const prev = c.plugins.get(slug);
	const rank = { low: 0, medium: 1, high: 2 };
	if (prev && rank[prev.confidence] >= rank[confidence]) return;
	const info = PLUGINS[slug];
	c.plugins.set(slug, { slug, ...(info ? { name: info.name } : {}), category: info?.category ?? "other", source, confidence });
}

export function addUsage(map: Map<string, Set<string>>, name: string, page: string): void {
	let s = map.get(name);
	if (!s) map.set(name, (s = new Set()));
	s.add(normalizeUrl(page));
}

const EVIDENCE = { linked: 0, listed: 1, resolved: 2 } as const;
const VAGUE: UrlKind[] = ["other", "archive"];

/** Adds a ledger URL. Facts already known stay; sources add up; the strongest evidence wins. */
export function addUrl(c: Collector, entry: UrlEntry): void {
	const key = normalizeUrl(entry.url);
	const prev = c.urls.get(key);
	if (!prev) {
		if (c.urls.size >= c.maxUrls) {
			c.dropped++;
			return;
		}
		c.urls.set(key, { ...entry, url: key, source: [...entry.source] });
		return;
	}
	for (const [k, v] of Object.entries(entry)) {
		if (v === undefined || k === "source" || k === "evidence" || k === "url") continue;
		const p = prev as unknown as Record<string, unknown>;
		if (k === "kind" && VAGUE.includes(prev.kind) && !VAGUE.includes(v as UrlKind)) p[k] = v;
		else if (p[k] === undefined) p[k] = v;
	}
	for (const s of entry.source) addSource(prev.source, s);
	if (EVIDENCE[entry.evidence] > EVIDENCE[prev.evidence]) prev.evidence = entry.evidence;
}

/** Drops leading and trailing slashes without a regex (a run of slashes stays linear). */
export function trimSlashes(p: string): string {
	let a = 0;
	let b = p.length;
	while (a < b && p[a] === "/") a++;
	while (b > a && p[b - 1] === "/") b--;
	return p.slice(a, b);
}

/** The URL's path under the site base without outer slashes; undefined when outside it or query-style. */
export function relPath(c: Collector, abs: string): string | undefined {
	let u: URL;
	try {
		u = new URL(abs, c.base);
	} catch {
		return undefined;
	}
	if (u.origin !== c.origin || u.search !== "" || !u.pathname.startsWith(c.base.pathname)) return undefined;
	return trimSlashes(u.pathname.slice(c.base.pathname.length));
}

/** Same origin and under the site base. */
export function onSite(c: Collector, abs: string): URL | undefined {
	try {
		const u = new URL(abs, c.base);
		u.hash = "";
		return u.origin === c.origin && u.pathname.startsWith(c.base.pathname) ? u : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Guesses the permalink structure from one post URL. With the post's date, slug and ID the
 * guess is exact for those tags; from the path alone, 4-digit then 2-digit segments are read
 * as year, month and day. Returns "" for plain (?p=) links.
 */
export function guessStructure(c: Collector, link: string, post: { date?: string; slug?: string; id?: number } = {}): string | undefined {
	const u = onSite(c, link);
	if (!u) return undefined;
	if (u.searchParams.has("p") && u.pathname === c.base.pathname) return "";
	const rel = relPath(c, u.href);
	if (rel === undefined || rel === "") return undefined;
	const segs = rel.split("/");
	const [y, m, d] = post.date ? (post.date.slice(0, 10).split("-") as [string, string, string]) : [];
	let dateStep = 0;
	const out = segs.map((s, i) => {
		const last = i === segs.length - 1;
		if (post.slug !== undefined && s === post.slug) return "%postname%";
		if (post.id !== undefined && s === String(post.id)) return "%post_id%";
		if (post.date) {
			if (s === y) return "%year%";
			if (s === m && dateStep++ === 0) return "%monthnum%";
			if (s === d) return "%day%";
			return s;
		}
		if (dateStep === 0 && /^\d{4}$/.test(s)) return (dateStep = 1), "%year%";
		if (dateStep === 1 && /^\d{2}$/.test(s)) return (dateStep = 2), "%monthnum%";
		if (dateStep === 2 && /^\d{2}$/.test(s) && !last) return (dateStep = 3), "%day%";
		if (last) return "%postname%";
		return s;
	});
	const trailing = u.pathname.endsWith("/") ? "/" : "";
	return `/${out.join("/")}${trailing}`;
}

export function setRank(c: Collector, url: string, place: number): void {
	const key = normalizeUrl(url);
	if (!c.rank.has(key)) c.rank.set(key, place);
}

export function setLocale(c: Collector, code: string): void {
	if (c.site.locales.length === 0) c.site.locales.push({ code, default: true } as Locale);
}

export function toInventory(c: Collector): Inventory {
	const usage = (m: Map<string, Set<string>>) =>
		[...m].map(([name, pages]) => ({ name, count: pages.size, samples: [...pages].sort().slice(0, 3) }));
	const storedElsewhere = [...c.plugins.keys()]
		.map((slug) => ({ plugin: slug, what: PLUGINS[slug]?.stores }))
		.filter((s): s is { plugin: string; what: string } => s.what !== undefined);
	const inv: Inventory = {
		version: INVENTORY_VERSION,
		site: c.site,
		levels: [1],
		coverage: c.coverage,
		types: [...c.types.values()],
		taxonomies: [...c.taxonomies.values()],
		plugins: [...c.plugins.values()],
		builders: usage(c.builders),
		shortcodes: usage(c.shortcodes),
		blocks: usage(c.blocks),
		menus: [],
		...(c.authors ? { authors: c.authors } : {}),
		...(c.media ? { media: c.media } : {}),
		...(c.comments ? { comments: c.comments } : {}),
		permalinks: c.permalinks,
		urls: [...c.urls.values()],
		storedElsewhere,
	};
	return canonical("inventory", inv);
}
