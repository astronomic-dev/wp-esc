// Reads page HTML: the home page plus up to 3 pages per type, 30 pages at most. Finds plugins
// from /wp-content/plugins/<slug>/ asset paths and SEO plugin comments, the theme from
// /wp-content/themes/<slug>/, page builders from their markup, shortcodes left
// unrendered in visible text, block classes, the generator tag and the page language.
// Pages that answer 200 mark their ledger URL `resolved`; feed, paging and date archive
// links on the site are added as `linked`.
// A sampled page (not the root) with body class "blog" is the posts page: kind "archive",
// type "post". Post type archives are found by readArchives (one request per custom type).

import { parse, walkSync, ELEMENT_NODE, TEXT_NODE } from "ultrahtml";
import type { SiteFetch } from "../../contracts/fetch.ts";
import type { UrlEntry } from "../../contracts/inventory.ts";
import { normalizeUrl } from "../../contracts/url.ts";
import type { Collector } from "./collect.ts";
import { addPlugin, addUrl, addUsage, cover, onSite, relPath, setLocale } from "./collect.ts";
import type { Discovery } from "./discover.ts";
import { addFieldsPlugin, soft } from "./rest.ts";

const n = (count: number, one: string): string => `${count} ${count === 1 ? one : `${one}s`}`;

export const PER_TYPE = 3;
export const MAX_PAGES = 30;

const BUILDERS: [string, RegExp][] = [
	["elementor", /\bdata-elementor-type=|class=["'][^"'<>]{0,2048}?\belementor-\d+\b/],
	["divi", /\bet_pb_(?:section|row|module|column)\b/],
	["beaver-builder", /\bfl-builder-content\b/],
	["wpbakery", /\bvc_row\b|\bwpb_wrapper\b/],
	["oxygen", /\bct-section\b|\boxy-[a-z-]+\b/],
	["bricks", /\bbrxe-[a-z]/],
	["breakdance", /\bbde-[a-z]/],
	["brizy", /\bbrz-section\b/],
	["siteorigin", /\bpanel-layout\b|\bso-panel\b/],
];

const SEO_COMMENTS: [string, RegExp][] = [
	["wordpress-seo", /optimized with the Yoast SEO/i],
	["seo-by-rank-math", /Search Engine Optimization by Rank Math/i],
	["all-in-one-seo-pack", /All in One SEO/i],
];

/** Core blocks whose wrapper carries a wp-block-<name> class. */
const CORE_BLOCKS = new Set(
	("archives audio avatar button buttons calendar categories code column columns comment-author-name comment-content " +
		"comment-date comment-edit-link comment-reply-link comment-template comments comments-pagination comments-title cover " +
		"details embed file footnotes gallery group heading home-link image latest-comments latest-posts list list-item loginout " +
		"media-text navigation navigation-link navigation-submenu page-list page-list-item paragraph post-author " +
		"post-author-name post-author-biography post-comments-form post-content post-date post-excerpt post-featured-image " +
		"post-navigation-link post-template post-terms post-title preformatted pullquote query query-no-results " +
		"query-pagination query-pagination-next query-pagination-numbers query-pagination-previous query-title quote " +
		"read-more rss search separator site-logo site-tagline site-title social-link social-links spacer table tag-cloud " +
		"template-part term-description verse video").split(" "),
);

/** wp-block-<x> classes that name another block (old class names). */
const CLASS_BLOCKS: Record<string, string> = { "comments-query-loop": "core/comments" };
/** wp-block-<x> classes on parts inside a block, not on a block of their own. */
const NOT_BLOCKS = new Set(["post", "navigation-item"]);

const NO_SHORTCODE_IN = new Set(["script", "style", "pre", "code", "textarea", "noscript", "template"]);

/**
 * The block name a wp-block-<x> class stands for. Only known core blocks map: a class
 * can also be a part inside a block (wp-block-query-pagination-next-arrow), and a plugin
 * block's class does not say where its namespace ends. Those give undefined.
 */
export function blockName(cls: string): string | undefined {
	const m = /^wp-block-([a-z0-9-]+)$/.exec(cls);
	if (!m || cls.includes("-is-layout-")) return undefined;
	const name = m[1] as string;
	if (NOT_BLOCKS.has(name)) return undefined;
	return CLASS_BLOCKS[name] ?? (CORE_BLOCKS.has(name) ? `core/${name}` : undefined);
}

/** Builder, shortcode and block names in one item's rendered content. `outputs`: shortcodes seen only from what they print. */
export interface ContentScan { builders: string[]; shortcodes: string[]; blocks: string[]; acf: boolean; outputs: string[] }

/**
 * Shortcodes WordPress has already run in rendered content, known from the HTML they
 * print: a class name on a wrapper element.
 */
function shortcodeOutput(classes: string[]): string | undefined {
	if (classes.includes("wpcf7")) return "contact-form-7";
	if (classes.includes("gallery") && classes.some((x) => x.startsWith("galleryid-"))) return "gallery";
	if (classes.includes("wp-audio-shortcode")) return "audio";
	if (classes.includes("wp-video") || classes.includes("wp-video-shortcode")) return "video";
	if (classes.includes("wp-playlist")) return "playlist";
	return undefined;
}

/** How much of one item's content withoutShortcodeOutput reads, and how many wrappers it checks. */
const MAX_OUTPUT_SCAN = 100_000;
const MAX_OUTPUT_WRAPPERS = 50;
const OUTPUT_OPEN = /<([a-z][a-z0-9]*)\b[^<>]*?\bclass\s*=\s*["']([^"'<>]*)["'][^<>]*>/gi;

/**
 * Rendered HTML with the output of known shortcodes (a form, a gallery, a player) cut
 * out: each wrapper element that shortcodeOutput names, with everything inside it. A
 * wrapper with no matching close tag is left in. Used to compare content with an excerpt,
 * which WordPress makes after stripping shortcodes.
 */
export function withoutShortcodeOutput(content: string): string {
	// Callers compare only the start of the content, so a long or hostile body is cut first,
	// and at most MAX_OUTPUT_WRAPPERS wrappers are looked at. Each closeOf scan is linear, so this stays bounded.
	const html = content.slice(0, MAX_OUTPUT_SCAN);
	if (!html.includes("class")) return html;
	let out = "";
	let at = 0;
	let seen = 0;
	OUTPUT_OPEN.lastIndex = 0;
	for (let m = OUTPUT_OPEN.exec(html); m; m = OUTPUT_OPEN.exec(html)) {
		if (!shortcodeOutput((m[2] as string).split(/\s+/))) continue;
		if (++seen > MAX_OUTPUT_WRAPPERS) break;
		const end = closeOf(html, (m[1] as string).toLowerCase(), m.index + m[0].length);
		if (end === -1) continue;
		out += `${html.slice(at, m.index)} `;
		at = end;
		OUTPUT_OPEN.lastIndex = end;
	}
	return out + html.slice(at);
}

/** The index just past the close tag that matches an element named `name` opened before `from`; -1 when none. */
function closeOf(html: string, name: string, from: number): number {
	const re = new RegExp(`<(/?)${name}\\b[^<>]*>`, "gi");
	re.lastIndex = from;
	let depth = 1;
	for (let m = re.exec(html); m; m = re.exec(html)) {
		if (m[1]) depth--;
		else if (!m[0].endsWith("/>")) depth++;
		if (depth === 0) return m.index + m[0].length;
	}
	return -1;
}

const SHORTCODE = /\[([a-z][a-z0-9_-]*)(?:\s[^[\]]*)?\/?\](?!\()/g;
const NO_SHORTCODE_OPEN = /<(script|style|pre|code|textarea|noscript|template)\b/gi;

/** The text of rendered HTML outside script, style, pre, code and the like, with tags removed. Linear. */
function visibleText(html: string): string {
	const lower = html.toLowerCase();
	let out = "";
	let at = 0;
	NO_SHORTCODE_OPEN.lastIndex = 0;
	for (let m = NO_SHORTCODE_OPEN.exec(html); m; m = NO_SHORTCODE_OPEN.exec(html)) {
		if (m.index < at) continue;
		out += `${html.slice(at, m.index)} `;
		const close = lower.indexOf(`</${(m[1] as string).toLowerCase()}`, m.index + m[0].length);
		if (close === -1) {
			at = html.length;
			break;
		}
		at = close;
		NO_SHORTCODE_OPEN.lastIndex = close + 2;
	}
	out += html.slice(at);
	return out.replace(/<[^<>]*>/g, " ");
}
const ACF_MARKUP = /\bclass\s*=\s*["'][^"'<>]{0,2048}?\bacf-(?:block|field)\b/;

/**
 * Scans one item's rendered content (REST content.rendered). Pure and regex-only, so it
 * stays cheap over every item a site lists. Shortcodes count only in visible text, as in
 * scanHtml.
 */
export function scanContent(html: string): ContentScan {
	const builders = BUILDERS.filter(([, re]) => re.test(html)).map(([name]) => name);
	const blocks = new Set<string>();
	const outputs = new Set<string>();
	if (html.includes("class")) {
		for (const m of html.matchAll(/\bclass\s*=\s*["']([^"']*)["']/g)) {
			const classes = (m[1] as string).split(/\s+/);
			for (const cls of classes) {
				const b = blockName(cls);
				if (b) blocks.add(b);
			}
			const out = shortcodeOutput(classes);
			if (out) outputs.add(out);
		}
	}
	const shortcodes = new Set<string>();
	if (html.includes("[")) {
		for (const m of visibleText(html).matchAll(SHORTCODE)) shortcodes.add(m[1] as string);
	}
	const seen = [...outputs].filter((x) => !shortcodes.has(x)).sort();
	for (const x of seen) shortcodes.add(x);
	return { builders, shortcodes: [...shortcodes].sort(), blocks: [...blocks].sort(), acf: ACF_MARKUP.test(html), outputs: seen };
}

export interface HtmlScan {
	plugins: string[];
	themes: Map<string, number>;
	wpVersion?: string;
	lang?: string;
	builders: string[];
	shortcodes: string[];
	blocks: string[];
	links: string[];
	/** The <body> classes WordPress writes (body_class), in order. */
	bodyClasses: string[];
}

/** True when a URL token is relative or on `origin` (absolute or protocol-relative). */
function onOrigin(token: string, origin: string | undefined): boolean {
	const m = /^(?:(https?:)?\/\/)([^/]+)/i.exec(token);
	if (!m) return !/^[a-z][a-z0-9+.-]*:/i.test(token); // relative path
	if (!origin) return false;
	const o = new URL(origin);
	try {
		return new URL(m[1] ? token : `${o.protocol}${token}`).origin === o.origin;
	} catch {
		return false;
	}
}

const DELIMITERS = new Set([..." \t\n\r\f\"'()<>,="]);
const MAX_PREFIX = 2048;

/**
 * wp-content/<dir>/<slug>/ paths in the HTML that are relative or on the site's origin.
 * The literal path is matched first; its URL prefix runs back to the nearest delimiter,
 * at most 2,048 characters. Each character is checked for a delimiter once, so a long
 * run of text cannot make it slow.
 */
function contentSlugs(html: string, dir: "plugins" | "themes", origin: string | undefined): string[] {
	const out: string[] = [];
	const re = dir === "plugins" ? /\/wp-content\/plugins\/([A-Za-z0-9_.-]+)\//g : /\/wp-content\/themes\/([A-Za-z0-9_.-]+)\//g;
	let scanned = 0; // text before this index has been checked for delimiters
	let lastDelim = -1;
	for (const m of html.matchAll(re)) {
		const end = m.index;
		for (let i = Math.max(scanned, end - MAX_PREFIX); i < end; i++) if (DELIMITERS.has(html[i] as string)) lastDelim = i;
		scanned = Math.max(scanned, end);
		const start = Math.max(lastDelim + 1, end - MAX_PREFIX);
		if (onOrigin(`${html.slice(start, end)}/`, origin)) out.push((m[1] as string).toLowerCase());
	}
	return out;
}

/**
 * Scans one page of HTML. Pure: no requests. Plugin and theme paths count only when
 * relative or on `origin` (the site's own origin), so a CDN or another site does not.
 */
export function scanHtml(html: string, origin?: string): HtmlScan {
	const plugins = new Set<string>(contentSlugs(html, "plugins", origin));
	for (const [slug, re] of SEO_COMMENTS) if (re.test(html)) plugins.add(slug);
	const themes = new Map<string, number>();
	for (const t of contentSlugs(html, "themes", origin)) themes.set(t, (themes.get(t) ?? 0) + 1);
	const builders = BUILDERS.filter(([, re]) => re.test(html)).map(([name]) => name);

	const shortcodes = new Set<string>();
	const blocks = new Set<string>();
	const links: string[] = [];
	let bodyClasses: string[] = [];
	let wpVersion: string | undefined;
	let lang: string | undefined;
	const doc = parse(html);
	walkSync(doc, (node, parent) => {
		if (node.type === ELEMENT_NODE) {
			const a = node.attributes as Record<string, string>;
			if (node.name === "html" && a.lang) lang = a.lang;
			if (node.name === "body" && a.class) bodyClasses = a.class.split(/\s+/).filter(Boolean);
			if (node.name === "meta" && a.name?.toLowerCase() === "generator") {
				const m = /^WordPress\s+([\d.]+)/i.exec(a.content ?? "");
				if (m) wpVersion = m[1];
			}
			if ((node.name === "a" || node.name === "link") && a.href) links.push(a.href.replaceAll("&amp;", "&"));
			for (const cls of (a.class ?? "").split(/\s+/)) {
				const b = blockName(cls);
				if (b) blocks.add(b);
			}
			return;
		}
		if (node.type !== TEXT_NODE) return;
		for (let p = parent as { name?: string; parent?: unknown } | undefined; p; p = p.parent as typeof p) {
			if (p.name && NO_SHORTCODE_IN.has(p.name)) return;
		}
		for (const m of String(node.value).matchAll(SHORTCODE)) shortcodes.add(m[1] as string);
	});
	return {
		plugins: [...plugins].sort(),
		themes,
		...(wpVersion ? { wpVersion } : {}),
		...(lang ? { lang } : {}),
		builders,
		shortcodes: [...shortcodes].sort(),
		blocks: [...blocks].sort(),
		links,
		bodyClasses,
	};
}

/** The page ID of a static front page, from the home page's body classes. */
export function frontPageId(classes: string[]): number | undefined {
	if (!classes.includes("home") || !classes.includes("page")) return undefined;
	for (const cls of classes) {
		const m = /^page-id-(\d+)$/.exec(cls);
		if (m) return Number(m[1]);
	}
	return undefined;
}

/** True when body_class names the post type: single-<type>, or "page" for a page. */
export function showsType(classes: string[], type: string): boolean {
	return classes.includes(`single-${type}`) || (type === "page" && classes.includes("page"));
}

function linkedKind(c: Collector, href: string): UrlEntry["kind"] | undefined {
	const u = onSite(c, href);
	if (!u) return undefined;
	if (u.searchParams.has("feed")) return "feed";
	if (u.searchParams.has("paged")) return "paged";
	const rel = relPath(c, u.href);
	if (rel === undefined) return undefined;
	if (/(^|\/)feed$/.test(rel)) return "feed";
	if (/(^|\/)page\/\d+$/.test(rel)) return "paged";
	if (/^\d{4}(\/\d{2}(\/\d{2})?)?$/.test(rel)) return "date";
	return undefined;
}

const joinNames = (xs: string[]): string => (xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/**
 * Post type archives. When every ledger entry of a custom type sits under one first path
 * segment (/team/<slug>/), that segment is fetched once. A 200 whose body class names the
 * type's archive (post-type-archive-<type>) adds it as kind "archive". One request per type.
 */
async function readArchives(fetch: SiteFetch, c: Collector): Promise<void> {
	const byType = new Map<string, UrlEntry[]>();
	for (const e of c.urls.values()) {
		if (e.kind !== "custom" || !e.type) continue;
		const list = byType.get(e.type) ?? [];
		list.push(e);
		byType.set(e.type, list);
	}
	for (const [type, entries] of [...byType].sort(([a], [b]) => (a < b ? -1 : 1))) {
		const firsts = new Set<string>();
		let slash = true;
		for (const e of entries) {
			const rel = relPath(c, e.url);
			const segs = rel === undefined ? [] : rel.split("/");
			if (segs.length < 2) {
				firsts.clear();
				break;
			}
			firsts.add(segs[0] as string);
			if (!e.url.endsWith("/")) slash = false;
		}
		if (firsts.size !== 1) continue;
		const url = new URL(`${[...firsts][0]}${slash ? "/" : ""}`, c.base);
		const prev = c.urls.get(normalizeUrl(url.href));
		if (prev && prev.kind !== "other" && prev.kind !== "archive") continue;
		let res;
		try {
			res = await fetch(url.pathname);
		} catch (e) {
			if (soft(e)) continue;
			throw e;
		}
		if (res.status !== 200 || normalizeUrl(res.url) !== normalizeUrl(url.href)) continue;
		const scan = scanHtml(await res.text(), c.origin);
		if (!scan.bodyClasses.includes(`post-type-archive-${type}`)) continue;
		addUrl(c, { url: url.href, kind: "archive", type, source: ["html"], evidence: "resolved" });
	}
}

/**
 * The pages to read: up to 3 per type, in the order the REST list gave them (newest
 * first), else sitemap order, then by URL.
 */
function choosePages(c: Collector, home: string): string[] {
	const out: string[] = [];
	const entries = [...c.urls.values()].filter((u) => u.type && (u.kind === "post" || u.kind === "page" || u.kind === "custom") && u.url !== home);
	for (const slug of [...c.types.keys()].sort()) {
		const mine = entries
			.filter((u) => u.type === slug)
			.sort((a, b) => (c.rank.get(a.url) ?? Infinity) - (c.rank.get(b.url) ?? Infinity) || (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
		for (const u of mine.slice(0, PER_TYPE)) {
			if (out.length >= MAX_PAGES - 1) return out;
			out.push(u.url);
		}
	}
	return out;
}

export async function readHtml(fetch: SiteFetch, c: Collector, d: Discovery): Promise<void> {
	const home = normalizeUrl(c.base.href);
	const themes = new Map<string, number>();
	let read = 0;
	let tried = 0;
	const take = (pageUrl: string, html: string): HtmlScan => {
		read++;
		const s = scanHtml(html, c.origin);
		for (const p of s.plugins) addPlugin(c, p, "html", "high");
		for (const [t, n] of s.themes) themes.set(t, (themes.get(t) ?? 0) + n);
		if (s.wpVersion && !c.site.wpVersion) c.site.wpVersion = s.wpVersion;
		if (s.lang) setLocale(c, s.lang);
		// When REST gave the content, usage comes from there, one per item, and theme
		// template parts on the sampled pages do not count. A page whose content REST did
		// not give (a type outside REST) still counts from its HTML.
		const fromContent = c.contentUrls.size > 0;
		if (!c.contentUrls.has(normalizeUrl(pageUrl)) && !(fromContent && pageUrl === home)) {
			for (const b of s.builders) addUsage(c.builders, b, pageUrl);
			for (const x of s.shortcodes) addUsage(c.shortcodes, x, pageUrl);
			if (!fromContent) for (const x of s.blocks) addUsage(c.blocks, x, pageUrl);
		}
		if (ACF_MARKUP.test(html)) c.acf = true;
		for (const href of s.links) {
			const kind = linkedKind(c, href);
			const u = kind ? onSite(c, href) : undefined;
			if (kind && u) addUrl(c, { url: u.href, kind, source: ["html"], evidence: "linked" });
		}
		return s;
	};

	tried++;
	if (d.home && d.home.status === 200) {
		const scan = take(home, d.home.html);
		const entry: UrlEntry = { url: home, kind: "home", source: ["html"], evidence: normalizeUrl(d.home.url) === home ? "resolved" : "listed" };
		// A static front page: body_class gives "home page page-id-<id>". A list of posts gives "home blog".
		const front = frontPageId(scan.bodyClasses);
		c.homeLists = scan.bodyClasses.includes("home") && scan.bodyClasses.includes("blog");
		if (front !== undefined) Object.assign(entry, { type: "page", id: front });
		addUrl(c, entry);
	}
	for (const pageUrl of choosePages(c, home)) {
		const u = new URL(pageUrl);
		tried++;
		let res;
		try {
			res = await fetch(u.pathname + u.search);
		} catch (e) {
			if (soft(e)) continue;
			throw e;
		}
		if (res.status !== 200) continue;
		const html = await res.text();
		const entry = c.urls.get(pageUrl);
		const scan = take(pageUrl, html);
		if (entry && normalizeUrl(res.url) === pageUrl) {
			addUrl(c, { ...entry, source: ["html"], evidence: "resolved" });
			// A page that is not the root with body class "blog" is the posts page (Settings > Reading).
			if (entry.kind === "page" && scan.bodyClasses.includes("blog") && !scan.bodyClasses.includes("home")) {
				entry.kind = "archive";
				entry.type = "post";
			}
			// The page's own body classes must name the type for HTML to count as a source.
			const t = entry.type ? c.types.get(entry.type) : undefined;
			if (t && showsType(scan.bodyClasses, t.slug) && !t.sources.includes("html")) t.sources.push("html");
		}
	}

	await readArchives(fetch, c);

	if (c.acf) addFieldsPlugin(c, "html");
	const theme = [...themes].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0];
	if (theme) c.site.theme = theme[0];
	if (read === 0) {
		cover(c, "html", "html", "failed", `No page answered 200 (tried ${tried}).`);
	} else {
		const seen = [...c.shortcodeOutputs].sort();
		const outputs = seen.length === 0 ? "" : ` ${joinNames(seen)} ${seen.length === 1 ? "was" : "were each"} seen from its output.`;
		const usage = c.contentUrls.size > 0
			? `Builders, shortcodes and blocks are counted from the REST content of ${n(c.contentUrls.size, "item")}, not from this sample. WordPress has already run the shortcodes in that content, so level 1 sees only the ones it can spot from their output; an export shows them all.${outputs}`
			: "Builders, shortcodes and blocks come from this sample only, so blocks from the theme's templates count too.";
		cover(c, "html", "html", "partial", `Read a sample of ${n(read, "page")}${read < tried ? ` (${tried} tried)` : ""}: the home page and up to ${PER_TYPE} pages of each type, at most ${MAX_PAGES}. Pages outside the sample are not read. ${usage}`);
	}
	cover(c, "plugins", "html", "partial", "Found from asset paths, SEO comments and what the REST API offers only; plugins with no front-end trace do not show. The full list needs the password (level 3).");
	cover(c, "menus", "html", "not-visible", "Menus are not read at level 1; names, items and locations need level 2 or 3.");
	cover(c, "settings", "html", "not-visible", "Site settings need the password (level 3).");
}
