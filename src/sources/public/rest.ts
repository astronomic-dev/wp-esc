// Reads the public REST API: namespaces, types, taxonomies, and every list paged with
// per_page=100 to X-WP-TotalPages. Fills counts, fields seen in list items, SEO head data
// (Yoast), and the URL ledger. A list that answers 401 or 404 gets coverage `failed`
// and the run goes on.

import type { FetchOptions, SiteFetch } from "../../contracts/fetch.ts";
import type { ContentType, Field, FieldShape, Confidence } from "../../contracts/inventory.ts";
import { SiteFetchError } from "../../http/site-fetch.ts";
import { normalizeUrl } from "../../contracts/url.ts";
import type { Collector } from "./collect.ts";
import { addPlugin, addUrl, addUsage, cover, guessStructure, onSite, setRank, taxonomyOf, typeOf } from "./collect.ts";
import { scanContent, withoutShortcodeOutput } from "./html.ts";
import type { Discovery } from "./discover.ts";
import { pluginForNamespace } from "./plugins-map.ts";
import { spendBytes, spendItems, type ListBudget } from "../limits.ts";

/** Types that are not site content (media is counted on its own). */
export const SKIP_TYPES = new Set([
	"attachment", "nav_menu_item", "wp_block", "wp_template", "wp_template_part", "wp_navigation", "wp_global_styles",
	"wp_font_family", "wp_font_face", "revision", "customize_changeset", "oembed_cache", "user_request", "custom_css",
]);
export const SKIP_TAXONOMIES = new Set(["nav_menu", "link_category", "post_format", "wp_pattern_category", "wp_theme", "wp_template_part_area"]);

const PER_PAGE = "100";
const MAX_PAGES = 1000;
const SAMPLE_LEN = 120;

type Json = Record<string, unknown>;

/** The request path for a REST route ("/wp/v2/posts") under an API root. */
export function routePath(root: URL, route: string): string {
	if (root.searchParams.has("rest_route")) return `${root.pathname}?rest_route=${route}`;
	return root.pathname.replace(/\/$/, "") + route;
}

/**
 * Fetch errors that end one request but not the run: the request cap, transport errors,
 * oversize bodies, and a redirect to another site (it was not followed). Address, method
 * and path errors stop the run.
 */
export function soft(e: unknown): e is SiteFetchError {
	if (!(e instanceof SiteFetchError)) return false;
	return e.code === "cap" || e.code === "transport" || e.code === "size" || (e.code === "origin" && e.target !== undefined);
}

async function getJson(fetch: SiteFetch, path: string, query?: FetchOptions["query"], budget?: ListBudget): Promise<{ status: number; json?: unknown; headers?: Headers; error?: string; capped?: string }> {
	try {
		const res = await fetch(path, query ? { query } : {});
		if (res.status !== 200) return { status: res.status, headers: res.headers };
		const text = await res.text();
		const capped = budget ? spendBytes(budget, Buffer.byteLength(text)) : undefined;
		if (capped) return { status: 200, headers: res.headers, capped };
		try {
			return { status: 200, json: JSON.parse(text), headers: res.headers };
		} catch {
			return { status: 200, headers: res.headers, error: "not JSON" };
		}
	} catch (e) {
		if (soft(e)) return { status: 0, error: e.message };
		throw e;
	}
}

/** count: items handed to `onPage`. status: the last answer (200 when a cap stopped the list). */
interface Listed { count: number; status: number; complete: boolean; total?: number; detail: string }

/**
 * Pages a list to the end. Each page goes to `onPage` and is dropped, so only what the
 * caller keeps from it stays in memory. `offset` is the place of the page's first item.
 */
export async function pageAll(fetch: SiteFetch, root: URL, route: string, budget: ListBudget, onPage: (items: Json[], offset: number) => void): Promise<Listed> {
	let count = 0;
	let pages = 1;
	let total: number | undefined;
	for (let page = 1; page <= Math.min(pages, MAX_PAGES); page++) {
		const r = await getJson(fetch, routePath(root, route), { per_page: PER_PAGE, page: String(page) }, budget);
		if (r.capped) return { count, status: 200, complete: false, total, detail: `${route} stopped at page ${page} of ${pages}: ${r.capped}.` };
		if (r.status !== 200 || !Array.isArray(r.json)) {
			const why = r.error ?? `answered ${r.status}`;
			if (page === 1) return { count, status: r.status, complete: false, detail: `${route} ${why}.` };
			return { count, status: r.status, complete: false, total, detail: `${route} stopped at page ${page} of ${pages} (${why}).` };
		}
		if (page === 1) {
			const tp = Number(r.headers?.get("x-wp-totalpages"));
			const t = Number(r.headers?.get("x-wp-total"));
			pages = Number.isFinite(tp) && tp >= 1 ? tp : r.json.length >= 100 ? MAX_PAGES : 1;
			if (Number.isFinite(t) && r.headers?.get("x-wp-total") !== null) total = t;
		}
		const got = r.json as Json[];
		const { take, reason } = spendItems(budget, got.length);
		onPage(take < got.length ? got.slice(0, take) : got, count);
		count += take;
		if (reason) return { count, status: 200, complete: false, total, detail: `${route} stopped at page ${page} of ${pages}: ${reason}.` };
		if (!r.headers?.get("x-wp-totalpages") && got.length < 100) break;
	}
	if (pages > MAX_PAGES) return { count, status: 200, complete: false, total, detail: `${route} has more than ${MAX_PAGES} pages.` };
	return { count, status: 200, complete: true, total, detail: `${route}: ${n(count, "item")}.` };
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const rendered = (v: unknown): string => (v && typeof v === "object" ? (str((v as Json).rendered) ?? "") : (str(v) ?? ""));
const isFilled = (v: unknown): boolean =>
	v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && v.length === 0) && !(typeof v === "object" && !Array.isArray(v) && Object.keys(v as object).length === 0);
const n = (count: number, one: string, many = `${one}s`): string => `${count} ${count === 1 ? one : many}`;
const sample = (s: string): string => (s.length > SAMPLE_LEN ? `${s.slice(0, SAMPLE_LEN)}…` : s);

/** The most words of an item's content compared with its excerpt or SEO description. */
const MAX_COMPARE_WORDS = 2000;

/** The lowercase words of rendered HTML: tags and entities dropped, punctuation splits. */
export function wordsOf(html: string, max = MAX_COMPARE_WORDS): string[] {
	const text = html.replace(/<[^<>]*>/g, " ").replace(/&#?[a-z0-9]+;/gi, " ").toLowerCase();
	const out: string[] = [];
	for (const w of text.split(/[^\p{L}\p{N}]+/u)) {
		if (w === "") continue;
		out.push(w);
		if (out.length >= max) break;
	}
	return out;
}

const startsWith = (whole: string[], part: string[]): boolean => part.length > 0 && part.length <= whole.length && part.every((w, i) => whole[i] === w);

/** True when `part` (non-empty) runs, word for word, in `whole`, starting in its first `lead` words. */
function runsFrom(whole: string[], part: string[], lead: number): boolean {
	for (let start = 0; start < Math.min(lead, whole.length); start++) if (startsWith(whole.slice(start, start + part.length), part)) return true;
	return false;
}

/** The words of an item's content as WordPress sees them for an excerpt: without the output of known shortcodes. */
const contentWords = (content: string): string[] => wordsOf(withoutShortcodeOutput(content));

/**
 * True when an excerpt is the one WordPress makes when none was written: the start of
 * the content, stripped of tags (the ellipsis and its entity drop out with the
 * punctuation). WordPress also strips shortcodes first, while the rendered content holds
 * what they print, so the output of known shortcodes (a form, a gallery) is cut from the
 * content before the words are compared. Nothing else may come between the words.
 */
export function isAutoExcerpt(excerpt: string, content: string): boolean {
	const e = wordsOf(excerpt, 200);
	if (e.length === 0) return true;
	return runsFrom(contentWords(content), e, 20);
}

/** True when a Yoast title is the default: the item's title, then the site name ("<title> <sep> <site name>"). */
export function isDefaultSeoTitle(value: string, title: string, siteName: string | undefined): boolean {
	const v = wordsOf(value).join(" ");
	const t = wordsOf(title).join(" ");
	return v === "" || v === t || (siteName !== undefined && v === [t, wordsOf(siteName).join(" ")].filter(Boolean).join(" "));
}

/**
 * True when a Yoast description is a default: the start of the excerpt (Yoast may cut it
 * short), or the start of the content. A description that copies a later sentence was
 * written by hand.
 */
export function isDefaultSeoDescription(value: string, excerpt: string, content: string): boolean {
	const v = wordsOf(value, 400);
	return v.length === 0 || startsWith(wordsOf(excerpt), v) || startsWith(contentWords(content), v);
}

export function shapeOf(v: unknown): FieldShape {
	if (typeof v === "boolean") return "boolean";
	if (typeof v === "number") return "number";
	if (Array.isArray(v)) return "list";
	if (v && typeof v === "object") return "object";
	const s = String(v);
	if (/^-?\d+(\.\d+)?$/.test(s)) return "number";
	if (/^https?:\/\/\S+$/.test(s)) return "url";
	if (s.length <= 254 && /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/.test(s)) return "email";
	if (/^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?$/.test(s) || /^\d{8}$/.test(s)) return "date";
	if (/<[a-z][^<>]*>/i.test(s)) return "html";
	return "text";
}

/** ACF and Secure Custom Fields field types mapped to field shapes. */
const ACF_SHAPES: Record<string, FieldShape> = {
	text: "text", textarea: "text", wysiwyg: "html", number: "number", range: "number", email: "email", url: "url",
	image: "image", file: "file", gallery: "list", relationship: "relation", post_object: "relation", page_link: "relation",
	taxonomy: "relation", user: "relation", true_false: "boolean", date_picker: "date", date_time_picker: "date",
	time_picker: "text", select: "text", radio: "text", button_group: "text", checkbox: "list", link: "object",
	group: "object", repeater: "repeater", flexible_content: "flexible", oembed: "url", color_picker: "text",
};

/**
 * The order of a value: the item's ID, its place in the list, then its row. Samples are
 * the first distinct values in this order (lowest IDs first), as if every item were kept.
 */
type Place = readonly number[];
const before = (a: Place, b: Place): boolean => {
	for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0);
	return false;
};
const SAMPLES = 2;

/** Running facts about one field's values: fill count, shapes, the earliest samples. */
class ValueAcc {
	filled = 0;
	readonly shapes = new Set<FieldShape>();
	private readonly samples = new Map<string, Place>();
	/** Rows, when values are lists of objects (repeaters). */
	rows?: RowAcc;

	add(v: unknown, at: Place, rows = false): void {
		if (rows && Array.isArray(v)) {
			for (const [k, r] of v.entries()) if (r && typeof r === "object" && !Array.isArray(r)) (this.rows ??= new RowAcc()).add(r as Json, [...at, k]);
		}
		if (!isFilled(v)) return;
		this.filled++;
		this.shapes.add(shapeOf(v));
		const s = sample(typeof v === "string" ? v : JSON.stringify(v));
		const prev = this.samples.get(s);
		if (prev && !before(at, prev)) return;
		this.samples.set(s, at);
		if (this.samples.size > SAMPLES) {
			let last: string | undefined;
			for (const [k, p] of this.samples) if (last === undefined || before(this.samples.get(last) as Place, p)) last = k;
			this.samples.delete(last as string);
		}
	}

	sampleList(): string[] {
		return [...this.samples].sort((a, b) => (before(a[1], b[1]) ? -1 : before(b[1], a[1]) ? 1 : 0)).map(([k]) => k);
	}
}

/** Repeater rows: one accumulator per row key. */
class RowAcc {
	count = 0;
	readonly keys = new Map<string, ValueAcc>();
	add(row: Json, at: Place): void {
		this.count++;
		for (const [k, v] of Object.entries(row)) {
			let a = this.keys.get(k);
			if (!a) this.keys.set(k, (a = new ValueAcc()));
			a.add(v, at);
		}
	}
	fields(): Field[] {
		return [...this.keys.keys()].sort().map((k) => toField(k, "acf", this.keys.get(k) as ValueAcc, this.count));
	}
}

/** A field from the values seen across a type's items. */
function toField(key: string, owner: Field["owner"], a: ValueAcc | undefined, total: number, extra: Partial<Field> = {}): Field {
	const filled = a?.filled ?? 0;
	const shapes = a?.shapes ?? new Set<FieldShape>();
	const shape: FieldShape = shapes.size === 0 ? "unknown" : shapes.size === 1 ? ([...shapes][0] as FieldShape) : "mixed";
	let confidence: Confidence = shapes.size > 1 || shape === "unknown" || shape === "object" || shape === "list" ? "low" : filled === total ? "high" : "medium";
	if (owner === "acf" && confidence === "high") confidence = "medium";
	return { key, owner, shape, source: "rest", filled, total, samples: a?.sampleList() ?? [], confidence, ...extra };
}

const CORE = ["title", "content", "excerpt", "featured_media"] as const;

interface Described { at: Place; type: string; label?: string }

/** Field evidence for one type, fed a page at a time. */
class FieldsAcc {
	items = 0;
	private first?: { at: Place; keys: Set<string> };
	private readonly core = new Map<string, ValueAcc>();
	private readonly bags = { meta: new Map<string, ValueAcc>(), acf: new Map<string, ValueAcc>() };
	// Field-group plugins (ACF, Secure Custom Fields) can send `<key>_source` objects with the
	// field's label and type. The earliest one per key is kept.
	private readonly described = { meta: new Map<string, Described>(), acf: new Map<string, Described>() };
	private yoast = false;
	/** Per list page: how many items carry each Yoast title and description. */
	private readonly repeats = new WeakMap<Json[], { counts: Map<string, number>; counted: Set<string> }>();
	/** True when some list page repeated one Yoast value on several items. */
	private stuck = false;

	private readonly siteName?: string;
	constructor(siteName?: string) {
		this.siteName = siteName;
	}

	private acc(map: Map<string, ValueAcc>, k: string): ValueAcc {
		let a = map.get(k);
		if (!a) map.set(k, (a = new ValueAcc()));
		return a;
	}

	add(i: Json, at: Place, page?: Json[]): void {
		this.items++;
		if (!this.first || before(at, this.first.at)) this.first = { at, keys: new Set(CORE.filter((k) => k in i)) };
		this.acc(this.core, "post_title").add(rendered(i.title), at);
		this.acc(this.core, "post_content").add(rendered(i.content).trim(), at);
		// REST fills an empty excerpt from the content; only a different one was written.
		const content = rendered(i.content);
		const excerpt = rendered(i.excerpt).trim();
		this.acc(this.core, "post_excerpt").add(isAutoExcerpt(excerpt, content) ? "" : excerpt, at);
		this.acc(this.core, "_thumbnail_id").add(num(i.featured_media) ? String(i.featured_media) : "", at);
		for (const bag of ["meta", "acf"] as const) {
			const b = i[bag];
			if (!b || typeof b !== "object" || Array.isArray(b)) continue;
			for (const [k, v] of Object.entries(b as Json)) {
				this.acc(this.bags[bag], k).add(v, at, bag === "acf");
				if (k.endsWith("_source") && v && typeof v === "object" && typeof (v as Json).type === "string") {
					const base = k.slice(0, -"_source".length);
					const prev = this.described[bag].get(base);
					if (!prev || before(at, prev.at)) {
						const label = (v as Json).label;
						this.described[bag].set(base, { at, type: (v as Json).type as string, ...(typeof label === "string" ? { label } : {}) });
					}
				}
			}
		}
		const head = i.yoast_head_json;
		if (head && typeof head === "object") this.yoast = true;
		const h = (head && typeof head === "object" ? head : {}) as Json;
		// yoast_head_json holds Yoast's defaults when no value was set, and on some sites it
		// repeats one item's values across a whole list page. Neither counts as filled.
		const title = str(h.title) ?? "";
		const desc = str(h.description) ?? "";
		const ownTitle = rendered(i.title);
		// A value repeated on a page counts once, on the item whose own title the Yoast title starts with.
		const repeats = page ? this.pageRepeats(page) : undefined;
		const own = startsWith(wordsOf(title), wordsOf(ownTitle));
		const repeated = (k: string, v: string): boolean => {
			const key = `${k}\n${v}`;
			if (!repeats || (repeats.counts.get(key) ?? 0) <= 1) return false;
			this.stuck = true;
			if (!own || repeats.counted.has(key)) return true;
			repeats.counted.add(key);
			return false;
		};
		this.acc(this.core, "_yoast_wpseo_title").add(isDefaultSeoTitle(title, ownTitle, this.siteName) || repeated("title", title) ? "" : title, at);
		this.acc(this.core, "_yoast_wpseo_metadesc").add(isDefaultSeoDescription(desc, rendered(i.excerpt), content) || repeated("description", desc) ? "" : desc, at);
	}

	private pageRepeats(page: Json[]): { counts: Map<string, number>; counted: Set<string> } {
		const known = this.repeats.get(page);
		if (known) return known;
		const m = new Map<string, number>();
		for (const i of page) {
			const h = i.yoast_head_json;
			if (!h || typeof h !== "object") continue;
			for (const k of ["title", "description"] as const) {
				const v = str((h as Json)[k]);
				if (v) m.set(`${k}\n${v}`, (m.get(`${k}\n${v}`) ?? 0) + 1);
			}
		}
		const r = { counts: m, counted: new Set<string>() };
		this.repeats.set(page, r);
		return r;
	}

	fields(): Field[] {
		if (this.items === 0) return [];
		const total = this.items;
		const fields: Field[] = [];
		const has = (k: string): boolean => this.first?.keys.has(k) ?? false;
		const core = (k: string): ValueAcc | undefined => this.core.get(k);
		if (has("title")) fields.push(toField("post_title", "core", core("post_title"), total, { label: "Title", shape: "text" }));
		if (has("content")) fields.push(toField("post_content", "core", core("post_content"), total, { label: "Content", shape: "html" }));
		if (has("excerpt")) {
			fields.push(toField("post_excerpt", "core", core("post_excerpt"), total, {
				label: "Excerpt", shape: "html", confidence: "medium", note: "WordPress fills an empty excerpt from the start of the content. Only excerpts that differ from it are counted.",
			}));
		}
		if (has("featured_media")) fields.push(toField("_thumbnail_id", "core", core("_thumbnail_id"), total, { label: "Featured image", shape: "image" }));
		for (const owner of ["meta", "acf"] as const) {
			const map = this.bags[owner];
			for (const k of [...map.keys()].sort()) {
				if (k.startsWith("_acf")) continue; // ACF bookkeeping, not content
				const a = map.get(k) as ValueAcc;
				const base = k.slice(0, -"_source".length);
				if (k.endsWith("_source") && map.has(base) && this.described[owner].has(base)) continue;
				if (owner === "meta") {
					fields.push(toField(k, owner, a, total));
					continue;
				}
				const meta = this.described.acf.get(k);
				const shape = meta ? ACF_SHAPES[meta.type] : undefined;
				const extra: Partial<Field> = { note: meta ? `Field type "${meta.type}" as the REST API reports it.` : "Read from the acf field in REST; check the field group for the real type." };
				if (meta?.label) extra.label = meta.label;
				if (shape) extra.shape = shape;
				if (shape === "repeater") extra.subfields = a.rows?.fields() ?? [];
				fields.push(toField(k, owner, a, total, extra));
			}
		}
		if (this.yoast) {
			const note = `Read from yoast_head_json. Yoast fills it from defaults (the title and site name, the excerpt or the start of the content). Only values that differ from those are counted.${this.stuck ? " On this site the REST API repeats one item's Yoast values across each list page, so a repeated value counts once and this count is low. An export (level 2) shows the real count." : ""}`;
			fields.push(toField("_yoast_wpseo_title", "seo", core("_yoast_wpseo_title"), total, { label: "SEO title", confidence: "medium", note }));
			fields.push(toField("_yoast_wpseo_metadesc", "seo", core("_yoast_wpseo_metadesc"), total, { label: "SEO description", confidence: "medium", note }));
		}
		return fields;
	}
}

/** What the ledger, counts and permalinks need from one list item. */
interface Min { id?: number; link?: string; slug?: string; parent: number; post: number; author?: number; file?: string; status?: string; date?: string; count?: number; seq: number }

function minOf(i: Json, seq: number, withDate = false): Min {
	const m: Min = { parent: num(i.parent) ?? 0, post: num(i.post) ?? 0, seq };
	const id = num(i.id);
	if (id !== undefined) m.id = id;
	const link = str(i.link);
	if (link) m.link = link;
	const slug = str(i.slug);
	if (slug) m.slug = slug;
	const status = str(i.status);
	if (status) m.status = status;
	const count = num(i.count);
	if (count !== undefined) m.count = count;
	const author = num(i.author);
	if (author !== undefined) m.author = author;
	const file = str(i.source_url);
	if (file) m.file = file;
	if (withDate && str(i.date)) m.date = i.date as string;
	return m;
}

/** Slug paths through parents: "about/team". Undefined when an ancestor is missing. */
function paths(items: Min[]): Map<number, string> {
	const byId = new Map<number, Min>();
	for (const i of items) if (i.id !== undefined) byId.set(i.id, i);
	const out = new Map<number, string>();
	for (const [id] of byId) {
		const parts: string[] = [];
		let cur: Min | undefined = byId.get(id);
		const seen = new Set<number>();
		while (cur && !seen.has(cur.id as number)) {
			seen.add(cur.id as number);
			parts.unshift(cur.slug ?? "");
			const p = cur.parent;
			if (p === 0) break;
			cur = byId.get(p);
			if (!cur) {
				parts.length = 0;
				break;
			}
		}
		if (parts.length > 0) out.set(id, parts.join("/"));
	}
	return out;
}

const byId = (a: Min, b: Min): number => (a.id ?? 0) - (b.id ?? 0) || a.seq - b.seq;

function ledgerItems(c: Collector, t: ContentType, items: Min[]): void {
	const kind = t.slug === "post" ? "post" : t.slug === "page" ? "page" : "custom";
	const tree = t.hierarchical ? paths(items) : new Map<number, string>();
	const root = normalizeUrl(c.base.href);
	for (const i of items) {
		const { id, link, parent, slug } = i;
		if (link && t.slug === "page" && onSite(c, link) && normalizeUrl(link) === root) {
			// The front page: WordPress gives it the site root as its link.
			addUrl(c, { url: link, kind: "home", source: ["rest"], type: "page", evidence: "listed", ...(id !== undefined ? { id } : {}), ...(slug ? { slug } : {}) });
		} else if (link && onSite(c, link)) {
			addUrl(c, {
				url: link, kind, source: ["rest"], type: t.slug, evidence: "listed",
				...(id !== undefined ? { id } : {}), ...(slug ? { slug } : {}), ...(parent > 0 ? { parentId: parent } : {}),
				...(id !== undefined && tree.has(id) ? { path: tree.get(id) } : {}),
			});
		}
		if (id !== undefined) {
			const q = new URL(`?${t.slug === "page" ? "page_id" : "p"}=${id}`, c.base).href;
			if (!link || new URL(link).href !== q) addUrl(c, { url: q, kind: "query", source: ["rest"], type: t.slug, id, evidence: "listed" });
		}
	}
}

/**
 * Counts builders, shortcodes and blocks in one item's content.rendered. Usage is one
 * per item (its URL), the same unit the export and level 3 use.
 */
function scanItem(c: Collector, type: string, i: Json): void {
	if ("acf" in i) c.acf = true;
	if (!i.content || typeof i.content !== "object") return;
	const link = str(i.link);
	const id = num(i.id);
	const item = link && onSite(c, link) ? link : id !== undefined ? new URL(`?${type === "page" ? "page_id" : "p"}=${id}`, c.base).href : undefined;
	if (!item) return;
	c.contentUrls.add(normalizeUrl(item));
	const s = scanContent(rendered(i.content));
	if (s.acf) c.acf = true;
	for (const b of s.builders) addUsage(c.builders, b, item);
	for (const x of s.shortcodes) addUsage(c.shortcodes, x, item);
	for (const x of s.outputs) c.shortcodeOutputs.add(x);
	for (const x of s.blocks) addUsage(c.blocks, x, item);
}

/**
 * A field-group plugin from its trace. ACF and Secure Custom Fields leave the same
 * trace, so the entry names both, with low confidence; level 3 reads the real one.
 */
export function addFieldsPlugin(c: Collector, source: "rest" | "html"): void {
	if ([...c.plugins.values()].some((p) => p.category === "fields")) return;
	c.plugins.set("advanced-custom-fields", { slug: "advanced-custom-fields", name: "Advanced Custom Fields or Secure Custom Fields", category: "fields", source, confidence: "low" });
}

/** The site's approved comment count, from the X-WP-Total header of one comment page. */
async function readComments(fetch: SiteFetch, c: Collector, root: URL): Promise<void> {
	const r = await getJson(fetch, routePath(root, "/wp/v2/comments"), { per_page: PER_PAGE }, c.budget);
	const total = Number.parseInt(r.headers?.get("x-wp-total") ?? "", 10);
	if (r.status === 200 && Number.isFinite(total) && total >= 0) {
		c.comments = { count: total, source: "rest" };
		cover(c, "comments", "rest", "partial", `${n(total, "approved comment")} in all. The REST API shows approved comments only, and does not split them by type.`);
	} else {
		cover(c, "comments", "rest", "not-visible", `The REST API did not list comments (${r.error ?? r.capped ?? `answered ${r.status}`}).`);
	}
}

/** Pages a list, keeping only the minimal record of each item. */
async function minList(fetch: SiteFetch, c: Collector, root: URL, route: string, each?: (i: Json, at: Place, page: Json[]) => void, withDate = false): Promise<Listed & { items: Min[] }> {
	const items: Min[] = [];
	const r = await pageAll(fetch, root, route, c.budget, (page, offset) => {
		page.forEach((i, k) => {
			const m = minOf(i, offset + k, withDate);
			items.push(m);
			each?.(i, [m.id ?? 0, m.seq], page);
		});
	});
	return { ...r, items };
}

export async function readRest(fetch: SiteFetch, c: Collector, d: Discovery): Promise<void> {
	if (!d.apiRoot) {
		const home = d.homeRedirect !== undefined ? "the home page redirects to another site" : `home ${d.home?.status ?? 0}`;
		cover(c, "rest", "rest", "failed", `No REST API found (${home}; tried the Link header, the HTML link, wp-json/ and ?rest_route=/).`);
		return;
	}
	c.site.apiRoot = d.apiRoot;
	if (!d.index) {
		cover(c, "rest", "rest", "failed", `The REST API at ${d.apiRoot} answered ${d.status} to anonymous requests; types and URLs come from sitemaps and HTML.`);
		return;
	}
	const root = new URL(d.apiRoot);
	const index = d.index;
	if (str(index.name)) c.site.name = index.name as string;
	if (str(index.description)) c.site.tagline = index.description as string;
	const namespaces = Array.isArray(index.namespaces) ? (index.namespaces as unknown[]).filter((n): n is string => typeof n === "string") : [];
	for (const ns of namespaces) {
		const slug = pluginForNamespace(ns);
		if (slug) addPlugin(c, slug, "rest", "medium");
	}

	const typesRes = await getJson(fetch, routePath(root, "/wp/v2/types"));
	if (typesRes.status !== 200 || !typesRes.json || typeof typesRes.json !== "object") {
		cover(c, "rest", "rest", "failed", `The REST API answered, but its list of content types did not (${typesRes.error ?? `answered ${typesRes.status}`}).`);
		return;
	}
	c.restTypes = true;
	const taxRes = await getJson(fetch, routePath(root, "/wp/v2/taxonomies"));
	const failures: string[] = [];
	const lists = { done: 0 };

	const types = Object.entries(typesRes.json as Record<string, Json>).sort(([a], [b]) => (a < b ? -1 : 1));
	for (const [slug, info] of types) {
		const ns = str(info.rest_namespace) ?? "wp/v2";
		const base = str(info.rest_base) ?? slug;
		if (slug === "attachment") {
			const r = await minList(fetch, c, root, `/${ns}/${base}`);
			if (r.status === 200) {
				c.media = { count: r.complete ? r.count : (r.total ?? r.count), source: "rest" };
				for (const i of r.items.sort(byId)) {
					const { link, id } = i;
					if (!link || !onSite(c, link) || link.includes("/wp-content/") || id === undefined) continue;
					const parent = i.post;
					const file = i.file && /^https?:\/\//i.test(i.file) ? i.file : undefined;
					addUrl(c, { url: link, kind: "attachment", source: ["rest"], type: "attachment", id, evidence: "listed", ...(i.slug ? { slug: i.slug } : {}), ...(parent > 0 ? { parentId: parent } : {}), ...(file ? { file } : {}) });
				}
			}
			if (r.complete) lists.done++;
			else failures.push("media");
			cover(c, "type:attachment", "rest", r.complete ? "partial" : "failed", r.complete ? "Media items listed; files are not downloaded." : r.detail);
			continue;
		}
		if (SKIP_TYPES.has(slug)) continue;
		const t = typeOf(c, slug, "rest");
		if (str(info.name)) t.label = info.name as string;
		if (typeof info.hierarchical === "boolean") t.hierarchical = info.hierarchical;
		t.restBase = base;
		t.inRest = true;
		const taxes = Array.isArray(info.taxonomies) ? (info.taxonomies as string[]).filter((x) => !SKIP_TAXONOMIES.has(x)) : [];
		for (const x of taxes) if (!t.taxonomies.includes(x)) t.taxonomies.push(x);
		const acc = new FieldsAcc(c.site.name);
		const r = await minList(fetch, c, root, `/${ns}/${base}`, (i, at, page) => {
			acc.add(i, at, page);
			scanItem(c, slug, i);
		}, slug === "post");
		r.items.forEach((i) => {
			if (i.link && onSite(c, i.link)) setRank(c, i.link, i.seq);
		});
		const items = r.items.sort(byId);
		if (r.status !== 200) {
			failures.push(slug);
			cover(c, `type:${slug}`, "rest", "failed", r.detail);
			continue;
		}
		if (r.complete) {
			lists.done++;
			t.count = items.length;
			t.byStatus = {};
			for (const i of items) {
				const s = i.status ?? "publish";
				t.byStatus[s] = (t.byStatus[s] ?? 0) + 1;
			}
			cover(c, `type:${slug}`, "rest", "partial", `${n(items.length, "published item")}, every page read; drafts and private items need an export (level 2) or the password (level 3).`);
		} else {
			failures.push(slug);
			cover(c, `type:${slug}`, "rest", "partial", r.detail);
		}
		t.fields = acc.fields();
		ledgerItems(c, t, items);
		if (slug === "post") {
			for (const i of items) {
				if (i.date && /^\d{4}-\d{2}/.test(i.date)) c.months.add(i.date.slice(0, 7));
				if (i.author !== undefined) c.authorPosts.set(i.author, (c.authorPosts.get(i.author) ?? 0) + 1);
				if (i.id !== undefined) c.postIds.push(i.id);
			}
		}
		if (slug === "post" && items.length > 0) {
			const p = items[0] as Min;
			const s = guessStructure(c, p.link ?? "", { date: p.date, slug: p.slug, id: p.id });
			if (s !== undefined) c.permalinks = { structure: s, source: "rest", confidence: "medium" };
		}
	}

	if (taxRes.status === 200 && taxRes.json && typeof taxRes.json === "object") {
		for (const [slug, info] of Object.entries(taxRes.json as Record<string, Json>).sort(([a], [b]) => (a < b ? -1 : 1))) {
			if (SKIP_TAXONOMIES.has(slug)) continue;
			const tx = taxonomyOf(c, slug, "rest");
			if (str(info.name)) tx.label = info.name as string;
			if (typeof info.hierarchical === "boolean") tx.hierarchical = info.hierarchical;
			for (const ty of Array.isArray(info.types) ? (info.types as string[]) : []) if (!tx.types.includes(ty)) tx.types.push(ty);
			const ns = str(info.rest_namespace) ?? "wp/v2";
			const r = await minList(fetch, c, root, `/${ns}/${str(info.rest_base) ?? slug}`);
			if (r.status !== 200 || !r.complete) {
				failures.push(`taxonomy ${slug}`);
				cover(c, `taxonomy:${slug}`, "rest", r.status === 200 ? "partial" : "failed", r.detail);
				if (r.status !== 200) continue;
			} else {
				tx.count = r.count;
				cover(c, `taxonomy:${slug}`, "rest", "complete", `${n(r.count, "term")}.`);
				lists.done++;
			}
			const items = r.items.sort(byId);
			const tree = tx.hierarchical ? paths(items) : new Map<number, string>();
			const kind = slug === "category" ? "category" : slug === "post_tag" ? "tag" : "term";
			for (const i of items) {
				const { link, id, parent } = i;
				if (link && onSite(c, link)) {
					addUrl(c, {
						url: link, kind, source: ["rest"], taxonomy: slug, evidence: "listed",
						...(id !== undefined ? { termId: id } : {}), ...(i.slug ? { slug: i.slug } : {}), ...(i.count !== undefined ? { count: i.count } : {}),
						...(parent > 0 ? { parentId: parent, ...(id !== undefined && tree.has(id) ? { path: tree.get(id) } : {}) } : {}),
					});
				}
				// Short links WordPress answers for every term: ?cat=<id>, ?tag=<slug>. With plain
				// permalinks they are the term's own link, already added above.
				if (id !== undefined && slug === "category") addUrl(c, { url: new URL(`?cat=${id}`, c.base).href, kind: "query", source: ["rest"], taxonomy: slug, termId: id, evidence: "listed" });
				if (id !== undefined && slug === "post_tag" && i.slug) addUrl(c, { url: new URL(`?tag=${encodeURIComponent(i.slug)}`, c.base).href, kind: "query", source: ["rest"], taxonomy: slug, termId: id, slug: i.slug, evidence: "listed" });
			}
		}
	} else {
		failures.push("taxonomies");
	}

	if (c.acf) addFieldsPlugin(c, "rest");

	const users = await minList(fetch, c, root, "/wp/v2/users");
	if (users.status === 200) {
		if (users.complete) lists.done++;
		else failures.push("users");
		c.authors = { count: users.complete ? users.count : (users.total ?? users.count), source: "rest" };
		for (const u of users.items.sort(byId)) {
			const link = u.link;
			if (link && onSite(c, link)) {
				addUrl(c, { url: link, kind: "author", source: ["rest"], evidence: "listed", ...(u.slug ? { slug: u.slug } : {}) });
				if (u.id !== undefined && c.authorPosts.has(u.id)) c.authorCounts.set(normalizeUrl(link), c.authorPosts.get(u.id) as number);
			}
			// ?author=<id> answers too. No `id` on the entry: that field is a post ID.
			if (u.id !== undefined && u.slug) addUrl(c, { url: new URL(`?author=${u.id}`, c.base).href, kind: "query", source: ["rest"], slug: u.slug, evidence: "listed" });
		}
		cover(c, "users", "rest", "partial", "Only authors with published posts are listed. User counts by role need the password (level 3).");
	} else {
		failures.push("users");
		cover(c, "users", "rest", "failed", users.detail);
	}
	await readComments(fetch, c, root);
	if (c.dropped > 0) failures.push(`the ledger cap of ${c.maxUrls} URLs (${c.dropped} not kept)`);

	const status = failures.length === 0 ? "complete" : "partial";
	const detail = `Read ${n(lists.done, "content list")} to the end.${failures.length ? ` Could not read in full: ${failures.join(", ")}.` : ""}`;
	cover(c, "rest", "rest", status, detail);
}
