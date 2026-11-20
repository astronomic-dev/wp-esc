// The content model: propose model.json from an inventory, check a reviewed model,
// and write the Astro content config and the EmDash seed from it.

import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { MODEL_VERSION, type Model, type ModelField, type ModelFieldType, type Route } from "../contracts/model.ts";
import { REPEATER_SUB_FIELD_TYPES, RESERVED_COLLECTION_SLUGS, RESERVED_FIELD_SLUGS } from "./propose.ts";
import { toAstroConfig } from "./astro.ts";
import type { ExporterAnalyze as ExporterAnalyzeShape } from "./exporter.ts";
import { seedWithNotes, type SeedEvidence } from "./seed.ts";
import { clashingPaths } from "../redirects/plan.ts";
import { analyzeUrlFor, emdashStepsText, type SeedFile, type StepsContext } from "../emdash/steps.ts";
import type { Inventory } from "../contracts/inventory.ts";

export { collectionSlugFor, fieldSlugFor, isPlumbingKey, propose, taxonomySlugFor } from "./propose.ts";
export { toAstroConfig } from "./astro.ts";
export { emdashUrlFor, seedNotes, seedOf, seedWithNotes, storageTypeFor, toSeed, urlPatternFor, type SeedEvidence } from "./seed.ts";
export { exporterGuess, guessField, flatKeys, seedGuess, type ExporterAnalyze } from "./exporter.ts";

const SLUG = /^[a-z][a-z0-9_]*$/;
const TYPES: ModelFieldType[] = ["string", "text", "url", "number", "integer", "boolean", "datetime", "select", "multiSelect", "image", "file", "reference", "slug", "repeater", "portableText", "json"];

function checkRoute(where: string, route: string, errors: string[]): void {
	if (!route.startsWith("/")) errors.push(`${where}: the route ${route} must start with /`);
	else if (/^\/[/\\]/.test(route)) errors.push(`${where}: the route ${JSON.stringify(route)} must not start with // (that points to another site)`);
	if (/[\s\x00-\x1f\x7f\\]/.test(route)) errors.push(`${where}: the route ${JSON.stringify(route)} must not hold spaces, control characters or backslashes`);
	for (const token of route.match(/\{[^}]*\}/g) ?? []) {
		if (token !== "{slug}" && token !== "{path}") errors.push(`${where}: unknown token ${token} in ${route}`);
	}
	for (const segment of route.split("/")) {
		if ((segment.match(/\{/g) ?? []).length > 1) errors.push(`${where}: one token per path segment in ${route}`);
	}
}

function checkFields(where: string, fields: ModelField[], inRepeater: boolean, collections: Set<string>, errors: string[]): void {
	const names = new Set<string>();
	for (const f of fields) {
		const at = `${where}.${f.name}`;
		if (!SLUG.test(f.name) || f.name.length > 63) errors.push(`${at}: field names use a-z, 0-9 and _, start with a letter, and are at most 63 characters`);
		if (!inRepeater && RESERVED_FIELD_SLUGS.includes(f.name)) errors.push(`${at}: ${f.name} is reserved in EmDash`);
		if (names.has(f.name)) errors.push(`${at}: duplicate field name`);
		names.add(f.name);
		if (!f.label) errors.push(`${at}: a label is required`);
		if (!TYPES.includes(f.type)) errors.push(`${at}: unknown type ${f.type}`);
		if (inRepeater && !REPEATER_SUB_FIELD_TYPES.includes(f.type)) errors.push(`${at}: repeater rows take only ${REPEATER_SUB_FIELD_TYPES.join(", ")}`);
		if ((f.type === "select" || f.type === "multiSelect") && !f.options?.length) errors.push(`${at}: a ${f.type} field needs options`);
		if (f.type === "reference" && f.target && !collections.has(f.target)) errors.push(`${at}: the target ${f.target} is not a collection`);
		if (f.type === "repeater") {
			if (!f.subfields?.length) errors.push(`${at}: a repeater needs subfields`);
			else checkFields(at, f.subfields, true, collections, errors);
		} else if (f.subfields?.length) errors.push(`${at}: only a repeater has subfields`);
	}
}

/** Problems in a (hand-edited) model that would break the config or the seed. Empty when fine. */
export function validateModel(model: Model): string[] {
	const errors: string[] = [];
	if (model.version !== MODEL_VERSION) errors.push(`version: expected ${MODEL_VERSION}, got ${String(model.version)}`);
	let protocol = "";
	try {
		protocol = new URL(model.site?.url ?? "").protocol;
	} catch {}
	if (protocol !== "http:" && protocol !== "https:") errors.push(`site.url: ${JSON.stringify(model.site?.url)} is not an http(s) URL`);
	const collections = new Set<string>();
	for (const c of model.collections ?? []) {
		const at = `collections.${c.slug}`;
		if (!SLUG.test(c.slug) || c.slug.length > 63) errors.push(`${at}: collection slugs use a-z, 0-9 and _, start with a letter, and are at most 63 characters`);
		if (RESERVED_COLLECTION_SLUGS.includes(c.slug)) errors.push(`${at}: ${c.slug} is reserved in EmDash`);
		if (collections.has(c.slug)) errors.push(`${at}: duplicate collection slug`);
		collections.add(c.slug);
		if (!c.label) errors.push(`${at}: a label is required`);
		if (c.route) checkRoute(at, c.route, errors);
	}
	const taxonomies = new Set((model.taxonomies ?? []).map((t) => t.slug));
	for (const c of model.collections ?? []) {
		checkFields(`collections.${c.slug}`, c.fields ?? [], false, collections, errors);
		for (const t of c.taxonomies ?? []) if (!taxonomies.has(t)) errors.push(`collections.${c.slug}: the taxonomy ${t} is not in taxonomies`);
	}
	const seenTaxonomies = new Set<string>();
	for (const t of model.taxonomies ?? []) {
		if (seenTaxonomies.has(t.slug)) errors.push(`taxonomies.${t.slug}: duplicate taxonomy slug`);
		seenTaxonomies.add(t.slug);
		for (const c of t.collections) if (!collections.has(c)) errors.push(`taxonomies.${t.slug}: the collection ${c} is not in collections`);
		if (t.route) checkRoute(`taxonomies.${t.slug}`, t.route, errors);
	}
	for (const r of model.routes ?? []) checkRoute(`routes.${r.kind}`, r.pattern, errors);
	const menus = new Set<string>();
	for (const m of model.menus ?? []) {
		if (menus.has(m.name)) errors.push(`menus.${m.name}: duplicate menu name`);
		menus.add(m.name);
	}
	return errors;
}

/** How many `check` notes the model holds: on collections, fields (repeater rows too), taxonomies and menus. "Left out" notes are not counted. */
export function checkCount(model: Model): number {
	const inFields = (fields: ModelField[]): number => fields.reduce((n, f) => n + (f.check ? 1 : 0) + inFields(f.subfields ?? []), 0);
	return model.collections.reduce((n, c) => n + (c.check ? 1 : 0) + inFields(c.fields), 0) + model.taxonomies.filter((t) => t.check).length + model.menus.filter((m) => m.check).length;
}

/** How many "Left out" notes the model holds: on the model and on its collections. */
export function leftOutCount(model: Model): number {
	return (model.leftOut?.length ?? 0) + model.collections.reduce((n, c) => n + (c.leftOut?.length ?? 0), 0);
}

/** Reads a model.json and checks it. Throws with every problem listed. */
export async function readModel(file: string): Promise<Model> {
	const model = JSON.parse(await readFile(file, "utf8")) as Model;
	const errors = validateModel(model);
	if (errors.length) throw new Error(`${file} has problems:\n${errors.map((e) => `  - ${e}`).join("\n")}`);
	return model;
}

async function put(file: string, text: string): Promise<string> {
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, text, "utf8");
	return file;
}

/** Where the seed's field types came from, in words. */
export function seedEvidenceText(evidence: SeedEvidence): string {
	return evidence.analyze ? "the Exporter's analyze response" : evidence.inventory ? "the inventory's stored samples" : "the model alone (no inventory.json found)";
}

const SEO_NAMES: Record<string, string> = { "wordpress-seo": "Yoast SEO", "wordpress-seo-premium": "Yoast SEO Premium", "seo-by-rank-math": "Rank Math SEO" };

/** The SEO plugins the inventory found, by name; undefined without an inventory. */
export function seoPlugins(inv: Inventory | undefined): string[] | undefined {
	if (!inv) return undefined;
	return [...new Set(inv.plugins.filter((p) => p.category === "seo" && p.active !== false).map((p) => SEO_NAMES[p.slug] ?? p.name ?? p.slug))];
}

const FRESH = "A fresh EmDash site";

// EmDash 1.4.0 adds only /sitemap.xml, /sitemap-[collection].xml and /robots.txt to the
// site (astro/integration/routes.ts); it has no feed and no author pages.
/** The section on old-site pages EmDash does not make, or nothing when the model has none. */
function pagesToBuild(routes: Route[]): string[] {
	const lines: string[] = [];
	const feed = routes.find((r) => r.kind === "feed");
	const author = routes.find((r) => r.kind === "author");
	if (feed) lines.push(`- Feed: the old site had an RSS feed. EmDash does not make one (it adds only /sitemap.xml and /robots.txt), so build it at ${feed.pattern} in the site, for example with @astrojs/rss from the posts collection.`);
	if (author) {
		const at = author.pattern.length > 1 && author.pattern.endsWith("/") ? author.pattern.slice(0, -1) : author.pattern;
		lines.push(`- Author pages: the old site had them. EmDash does not make them, so build a page at ${at} (for example src/pages/author/[slug].astro) that lists each author's posts. Or leave them out, and send the old author URLs to the posts list.`);
	}
	return lines.length ? ["## Pages EmDash does not make", "", ...lines, ""] : [];
}

/** The text of seed/emdash-steps.md: how the seed differs from model.json, then the import steps for a fresh and an existing EmDash site. */
export function emdashStepsFile(seed: SeedFile, notes: string[], evidence: SeedEvidence, guessed: string[] = [], siteUrl?: string, routes: Route[] = []): string {
	const site = evidence.inventory?.site.url ?? siteUrl;
	const about: StepsContext = { analyze: !!evidence.analyze, guessed, seo: seoPlugins(evidence.inventory), ...(site ? { analyzeUrl: analyzeUrlFor(site, evidence.inventory?.site.apiRoot) } : {}) };
	const source = evidence.analyze
		? `the Exporter's analyze response${guessed.length ? `, except ${guessed.join(", ")}: the response does not list ${guessed.length > 1 ? "them, so their types are guesses" : "it, so its type is a guess"} (see the notes below)` : ""}`
		: seedEvidenceText(evidence);
	const lines = [
		"# EmDash import steps",
		"",
		`seed/seed.json is the EmDash schema for this move. Its custom field types come from ${source}.${evidence.analyze ? "" : " For an exact match with EmDash's import screen, write it again with --emdash-analyze <file>."}`,
		"",
		"## How the seed differs from model.json",
		"",
		"model.json and src/content.config.ts keep the richer types; the seed follows what EmDash's WordPress import asks for.",
		"",
		...(notes.length ? notes.map((n) => `- ${n}`) : ["- No differences."]),
		"",
		...pagesToBuild(routes),
		`## ${FRESH}`,
		"",
		emdashStepsText(seed, "fresh", about).trimEnd(),
		"",
		"## An EmDash site that is already set up",
		"",
		emdashStepsText(seed, "existing", { ...about, analyzeAbove: FRESH }).trimEnd(),
		"",
	];
	return lines.join("\n");
}

/**
 * Writes src/content.config.ts and/or seed/seed.json (with seed/emdash-steps.md) under
 * `out`. Returns the files written. `evidence` (the inventory, the Exporter's analyze
 * response) types the seed's custom fields.
 */
export async function writeModelFiles(model: Model, out: string, which: { astro?: boolean; seed?: boolean }, evidence: SeedEvidence = {}): Promise<string[]> {
	const written: string[] = [];
	if (which.astro) written.push(await put(join(out, "src/content.config.ts"), toAstroConfig(model)));
	if (which.seed) {
		const withClashes = evidence.inventory && !evidence.clashes ? { ...evidence, clashes: clashingPaths(evidence.inventory, model, { target: "emdash" }) } : evidence;
		const { seed, notes, guessed } = seedWithNotes(model, withClashes);
		written.push(await put(join(out, "seed/seed.json"), `${JSON.stringify(seed, null, "\t")}\n`));
		written.push(await put(join(out, "seed/emdash-steps.md"), emdashStepsFile(seed as unknown as SeedFile, notes, evidence, guessed, model.site.url, model.routes)));
	}
	return written;
}

/** Reads an Exporter analyze response (GET /wp-json/emdash/v1/analyze) and checks its shape. */
export async function readAnalyze(file: string): Promise<ExporterAnalyzeShape> {
	const data = JSON.parse(await readFile(file, "utf8")) as ExporterAnalyzeShape;
	const ok = data && Array.isArray(data.post_types) && data.post_types.every((p) => typeof p?.name === "string" && (p.custom_fields === undefined || (Array.isArray(p.custom_fields) && p.custom_fields.every((f) => typeof f?.key === "string" && typeof f?.inferred_type === "string"))));
	if (!ok) throw new Error(`${file} is not an EmDash Exporter analyze response (no post_types with name and custom_fields)`);
	return data;
}
