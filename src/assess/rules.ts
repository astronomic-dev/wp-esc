// Assessment rules: each one reads the inventory and gives zero or more findings.
// Every finding has an area, a score, a plain reason and the next step.
// The readers are site owners, so the text uses short, plain sentences.

import type { ContentType, Field, Inventory, Plugin, Usage } from "../contracts/inventory.ts";
import type { Finding, Link, StorePath } from "../contracts/assessment.ts";
import type { Model, ModelField, ModelMenuItem } from "../contracts/model.ts";
import { clashingPaths, planRedirects, siteBase, type Row } from "../redirects/plan.ts";
import { emdashUrlFor } from "../model/seed.ts";
import { isPluginPostType } from "../model/propose.ts";

/** What a rule reads besides the inventory: the content model the move maps to. */
export interface RuleContext {
	model: Model;
}

export interface Rule {
	name: string;
	run: (inv: Inventory, ctx: RuleContext) => Finding[];
}

// WordPress types that are plumbing, not content.
const PLUMBING_TYPES = new Set(["attachment", "revision", "nav_menu_item", "custom_css", "customize_changeset", "oembed_cache", "user_request", "wp_block", "wp_template", "wp_template_part", "wp_navigation", "wp_global_styles", "wp_font_family", "wp_font_face"]);
// Types a store plugin owns. The store finding covers them.
const STORE_TYPES = new Set(["product", "product_variation", "shop_order", "shop_order_refund", "shop_coupon", "download", "edd_payment", "edd_discount"]);
// Shortcodes WordPress itself ships. Plain Astro has no match for them, so they are listed apart.
const CORE_SHORTCODES = new Set(["caption", "wp_caption", "gallery", "audio", "video", "playlist", "embed"]);
// Shortcode prefixes each page builder owns. The builder finding covers them, but only
// when that builder was found; another builder's shortcodes still need their own fix.
const BUILDER_SHORTCODES: Record<string, string[]> = {
	divi: ["et_pb_"],
	wpbakery: ["vc_"],
	js_composer: ["vc_"],
	avada: ["fusion_"],
	"fusion-builder": ["fusion_"],
	"beaver-builder": ["fl_builder"],
	"beaver-builder-lite-version": ["fl_builder"],
	cornerstone: ["cs_", "x_"],
	enfold: ["av_"],
	tatsu: ["tatsu_"],
};
// Shortcodes each form plugin owns. The forms finding covers them.
const FORM_SHORTCODES: Record<string, string[]> = {
	"contact-form-7": ["contact-form-7", "contact-form"],
	"wpforms-lite": ["wpforms"],
	wpforms: ["wpforms"],
	gravityforms: ["gravityform", "gravityforms"],
	"ninja-forms": ["ninja_form", "ninja_forms"],
	formidable: ["formidable"],
	fluentform: ["fluentform"],
	forminator: ["forminator_form"],
};
// What a simple field holds, in plain words, by shape.
const SHAPE_WORDS: Record<string, string> = {
	text: "text",
	html: "text",
	number: "numbers",
	boolean: "yes-or-no values",
	date: "dates",
	url: "links",
	email: "email addresses",
	image: "images",
	file: "files",
	list: "lists",
};
const SIMPLE_SHAPES = new Set(["text", "html", "number", "boolean", "date", "url", "email", "image", "file", "relation", "list"]);
const NESTED_SHAPES = new Set(["repeater", "flexible"]);
// Meta keys WordPress core writes for its own blocks (footnotes). The model leaves them out.
const CORE_META_KEYS = new Set(["footnotes"]);

const KNOWN_NAMES: Record<string, string> = {
	elementor: "Elementor",
	divi: "Divi",
	"beaver-builder": "Beaver Builder",
	"beaver-builder-lite-version": "Beaver Builder",
	"js_composer": "WPBakery",
	wpbakery: "WPBakery",
	oxygen: "Oxygen",
	bricks: "Bricks",
	avada: "Avada",
	"fusion-builder": "Avada",
	"siteorigin-panels": "SiteOrigin",
	"thrive-visual-editor": "Thrive Architect",
	woocommerce: "WooCommerce",
	"easy-digital-downloads": "Easy Digital Downloads",
};

const LINKS: Record<string, Link> = {
	polar: { label: "Polar", url: "https://polar.sh/" },
	buyButton: { label: "Shopify Buy Button", url: "https://www.shopify.com/buy-button" },
	snipcart: { label: "Snipcart", url: "https://snipcart.com/" },
	shopify: { label: "Shopify", url: "https://www.shopify.com/" },
	podia: { label: "Podia", url: "https://www.podia.com/" },
	memberful: { label: "Memberful", url: "https://memberful.com/" },
};

// Helpers.

function nameOf(inv: Inventory, slug: string): string {
	const plugin = inv.plugins.find((p) => p.slug === slug);
	if (plugin?.name) return plugin.name;
	if (KNOWN_NAMES[slug]) return KNOWN_NAMES[slug] as string;
	return slug.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function list(items: string[]): string {
	if (items.length <= 1) return items.join("");
	return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
const uniq = (items: string[]): string[] => [...new Set(items)].sort();
const pluginsIn = (inv: Inventory, category: Plugin["category"]): Plugin[] => inv.plugins.filter((p) => p.category === category && p.active !== false);
const hasStore = (inv: Inventory): boolean => pluginsIn(inv, "store").length > 0;

/** Shortcodes that belong to an active form plugin. */
function formShortcodes(inv: Inventory): Usage[] {
	const names = new Set(pluginsIn(inv, "forms").flatMap((p) => FORM_SHORTCODES[p.slug] ?? []));
	return inv.shortcodes.filter((s) => s.count > 0 && names.has(s.name));
}

/** Content types the move covers as content: not plumbing, not plugin data, and not store-owned when a store runs. */
function contentTypes(inv: Inventory): ContentType[] {
	const store = hasStore(inv);
	return inv.types.filter((t) => !PLUMBING_TYPES.has(t.slug) && !isPluginPostType(t.slug) && !(store && STORE_TYPES.has(t.slug)));
}

/** A content type's name as the site shows it: its label, else the model's, else its slug in title case. */
function labelOf(t: ContentType, model?: Model): string {
	return t.label ?? model?.collections.find((c) => c.from === t.slug)?.label ?? t.slug.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Below level 2: no export and no password, so drafts, private items and raw content are not seen. */
const levelOneOnly = (inv: Inventory): boolean => !inv.levels.includes(2) && !inv.levels.includes(3);

function customFields(inv: Inventory): Field[] {
	return contentTypes(inv).flatMap((t) => t.fields.filter((f) => f.owner === "acf" || f.owner === "meta" || f.owner === "seo"));
}

/** True when the site's one category is WordPress's default "Uncategorized". */
function onlyUncategorized(inv: Inventory): boolean {
	if (inv.taxonomies.find((t) => t.slug === "category")?.count !== 1) return false;
	const terms = inv.urls.filter((u) => u.kind === "category" || (u.taxonomy === "category" && u.kind === "term"));
	const slugs = new Set(terms.map((u) => u.slug));
	return slugs.size === 1 && slugs.has("uncategorized");
}

// Unpublished titles a finding names. The inventory keeps at most this many per type.
const UNPUBLISHED_SHOWN = 20;
const STATUS_WORDS: Record<string, string> = { draft: "draft", private: "private", pending: "waiting for review", future: "scheduled" };

/** "124 posts, with 3 drafts and 1 private post", the unpublished titles, and a next step when some are not published. */
function statuses(t: ContentType, one: string, many: string): { text: string; titles: string; unpublished: string } {
	const n = (status: string): number => t.byStatus[status] ?? 0;
	const parts = [
		n("draft") ? plural(n("draft"), "draft", "drafts") : "",
		n("private") ? plural(n("private"), `private ${one}`, `private ${many}`) : "",
		n("future") ? plural(n("future"), `scheduled ${one}`, `scheduled ${many}`) : "",
		n("pending") ? `${n("pending")} waiting for review` : "",
	].filter(Boolean);
	const text = `${plural(t.count ?? 0, one, many)}${parts.length ? `, with ${list(parts)}` : ""}`;
	const shown = (t.unpublished ?? []).slice(0, UNPUBLISHED_SHOWN);
	const all = ["draft", "private", "future", "pending"].reduce((sum, k) => sum + n(k), 0);
	const rest = all - shown.length;
	const titles = shown.length ? ` Not published: ${list([...shown.map((u) => `"${u.title}" (${STATUS_WORDS[u.status] ?? u.status})`), ...(rest > 0 ? [`${rest} more`] : [])])}.` : "";
	return { text, titles, unpublished: parts.length ? " Decide which unpublished ones to move. They are not public now." : "" };
}

// Rules.

const coreContent: Rule = {
	name: "posts-and-pages",
	run(inv) {
		const out: Finding[] = [];
		const posts = inv.types.find((t) => t.slug === "post");
		if (posts?.count) {
			const { text, titles, unpublished } = statuses(posts, "post", "posts");
			const reason = onlyUncategorized(inv)
				? `${text}.${titles} Titles, content and dates move cleanly. The only category is "Uncategorized", WordPress's default, which most owners drop.`
				: `${text}.${titles} Titles, content, dates and categories move cleanly.`;
			out.push({ area: "posts", score: "easy", count: posts.count, reason, next: `Move them with the EmDash importer, or as Markdown files for plain Astro.${unpublished}` });
		}
		const pages = inv.types.find((t) => t.slug === "page");
		if (pages?.count) {
			const { text, titles, unpublished } = statuses(pages, "page", "pages");
			const builderNote = inv.builders.length > 0 ? " Pages made with a page builder are scored on their own below." : "";
			out.push({ area: "pages", score: "easy", count: pages.count, reason: `${text}.${titles} Plain pages move like posts.${builderNote}`, next: `Move them with the EmDash importer, or as Markdown files for plain Astro. The addresses finding says which ones change.${unpublished}` });
		}
		return out;
	},
};

const customTypes: Rule = {
	name: "custom-types",
	run(inv, { model }) {
		const types = contentTypes(inv).filter((t) => t.slug !== "post" && t.slug !== "page" && t.count !== undefined && t.count > 0);
		if (types.length === 0) return [];
		const named = types.map((t) => `${labelOf(t, model)} (${t.count})`);
		return [{
			area: "custom-types",
			score: "easy",
			count: types.length,
			items: types.map((t) => t.slug),
			reason: `${plural(types.length, "custom content type", "custom content types")}: ${list(named)}.`,
			next: "Each one becomes its own collection on the new site. Review the proposed content model.",
		}];
	},
};

const simpleFields: Rule = {
	name: "simple-fields",
	run(inv, { model }) {
		// One field per key: the same key on posts and pages is one field here.
		const all = customFields(inv).filter((f) => SIMPLE_SHAPES.has(f.shape));
		const fields = [...new Map(all.map((f) => [f.key, f])).values()];
		if (fields.length === 0) return [];
		const keys = new Set(fields.map((f) => f.key));
		const marked = new Set(model.collections.flatMap((c) => modelFields(c.fields)).filter((f) => f.check && keys.has(f.from)).map((f) => f.from));
		const unsure = marked.size;
		const note = unsure > 0 ? ` ${plural(unsure, "is", "are")} marked "check this" in the model.` : "";
		// Say what the fields hold, from their shapes. Links to other entries are stored as
		// WordPress post IDs (often a packed list), so they get their own sentence.
		const words = [...new Set(fields.filter((f) => f.shape !== "relation").map((f) => SHAPE_WORDS[f.shape] ?? "values"))];
		const relations = fields.filter((f) => f.shape === "relation");
		const holds = words.length ? `${plural(fields.length, "custom field holds", "custom fields hold")} ${list(words)}` : `${plural(fields.length, "custom field links", "custom fields link")} to other entries`;
		const linked = relations.length && words.length ? ` ${relations.length === 1 ? "One links" : `${relations.length} link`} to other entries by WordPress post ID: ${list(uniq(relations.map((f) => f.key)))}.` : "";
		return [{
			area: "fields",
			score: "easy",
			count: fields.length,
			items: uniq(fields.map((f) => f.key)),
			reason: `${holds}.${linked}${note}`,
			next: unsure > 0 ? "They move as fields in the new content model. Check the marked ones." : "They move as fields in the new content model.",
		}];
	},
};

const modelFields = (fields: ModelField[]): ModelField[] => fields.flatMap((f) => [f, ...modelFields(f.subfields ?? [])]);

const nestedFields: Rule = {
	name: "repeaters-and-flexible-content",
	run(inv) {
		const fields = customFields(inv).filter((f) => NESTED_SHAPES.has(f.shape));
		if (fields.length === 0) return [];
		const items = uniq(fields.map((f) => f.key));
		return [{
			area: "repeaters",
			score: "some-work",
			count: items.length,
			items,
			reason: `${plural(items.length, "field repeats rows or mixes layouts", "fields repeat rows or mix layouts")}: ${list(items)}. The model can hold them, but the data needs care.`,
			next: "Check each row's parts in the proposed model. Then build a section on the new site that shows them.",
		}];
	},
};

const unclearFields: Rule = {
	name: "unclear-fields",
	run(inv) {
		// An empty field has nothing to move, and core meta is not the owner's data.
		const fields = customFields(inv).filter((f) => !SIMPLE_SHAPES.has(f.shape) && !NESTED_SHAPES.has(f.shape) && f.filled > 0 && !CORE_META_KEYS.has(f.key));
		if (fields.length === 0) return [];
		const items = uniq(fields.map((f) => f.key));
		return [{
			area: "unclear-fields",
			score: "some-work",
			count: items.length,
			items,
			reason: `${plural(items.length, "field holds", "fields hold")} packed or mixed data, so its type is a guess.`,
			next: "Look at the sample values, then pick a type for each one in the model.",
		}];
	},
};

const builders: Rule = {
	name: "page-builders",
	run(inv) {
		// One finding per builder: a page can use two builders, so counts never add up.
		return inv.builders.filter((b) => b.count > 0).map((b) => ({
			area: "builders",
			score: "hard",
			count: b.count,
			items: [b.name],
			reason: `${plural(b.count, "page uses", "pages use")} ${nameOf(inv, b.name)}. The builder's layouts do not move to a new site.`,
			next: "Rebuild these pages on the new site. Copy the text over, then lay it out with the theme's sections.",
		}));
	},
};

const shortcodes: Rule = {
	name: "unknown-shortcodes",
	run(inv) {
		const owned = inv.builders.filter((b) => b.count > 0).flatMap((b) => BUILDER_SHORTCODES[b.name.toLowerCase()] ?? []);
		const forms = new Set(formShortcodes(inv).map((s) => s.name));
		const found = inv.shortcodes.filter((s) => s.count > 0 && !forms.has(s.name) && !owned.some((prefix) => s.name.startsWith(prefix)));
		if (found.length === 0) return [];
		const items = uniq(found.map((s) => s.name));
		const where = (s: Usage): string => `[${s.name}] (${plural(s.count, "item", "items")})`;
		const sorted = [...found].sort((a, b) => (a.name < b.name ? -1 : 1));
		const other = sorted.filter((s) => !CORE_SHORTCODES.has(s.name));
		const core = sorted.filter((s) => CORE_SHORTCODES.has(s.name));
		const parts: string[] = [`${plural(items.length, "shortcode needs", "shortcodes need")} a fix on the new site.`];
		if (other.length) parts.push(`${list(other.map(where))} ${other.length === 1 ? "does" : "do"} not move on ${other.length === 1 ? "its" : "their"} own.`);
		if (core.length) parts.push(`${list(core.map(where))} ${core.length === 1 ? "is" : "are"} WordPress core; ${core.length === 1 ? "it needs" : "they need"} a gallery or embed section on plain Astro.`);
		if (levelOneOnly(inv)) parts.push(LEVEL_ONE_SHORTCODES);
		return [{
			area: "shortcodes",
			score: "some-work",
			count: items.length,
			items,
			reason: parts.join(" "),
			next: "Replace each one on the new site, for example with a form, an embed or a section.",
		}];
	},
};

const LEVEL_ONE_SHORTCODES = "WordPress has already run most shortcodes at this level; an export shows them all.";

const comments: Rule = {
	name: "comments",
	run(inv) {
		const n = inv.comments?.count ?? 0;
		if (n === 0) return [];
		const pending = Math.min(inv.comments?.pending ?? 0, n);
		const wait = pending ? ` ${pending === n ? (n === 1 ? "It waits" : "All of them wait") : `${pending} of them ${pending === 1 ? "waits" : "wait"}`} for approval, so ${pending === 1 ? "it is" : "they are"} not public now.` : "";
		return [{
			area: "comments",
			score: "some-work",
			count: n,
			reason: `${plural(n, "comment is", "comments are")} on the site.${wait} Plain Astro has no comments. On EmDash, the import from the EmDash Exporter plugin brings comments over, with their replies and dates. The import from an export file does not.`,
			next: "For plain Astro, keep the old comments as text in the posts, or add a comment service. For EmDash, use the EmDash Exporter plugin if you want the comments.",
		}];
	},
};

const store: Rule = {
	name: "store",
	run(inv) {
		const plugins = pluginsIn(inv, "store");
		if (plugins.length === 0) return [];
		const names = uniq(plugins.map((p) => nameOf(inv, p.slug)));
		const products = inv.types.filter((t) => STORE_TYPES.has(t.slug) && (t.slug === "product" || t.slug === "download")).reduce((n, t) => n + (t.count ?? 0), 0);
		const what = products > 0 ? `, with ${plural(products, "product", "products")}` : "";
		return [{
			area: "store",
			score: "blocker",
			...(products > 0 ? { count: products } : {}),
			items: names,
			reason: `${list(names)} ${names.length === 1 ? "runs" : "run"} the store${what}. The new site cannot take orders without a store service.`,
			next: "Pick a store path below before you move.",
		}];
	},
};

const members: Rule = {
	name: "members",
	run(inv) {
		const plugins = pluginsIn(inv, "members");
		if (plugins.length === 0) return [];
		const names = uniq(plugins.map((p) => nameOf(inv, p.slug)));
		return [{
			area: "members",
			score: "blocker",
			items: names,
			reason: `${list(names)} ${names.length === 1 ? "runs" : "run"} a member area. Logins and paid access do not move to the new site.`,
			next: "Use a ready-made member tool such as Memberful, and link to it from the new site. See the ready-made path below.",
		}];
	},
};

const courses: Rule = {
	name: "courses",
	run(inv) {
		const plugins = pluginsIn(inv, "courses");
		if (plugins.length === 0) return [];
		const names = uniq(plugins.map((p) => nameOf(inv, p.slug)));
		return [{
			area: "courses",
			score: "blocker",
			items: names,
			reason: `${list(names)} ${names.length === 1 ? "runs" : "run"} your courses. Lessons, logins and progress do not move to the new site.`,
			next: "Use a ready-made course tool such as Podia, and link to it from the new site. See the ready-made path below.",
		}];
	},
};

const forms: Rule = {
	name: "forms",
	run(inv) {
		const plugins = pluginsIn(inv, "forms");
		if (plugins.length === 0) return [];
		const names = uniq(plugins.map((p) => nameOf(inv, p.slug)));
		// The form plugin's shortcodes are the same forms, so they are counted here, not as shortcodes.
		const codes = formShortcodes(inv);
		const pages = new Set(codes.flatMap((s) => s.samples)).size;
		const setup = !levelOneOnly(inv) && (inv.types.some((t) => t.slug === "wpcf7_contact_form") || plugins.some((p) => p.slug === "contact-form-7")) ? " The export holds each form's setup (its fields and mail settings) as a wpcf7_contact_form item. Use it to rebuild the forms." : "";
		const placed = codes.length ? ` ${list(uniq(codes.map((s) => `[${s.name}]`)))} ${codes.length === 1 ? "places" : "place"} them in the content.` : "";
		return [{
			area: "forms",
			score: "some-work",
			...(pages > 0 ? { count: Math.max(pages, ...codes.map((s) => s.count)) } : {}),
			items: names,
			reason: `${list(names)} ${names.length === 1 ? "runs" : "run"} your forms.${placed} The forms need a new place to send messages.${setup}`,
			next: "Rebuild each form on the new site. Send it to a form service or your own form handler.",
		}];
	},
};

const hiddenTypes: Rule = {
	name: "hidden-types",
	run(inv) {
		const hidden = contentTypes(inv).filter((t) => t.count === undefined);
		if (hidden.length === 0) return [];
		const items = uniq(hidden.map((t) => t.slug));
		// Hidden plugin types are not listed: they are plugin data, left out of the move.
		const plugin = uniq(inv.types.filter((t) => t.count === undefined && !PLUMBING_TYPES.has(t.slug) && isPluginPostType(t.slug)).map((t) => t.slug));
		const left = plugin.length ? ` ${list(plugin)} ${plugin.length === 1 ? "is" : "are"} plugin data, left out of the move.` : "";
		const next = levelOneOnly(inv)
			? "An export (level 2) or the password (level 3) shows them."
			: !inv.levels.includes(3)
				? "The password (level 3) shows them. It needs an application password."
				: "Use the EmDash Exporter plugin to see these.";
		return [{
			area: "hidden-types",
			score: "some-work",
			count: items.length,
			items,
			reason: `${plural(items.length, "content type is", "content types are")} hidden from this run: ${list(items)}. ${items.length === 1 ? "Its count and fields are" : "Their counts and fields are"} not known yet.${left}`,
			next,
		}];
	},
};

const storedElsewhere: Rule = {
	name: "stored-elsewhere",
	run(inv) {
		// Flamingo has its own finding.
		const stored = inv.storedElsewhere.filter((s) => s.plugin !== "flamingo");
		if (stored.length === 0) return [];
		const owners = uniq(stored.map((s) => nameOf(inv, s.plugin)));
		const parts = stored.map((s) => `${s.what} (${nameOf(inv, s.plugin)})`);
		return [{
			area: "stored-data",
			score: "some-work",
			items: uniq(stored.map((s) => `${s.plugin}: ${s.what}`)),
			reason: `Some data is kept in plugin tables, not in the posts: ${list(uniq(parts))}.`,
			next: `This data stays in WordPress. Export it with ${list(owners)} before you turn the old site off.`,
		}];
	},
};

const FLAMINGO_TYPES = ["flamingo_inbound", "flamingo_contact"];

/** Flamingo keeps Contact Form 7's messages and contacts as its own post types. No import brings them. */
const flamingo: Rule = {
	name: "flamingo",
	run(inv) {
		const countOf = (slug: string): number => inv.types.find((t) => t.slug === slug)?.count ?? 0;
		const [messages, contacts] = FLAMINGO_TYPES.map(countOf) as [number, number];
		const active = inv.plugins.some((p) => p.slug === "flamingo" && p.active !== false) || inv.storedElsewhere.some((s) => s.plugin === "flamingo");
		if (!messages && !contacts && !active) return [];
		const items = FLAMINGO_TYPES.filter((slug) => countOf(slug) > 0);
		const what = items.length
			? `${list([messages ? plural(messages, "saved form message", "saved form messages") : "", contacts ? plural(contacts, "contact", "contacts") : ""].filter(Boolean))} (Flamingo).`
			: "Flamingo saves form messages and contacts.";
		return [{
			area: "stored-data",
			score: "some-work",
			...(items.length ? { count: items.length, items } : {}),
			reason: `${what} Neither EmDash nor plain Astro imports them. Save them before you switch off WordPress.`,
			next: "Copy the messages and contacts out of Flamingo in the WordPress admin, and keep them somewhere safe.",
		}];
	},
};

const languages: Rule = {
	name: "languages",
	run(inv) {
		if (inv.site.locales.length < 2) return [];
		const items = uniq(inv.site.locales.map((l) => l.code));
		const prefix = inv.site.locales.find((l) => l.prefix)?.prefix;
		return [{
			area: "languages",
			score: "some-work",
			count: items.length,
			items,
			reason: `The site has ${items.length} languages: ${list(items)}. Each translation must stay linked to its original.`,
			next: prefix ? `Keep each language at its old address, such as /${prefix}/, and move the translations together.` : "Keep each language at its old address, and move the translations together.",
		}];
	},
};

const ENTRY_KINDS = new Set(["post", "page", "custom"]);
const bare = (p: string): string => (p.length > 1 && p.endsWith("/") ? p.replace(/\/+$/, "") : p);
const SHOWN = 2; // example menu links in a reason

// What each kind of old URL is called in the addresses reason.
const KIND_WORDS: Record<string, [string, string]> = {
	post: ["post", "posts"],
	page: ["page", "pages"],
	custom: ["custom entry", "custom entries"],
	category: ["term", "terms"],
	tag: ["term", "terms"],
	term: ["term", "terms"],
	author: ["author page", "author pages"],
	date: ["date archive", "date archives"],
	feed: ["feed", "feeds"],
	attachment: ["attachment page", "attachment pages"],
	paged: ["later list page", "later list pages"],
	home: ["home page", "home pages"],
	archive: ["post type archive", "post type archives"],
};

/**
 * "120 posts, 51 date archives and 1 term": each group with its count, biggest first.
 * Query URLs are one group, unless they are the site's own addresses (plain permalinks).
 */
function groups(rows: Row[], plain: boolean): string {
	const counts = new Map<string, { n: number; words: [string, string] }>();
	for (const r of rows) {
		const front = r.new === "/" && (r.kind === "page" || r.kind === "query"); // the front page, by path or by ?page_id=
		const words: [string, string] = !plain && r.old.includes("?") ? ["query URL", "query URLs"] : front ? (KIND_WORDS.home as [string, string]) : (KIND_WORDS[r.kind] ?? ["other address", "other addresses"]);
		const g = counts.get(words[1]) ?? { n: 0, words };
		g.n++;
		counts.set(words[1], g);
	}
	const sorted = [...counts.values()].sort((a, b) => b.n - a.n || (a.words[1] < b.words[1] ? -1 : 1));
	// At most GROUPS named, so the sentence stays short; the rest are summed, so the parts still add up.
	const named = sorted.length > GROUPS ? sorted.slice(0, GROUPS - 1) : sorted;
	const rest = sorted.slice(named.length).reduce((n, g) => n + g.n, 0);
	return list([...named.map((g) => plural(g.n, g.words[0], g.words[1])), ...(rest ? [plural(rest, "other address", "other addresses")] : [])]);
}
const GROUPS = 7;

/**
 * Addresses: every old URL that changes on at least one target (a new path, a lost slash,
 * a move out of the base path, a query URL), plus every one that goes to review. The rows
 * come from the redirect plan for both targets, so the finding and the plan never disagree.
 * The reason gives one number per target, split into groups that add up to it.
 */
const addresses: Rule = {
	name: "addresses",
	run(inv, { model }) {
		const astroRows = planRedirects(inv, model, { target: "astro" });
		const emdashRows = planRedirects(inv, model, { target: "emdash" });
		const astro = new Map<string, Row>(astroRows.map((r) => [r.old, r]));
		const items = uniq([...astroRows, ...emdashRows].filter((r) => r.status !== "same").map((r) => r.old));
		if (items.length === 0) return [];
		const base = siteBase(new URL(inv.site.url));
		const inBase = (p: string): string => (base !== "/" && p.startsWith(base) ? `/${p.slice(base.length)}` : p);
		const plain = !inv.permalinks.structure;

		const parts: string[] = [`${plural(items.length, "old address changes", "old addresses change")} on plain Astro, on EmDash or on both.`];
		for (const [name, rows] of [["plain Astro", astroRows], ["EmDash", emdashRows]] as const) {
			const moved = rows.filter((r) => r.status === "301");
			const review = rows.filter((r) => r.status === "review");
			const n = moved.length + review.length;
			if (n === 0) {
				parts.push(`On ${name}, none change.`);
				continue;
			}
			const verb = n === 1 ? "changes" : "change";
			if (!review.length) {
				parts.push(`On ${name}, ${n} ${verb}: ${groups(moved, plain)}.`);
				continue;
			}
			parts.push(`On ${name}, ${n} ${verb}.`);
			if (moved.length) parts.push(`${moved.length} get a redirect: ${groups(moved, plain)}.`);
			parts.push(`${review.length} ${review.length === 1 ? "needs" : "need"} a new page picked by hand: ${groups(review, plain)}.`);
		}

		// Why, with examples: entries first, since those are the addresses people know.
		const eg = (rows: Row[]): string => list([...rows].sort((x, y) => Number(!ENTRY_KINDS.has(x.kind)) - Number(!ENTRY_KINDS.has(y.kind))).slice(0, 2).map((r) => `${r.old} to ${r.new}`));
		const moved = astroRows.filter((r) => r.status === "301");
		if (base !== "/") parts.push(`The old site is at ${base}, and the new site is at the root, so the addresses move out of ${base}.`);
		const queries = moved.filter((r) => r.old.includes("?"));
		if (plain && queries.length) parts.push(`The old site uses plain addresses such as /?p=123. They move to readable paths, for example ${eg(queries)}.`);
		const posts = moved.filter((r) => r.kind === "post" && !r.old.includes("?") && bare(inBase(r.old)) !== bare(r.new));
		if (posts.length) {
			const route = model.collections.find((c) => c.from === "post")?.route;
			const from = inv.permalinks.structure ? ` from ${inv.permalinks.structure}` : "";
			parts.push(`Post addresses change${from}${route ? ` to ${route}` : ""}, for example ${eg(posts)}.`);
		}
		const nested: Row[] = [];
		const slash: Row[] = [];
		const clashes = new Set<string>();
		for (const r of emdashRows) {
			const a = astro.get(r.old);
			if (!a || a.status === "review") continue;
			if (r.status === "review") {
				if (ENTRY_KINDS.has(r.kind) && clashingNote(r.note)) clashes.add(r.old);
				continue;
			}
			if (r.status !== "301" || r.old.includes("?")) continue;
			if (ENTRY_KINDS.has(r.kind) && bare(a.new) !== r.new) nested.push(r);
			else if (a.new.length > 1 && a.new.endsWith("/") && bare(a.new) === r.new) slash.push(r);
		}
		if (nested.length) parts.push(`On EmDash, ${nested.every((r) => r.kind === "page") ? "nested pages move" : "nested entries move"} to /<slug>, for example ${eg(nested)}. Plain Astro keeps the nested paths.`);
		if (slash.length) parts.push(`On EmDash, addresses lose the slash at the end, for example ${eg(slash)}.`);
		if (clashes.size) parts.push(`${plural(clashes.size, "page shares", "pages share")} a slug, so on EmDash they would land on one address: ${list([...clashes].sort())}.`);
		const review = [...astroRows, ...emdashRows].some((r) => r.status === "review");
		return [{
			area: "addresses",
			score: review ? "some-work" : "easy",
			count: items.length,
			items,
			reason: parts.join(" "),
			next: clashes.size
				? "Use the redirect plan for the moved pages. Give each clashing page a new slug, then map it by hand."
				: review
					? "Use the redirect plan, so the old addresses send visitors to the new ones. Pick a new page by hand for each review row in redirects.csv."
					: "Use the redirect plan, so the old addresses send visitors to the new ones.",
		}];
	},
};

/** A review row that is there because two old pages land on one new path (plan.ts). */
const clashingNote = (note: string): boolean => /different old pages land on/.test(note);

const media: Rule = {
	name: "media",
	run(inv, { model }) {
		const count = inv.media?.count ?? 0;
		if (count === 0) return [];
		const typed = (fields: Model["collections"][number]["fields"]): boolean => fields.some((f) => f.type === "image" || f.type === "file" || typed(f.subfields ?? []));
		const pointed = model.collections.some((c) => typed(c.fields)) ? " Image and file fields point to them." : "";
		return [{
			area: "media",
			score: "easy",
			count,
			reason: `${plural(count, "media file is", "media files are")} listed. This tool does not download them.`,
			next: `Copy the files from wp-content/uploads to the new site before you build it.${pointed}`,
		}];
	},
};

/** Menu links whose EmDash URL differs from model.json (slash changes too), as the seed writes them. */
function menuChanges(model: Model, items: ModelMenuItem[], clashes: Set<string>): { moved: string[]; unset: string[] } {
	const moved: string[] = [];
	const unset: string[] = [];
	const walk = (list: ModelMenuItem[]): void => {
		for (const i of list) {
			const now = emdashUrlFor(model, i.url);
			if (clashes.has(now.replace(/[?#].*$/, ""))) unset.push(i.label);
			else if (now !== i.url) moved.push(`${i.label}: ${i.url} to ${now}`);
			walk(i.children ?? []);
		}
	};
	walk(items);
	return { moved, unset };
}

const countItems = (items: ModelMenuItem[]): number => items.reduce((n, i) => n + 1 + countItems(i.children ?? []), 0);

/**
 * Menus: one item per menu. Classic menus move with the seed; a block theme's Navigation
 * block (kind "block", or a wp_navigation post whose links were not read) is rebuilt by hand.
 */
const menus: Rule = {
	name: "menus",
	run(inv, { model }) {
		// Menus are keyed on name plus kind: a block theme's Navigation block often has the
		// same name as the classic menu.
		const blocks = inv.menus.filter((m) => m.kind === "block");
		const classicInv = inv.menus.filter((m) => m.kind !== "block");
		const named = (m: { name: string; label: string }, list: { name: string }[]): boolean => list.some((x) => x.name === m.label || x.name === m.name);
		// A model menu is classic unless only a Navigation block has its name.
		const classic = model.menus.filter((m) => named(m, classicInv) || !named(m, blocks));
		const unmodeled = classicInv.filter((m) => !model.menus.some((x) => x.label === m.name || x.name === m.name));
		const navPosts = inv.types.find((t) => t.slug === "wp_navigation")?.count ?? 0;
		const unread = classic.length === 0 && unmodeled.length === 0 && blocks.length === 0 && navPosts > 0;
		if (classic.length === 0 && unmodeled.length === 0 && blocks.length === 0 && !unread) return [];
		const parts: string[] = [];
		const nexts: string[] = [];
		const moving = [...classic.map((m) => countItems(m.items)), ...unmodeled.map((m) => m.items.length)];
		if (moving.length) {
			const links = moving.reduce((a, b) => a + b, 0);
			parts.push(`${plural(moving.length, "menu", "menus")} with ${plural(links, "link", "links")} ${moving.length === 1 ? "moves" : "move"} over.`);
			const clashes = new Set(clashingPaths(inv, model, { target: "emdash" }));
			const { moved, unset } = classic.reduce((acc, m) => {
				const c = menuChanges(model, m.items, clashes);
				return { moved: [...acc.moved, ...c.moved], unset: [...acc.unset, ...c.unset] };
			}, { moved: [] as string[], unset: [] as string[] });
			if (moved.length) parts.push(`On EmDash, ${plural(moved.length, "link changes", "links change")} with the page addresses: ${list(moved.length > SHOWN ? [...moved.slice(0, SHOWN), `${moved.length - SHOWN} more`] : moved)}.`);
			if (unset.length) parts.push(`On EmDash, ${plural(unset.length, "link points", "links point")} at an address two pages share: ${list(unset)}. Set ${unset.length === 1 ? "it" : "them"} after the import.`);
			nexts.push(moved.length || unset.length ? "The EmDash seed already uses the new links. Check each menu after the import." : "Check each menu after the import.");
		}
		for (const b of blocks) parts.push(`"${b.name}" is a Navigation block. Rebuild the Navigation block by hand: ${plural(b.items.length, "link", "links")}.`);
		if (unread) parts.push(navPosts === 1 ? "The site's menu is a Navigation block, and its links were not read. Rebuild the Navigation block by hand." : `The site's menus are ${navPosts} Navigation blocks, and their links were not read. Rebuild each Navigation block by hand.`);
		if (blocks.length || unread) nexts.push("Build each Navigation block as a menu on the new site, with the same links.");
		const names = uniq([...classic.map((m) => m.label), ...unmodeled.map((m) => m.name), ...blocks.map((b) => `${b.name} (Navigation block)`)]);
		return [{
			area: "menus",
			score: "easy",
			count: unread ? navPosts : names.length,
			...(names.length ? { items: names } : {}),
			reason: parts.join(" "),
			next: nexts.join(" "),
		}];
	},
};

/** Every rule, in report order. */
export const RULES: Rule[] = [coreContent, customTypes, simpleFields, nestedFields, unclearFields, builders, shortcodes, comments, store, members, courses, forms, hiddenTypes, storedElsewhere, flamingo, languages, addresses, media, menus];

/** The ways to sell or run paid access after the move. Given when the site has a store, members or courses. */
export function storePaths(inv: Inventory): StorePath[] | undefined {
	const shop = hasStore(inv);
	const access = pluginsIn(inv, "members").length > 0 || pluginsIn(inv, "courses").length > 0;
	if (!shop && !access) return undefined;
	const paths: StorePath[] = [];
	if (shop) {
		paths.push(
			{ kind: "digital", title: "Digital goods with a hosted checkout", reason: "For downloads, ebooks and other digital goods. The site stays static, and the checkout service handles payment and tax.", links: [LINKS.polar as Link] },
			{ kind: "physical", title: "Physical goods with a headless store backend", reason: "The backend handles carts, shipping, tax and stock. Astro renders the store pages.", links: [] },
			{ kind: "buy-button", title: "A Buy button for a few items", reason: "Add a Buy button to each product page. Check that it handles your variants, tax and shipping.", links: [LINKS.buyButton as Link, LINKS.snipcart as Link] },
		);
	}
	const ready: Link[] = [];
	if (shop) ready.push(LINKS.shopify as Link);
	if (access) ready.push(LINKS.podia as Link, LINKS.memberful as Link);
	const title = shop && access ? "A ready-made tool" : shop ? "A ready-made store" : "A ready-made course or member tool";
	paths.push({ kind: "ready-made", title, reason: "Fast to set up, for a monthly fee. The tool runs it for you, and your site links to it.", links: ready });
	return paths;
}
