// model.json -> seed/seed.json: an EmDash seed with schema only (collections, fields,
// taxonomies, menus; no content, terms or settings), in EmDash's seed field types.
// The shape follows EmDash 1.4.0's SeedFile (node_modules/emdash/src/seed/types.ts)
// and passes its validateSeed (src/seed/validate.ts); the slow test proves that.
//
// Every value is written through JSON.stringify, so no old-site text can break out.
//
// URL patterns: EmDash fills one path segment per placeholder and has no {path}, so a
// hierarchical route `/{path}/` becomes `/{slug}`. EmDash patterns carry no trailing slash.
// Terms too: EmDash finds a term by slug (taxonomies/index.ts getTerm) and its menus link
// one as /<taxonomy>/<slug> (menus/index.ts resolveTaxonomyUrl), so /category/{path}/
// becomes /category/{slug} on EmDash.
// Menu links follow the same rules (emdashUrlFor), so they point at the EmDash URLs.
//
// Where the seed differs from model.json (types, optional fields, added fields, flat
// rows, patterns, menu links), seedNotes says so; the CLI writes the notes with the
// import steps to seed/emdash-steps.md. model.json and content.config.ts carry none.

import type { Inventory } from "../contracts/inventory.ts";
import type { Collection, Model, ModelField, ModelFieldType, ModelMenuItem } from "../contracts/model.ts";
import { canonical } from "../contracts/write.ts";
import { collectionSlugFor, fieldSlugFor, isPlumbingKey } from "./propose.ts";
import { acfEmDashType, acfFieldsForPostType, exporterTypeForModel, flatKeys, guessField, inventoryField, isAcfRowMeta, mapInferredType, rowsArriveWhole, rowsCutShort, seedGuess, supportsThumbnail, type AcfFieldInfo, type ExporterAnalyze, type ExporterPostType } from "./exporter.ts";

type Json = Record<string, unknown>;

// Custom fields get the type EmDash's import will require of them (exporter.ts), and
// isTypeCompatible (src/import/utils.ts) accepts only: the same type; string <- string,
// text, slug; text <- string, text; number or integer <- number, integer; portableText
// <- portableText, json. So an `image` field would show "Incompatible".
// The best evidence wins:
//   1. the Exporter's own analyze response (--emdash-analyze): its ACF groups and
//      reported keys, with the slugs and types EmDash 1.4.0 makes of them, exactly;
//   2. the inventory: the Exporter's guess rules on the stored samples, which EmDash
//      accepts whether or not an ACF group is located on the post type; the ACF type only
//      for an ACF field on one entry or none (exporter.ts seedGuess);
//   3. the model alone: the key-name rules, then the type WordPress stores the value as.
// No custom field is required: EmDash rejects an imported entry that lacks a required
// value. Rows of a repeater the seed types as a row count arrive as flat keys
// (`faq_0_question`), so the seed adds those; an ACF repeater it types json gets its rows
// whole, so its flat row keys are left out. content.config.ts keeps the clean repeater.
const STORAGE: Partial<Record<ModelFieldType, ModelFieldType>> = {
	url: "string",
	select: "string",
	multiSelect: "json",
	boolean: "integer",
	datetime: "string",
	image: "integer",
	file: "integer",
	reference: "integer",
	repeater: "integer", // ACF stores the row count; the rows live in sub-keys
	slug: "string",
	portableText: "json",
};

/** The type WordPress stores a custom field of this model type as. */
export function storageTypeFor(type: ModelFieldType): ModelFieldType {
	return STORAGE[type] ?? type;
}

/** What the seed writer can use besides the model. */
export interface SeedEvidence {
	inventory?: Inventory;
	analyze?: ExporterAnalyze;
	/** EmDash paths two or more old pages land on (redirects/plan.ts clashingPaths); writeModelFiles fills it from the inventory. */
	clashes?: string[];
}

// EmDash's base fields keep their own types (BASE_REQUIRED_FIELDS, FEATURED_IMAGE_FIELD).
const CORE_FROM = new Set(["post_title", "post_content", "post_excerpt", "_thumbnail_id"]);
// The post dates are EmDash's own published_at and updated_at, which its import fills from WordPress.
const DATE_FROM = new Set(["post_date", "post_modified"]);

export function urlPatternFor(route: string): string {
	const p = route.replaceAll("{path}", "{slug}");
	return p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p;
}

const SEO_SLUGS = new Set(["seo_title", "seo_description", "seo_focus_keyphrase"]);
const FEATURED = { slug: "featured_image", label: "Featured image", type: "image" };

// EmDash's sanitizeFieldSlug, fieldLabelFromKey and isPluginBookkeepingMeta, as propose.ts has them.
const labelOf = (key: string): string => key.split(/[_-]+/).filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");

function baseField(f: ModelField): Json {
	const out: Json = { slug: f.name, label: f.label, type: f.type };
	if (f.required) out.required = true;
	if (f.searchable) out.searchable = true;
	return out;
}

/** The fields EmDash 1.4.0's analysis requires of a post type, from the analyze response (slug -> type, in order). */
function reportedFields(analyze: ExporterAnalyze, pt: ExporterPostType): Map<string, { type: string; label: string }> {
	const out = new Map<string, { type: string; label: string }>();
	const json: AcfFieldInfo[] = [];
	for (const f of acfFieldsForPostType(analyze.acf, pt.name)) {
		const slug = fieldSlugFor(f.name);
		if (out.has(slug)) continue;
		const type = acfEmDashType(f.type);
		if (type === "json") json.push(f);
		out.set(slug, { type, label: f.label || labelOf(f.name) });
	}
	for (const f of pt.custom_fields ?? []) {
		if (isPlumbingKey(f.key) && !f.key.startsWith("_")) continue; // isPluginBookkeepingMeta
		if (isAcfRowMeta(f.key, json)) continue;
		const slug = fieldSlugFor(f.key);
		if (!out.has(slug)) out.set(slug, { type: mapInferredType(f.inferred_type), label: labelOf(f.key) });
	}
	return out;
}

/** The seed fields for one collection, and notes on where they differ from the model. */
function seedFields(c: Collection, evidence: SeedEvidence): { fields: Json[]; notes: string[]; guessed: string[] } {
	// Every post type that imports into this collection: its own, then any EmDash names alike (propose.ts mergeRepeats).
	const ours = (name: string): boolean => name === c.from || collectionSlugFor(name) === c.slug;
	const first = <T>(list: T[], name: (x: T) => string): T[] => [...list.filter((x) => name(x) === c.from), ...list.filter((x) => name(x) !== c.from && ours(name(x)))];
	const types = first(evidence.inventory?.types ?? [], (t) => t.slug);
	const pts = first(evidence.analyze?.post_types ?? [], (p) => p.name);
	const pt = pts[0];
	const reported = new Map<string, { type: string; label: string }>();
	for (const p of pts) for (const [slug, r] of reportedFields(evidence.analyze as ExporterAnalyze, p)) if (!reported.has(slug)) reported.set(slug, r);
	const invField = (key: string) => types.map((t) => inventoryField(t, key)).find((f) => f !== undefined);
	const out: Json[] = [];
	const notes: string[] = [];
	const used = new Set<string>();
	const push = (field: Json): void => {
		used.add(field.slug as string);
		out.push(field);
	};
	const custom = (slug: string, label: string, guess: string): boolean => {
		if (used.has(slug)) return false;
		push({ slug, label, type: reported.get(slug)?.type ?? guess });
		return true;
	};
	for (const f of c.fields) if (CORE_FROM.has(f.from)) push(baseField(f));
	if ((pts.length ? pts.some(supportsThumbnail) : true) && !used.has(FEATURED.slug)) {
		push({ ...FEATURED });
		notes.push(`featured_image is in the seed but not in model.json: EmDash's import asks every post type ${pt ? "that supports featured images " : ""}for it, so the seed adds it (optional) and the import shows Ready.`);
	}
	const optional: string[] = [];
	const guessed: string[] = [];
	const dates = c.fields.filter((f) => DATE_FROM.has(f.from)).map((f) => f.name);
	if (dates.length) notes.push(`${dates.join(" and ")} ${dates.length > 1 ? "are" : "is"} not in the seed: EmDash keeps an entry's published and updated dates itself, and its import fills them from WordPress.`);
	for (const f of c.fields) {
		if (CORE_FROM.has(f.from) || DATE_FROM.has(f.from) || SEO_SLUGS.has(f.name)) continue;
		const inv = invField(f.from);
		// With the analyze response, a field takes the Exporter's slug for its key.
		const slug = pt && reported.has(fieldSlugFor(f.from)) ? fieldSlugFor(f.from) : f.name;
		const guess = inv ? seedGuess(f.from, inv) : undefined;
		if (!custom(slug, f.label, guess ? guess.type : exporterTypeForModel(f.from, storageTypeFor(f.type)))) continue;
		const type = (out.at(-1) as Json).type as string;
		if (f.required) optional.push(slug);
		if (slug !== f.name) notes.push(`${f.name} is named ${slug} in the seed, the slug EmDash's Exporter gives the key ${f.from}.`);
		if (type !== f.type) {
			const why = reported.has(slug) ? "the type EmDash's Exporter analysis reports" : guess ? "the type the Exporter's rules give for the stored samples" : `the type WordPress stores a ${f.type} value as`;
			notes.push(`${slug} is ${type} in the seed and ${f.type} in model.json and content.config.ts: ${why}, so EmDash's import accepts it.`);
		}
		// EmDash's import keeps a json value as it arrives (execute.ts coerceToFieldType), so a
		// relation list stored as serialized PHP may come in as that text, with old post IDs.
		if (type === "json" && inv?.shape === "relation" && inv.samples.some((v) => /^a:\d+:\{/.test(v.trim()))) {
			notes.push(`${slug}: the WordPress export stores these as serialized PHP (a:2:{...}), not as a list. EmDash's import keeps a json value as it arrives and does not turn it into an ID list. After the import, check that each entry holds a list of IDs, not the serialized text, then relink the old WordPress post IDs to the new entries.`);
		}
		if (guess?.risk && !reported.has(slug)) notes.push(`${slug}: ${guess.risk} If the import screen shows Incompatible, change the seed field to the type it names.`);
		if (evidence.analyze && !reported.has(slug)) {
			guessed.push(slug);
			const from = guess ? "the Exporter's rules on the inventory's samples" : "the model alone";
			if (pt) notes.push(`${slug}: the analyze response does not list ${f.from} for ${pt.name}, so its type (${type}) is a guess from ${from}, not an exact match. If the import screen shows Incompatible, change the seed field to the type it names.`);
		}
		if (f.type === "image" || f.type === "file") {
			const holds =
				type === "json"
					? "what ACF returns for it: by default an object with the WordPress attachment's id, url, alt and sizes (or only the URL or the ID, by the field's Return Format), with URLs on the old site"
					: type === "reference"
						? `the WordPress attachment ID, as a reference field (EmDash's Exporter makes a key that ends in ${/_[a-z]+$/.exec(f.from)?.[0] ?? "_image"} a reference; an image field with another name is an integer)`
						: type === "integer"
							? "the WordPress attachment ID, as an integer"
							: `the stored value as ${type}`;
			notes.push(`${slug}: after the import it holds ${holds}, not an EmDash ${f.type}. To make it a real ${f.type} field: after the media import, add a new ${f.type} field in Content Types, pick each entry's file from the media library (the one with the old value's file name, or the WordPress attachment with that ID), then delete ${slug} and rename the new field.`);
		}
		// Flat row keys: with the analyze response, only those it reports; else unless the rows arrive whole.
		const flat: string[] = [];
		if (inv && (pt || !rowsArriveWhole(f.from, inv))) {
			for (const k of flatKeys(f.from, inv)) {
				const s = fieldSlugFor(k.key);
				if ((!pt || reported.has(s)) && custom(s, labelOf(k.key), guessField(k.key, k.field).type)) flat.push(s);
			}
		}
		if (f.type === "repeater" || (inv && (inv.shape === "repeater" || inv.shape === "flexible"))) {
			const more = !pt && inv && rowsCutShort(inv) ? " The inventory's samples are cut short, so some entries may have more rows. The import screen adds those (Add fields)." : "";
			if (flat.length) notes.push(`${slug}: EmDash's import brings the rows in as flat fields (${flat.length > 4 ? `${flat.slice(0, 2).join(", ")} ... ${flat.at(-1)}` : flat.join(", ")}: ${flat.length} in all), which the seed adds as optional fields; content.config.ts keeps the ${f.name} list.${more}`);
			else if (type === "json") notes.push(`${slug}: EmDash's import brings the rows in whole, as json; content.config.ts keeps the ${f.name} list.`);
			else notes.push(`${slug}: EmDash's import brings the rows in as flat fields (${f.from}_0_...), which the import screen adds (Add fields); content.config.ts keeps the ${f.name} list.`);
		}
	}
	const extra: string[] = [];
	for (const [slug, r] of reported) if (custom(slug, r.label, r.type)) extra.push(slug);
	if (extra.length) notes.push(`The seed adds ${extra.join(", ")}, which EmDash's Exporter analysis reports but model.json does not have, so the import shows Ready.`);
	for (const f of c.fields) {
		if (!SEO_SLUGS.has(f.name) || used.has(f.name)) continue;
		push(baseField({ ...f, required: false }));
		// EmDash's Exporter import writes only seo_title and seo_description (execute.ts IMPORT_FIELDS).
		if (f.name === "seo_focus_keyphrase") notes.push(`seo_focus_keyphrase: EmDash's import does not bring the focus keyphrase (${f.from}) across, so the field stays empty. Copy the ones you need by hand, or delete the field.`);
	}
	if (evidence.analyze && !pt && guessed.length) notes.push(`The analyze response has no post type ${c.from}, so the types of ${guessed.join(", ")} are guesses from the inventory or the model, not an exact match. If the import screen shows Incompatible, change the seed field to the type it names.`);
	if (optional.length) notes.unshift(`${optional.join(", ")} ${optional.length > 1 ? "are" : "is"} required in model.json but optional in the seed: EmDash rejects an imported entry that lacks a required value, so turn Required on after the import, if at all.`);
	return { fields: out, notes, guessed };
}

// A menu link to a path two old pages land on would point at whichever page EmDash gives
// that slug, so it gets "#" (a custom item needs a url) and a note says to set it.
const PLACEHOLDER = "#";

function seedItem(i: ModelMenuItem, model: Model, moved: string[], clashes: Set<string>, unset: string[]): Json {
	let url = emdashUrlFor(model, i.url);
	const path = url.replace(/[?#].*$/, "");
	if (clashes.has(path)) {
		unset.push(`"${i.label}" (${path})`);
		url = PLACEHOLDER;
	} else if (url !== i.url) moved.push(`${i.url} -> ${url}`);
	const out: Json = { type: "custom", label: i.label, url };
	if (i.children?.length) out.children = i.children.map((x) => seedItem(x, model, moved, clashes, unset));
	return out;
}

const tokenRegex = (pattern: string): RegExp => new RegExp(`^${pattern.split(/(\{slug\}|\{path\})/).map((part) => (part === "{slug}" ? "([^/]+)" : part === "{path}" ? "(.+?)" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("")}$`);

/**
 * A model path (Astro target: the model's routes as written) as the EmDash site serves
 * it: an entry of a {path} collection moves to /<slug>, and no path but / has a trailing
 * slash (EmDash patterns have none). Addresses off the site stay as they are.
 */
export function emdashUrlFor(model: Model, url: string): string {
	if (!url.startsWith("/") || url.startsWith("//")) return url;
	const cut = url.search(/[?#]/);
	const full = cut === -1 ? url : url.slice(0, cut);
	const rest = cut === -1 ? "" : url.slice(cut);
	// A locale prefix (/fr/...) stays in front; the route is matched on the path after it.
	const prefix = model.locales.map((l) => l.prefix).find((p): p is string => !!p && (full === `/${p}` || full.startsWith(`/${p}/`)));
	if (prefix) {
		const inner = emdashUrlFor(model, full.slice(prefix.length + 1) || "/");
		return `/${prefix}${inner === "/" ? "" : inner}${rest}`;
	}
	const path = full;
	const strip = (p: string): string => (p.length > 1 && p.endsWith("/") ? p.replace(/\/+$/, "") : p);
	const fixed = new Set(model.routes.filter((r) => !r.pattern.includes("{")).map((r) => r.pattern));
	if (path === "/" || fixed.has(path)) return strip(path) + rest;
	// Literal routes first, so /services/ is not read as a page path.
	const flat = [...model.collections.filter((c) => c.route && !c.route.includes("{path}")).map((c) => c.route as string), ...model.taxonomies.map((t) => t.route).filter((r): r is string => !!r && !r.includes("{path}")), ...model.routes.filter((r) => r.pattern.includes("{")).map((r) => r.pattern)];
	if (flat.some((r) => tokenRegex(r).test(path))) return strip(path) + rest;
	// Nested routes: terms first (they have a fixed prefix), then entries. EmDash finds a term
	// by its slug alone (taxonomies getTerm), and its menus link terms as /<taxonomy>/<slug>,
	// so a nested term moves to /<prefix>/<slug>, like a nested page.
	const nested = [...model.taxonomies.map((t) => t.route), ...model.collections.map((c) => c.route)].filter((r): r is string => !!r && r.includes("{path}"));
	for (const route of nested) {
		const m = tokenRegex(route).exec(path);
		if (m) {
			const filled = m.slice(1).map((x) => x.split("/").at(-1) as string);
			let i = 0;
			return urlPatternFor(route).replace(/\{slug\}/g, () => filled[i++] ?? "") + rest;
		}
	}
	return strip(path) + rest;
}

const COUNT_WORDS = ["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];

/** The slugs two or more of a collection's old entries share, in words: "two pages use the slug pricing: /a/pricing/ and /b/pricing/". */
function duplicateSlugs(c: Collection, inv: Inventory | undefined): string[] {
	if (!inv) return [];
	const bySlug = new Map<string, string[]>();
	for (const u of inv.urls) {
		if (u.type !== c.from || !u.slug || !["post", "page", "custom", "home"].includes(u.kind)) continue;
		let path: string;
		try {
			path = new URL(u.url).pathname;
		} catch {
			continue;
		}
		const list = bySlug.get(u.slug) ?? [];
		if (!list.includes(path)) list.push(path);
		bySlug.set(u.slug, list);
	}
	const noun = c.label.toLowerCase();
	return [...bySlug]
		.filter(([, paths]) => paths.length > 1)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([slug, paths]) => {
			const sorted = [...paths].sort();
			const list = sorted.length > 2 ? `${sorted.slice(0, -1).join(", ")} and ${sorted.at(-1)}` : sorted.join(" and ");
			return `${COUNT_WORDS[sorted.length] ?? String(sorted.length)} ${noun} use the slug ${slug}: ${list}`;
		});
}

/**
 * The seed object for a model, the notes on where it differs from model.json, and
 * `guessed`: the custom fields (collection.field) an analyze response was given for but
 * does not list, so their types are guesses.
 */
export function seedWithNotes(input: Model, evidence: SeedEvidence = {}): { seed: Json; notes: string[]; guessed: string[] } {
	const model = canonical("model", input);
	const host = new URL(model.site.url).hostname;
	const notes: string[] = [];
	const moved: string[] = [];
	const guessed: string[] = [];
	const clashes = new Set(evidence.clashes ?? []);
	const unset: string[] = [];
	const collections = model.collections.map((c) => {
		const out: Json = { slug: c.slug, label: c.label };
		if (c.labelSingular) out.labelSingular = c.labelSingular;
		out.description = `From WordPress post type ${c.from}.`;
		if (c.route) out.urlPattern = urlPatternFor(c.route);
		out.supports = [...c.supports];
		const { fields, notes: own, guessed: g } = seedFields(c, evidence);
		for (const slug of g) guessed.push(`${c.slug}.${slug}`);
		out.fields = fields;
		if (c.route?.includes("{path}")) {
			const dups = duplicateSlugs(c, evidence.inventory);
			own.unshift(`urlPattern is ${urlPatternFor(c.route)}, not ${c.route}: EmDash has no {path}, so child entries move to /<slug> and duplicate slugs will clash${dups.length ? ` (${dups.join("; ")})` : ""}. The redirect plan for --target emdash maps the old nested URLs.`);
		}
		for (const n of own) notes.push(`${c.slug}: ${n}`);
		return out;
	});
	const seed: Json = {
		$schema: "https://emdashcms.com/seed.schema.json",
		version: "1",
		meta: { name: model.site.name ?? host, description: `Content model proposed from ${model.site.url}. Schema only: run EmDash's WordPress import for the content.` },
		collections,
		taxonomies: model.taxonomies.map((t) => {
			const out: Json = { name: t.slug, label: t.label };
			if (t.labelSingular) out.labelSingular = t.labelSingular;
			out.hierarchical = t.hierarchical;
			out.collections = [...t.collections];
			return out;
		}),
		menus: model.menus.map((m) => ({ name: m.name, label: m.label, items: m.items.map((i) => seedItem(i, model, moved, clashes, unset)) })),
	};
	for (const t of model.taxonomies) {
		if (t.route?.includes("{path}")) notes.push(`${t.slug}: term pages are at ${urlPatternFor(t.route)}, not ${t.route}: EmDash finds a term by its slug alone and links terms as /<taxonomy>/<slug>, so a child term moves to ${urlPatternFor(t.route).replace("{slug}", "<slug>")}. Duplicate term slugs will clash.`);
	}
	if (moved.length) notes.push(`menus: links use the EmDash URLs (child pages at /<slug>, no trailing slash), not the paths in model.json: ${moved.join(", ")}.`);
	if (unset.length) notes.push(`menus: check ${unset.join(", ")}: two or more old pages land on ${unset.length > 1 ? "those addresses" : "that address"} on EmDash (see the review rows in the emdash redirects.csv), so the seed links ${unset.length > 1 ? "them" : "it"} to ${PLACEHOLDER}. Give one page a new slug, then set the link under Menus after the import.`);
	return { seed, notes, guessed };
}

/** The seed object for a model, with the best evidence given for the custom field types. */
export function seedOf(input: Model, evidence: SeedEvidence = {}): Json {
	return seedWithNotes(input, evidence).seed;
}

/** Notes on where the seed differs from model.json and content.config.ts, one per line. */
export function seedNotes(input: Model, evidence: SeedEvidence = {}): string[] {
	return seedWithNotes(input, evidence).notes;
}

/** The text of seed/seed.json for a model. */
export function toSeed(model: Model, evidence: SeedEvidence = {}): string {
	return `${JSON.stringify(seedOf(model, evidence), null, "\t")}\n`;
}
