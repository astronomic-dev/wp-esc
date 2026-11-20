// Level 2: what a WordPress export file (WXR) carries.
//
// Streams the file once and keeps only running counts, so memory stays flat:
// - types and every status (plumbing types are left out). Plugin and site data types
//   (INTERNAL_TYPES) are counted with their statuses, but their fields and content are
//   not read and they get no URLs,
// - fields from post meta and ACF (see meta.ts and acf.ts), with fill counts and samples,
// - shortcodes and block comments in raw content, Elementor usage,
// - menus from nav_menu_item posts (items numbered 1…N in menu order), Navigation blocks
//   from published wp_navigation posts (kind "block", see navigation.ts), taxonomies and
//   terms, author and media counts,
// - the titles and statuses of drafts, private and pending items (at most
//   MAX_UNPUBLISHED_PER_TYPE per type),
// - the URL ledger for published items (each <link>, its ?p= or ?page_id= form, and a
//   query-style <guid> when it differs). A link keeps its type's kind (post, page,
//   attachment, custom) even when it is a plain ?p= link; only the extra forms are "query".
//   Attachments carry their upload file URL and a parent: post_parent, or else the first
//   published post that uses them as _thumbnail_id,
// - plugins the export shows by their own post types, and storedElsewhere for those
//   that keep data outside the export.
// - comment counts per type, and how many wait for approval (only the counts; no comment
//   text, names or emails). Only approved and waiting comments count, not spam or trash,
//   the same two the level 3 reader counts.
// Never kept: author names, logins and emails, comment contents, Flamingo messages, form settings.

import type { ContentType, Coverage, Field, Inventory, Menu, MenuItem, Plugin, Taxonomy, UrlEntry, UrlKind } from "../../contracts/inventory.ts";
import { canonical } from "../../contracts/write.ts";
import { normalizeUrl } from "../../contracts/url.ts";
import { DATA_IN_EXPORT } from "../../contracts/merge.ts";
import { PLUGINS } from "../public/plugins-map.ts";
import { AcfSettings, AcfValues, acfFields } from "./acf.ts";
import { UsageCounter, scanContent } from "./content.ts";
import { CORE_LABELS, addValue, inferShape, inferredConfidence, isPlumbing, isSparse, labelOf, newStats, ownerOf, sparseNote, type ValueStats } from "./meta.ts";
import { blockMenu, type NavPage } from "./navigation.ts";
import { MAX_UNPUBLISHED_PER_TYPE } from "../limits.ts";
import { streamWxrChunks, streamWxrFile, type WxrChannel, type WxrItem, type WxrLimits, type WxrStreamResult, type WxrTerm } from "./stream.ts";

/** Types that are site plumbing, not content, and not counted. */
const PLUMBING_TYPES = new Set([
	"attachment", "nav_menu_item", "revision", "custom_css", "customize_changeset", "oembed_cache", "user_request",
	"wp_block", "wp_font_family", "wp_font_face",
]);
/** Site data types WordPress or a fields plugin owns: counted, never read as content. */
const SITE_DATA_TYPES = new Set([
	"wp_template", "wp_template_part", "wp_navigation", "wp_global_styles",
	"acf-field", "acf-field-group", "acf-post-type", "acf-taxonomy", "acf-ui-options-page",
]);
/** Types a plugin owns. They show the plugin; their posts are not content. */
const PLUGIN_TYPES: Record<string, string> = {
	wpcf7_contact_form: "contact-form-7",
	flamingo_contact: "flamingo", flamingo_inbound: "flamingo", flamingo_outbound: "flamingo",
	elementor_library: "elementor", "e-floating-buttons": "elementor", "e-landing-page": "elementor",
	shop_order: "woocommerce", shop_order_refund: "woocommerce", shop_coupon: "woocommerce", shop_webhook: "woocommerce",
	memberpressproduct: "memberpress", memberpressgroup: "memberpress", memberpressrule: "memberpress", "mp-reminder": "memberpress",
	wpforms: "wpforms", "wpforms-log": "wpforms",
};
/** What the type line says about a data type the export holds. */
const DATA_NOTES: Record<string, string> = {
	flamingo_inbound: "These are Contact Form 7 messages. They are in this export file, but EmDash does not import them. Keep the file if you need them.",
};
/** Content types that also show a plugin. */
const PLUGIN_CONTENT_TYPES: Record<string, string> = { product: "woocommerce", product_variation: "woocommerce", download: "easy-digital-downloads" };
const SKIP_TAXONOMIES = new Set(["nav_menu", "link_category", "post_format", "wp_pattern_category", "wp_theme", "wp_template_part_area"]);
const LISTED_STATUSES = new Set(["publish"]);
/** Statuses whose titles the `unpublished` list keeps. */
export const UNPUBLISHED_STATUSES = new Set(["draft", "private", "pending"]);
const STATUS_WORDS: Record<string, string> = { publish: "published", future: "scheduled", pending: "pending", draft: "draft", private: "private", trash: "in the trash" };

interface TypeAcc {
	slug: string;
	total: number;
	comments: number;
	pendingComments: number;
	unpublished: { title: string; status: string }[];
	byStatus: Record<string, number>;
	withParent: number;
	taxonomies: Set<string>;
	core: Map<string, ValueStats>;
	meta: Map<string, ValueStats>;
	acf: AcfValues;
}

interface NavItem { id: number; title: string; order: number; parent: number; kind: string; object: string; objectId: number; url: string; menu: string }
interface PostRef { type: string; title: string; link: string; slug: string; parent: number; order: number; published: boolean; file?: string }
interface InternalAcc { total: number; byStatus: Record<string, number> }

const n = (count: number, one: string, many = `${one}s`): string => `${count} ${count === 1 ? one : many}`;

function newType(slug: string): TypeAcc {
	return { slug, total: 0, comments: 0, pendingComments: 0, unpublished: [], byStatus: {}, withParent: 0, taxonomies: new Set(), core: new Map(), meta: new Map(), acf: new AcfValues() };
}

function stat(map: Map<string, ValueStats>, key: string): ValueStats {
	let s = map.get(key);
	if (!s) map.set(key, (s = newStats()));
	return s;
}

/** The site URL with one trailing slash. */
function siteUrlOf(c: WxrChannel): string {
	const base = (c.baseBlogUrl || c.baseSiteUrl || "").trim();
	return base.endsWith("/") ? base : `${base}/`;
}

function originOf(url: string): string | undefined {
	try {
		return new URL(url).origin;
	} catch {
		return undefined;
	}
}

export class WxrReader {
	private readonly types = new Map<string, TypeAcc>();
	private readonly internal = new Map<string, InternalAcc>();
	/** Attachment ID to the first published post that uses it as its featured image. */
	private readonly thumbOf = new Map<number, number>();
	private readonly acf = new AcfSettings();
	private readonly terms = new Map<string, WxrTerm>(); // `${taxonomy} ${id or slug}`
	private readonly termTypes = new Map<string, Set<string>>();
	private readonly posts = new Map<number, PostRef>();
	private readonly nav: NavItem[] = [];
	/** Published wp_navigation posts: title and raw content. */
	private readonly blockNav: { title: string; content: string }[] = [];
	private readonly shortcodes = new UsageCounter();
	private readonly blocks = new UsageCounter();
	private readonly builders = new UsageCounter();
	private readonly plugins = new Set<string>();
	private readonly structures = new Map<string, number>();
	private readonly datedPosts: { link: string; date: string; slug: string; id: number }[] = [];
	private authors = 0;
	private media = 0;
	private channel: WxrChannel = {};

	author(): void {
		this.authors++;
	}

	term(t: WxrTerm): void {
		const key = `${t.taxonomy} ${t.id ?? t.slug}`;
		if (!this.terms.has(key)) this.terms.set(key, t);
	}

	item(item: WxrItem): void {
		const type = item.type;
		if (type === "attachment") {
			this.media++;
			if (item.status === "inherit" || item.status === "publish") {
				const ref: PostRef = { type, title: item.title, link: item.link, slug: item.name, parent: item.parent, order: item.menuOrder, published: true };
				if (item.attachmentUrl) ref.file = item.attachmentUrl;
				this.posts.set(item.id, ref);
			}
			return;
		}
		if (type === "nav_menu_item") return this.navItem(item);
		if (type === "acf-field" || type === "acf-field-group") this.acf.addItem(item);
		const plugin = PLUGIN_TYPES[type];
		if (plugin) this.plugins.add(plugin);
		if (plugin || SITE_DATA_TYPES.has(type)) return this.internalItem(item);
		if (PLUMBING_TYPES.has(type) || !type) return;
		if (PLUGIN_CONTENT_TYPES[type]) this.plugins.add(PLUGIN_CONTENT_TYPES[type] as string);
		this.contentItem(item);
	}

	private navItem(item: WxrItem): void {
		const m = new Map(item.meta.map((x) => [x.key, x.value]));
		const menu = item.terms.find((t) => t.domain === "nav_menu")?.slug ?? "";
		this.nav.push({
			id: item.id, title: item.title, order: item.menuOrder, parent: Number(m.get("_menu_item_menu_item_parent") ?? 0) || 0,
			kind: m.get("_menu_item_type") ?? "", object: m.get("_menu_item_object") ?? "", objectId: Number(m.get("_menu_item_object_id") ?? 0) || 0,
			url: m.get("_menu_item_url") ?? "", menu,
		});
	}

	private internalItem(item: WxrItem): void {
		let t = this.internal.get(item.type);
		if (!t) this.internal.set(item.type, (t = { total: 0, byStatus: {} }));
		t.total++;
		const status = item.status || "publish";
		t.byStatus[status] = (t.byStatus[status] ?? 0) + 1;
		if (item.type === "wp_navigation" && status === "publish") this.blockNav.push({ title: item.title, content: item.content });
	}

	private contentItem(item: WxrItem): void {
		let t = this.types.get(item.type);
		if (!t) this.types.set(item.type, (t = newType(item.type)));
		t.total++;
		t.comments += item.comments;
		t.pendingComments += item.pendingComments;
		const status = item.status || "publish";
		t.byStatus[status] = (t.byStatus[status] ?? 0) + 1;
		if (UNPUBLISHED_STATUSES.has(status) && t.unpublished.length < MAX_UNPUBLISHED_PER_TYPE) t.unpublished.push({ title: item.title.trim() || "(no title)", status });
		if (item.parent) t.withParent++;
		for (const term of item.terms) {
			if (SKIP_TAXONOMIES.has(term.domain)) continue;
			t.taxonomies.add(term.domain);
			let types = this.termTypes.get(term.domain);
			if (!types) this.termTypes.set(term.domain, (types = new Set()));
			types.add(item.type);
		}
		const published = LISTED_STATUSES.has(status);
		this.posts.set(item.id, { type: item.type, title: item.title, link: item.link, slug: item.name, parent: item.parent, order: item.menuOrder, published });
		if (published && item.type === "post") this.datedPosts.push({ link: item.link, date: item.date, slug: item.name, id: item.id });

		addValue(stat(t.core, "post_title"), item.title);
		addValue(stat(t.core, "post_content"), item.content);
		addValue(stat(t.core, "post_excerpt"), item.excerpt);
		const scan = scanContent(item.content);

		const values = new Map<string, string>();
		for (const m of item.meta) values.set(m.key, m.value);
		// ACF: `_name` holding `field_...` next to `name` ties the value to a field.
		const refs = new Map<string, string>();
		for (const [k, v] of values) {
			if (k.startsWith("_") && /^field_[A-Za-z0-9_]+$/.test(v.trim()) && values.has(k.slice(1))) refs.set(k.slice(1), v.trim());
		}
		let elementor = false;
		for (const [k, v] of values) {
			if (k === "_elementor_edit_mode") elementor ||= v.trim() === "builder";
			if (k === "_elementor_data") {
				if (v.trim() !== "" && v.trim() !== "[]") elementor = true;
				scanContent(v.replaceAll("\\/", "/"), scan);
			}
			if (k.startsWith("_") && refs.has(k.slice(1))) continue;
			const ref = refs.get(k);
			if (ref) {
				t.acf.add(ref, k, v);
				continue;
			}
			if (isPlumbing(k) || k.startsWith("_acf")) continue;
			if (k === "_thumbnail_id" && published) {
				const att = Number.parseInt(v, 10);
				if (Number.isInteger(att) && att > 0 && !this.thumbOf.has(att)) this.thumbOf.set(att, item.id);
			}
			if (k.startsWith("_yoast_wpseo_")) this.plugins.add("wordpress-seo");
			else if (k.startsWith("rank_math_")) this.plugins.add("seo-by-rank-math");
			addValue(stat(k === "_thumbnail_id" || k === "_wp_page_template" ? t.core : t.meta, k), v);
		}
		const sample = published ? item.link : undefined;
		if (elementor) {
			this.builders.add(["elementor"], sample);
			this.plugins.add("elementor");
		}
		this.shortcodes.add(scan.shortcodes, sample);
		this.blocks.add(scan.blocks, sample);
	}

	setChannel(c: WxrChannel): void {
		this.channel = c;
	}

	// --- Output -----------------------------------------------------------------------

	private coreFields(t: TypeAcc): Field[] {
		const out: Field[] = [];
		for (const [key, s] of t.core) {
			if (s.filled === 0 && key !== "post_title" && key !== "post_content") continue;
			const shape = key === "post_content" ? "html" : key === "_thumbnail_id" ? "image" : "text";
			const f: Field = { key, owner: "core", shape, source: "wxr", filled: s.filled, total: t.total, samples: s.samples, confidence: "high" };
			const label = CORE_LABELS[key];
			if (label) f.label = label;
			out.push(f);
		}
		return out;
	}

	private metaFields(t: TypeAcc): Field[] {
		const out: Field[] = [];
		for (const [key, s] of t.meta) {
			const shape = inferShape(s);
			const f: Field = { key, owner: ownerOf(key), shape, source: "wxr", filled: s.filled, total: t.total, samples: s.samples, confidence: inferredConfidence(shape, s.filled, t.total) };
			const label = labelOf(key);
			if (label) f.label = label;
			const notes: string[] = [];
			if (isSparse(s.filled, t.total)) notes.push(sparseNote(s.filled, t.total));
			if (shape === "mixed") notes.push("Values have more than one shape.");
			if (shape === "serialized") notes.push("Values are PHP serialized data.");
			if (notes.length) f.note = notes.join(" ");
			out.push(f);
		}
		return out;
	}

	private typesOut(): ContentType[] {
		const internal = [...this.internal].map(([slug, t]): ContentType => ({ slug, count: t.total, byStatus: t.byStatus, fields: [], taxonomies: [], sources: ["wxr"] }));
		return [...internal, ...[...this.types.values()].map((t) => {
			const type: ContentType = {
				slug: t.slug,
				count: t.total,
				byStatus: t.byStatus,
				fields: [...this.coreFields(t), ...acfFields(t.slug, this.acf, t.acf, t.total), ...this.metaFields(t)],
				taxonomies: [...t.taxonomies],
				sources: ["wxr"],
			};
			if (t.unpublished.length) type.unpublished = t.unpublished;
			if (t.slug === "page") type.hierarchical = true;
			else if (t.slug === "post") type.hierarchical = false;
			else if (t.withParent > 0) type.hierarchical = true;
			return type;
		})];
	}

	private taxonomiesOut(): Taxonomy[] {
		const out = new Map<string, Taxonomy>();
		const get = (slug: string): Taxonomy => {
			let t = out.get(slug);
			if (!t) out.set(slug, (t = { slug, count: 0, types: [...(this.termTypes.get(slug) ?? [])], sources: ["wxr"] }));
			return t;
		};
		for (const term of this.terms.values()) {
			if (SKIP_TAXONOMIES.has(term.taxonomy)) continue;
			const t = get(term.taxonomy);
			t.count = (t.count ?? 0) + 1;
			if (term.parent) t.hierarchical = true;
		}
		for (const slug of this.termTypes.keys()) get(slug);
		for (const t of out.values()) {
			if (t.slug === "category") t.hierarchical = true;
			if (t.slug === "post_tag") t.hierarchical = false;
		}
		return [...out.values()];
	}

	private kindOf(type: string): UrlKind {
		return type === "post" ? "post" : type === "page" ? "page" : type === "attachment" ? "attachment" : "custom";
	}

	private pathOf(id: number): string {
		const parts: string[] = [];
		const seen = new Set<number>();
		for (let cur = id; cur && !seen.has(cur); ) {
			seen.add(cur);
			const p = this.posts.get(cur);
			if (!p) break;
			parts.unshift(p.slug);
			cur = p.parent;
		}
		return parts.join("/");
	}

	private urlsOut(siteUrl: string): UrlEntry[] {
		const origin = originOf(siteUrl);
		const out: UrlEntry[] = [];
		const home = siteUrl.replace(/\/$/, "");
		for (const [id, p] of this.posts) {
			if (!p.published || !p.link || originOf(p.link) !== origin) continue;
			// A plain-permalink link (?page_id=16) is still the page itself: it keeps the
			// type's kind, its slug and path, so the kind does not change between levels.
			const kind: UrlKind = p.link.replace(/\/$/, "") === home ? "home" : this.kindOf(p.type);
			const entry: UrlEntry = { url: p.link, kind, source: ["wxr"], type: p.type, id, evidence: "listed" };
			if (p.slug) entry.slug = p.slug;
			if (p.type === "attachment") {
				if (p.file) entry.file = p.file;
				const parent = p.parent && this.posts.has(p.parent) ? p.parent : this.thumbOf.get(id);
				if (parent) entry.parentId = parent;
			} else if (this.types.get(p.type)?.withParent) {
				if (p.parent && this.posts.has(p.parent)) entry.parentId = p.parent;
				entry.path = this.pathOf(id);
			}
			out.push(entry);
			// WordPress answers ?p=ID (?page_id=ID for pages) for every public item; the
			// redirect plan needs these, and REST cannot list types it does not show.
			// When the link is that form already, the dedupe in finish() keeps the link.
			if (p.type !== "attachment") {
				const q = new URL(`?${p.type === "page" ? "page_id" : "p"}=${id}`, siteUrl).href;
				out.push({ url: q, kind: "query", source: ["wxr"], type: p.type, id, evidence: "listed" });
			}
		}
		return out;
	}

	private guidUrls(siteUrl: string, guids: Map<number, string>): UrlEntry[] {
		const origin = originOf(siteUrl);
		const out: UrlEntry[] = [];
		for (const [id, guid] of guids) {
			const p = this.posts.get(id);
			if (!p?.published || p.type === "attachment" || guid === p.link || !guid.includes("?") || originOf(guid) !== origin) continue;
			out.push({ url: guid, kind: "query", source: ["wxr"], type: p.type, id, evidence: "listed" });
		}
		return out;
	}

	private menusOut(siteUrl: string): Menu[] {
		const byMenu = new Map<string, NavItem[]>();
		for (const i of this.nav) {
			const list = byMenu.get(i.menu) ?? [];
			list.push(i);
			byMenu.set(i.menu, list);
		}
		const termBy = (tax: string, id: number): WxrTerm | undefined => this.terms.get(`${tax} ${id}`);
		const out: Menu[] = [];
		for (const [slug, items] of byMenu) {
			const term = [...this.terms.values()].find((t) => t.taxonomy === "nav_menu" && t.slug === slug);
			const menu: Menu = { name: term?.name ?? slug, kind: "classic", items: [], source: "wxr" };
			if (term?.id) menu.id = term.id;
			// WordPress menu_order can skip numbers (0, 2, 3, 4); every item is kept and
			// numbered 1…N in that order.
			const sorted = [...items].sort((a, b) => a.order - b.order || a.id - b.id);
			for (const [k, i] of sorted.entries()) {
				const item: MenuItem = { id: i.id, title: i.title, url: i.url, order: k + 1 };
				if (i.parent) item.parent = i.parent;
				if (i.kind === "post_type") {
					const p = this.posts.get(i.objectId);
					item.target = { kind: this.kindOf(i.object), type: i.object, id: i.objectId };
					if (p) {
						if (!item.url) item.url = p.link;
						if (!item.title) item.title = p.title;
					}
				} else if (i.kind === "post_type_archive") {
					item.target = { kind: "archive", type: i.object };
					if (!item.url) item.url = `${siteUrl}?post_type=${encodeURIComponent(i.object)}`;
				} else if (i.kind === "taxonomy") {
					const kind: UrlKind = i.object === "category" ? "category" : i.object === "post_tag" ? "tag" : "term";
					item.target = { kind, type: i.object, id: i.objectId };
					const t = termBy(i.object, i.objectId);
					if (!item.title && t?.name) item.title = t.name;
					if (!item.url) {
						item.url = kind === "category" ? `${siteUrl}?cat=${i.objectId}` : t ? `${siteUrl}?${kind === "tag" ? "tag" : encodeURIComponent(i.object)}=${encodeURIComponent(t.slug)}` : siteUrl;
					}
				}
				if (!item.url) item.url = siteUrl;
				menu.items.push(item);
			}
			out.push(menu);
		}
		const pages = this.pages();
		for (const b of this.blockNav) out.push(blockMenu(b.title || "Navigation", b.content, siteUrl, pages, "wxr"));
		return out;
	}

	/** Published pages, for a page-list block. */
	private pages(): NavPage[] {
		const out: NavPage[] = [];
		for (const [id, p] of this.posts) if (p.type === "page" && p.published && p.link) out.push({ id, title: p.title, link: p.link, parent: p.parent, order: p.order });
		return out;
	}

	private permalinks(siteUrl: string): Inventory["permalinks"] {
		const counts = new Map<string, number>();
		for (const p of this.datedPosts) {
			const s = structureOf(siteUrl, p);
			if (s !== undefined) counts.set(s, (counts.get(s) ?? 0) + 1);
		}
		const best = [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0];
		if (!best) return { source: "wxr", confidence: "low" };
		const share = best[1] / this.datedPosts.length;
		return { structure: best[0], source: "wxr", confidence: share >= 0.9 ? "medium" : "low" };
	}

	private pluginsOut(): Plugin[] {
		return [...this.plugins].map((slug) => {
			const info = PLUGINS[slug];
			const p: Plugin = { slug, category: info?.category ?? "other", source: "wxr", confidence: "medium" };
			if (info?.name) p.name = info.name;
			return p;
		});
	}

	finish(stream: WxrStreamResult, guids: Map<number, string>): Inventory {
		this.acf.link();
		const c = this.channel;
		const siteUrl = siteUrlOf(c);
		const coverage: Coverage[] = [];
		const missing = "Media files, site options, users and plugin tables are not in the export.";
		const mb = (chars: number): string => `${Math.round(chars / (1024 * 1024))} MB`;
		const cut = stream.cut
			? ` ${n(stream.cut, "value")} longer than ${mb(stream.limits.maxValueChars)} (or past ${mb(stream.limits.maxItemChars)} in one item) ${stream.cut === 1 ? "was" : "were"} cut; shortcodes, blocks and samples past the cut are not counted.`
			: "";
		if (stream.doctype) {
			coverage.push({ area: "wxr", source: "wxr", status: "failed", detail: "This export has a DOCTYPE, which WordPress never writes; the file was not read." });
		} else if (stream.errors.length) {
			const read = stream.stopped ? `Stopped there after ${n(stream.items, "item")}.` : `Read ${n(stream.items, "item")}.`;
			coverage.push({ area: "wxr", source: "wxr", status: "partial", detail: `The export did not parse cleanly (${stream.errors[0]}). ${read}${cut} ${missing}` });
		} else if (cut) {
			coverage.push({ area: "wxr", source: "wxr", status: "partial", detail: `Read the export: ${n(stream.items, "item")}, ${n(stream.meta, "meta row")}.${cut} ${missing}` });
		} else {
			coverage.push({ area: "wxr", source: "wxr", status: "complete", detail: `Read the export: ${n(stream.items, "item")}, ${n(stream.meta, "meta row")}. ${missing}` });
		}
		// One line per content type and for menus, so a merge can tell they were read.
		const whole = coverage[0]?.status === "complete" ? "complete" : "partial";
		for (const t of this.types.values()) {
			const statuses = Object.entries(t.byStatus).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([k, v]) => `${v} ${STATUS_WORDS[k] ?? k}`).join(", ");
			coverage.push({ area: `type:${t.slug}`, source: "wxr", status: whole, detail: `${n(t.total, "item")} in the export, every status (${statuses}), with their fields.` });
		}
		for (const [slug, t] of this.internal) {
			const statuses = Object.entries(t.byStatus).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([k, v]) => `${v} ${STATUS_WORDS[k] ?? k}`).join(", ");
			const note = DATA_NOTES[slug] ?? "This is plugin or site data, not content; only the count is kept.";
			coverage.push({ area: `type:${slug}`, source: "wxr", status: whole, detail: `${n(t.total, "item")} in the export (${statuses}). ${note}` });
		}
		const byType: Record<string, number> = {};
		let comments = 0;
		let pending = 0;
		for (const t of this.types.values()) {
			pending += t.pendingComments;
			if (t.comments === 0) continue;
			byType[t.slug] = t.comments;
			comments += t.comments;
		}
		const split = Object.entries(byType).sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, v]) => `${k} ${v}`).join(", ");
		const comment = whole === "complete"
			? comments ? `${n(comments, "comment")} in the export (${split}). ${pendingNote(pending)}Commenter names and emails are not read.` : "No comments in the export."
			: `${n(comments, "comment")} read before the export stopped, so no count is given.`;
		coverage.push({ area: "comments", source: "wxr", status: whole, detail: comment });
		if (this.nav.length || this.blockNav.length) {
			const parts: string[] = [];
			if (this.nav.length) parts.push(`Read ${n(new Set(this.nav.map((i) => i.menu)).size, "menu")} with ${n(this.nav.length, "item")}. Menu locations are not in the export.`);
			if (this.blockNav.length) parts.push(navNote(this.menusOut(siteUrl).filter((m) => m.kind === "block")));
			coverage.push({ area: "menus", source: "wxr", status: "partial", detail: parts.join(" ") });
		}
		if (this.acf.size > 0) {
			const groups = this.internal.get("acf-field-group")?.total ?? 0;
			const fields = this.internal.get("acf-field")?.total ?? 0;
			coverage.push({ area: "acf", source: "wxr", status: whole, detail: `Read the custom field settings in the export (${n(groups, "field group")}, ${n(fields, "field")}). Field types come from these settings.` });
		} else if (this.types.size && [...this.types.values()].some((t) => t.acf.stats.size)) {
			coverage.push({ area: "acf", source: "wxr", status: "partial", detail: "Custom field values are in the export but their settings are not (they are defined in code); field types are guessed." });
		}
		const site: Inventory["site"] = { url: siteUrl, locales: [] };
		if (c.title) site.name = c.title;
		if (c.description) site.tagline = c.description;
		const version = /[?&]v=([\w.-]+)/.exec(c.generator ?? "")?.[1];
		if (version) site.wpVersion = version;
		if (c.language) site.locales.push({ code: c.language, default: true });
		const plugins = this.pluginsOut();
		const inv: Inventory = {
			version: 1,
			site,
			levels: [2],
			coverage,
			types: this.typesOut(),
			taxonomies: this.taxonomiesOut(),
			plugins,
			builders: this.builders.list(),
			shortcodes: this.shortcodes.list(),
			blocks: this.blocks.list(),
			menus: this.menusOut(siteUrl),
			// Counts only from a whole read: a cut or rejected file would undercount.
			...(whole === "complete"
				? {
					authors: { count: this.authors, source: "wxr" as const },
					media: { count: this.media, source: "wxr" as const },
					comments: { count: comments, source: "wxr" as const, ...(comments ? { byType } : {}), ...(pending ? { pending } : {}) },
				}
				: {}),
			permalinks: this.permalinks(siteUrl),
			urls: [...this.urlsOut(siteUrl), ...this.guidUrls(siteUrl, guids)],
			// A plugin whose data this export holds as a post type stores nothing elsewhere.
			storedElsewhere: plugins.flatMap((p) => (PLUGINS[p.slug]?.stores && !this.internal.has(DATA_IN_EXPORT[p.slug] ?? "") ? [{ plugin: p.slug, what: PLUGINS[p.slug]?.stores as string }] : [])),
		};
		// One ledger entry per canonical URL: the first (link) wins over a guid alias.
		const seen = new Set<string>();
		inv.urls = inv.urls.filter((u) => {
			const key = normalizeUrl(u.url);
			return seen.has(key) ? false : (seen.add(key), true);
		});
		return canonical("inventory", inv);
	}
}

/** The comments line's sentence on comments that wait for approval, with a trailing space; "" when none. */
export function pendingNote(pending: number): string {
	if (!pending) return "";
	return `${n(pending, "comment")} ${pending === 1 ? "waits" : "wait"} for approval; level 1 sees approved comments only. `;
}

/** The menus line's sentence on Navigation blocks read. */
export function navNote(menus: Menu[]): string {
	const one = (m: Menu): string => `"${m.name}" (${n(m.items.length, "link")})`;
	return `Read ${n(menus.length, "Navigation block")}: ${menus.map(one).join(", ")}.`;
}

/** The permalink structure one published post's link shows, relative to the site URL. */
function structureOf(siteUrl: string, p: { link: string; date: string; slug: string; id: number }): string | undefined {
	if (!p.link.startsWith(siteUrl.replace(/\/$/, ""))) return undefined;
	const rest = p.link.slice(siteUrl.replace(/\/$/, "").length);
	if (/^\/?(\?|index\.php\?)p=\d+/.test(rest)) return "";
	const [y, mo, d] = p.date.split(/[- ]/);
	const parts = rest.split("/").map((seg, i, all) => {
		if (seg === "" && (i === 0 || i === all.length - 1)) return seg;
		if (seg === p.slug) return "%postname%";
		if (seg === String(p.id)) return "%post_id%";
		if (seg === y) return "%year%";
		if (seg === mo) return "%monthnum%";
		if (seg === d) return "%day%";
		return seg;
	});
	const s = parts.join("/");
	return s.includes("%postname%") || s.includes("%post_id%") ? s : undefined;
}

async function run(feed: (r: WxrReader, guids: Map<number, string>) => Promise<WxrStreamResult>): Promise<Inventory> {
	const reader = new WxrReader();
	const guids = new Map<number, string>();
	const result = await feed(reader, guids);
	return reader.finish(result, guids);
}

function handlers(r: WxrReader, guids: Map<number, string>) {
	return {
		channel: (c: WxrChannel) => r.setChannel(c),
		author: () => r.author(),
		term: (t: WxrTerm) => r.term(t),
		item: (i: WxrItem) => {
			if (i.guid && i.guid !== i.link && i.guid.includes("?") && i.status === "publish") guids.set(i.id, i.guid);
			r.item(i);
		},
	};
}

/** Reads a WXR export file into a level 2 inventory. */
export function readWxr(file: string, limits: Partial<WxrLimits> = {}): Promise<Inventory> {
	return run((r, g) => streamWxrFile(file, handlers(r, g), limits));
}

/** Reads WXR text arriving in chunks (for tests and pipes). */
export function readWxrChunks(chunks: AsyncIterable<string>, limits: Partial<WxrLimits> = {}): Promise<Inventory> {
	return run((r, g) => streamWxrChunks(chunks, handlers(r, g), limits));
}
