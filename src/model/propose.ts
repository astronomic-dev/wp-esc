// inventory.json -> model.json: the proposed content model, mapped from WordPress.
//
// Names follow EmDash's WordPress importer, so its import finds the collections and
// fields it expects and shows each post type as Ready. The rules come from EmDash 1.4.0:
//   node_modules/emdash/src/import/utils.ts mapPostTypeToCollection, used by both the
//     WXR analysis (astro/routes/api/import/wordpress/analyze.ts) and the Exporter-plugin
//     analysis (import/sources/wordpress-plugin.ts): a fixed map (post -> posts, page ->
//     pages, product -> products, testimonial -> testimonials, event -> events, faq ->
//     faqs; portfolio and team stay), else sanitizeCollectionSlug(postType): lowercase,
//     every char outside [a-z0-9_] becomes "_", leading non-letters dropped, empty gives
//     "imported", reserved collection slugs get "wp_". The Exporter-plugin analysis does
//     not number repeats (only the WXR analysis does), and the import screen has no way to
//     pick another collection, so two post types with one slug import into one
//     collection: the model merges them (mergeRepeats).
//   node_modules/emdash/src/import/utils.ts
//     BASE_REQUIRED_FIELDS (title, content, excerpt) and FEATURED_IMAGE_FIELD, which the
//     analysis requires of every collection; sanitizeFieldSlug for custom field slugs;
//     isInternalMetaKey and isPluginBookkeepingMeta for the keys it never imports.
//   node_modules/emdash/src/import/wxr-taxonomies.ts: post_tag becomes "tag".
//   node_modules/emdash/src/schema/types.ts: RESERVED_COLLECTION_SLUGS,
//     RESERVED_FIELD_SLUGS, REPEATER_SUB_FIELD_TYPES.
//
// Low-confidence fields are optional, take a loose type, and carry `check`.
// `check` notes hold for every target. Where the EmDash seed differs (field types the
// import asks for, optional fields, flat repeater rows, /{slug} for nested pages), the
// seed step writes the notes to seed/emdash-steps.md (seed.ts seedNotes), since only
// it knows which evidence (inventory or --emdash-analyze) typed the seed.

import type { Field, Inventory, Locale, Menu, MenuItem, UrlEntry } from "../contracts/inventory.ts";
import { MODEL_VERSION, type Collection, type CollectionSupport, type Model, type ModelField, type ModelFieldType, type ModelMenu, type ModelMenuItem, type ModelTaxonomy, type Route } from "../contracts/model.ts";
import { canonical } from "../contracts/write.ts";
import { normalizeUrl } from "../contracts/url.ts";

// --- EmDash names -------------------------------------------------------------------

const POST_TYPE_TO_COLLECTION: Record<string, string> = {
	post: "posts",
	page: "pages",
	attachment: "media",
	product: "products",
	portfolio: "portfolio",
	testimonial: "testimonials",
	team: "team",
	event: "events",
	faq: "faqs",
};

// WordPress's own bookkeeping types: never content, so the model drops them without a word.
export const INTERNAL_POST_TYPES = ["revision", "nav_menu_item", "custom_css", "customize_changeset", "oembed_cache", "attachment", "user_request"];
// Types that hold plugin, builder, theme or editor data, not site content. The inventory
// counts them; the model leaves them out and names them in a "Left out" note.
export const PLUGIN_POST_TYPES = [
	"wp_block", "wp_global_styles", "wp_navigation", "wp_template", "wp_template_part", "wp_font_family", "wp_font_face",
	"acf-field-group", "acf-field", "acf-post-type", "acf-taxonomy", "acf-ui-options-page",
	"elementor_library", "e-floating-buttons", "e-landing-page", "elementor_font", "elementor_icons", "elementor_snippet",
	"wpcf7_contact_form", "flamingo_inbound", "flamingo_contact", "flamingo_outbound",
	"wpforms", "wpforms_log", "fl-builder-template", "fl-theme-layout", "et_pb_layout", "et_template", "et_header_layout", "et_body_layout", "et_footer_layout",
	"ct_template", "bricks_template", "oceanwp_library", "astra-advanced-hook", "jet-engine", "jet-theme-core", "jet-menu", "shop_order", "shop_order_refund", "shop_coupon", "shop_webhook", "product_variation", "scheduled-action",
];
const PLUGIN_POST_TYPE_PREFIXES = ["acf-", "elementor_", "flamingo_", "wpcf7", "wpforms", "fl-builder", "et_", "jet-", "wp_", "shop_", "wc_", "woocommerce_", "memberpress", "mepr-", "mpcs-"];

/** Does this post type hold plugin, builder, theme or editor data rather than site content? */
export function isPluginPostType(slug: string): boolean {
	return PLUGIN_POST_TYPES.includes(slug) || PLUGIN_POST_TYPE_PREFIXES.some((p) => slug.startsWith(p));
}
export const RESERVED_COLLECTION_SLUGS = ["content", "media", "users", "revisions", "taxonomies", "options", "audit_logs", "reorder", "relations"];
export const RESERVED_FIELD_SLUGS = ["id", "slug", "status", "author_id", "primary_byline_id", "created_at", "updated_at", "published_at", "scheduled_at", "deleted_at", "version", "live_revision_id", "draft_revision_id", "terms", "bylines", "byline"];
export const REPEATER_SUB_FIELD_TYPES: ModelFieldType[] = ["string", "text", "url", "number", "integer", "boolean", "datetime", "select", "image"];

const INTERNAL_META_KEYS = ["_edit_last", "_edit_lock", "_pingme", "_encloseme"];
const INTERNAL_META_PREFIXES = ["_edit_", "_wp_"];
const PLUGIN_META_PREFIXES = ["aawp_", "algolia_", "amazon_polly_", "ampforwp_", "classifai_", "essb_", "eg_", "gnpub_", "jetpack_", "mashsb_", "monsterinsights_", "onesignal_", "penci_", "perfmatters_", "pys_", "rank_math_", "rp4wp_", "saswp_", "sbg_", "snap_", "spay_", "tie_", "wl_", "wpil_", "wprm_", "wpswa_", "wpuf_", "yarpp_"];
const PLUGIN_META_KEYS = ["entity_same_as", "exclude_from_search", "footnotes", "inline_featured_image", "os_meta", "thirstydata"];
const SEO_KEYS = ["_yoast_wpseo_title", "_yoast_wpseo_metadesc", "_yoast_wpseo_focuskw", "_rank_math_title", "_rank_math_description", "_rank_math_focus_keyword"];

/** The collection EmDash's importer suggests for a WordPress post type (mapPostTypeToCollection). */
export function collectionSlugFor(postType: string): string {
	const mapped = POST_TYPE_TO_COLLECTION[postType];
	if (mapped) return mapped;
	const s = postType.toLowerCase().replace(/[^a-z0-9_]/g, "_").replace(/^[^a-z]+/, "");
	if (!s) return "imported";
	return RESERVED_COLLECTION_SLUGS.includes(s) ? `wp_${s}` : s;
}

/** The field slug EmDash's importer makes from a meta or ACF key. */
export function fieldSlugFor(key: string): string {
	const s = key.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^[^a-z]+/, "").slice(0, 63);
	if (!s) return "field";
	return RESERVED_FIELD_SLUGS.includes(s) ? `wp_${s}` : s;
}

/** The EmDash taxonomy name for a WordPress taxonomy. */
export function taxonomySlugFor(taxonomy: string): string {
	return taxonomy === "post_tag" ? "tag" : taxonomy;
}

/** Keys EmDash's importer never turns into fields: internal meta and plugin bookkeeping. */
export function isPlumbingKey(key: string): boolean {
	if (key === "_thumbnail_id") return false;
	if (INTERNAL_META_KEYS.includes(key)) return true;
	if (INTERNAL_META_PREFIXES.some((p) => key.startsWith(p))) return true;
	if (key.startsWith("_yoast_") || key.startsWith("_rank_math_")) return !SEO_KEYS.includes(key);
	if (key.startsWith("_")) return true;
	const normalized = key.replaceAll("-", "_");
	return PLUGIN_META_KEYS.includes(normalized) || PLUGIN_META_PREFIXES.some((p) => normalized.startsWith(p));
}

// --- Small helpers -------------------------------------------------------------------

const capitalize = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
// Words whose plural is the word itself, for a guessed label: "Team" -> "Team member".
const COLLECTIVE: Record<string, string> = { team: "Team member", staff: "Staff member", crew: "Crew member", faculty: "Faculty member", people: "Person", news: "News item", media: "Media item" };
// Words that end in s but are not plurals (or are their own singular): "News", "Series", "Status".
const NOT_PLURAL = /(news|series|species|ss|us|is)$/i;
const singularize = (s: string): string => (NOT_PLURAL.test(s) ? s : s.endsWith("ies") ? `${s.slice(0, -3)}y` : s.endsWith("s") ? s.slice(0, -1) : s);
const labelFromKey = (key: string): string => capitalize(key.split(/[_-]+/).filter(Boolean).join(" "));
const byKey = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// --- URL patterns ----------------------------------------------------------------------

interface Site {
	origin: string;
	base: string; // the site's path, with a trailing slash
	prefixes: Map<string, string>; // locale code -> URL prefix
	trailing: boolean;
}

function siteOf(inv: Inventory): Site {
	const url = new URL(inv.site.url);
	const base = url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`;
	const prefixes = new Map<string, string>();
	for (const l of inv.site.locales) if (l.prefix) prefixes.set(l.code, l.prefix);
	const paths = inv.urls.filter((u) => u.kind !== "query").map((u) => new URL(u.url).pathname).filter((p) => p !== base);
	const trailing = paths.length === 0 || paths.filter((p) => p.endsWith("/")).length * 2 >= paths.length;
	return { origin: url.origin, base, prefixes, trailing };
}

/** The entry's path inside the site, without the base path or a locale prefix: `service/bookkeeping/`. */
function relPath(site: Site, entry: { url: string; locale?: string }): string | undefined {
	const url = new URL(entry.url);
	if (url.origin !== site.origin || url.search || !url.pathname.startsWith(site.base)) return undefined;
	let p = url.pathname.slice(site.base.length);
	const prefix = entry.locale ? site.prefixes.get(entry.locale) : undefined;
	if (prefix && (p === prefix || p.startsWith(`${prefix}/`))) p = p.slice(prefix.length).replace(/^\//, "");
	return p;
}

/** The one pattern every entry fits, or undefined. Hierarchical lists prefer {path}. */
function inferPattern(site: Site, entries: UrlEntry[], hierarchical: boolean): string | undefined {
	let common: Set<string> | undefined;
	for (const e of entries) {
		const p = relPath(site, e);
		// The site root is the home page, whatever page it shows: it never sets a pattern.
		if (p === undefined || p === "" || !e.slug) continue;
		const slash = p.endsWith("/") ? "/" : "";
		const bare = slash ? p.slice(0, -1) : p;
		const found = new Set<string>();
		if (bare === e.slug || bare.endsWith(`/${e.slug}`)) found.add(`/${bare.slice(0, bare.length - e.slug.length)}{slug}${slash}`);
		const path = e.path ?? e.slug;
		if (bare === path || bare.endsWith(`/${path}`)) found.add(`/${bare.slice(0, bare.length - path.length)}{path}${slash}`);
		common = common ? new Set([...common].filter((x) => found.has(x))) : found;
	}
	if (!common || common.size === 0) return undefined;
	const list = [...common].sort(byKey);
	const pick = hierarchical ? (list.find((x) => x.includes("{path}")) ?? list[0]) : (list.find((x) => x.includes("{slug}")) ?? list[0]);
	return pick;
}

// WordPress permalink tags (wp-includes/class-wp-rewrite.php rewritecode), as regexes.
const PERMALINK_TAGS: Record<string, string> = {
	"%year%": "\\d{4}",
	"%monthnum%": "\\d{2}",
	"%day%": "\\d{2}",
	"%hour%": "\\d{2}",
	"%minute%": "\\d{2}",
	"%second%": "\\d{2}",
	"%post_id%": "\\d+",
	"%category%": "[^?#]+",
	"%author%": "[^/]+",
};
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Does every entry's URL fit the permalink structure, with its own slug for %postname%? */
function fitsStructure(site: Site, entries: UrlEntry[], structure: string | undefined): boolean {
	if (!structure || !structure.includes("%postname%")) return false;
	let seen = 0;
	for (const e of entries) {
		const p = relPath(site, e);
		if (p === undefined || p === "" || !e.slug) continue;
		const slug = e.slug;
		const re = structure
			.replace(/^\//, "")
			.replace(/\/$/, "")
			.split(/(%[a-z_]+%)/)
			.map((part) => (part === "%postname%" ? escapeRe(slug) : (PERMALINK_TAGS[part] ?? escapeRe(part))))
			.join("");
		if (!new RegExp(`^${re}/?$`).test(p)) return false;
		seen++;
	}
	return seen > 0;
}

const fill = (pattern: string, slug: string, path: string): string => pattern.replace("{slug}", slug).replace("{path}", path);

// --- Fields ------------------------------------------------------------------------------

const LOOSE_SHAPES = new Set(["relation", "list", "object", "repeater", "flexible", "serialized", "mixed", "unknown"]);

interface FieldContext {
	multilingual: number; // locale count when more than one
	collectionOf: (postType: string) => string;
	inRepeater: boolean;
}

function scalarType(f: Field, loose: boolean): ModelFieldType {
	switch (f.shape) {
		case "text":
			if (f.options?.length) return "select";
			return f.samples.some((s) => s.includes("\n") || s.length > 200) ? "text" : "string";
		case "html":
			return "text";
		case "number":
			if (loose) return "string";
			return f.samples.every((s) => /^-?\d+$/.test(s.trim())) ? "integer" : "number";
		case "boolean":
			return loose ? "string" : "boolean";
		case "date":
			return loose ? "string" : "datetime";
		case "url":
			return loose ? "string" : "url";
		case "email":
			return "string";
		case "image":
			return "image";
		case "file":
			return "file";
		default:
			return "json";
	}
}

// One rule for every field's fill rate: none filled, or fewer than half.
function fillNote(filled: number, total: number): string | undefined {
	if (total <= 0) return undefined;
	if (filled === 0) return "No entry has one. Remove it?";
	if (filled * 2 < total) return `Filled on ${filled} of ${total}. Keep it?`;
	return undefined;
}

// The REST API returns WordPress's computed defaults for excerpts and SEO fields, so a
// level 1 count can be higher than what was written by hand.
const LEVEL1_DEFAULTS = "Level 1 counts can be high: WordPress fills these from defaults.";
const fromRest = (f: Field): boolean => f.source === "rest" || f.source === "html";

/** The check note for the excerpt or an SEO field: the fill rule, and the level 1 warning when REST gave the count. */
function filledCheck(f: Field, extra?: string): string | undefined {
	const fill = fillNote(f.filled, f.total);
	const count = fill ?? (fromRest(f) && f.total > 0 ? `Filled on ${f.filled} of ${f.total}.` : undefined);
	const parts = [count, fill && extra ? extra : undefined, fromRest(f) ? LEVEL1_DEFAULTS : undefined].filter(Boolean);
	return parts.length ? parts.join(" ") : undefined;
}

function checkFor(f: Field, ctx: FieldContext): string[] {
	const reasons: string[] = [];
	const targets = (f.targets ?? []).map(ctx.collectionOf);
	switch (f.shape) {
		case "relation":
			reasons.push(`Values are WordPress post IDs${targets.length ? `; relink to ${targets.join(", ")} entries after import` : "; relink them after import"}.`);
			break;
		case "repeater":
			reasons.push("A repeater; check the rows after import.");
			break;
		case "flexible": {
			const names = (f.layouts ?? []).map((l) => l.name);
			reasons.push(`Flexible content${names.length ? ` (${names.join(", ")})` : ""}; EmDash blocks are not set up in v1, so this stays loose JSON.`);
			break;
		}
		case "serialized":
			reasons.push("Stored as serialized PHP; check the values after import.");
			break;
		case "mixed":
			reasons.push("Values have mixed types; kept loose.");
			break;
		case "list":
		case "object":
			reasons.push("A list or object value; kept as loose JSON.");
			break;
		case "unknown":
			reasons.push("The samples do not show the value's shape; kept as loose JSON.");
			break;
		case "html":
			reasons.push("Holds HTML; it stays raw markup after import.");
			break;
	}
	const fill = fillNote(f.filled, f.total);
	if (fill) reasons.push(fill);
	if (f.confidence === "low" && f.note && !reasons.some((r) => r === f.note)) {
		if (!(f.shape === "relation" && /post IDs/i.test(f.note)) && !(f.shape === "flexible" && /flexible/i.test(f.note)) && !/^(Filled on|No entry has one)/.test(f.note)) reasons.push(f.note);
	}
	if (f.confidence === "low" && reasons.length === 0) reasons.push("Low confidence in the inferred type.");
	if (ctx.multilingual > 1 && f.owner !== "core") reasons.push(`The site has ${ctx.multilingual} languages; check this field in each.`);
	return reasons;
}

function toField(f: Field, ctx: FieldContext): ModelField {
	const reasons = checkFor(f, ctx);
	const low = f.confidence === "low" || LOOSE_SHAPES.has(f.shape) || f.shape === "html" || reasons.length > 0;
	let type: ModelFieldType = f.shape === "repeater" && !ctx.inRepeater && f.subfields?.length ? "repeater" : scalarType(f, low);
	if (ctx.inRepeater && !REPEATER_SUB_FIELD_TYPES.includes(type)) {
		reasons.push(`EmDash repeater rows hold simple fields only, so this ${type} value is kept as text.`);
		type = "string";
	}
	const required = !low && f.confidence !== "low" && f.total > 0 && f.filled === f.total;
	const out: ModelField = { name: fieldSlugFor(f.key), from: f.key, label: f.label ?? labelFromKey(f.key), type, required };
	if (type === "select" && f.options) out.options = [...f.options];
	if (type === "repeater") out.subfields = orderFields(f.subfields ?? []).map((s) => toField(s, { ...ctx, inRepeater: true }));
	if (reasons.length) out.check = reasons.join(" ");
	return out;
}

/** Source order: Field.order first, then key, so any input order gives one output. */
function orderFields(fields: Field[]): Field[] {
	return [...fields].sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER) || byKey(a.key, b.key));
}

// EmDash's BASE_REQUIRED_FIELDS and FEATURED_IMAGE_FIELD (import/utils.ts). Every
// collection gets them so the importer's analysis finds no missing field.
const CORE: { key: string; name: string; label: string; type: ModelFieldType; required: boolean; searchable?: boolean }[] = [
	{ key: "post_title", name: "title", label: "Title", type: "string", required: true, searchable: true },
	{ key: "post_content", name: "content", label: "Content", type: "portableText", required: false, searchable: true },
	{ key: "post_excerpt", name: "excerpt", label: "Excerpt", type: "text", required: false },
	{ key: "_thumbnail_id", name: "featured_image", label: "Featured image", type: "image", required: false },
];
// The post dates. WordPress has them on every entry; posts show them, so the model keeps
// them there (Astro frontmatter). EmDash keeps them as its own published and updated
// dates, which its import fills, so the seed leaves them out (seed.ts).
const DATES: { key: string; name: string; label: string; type: ModelFieldType; required: boolean }[] = [
	{ key: "post_date", name: "date", label: "Date", type: "datetime", required: true },
	{ key: "post_modified", name: "modified", label: "Modified", type: "datetime", required: false },
];
const DATED_TYPES = new Set(["post"]);
const CORE_KEYS = new Set([...CORE.map((c) => c.key), ...DATES.map((d) => d.key)]);

// One reason for every collection: EmDash's import asks for an excerpt and a featured
// image (when the post type has them), so the base fields stay, optional, even unused.
const KEPT_FOR_IMPORT = "Kept (optional), since EmDash's import can ask for it. Remove it if the new site will not use it.";
const KEPT_EMPTY = "EmDash's import can ask for it, so it is kept (optional) until you decide.";

/** Check notes for EmDash's base fields, which every collection keeps whatever the old site shows. */
function coreCheck(key: string, seen: Field | undefined, typeSeen: boolean): string | undefined {
	if (key === "post_title" || key === "post_content") return undefined;
	const what = key === "post_excerpt" ? "excerpt" : "featured image";
	if (!seen) return typeSeen ? `The old site shows no ${what} for this type. ${KEPT_FOR_IMPORT}` : undefined;
	if (key === "post_excerpt") return filledCheck(seen, seen.filled === 0 ? KEPT_EMPTY : undefined);
	const fill = fillNote(seen.filled, seen.total);
	return fill && seen.filled === 0 ? `${fill} ${KEPT_EMPTY}` : fill;
}

// SEO: EmDash's Exporter import writes Yoast and Rank Math values into the content fields
// seo_title (string) and seo_description (text), and creates them when an entry has one
// (src/astro/routes/api/import/wordpress-plugin/execute.ts, IMPORT_FIELDS). The model
// declares them so the seed and the review show them; `seo` in supports stays for
// EmDash's own SEO panel.
// Field slugs: the Exporter path names custom fields with sanitizeFieldSlug (analyze in
// wordpress-plugin.ts, assignMetaValue in execute.ts), not mapMetaKeyToField, which only
// feeds the WXR path's suggestions. Both agree on plain keys; on hyphenated keys
// mapMetaKeyToField gives an invalid slug, so fieldSlugFor follows sanitizeFieldSlug.
// The focus keyphrase has no place in EmDash's SEO panel, so it is a plain optional text
// field, seo_focus_keyphrase; EmDash's import does not fill it (seed.ts says so).
const SEO_FIELDS: { name: string; label: string; type: ModelFieldType; keys: string[] }[] = [
	{ name: "seo_title", label: "SEO Title", type: "string", keys: ["_yoast_wpseo_title", "_rank_math_title"] },
	{ name: "seo_description", label: "SEO Description", type: "text", keys: ["_yoast_wpseo_metadesc", "_rank_math_description"] },
	{ name: "seo_focus_keyphrase", label: "Focus keyphrase", type: "string", keys: ["_yoast_wpseo_focuskw", "_rank_math_focus_keyword"] },
];

// --- Menus -------------------------------------------------------------------------------

function menuItems(items: MenuItem[], parent: number | undefined, urlFor: (url: string) => string): ModelMenuItem[] {
	return items
		.filter((i) => i.parent === parent)
		.sort((a, b) => a.order - b.order || a.id - b.id)
		.map((i) => {
			const out: ModelMenuItem = { label: i.title, url: urlFor(i.url) };
			const children = menuItems(items, i.id, urlFor);
			if (children.length) out.children = children;
			return out;
		});
}

/** Menu links to a post type archive, as ledger-like entries (the ledger may not list the archive). */
export function menuArchives(inv: Inventory): { url: string; type: string }[] {
	const out: { url: string; type: string }[] = [];
	for (const m of inv.menus) for (const i of m.items) if (i.target?.kind === "archive" && i.target.type) out.push({ url: i.url, type: i.target.type });
	return out;
}

function menuName(m: Menu): string {
	const raw = m.location ?? m.name;
	return raw.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "menu";
}

// --- Left out post types ----------------------------------------------------------------

/** "Left out" notes for the plugin, builder and theme post types. Form setup and saved messages get their own, since the owner needs them. */
function pluginLeftOut(types: string[], blockMenu: boolean): string[] {
	const out: string[] = [];
	const special = (t: string): boolean => t === "wpcf7_contact_form" || t.startsWith("flamingo_") || (blockMenu && t === "wp_navigation");
	const rest = types.filter((t) => !special(t));
	if (rest.length) out.push(`Left out post types that hold plugin, builder or theme data, not site content: ${rest.join(", ")}. The move does not bring them across.`);
	for (const t of types) {
		if (t === "wpcf7_contact_form") out.push("Left out wpcf7_contact_form: it holds your form setup (fields and mail settings); use it to rebuild the forms.");
		else if (t.startsWith("flamingo_")) out.push(`Left out ${t}: it holds saved form messages; save them before you switch.`);
		else if (t === "wp_navigation" && blockMenu) out.push("Left out wp_navigation as a post type: its links are kept in the menus.");
	}
	return out;
}

/** A page's title for a note: the menu label that links to it, else its slug in words. */
function pageTitle(inv: Inventory, id: number, slug: string | undefined): string {
	for (const m of inv.menus) for (const i of m.items) if (i.target?.id === id && i.title) return i.title;
	return capitalize((slug ?? String(id)).replace(/[-_]+/g, " "));
}

// --- The proposal -----------------------------------------------------------------------

/**
 * Post types that EmDash names alike (`case-study`, `case_study`) all import into one
 * collection on the Exporter path, so they become one: the first post type in inventory
 * order keeps it, and the others add their fields. A field stays required only when every
 * merged type requires it, since EmDash rejects an entry that lacks a required value.
 */
function mergeRepeats(collections: Collection[], order: string[], routeOf: Map<string, { pattern: string; hierarchical: boolean }>): void {
	const bySlug = new Map<string, Collection[]>();
	for (const c of collections) bySlug.set(c.slug, [...(bySlug.get(c.slug) ?? []), c]);
	for (const group of bySlug.values()) {
		if (group.length < 2) continue;
		group.sort((a, b) => order.indexOf(a.from) - order.indexOf(b.from));
		const [keep, ...rest] = group as [Collection, ...Collection[]];
		for (const other of rest) {
			for (const f of other.fields) {
				const have = keep.fields.find((x) => x.name === f.name);
				if (!have) keep.fields.push({ ...f, required: false });
				else if (have.type !== f.type) {
					const note = `Post type ${other.from} has this field as ${f.type}; ${keep.from} has it as ${have.type}, which is kept.`;
					have.check = have.check ? `${have.check} ${note}` : note;
				}
			}
			for (const f of keep.fields) if (f.required && !other.fields.some((x) => x.name === f.name && x.required)) f.required = false;
			for (const s of other.supports) if (!keep.supports.includes(s)) keep.supports.push(s);
			for (const t of other.taxonomies) if (!keep.taxonomies.includes(t)) keep.taxonomies.push(t);
			for (const n of other.leftOut ?? []) keep.leftOut = [...(keep.leftOut ?? []), `${other.from}: ${n}`];
			const route = routeOf.get(keep.from);
			if (route) routeOf.set(other.from, route);
			else routeOf.delete(other.from);
			collections.splice(collections.indexOf(other), 1);
		}
		const others = rest.map((c) => c.from).join(", ");
		const note = `EmDash's Exporter import puts post type${rest.length > 1 ? "s" : ""} ${others} into this collection too, since it names ${rest.length > 1 ? "them" : "it"} ${keep.slug} as well and the import screen cannot pick another; the fields are those of every type, required only when all require them. The redirect plan sends their old URLs to this collection's pattern, so duplicate slugs will clash.`;
		keep.check = keep.check ? `${keep.check} ${note}` : note;
	}
}

/** Proposes the content model for an inventory. The result is in canonical order. */
export function propose(inv: Inventory): Model {
	const site = siteOf(inv);
	const slash = site.trailing ? "/" : "";
	// Inventory order is the order EmDash sees the post types, so repeats are numbered in it.
	const inOrder = inv.types.filter((t) => !INTERNAL_POST_TYPES.includes(t.slug) && !isPluginPostType(t.slug));
	const pluginTypes = inv.types.filter((t) => !INTERNAL_POST_TYPES.includes(t.slug) && isPluginPostType(t.slug)).map((t) => t.slug).sort(byKey);
	const types = [...inOrder].sort((a, b) => byKey(a.slug, b.slug));

	// Collection slugs. Post types that share one go into one collection (mergeRepeats).
	const slugOf = new Map<string, string>();
	for (const t of inOrder) slugOf.set(t.slug, collectionSlugFor(t.slug));
	const collectionOf = (postType: string): string => slugOf.get(postType) ?? collectionSlugFor(postType);
	const taxonomySlugs = new Set(inv.taxonomies.map((t) => t.slug));
	const ctx: FieldContext = { multilingual: inv.site.locales.length, collectionOf, inRepeater: false };

	// Collections.
	const collections: Collection[] = [];
	const routeOf = new Map<string, { pattern: string; hierarchical: boolean }>();
	for (const t of types) {
		const slug = slugOf.get(t.slug) as string;
		const notes: string[] = [];
		const hierarchical = t.hierarchical === true;

		const entries = inv.urls.filter((u) => u.type === t.slug && (u.kind === "post" || u.kind === "page" || u.kind === "custom"));
		let route: string | null = inferPattern(site, entries, hierarchical) ?? null;
		const anyUrl = inv.urls.some((u) => u.type === t.slug && u.kind !== "archive");
		if (route === null && (entries.length > 0 || anyUrl)) {
			route = hierarchical ? `/{path}${slash}` : t.slug === "post" ? `/blog/{slug}${slash}` : `/${slug.replaceAll("_", "-")}/{slug}${slash}`;
			const structure = inv.permalinks.structure;
			const plain = structure === "" || (entries.length > 0 && entries.every((e) => new URL(e.url).search !== ""));
			if (plain) notes.push(`Old URLs are plain links (?p=, ?page_id=); each one moves to a readable path. The new pattern is ${route}, and the redirect plan maps each old link.`);
			else if (entries.length === 0) notes.push(`WordPress used plain links (?p=) for these; the new pattern is ${route}, and the redirect plan maps each old link.`);
			else if (hierarchical && /^\/?%postname%\/?$/.test(structure ?? "")) notes.push(`Nested pages keep their paths: the new pattern is ${route}. The redirect plan maps each old URL.`);
			else if (fitsStructure(site, entries, structure)) notes.push(`Old URLs follow the permalink structure ${structure}. The new URLs have no dates or other tags, so the new pattern is ${route}. The redirect plan maps each old URL.`);
			else notes.push(`Old URLs did not share one pattern${structure ? ` (${structure})` : ""}; the new pattern is ${route}, and the redirect plan maps each old URL.`);
		}
		if (route === null) notes.push("No public URLs were found, so entries have no page of their own.");
		if (t.count === undefined) notes.push("Seen by name only; no entries or fields were visible, so check the fields by hand.");
		if (route) routeOf.set(t.slug, { pattern: route, hierarchical });

		const fields: ModelField[] = [];
		const leftOut: string[] = [];
		const used = new Set<string>();
		// The REST API fills an empty excerpt from the content. When the export was read and
		// still the excerpt comes only from the REST API, the export holds none: 0 written by hand.
		const fromExport = t.sources.includes("wxr");
		for (const c of CORE) {
			let seenField = t.fields.find((f) => f.key === c.key);
			if (seenField && c.key === "post_excerpt" && fromExport && seenField.source !== "wxr") seenField = { ...seenField, shape: "text", source: "wxr", filled: 0, total: t.count ?? seenField.total, samples: [] };
			const f: ModelField = { name: c.name, from: c.key, label: seenField?.label ?? c.label, type: c.type, required: c.required };
			if (c.searchable) f.searchable = true;
			const check = coreCheck(c.key, seenField, t.count !== undefined && t.fields.length > 0);
			if (check) f.check = check;
			fields.push(f);
			used.add(c.name);
		}
		if (DATED_TYPES.has(t.slug)) {
			for (const d of DATES) {
				fields.push({ name: d.name, from: d.key, label: t.fields.find((f) => f.key === d.key)?.label ?? d.label, type: d.type, required: d.required });
				used.add(d.name);
			}
		}
		const plumbing: string[] = [];
		const seoLeftOut: string[] = [];
		const datesLeftOut: string[] = [];
		let seo = false;
		const seoKeys = new Map<string, Field>(); // EmDash field -> WordPress field
		// SEO keys go to the seo panel and `_`-prefixed internal keys are dropped, as EmDash's
		// WXR import does. The Exporter never reports a `_` key (exporter.ts), so none of
		// them is missing on EmDash's import screen.
		for (const f of orderFields(t.fields)) {
			if (CORE_KEYS.has(f.key)) {
				if (DATES.some((d) => d.key === f.key) && !DATED_TYPES.has(t.slug)) datesLeftOut.push(f.key);
				continue;
			}
			if (SEO_KEYS.includes(f.key) || f.owner === "seo") {
				seo = true;
				const target = SEO_FIELDS.find((d) => d.keys.includes(f.key))?.name;
				if (target && !seoKeys.has(target)) seoKeys.set(target, f);
				else seoLeftOut.push(f.key);
				continue;
			}
			if (isPlumbingKey(f.key) || f.owner === "builder") {
				plumbing.push(f.key);
				continue;
			}
			const mf = toField(f, ctx);
			if (used.has(mf.name)) {
				leftOut.push(`Left out the key ${f.key}: it gives the field name ${mf.name}, which is taken.`);
				continue;
			}
			used.add(mf.name);
			fields.push(mf);
		}
		for (const def of SEO_FIELDS) {
			const from = seoKeys.get(def.name);
			if (!from || used.has(def.name)) continue;
			const sf: ModelField = { name: def.name, from: from.key, label: def.label, type: def.type, required: false };
			const check = filledCheck(from);
			if (check) sf.check = check;
			fields.push(sf);
			used.add(def.name);
		}
		if (plumbing.length) leftOut.push(`Left out WordPress internal keys: ${plumbing.sort(byKey).join(", ")}.`);
		if (datesLeftOut.length) leftOut.push(`Left out the WordPress dates (${datesLeftOut.sort(byKey).join(", ")}): this collection shows none. Add a date field if the new site needs one.`);
		if (seoLeftOut.length) leftOut.push(`Left out SEO plugin keys that EmDash's SEO panel has no place for: ${seoLeftOut.sort(byKey).join(", ")}.`);

		const supports: CollectionSupport[] = route ? ["drafts", "revisions", "search", "seo"] : ["drafts", "revisions"];
		if (seo && !supports.includes("seo")) supports.push("seo");
		const label = t.label ?? capitalize(slug.replaceAll("_", " "));
		const c: Collection = {
			slug,
			from: t.slug,
			label,
			labelSingular: (t.label ? undefined : COLLECTIVE[label.toLowerCase()]) ?? singularize(label),
			route,
			supports,
			taxonomies: t.taxonomies.filter((x) => taxonomySlugs.has(x)).map(taxonomySlugFor),
			fields,
		};
		if (hierarchical) c.hierarchical = true;
		if (notes.length) c.check = notes.join(" ");
		if (leftOut.length) c.leftOut = leftOut;
		collections.push(c);
	}
	mergeRepeats(collections, inOrder.map((t) => t.slug), routeOf);

	// Two collections with the same URL shape share one route.
	const shape = (p: string): string => p.replace(/\{(slug|path)\}/, "{}");
	for (const c of collections) {
		if (!c.route) continue;
		const yields = (o: Collection): boolean => (o.hierarchical === true) !== (c.hierarchical === true) ? o.hierarchical === true : o.slug < c.slug;
		const other = collections.find((o) => o !== c && o.route && shape(o.route) === shape(c.route as string) && yields(o));
		if (!other) continue;
		const note = `Shares the URL space ${c.route} with ${other.slug}; one route must serve both, or move this collection under its own path.`;
		c.check = c.check ? `${c.check} ${note}` : note;
	}

	// Notes about the model as a whole go on one collection: pages, else posts, else the first.
	const host = collections.find((c) => c.from === "page") ?? collections.find((c) => c.from === "post") ?? collections[0];
	const hostNotes: string[] = [];
	const renamed = collections.filter((c) => POST_TYPE_TO_COLLECTION[c.from] && POST_TYPE_TO_COLLECTION[c.from] !== c.from).map((c) => `${c.from} becomes ${c.slug}`);
	const kept = collections.filter((c) => c.slug === c.from).map((c) => c.slug);
	if (renamed.length && kept.length) hostNotes.push(`Collection names: ${renamed.join(", ")}. Other post types keep their WordPress names (${kept.join(", ")}).`);
	if (host && hostNotes.length) host.check = [host.check, ...hostNotes].filter(Boolean).join(" ");
	const leftOut = pluginLeftOut(pluginTypes, inv.menus.some((m) => m.kind === "block"));

	// Taxonomies.
	const termRoutes = new Map<string, string>();
	const taxonomies: ModelTaxonomy[] = [];
	for (const t of [...inv.taxonomies].sort((a, b) => byKey(a.slug, b.slug))) {
		if (t.slug === "nav_menu" || t.slug === "post_format") continue;
		const slug = taxonomySlugFor(t.slug);
		const label = t.label ?? capitalize(slug.replaceAll("_", " "));
		const hierarchical = t.hierarchical === true;
		const terms = inv.urls.filter((u) => u.taxonomy === t.slug && (u.kind === "category" || u.kind === "tag" || u.kind === "term"));
		const tx: ModelTaxonomy = {
			slug,
			from: t.slug,
			label,
			labelSingular: singularize(label),
			hierarchical,
			collections: t.types.filter((x) => slugOf.has(x)).map(collectionOf),
		};
		if (t.count === 0) tx.check = "The old site has no terms in it. Keep it only if the new site will use it.";
		let route = inferPattern(site, terms, hierarchical);
		const notes: string[] = [];
		if (route && hierarchical && !route.includes("{path}")) {
			// Old term URLs were flat, but the terms nest: the new site shows the nesting, as for categories.
			route = route.replace("{slug}", "{path}");
			notes.push(`Old term URLs were flat, but the terms nest. The new pattern is ${route}, so child terms move under their parent. The redirect plan maps each old URL.`);
		}
		if (!route && inv.urls.some((u) => u.taxonomy === t.slug)) {
			// Term pages with plain links (?cat=1) or no pattern: give them the usual WordPress path.
			const base = t.slug === "category" ? "category" : t.slug === "post_tag" ? "tag" : slug.replaceAll("_", "-");
			route = `/${base}/${hierarchical ? "{path}" : "{slug}"}${slash}`;
			notes.push(inv.permalinks.structure === "" ? `Old term URLs are plain links (?cat=, ?tag=); each one moves to a readable path. The new pattern is ${route}, and the redirect plan maps each old link.` : `The old term pages had no shared pattern (or used plain links like ?cat=1). The new pattern is ${route}. The redirect plan maps each old URL.`);
		}
		if (route) {
			tx.route = route;
			termRoutes.set(t.slug, route);
		}
		if (notes.length) tx.check = tx.check ? `${tx.check} ${notes.join(" ")}` : notes.join(" ");
		taxonomies.push(tx);
	}

	// Routes that are not one entry or term.
	const routes: Route[] = [];
	// Every site has a home page, and it stays at the root.
	routes.push({ kind: "home", pattern: "/" });
	routes.push({ kind: "search", pattern: `/search${slash}` });
	// Post type archives: from the ledger, and from menu links to one (WordPress menus name the archive's post type).
	// A plain archive link (?post_type=service) has no path, so the archive goes where the entries live: /services/.
	for (const u of [...inv.urls.filter((x) => x.kind === "archive" && x.type), ...menuArchives(inv)]) {
		const collection = slugOf.get(u.type as string);
		if (!collection || routes.some((r) => r.kind === "archive" && r.collection === collection)) continue;
		const p = relPath(site, u);
		const entries = routeOf.get(u.type as string)?.pattern;
		const prefix = entries ? entries.slice(0, entries.indexOf("{")) : "/";
		const pattern = p !== undefined ? `/${p}` : prefix !== "/" ? (slash ? prefix : prefix.replace(/\/$/, "")) : `/${collection.replaceAll("_", "-")}${slash}`;
		routes.push({ kind: "archive", pattern, collection });
	}
	if (inv.urls.some((u) => u.kind === "feed")) routes.push({ kind: "feed", pattern: "/rss.xml" });
	const authors = inv.urls.filter((u) => u.kind === "author");
	// Author pages with plain links (?author=2) get the usual WordPress path.
	const authorRoute = inferPattern(site, authors, false) ?? (authors.length ? `/author/{slug}${slash}` : undefined);
	if (authorRoute) routes.push({ kind: "author", pattern: authorRoute });
	const posts = routeOf.get("post");
	// The home page listed the latest posts (WordPress "Your latest posts"): the root entry has no page behind it.
	const homeListsPosts = inv.urls.some((u) => u.kind === "home" && !u.type);
	if (posts) {
		const prefix = posts.pattern.slice(0, posts.pattern.indexOf("{"));
		const postsArchive = routes.some((r) => r.kind === "archive" && r.collection === collectionOf("post"));
		if (prefix !== "/") routes.push({ kind: "blog", pattern: prefix });
		else if (homeListsPosts && !postsArchive) routes.push({ kind: "blog", pattern: `/blog${slash}` });
		const blog = routes.find((r) => r.kind === "blog")?.pattern;
		const c = collections.find((x) => x.from === "post");
		if (homeListsPosts && blog && c) {
			const note = `The old home page listed the latest posts. On the new site the post list is at ${blog}, and the home page is a page of its own. Decide what the home page shows.`;
			c.check = c.check ? `${c.check} ${note}` : note;
		}
	}

	// The front page and the posts page are WordPress pages too, so the pages collection
	// would publish them a second time next to / and the posts list.
	const pages = collections.find((c) => c.from === "page");
	const pagesRoute = routeOf.get("page")?.pattern;
	if (pages) {
		const pageNotes: string[] = [];
		const pathOf = (e: UrlEntry): string => (pagesRoute ? fill(pagesRoute, e.slug ?? "", e.path ?? e.slug ?? "") : `/${e.path ?? e.slug ?? ""}${slash}`);
		const home = inv.urls.find((u) => u.kind === "home" && u.type === "page" && u.id !== undefined);
		if (home) pageNotes.push(`Page ${home.id} (${pageTitle(inv, home.id as number, home.slug)}) is the front page. Build it at / and do not also publish it at ${pathOf(home)}.`);
		const postsPage = inv.urls.find((u) => u.kind === "archive" && u.type === "post" && u.id !== undefined);
		const list = routes.find((r) => r.kind === "archive" && r.collection === collectionOf("post"))?.pattern ?? routes.find((r) => r.kind === "blog")?.pattern;
		if (postsPage) pageNotes.push(`Page ${postsPage.id} (${pageTitle(inv, postsPage.id as number, postsPage.slug)}) is the posts page. The posts list takes ${list ?? pathOf(postsPage)}; drop this page or move its text onto the list.`);
		else if (home && posts && !inv.levels.some((l) => l > 1)) {
			const named = inv.urls.filter((u) => u.type === "page" && u.kind === "page" && (u.slug === "news" || u.slug === "blog")).sort((a, b) => byKey(a.url, b.url))[0];
			if (named) pageNotes.push(`Level 1 cannot see which page lists the posts. Check whether ${pathOf(named)} is the blog.`);
		}
		if (pageNotes.length) pages.check = [pages.check, ...pageNotes].filter(Boolean).join(" ");
	}

	// Menus, with each old URL turned into its new path.
	const ledger = new Map<string, UrlEntry>();
	for (const u of inv.urls) ledger.set(normalizeUrl(u.url), u);
	const archiveOf = new Map(routes.filter((r) => r.kind === "archive").map((r) => [r.collection, r.pattern]));
	for (const a of menuArchives(inv)) {
		try {
			const key = normalizeUrl(a.url);
			if (!ledger.has(key)) ledger.set(key, { url: key, kind: "archive", type: a.type, source: [], evidence: "linked" });
		} catch {}
	}
	const urlFor = (raw: string): string => {
		let abs: string;
		try {
			abs = normalizeUrl(raw);
		} catch {
			return raw;
		}
		const e = ledger.get(abs);
		const prefix = e?.locale ? site.prefixes.get(e.locale) : undefined;
		const localized = (p: string): string => (prefix ? `/${prefix}${p}` : p);
		if (e) {
			const slug = e.slug ?? "";
			const path = e.path ?? slug;
			if (e.kind === "home") return localized("/");
			if ((e.kind === "post" || e.kind === "page" || e.kind === "custom") && e.type && routeOf.has(e.type)) return localized(fill((routeOf.get(e.type) as { pattern: string }).pattern, slug, path));
			if (e.taxonomy && termRoutes.has(e.taxonomy)) return localized(fill(termRoutes.get(e.taxonomy) as string, slug, path));
			if (e.kind === "archive" && e.type && archiveOf.has(slugOf.get(e.type))) return localized(archiveOf.get(slugOf.get(e.type)) as string);
		}
		const p = relPath(site, { url: abs, locale: e?.locale });
		return p === undefined ? raw : localized(`/${p}`);
	};
	const menus: ModelMenu[] = [];
	for (const m of [...inv.menus].sort((a, b) => byKey(menuName(a), menuName(b)) || byKey(a.name, b.name))) {
		let name = menuName(m);
		if (menus.some((x) => x.name === name)) name = `${name}-${menus.length + 1}`;
		const menu: ModelMenu = { name, from: m.name, label: capitalize(m.name), items: menuItems(m.items, undefined, urlFor) };
		if (m.kind === "block") {
			const classic = inv.menus.filter((x) => x.kind !== "block").map((x) => x.name);
			menu.check = classic.length
				? `Read from a Navigation block (wp_navigation). The old site also has the classic menu ${classic.join(", ")}. Check which one the live header shows, and keep that one.`
				: "Read from a Navigation block (wp_navigation), not a classic menu. Compare its links with the header on the live site.";
		}
		menus.push(menu);
	}

	const locales: Locale[] = inv.site.locales.map((l) => ({ ...l }));
	const model: Model = {
		version: MODEL_VERSION,
		site: { url: inv.site.url, ...(inv.site.name ? { name: inv.site.name } : {}), ...(inv.site.tagline ? { tagline: inv.site.tagline } : {}) },
		locales,
		collections,
		taxonomies,
		menus,
		routes,
	};
	if (leftOut.length) model.leftOut = leftOut;
	return canonical("model", model);
}
