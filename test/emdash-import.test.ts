// The EmDash import proof (Task 9).
//
// Fast (always): src/emdash/steps.ts, and the generated seed checked against the EmDash
// Exporter's recorded analyze response for `business` (test/fixtures/business/
// emdash-analyze.json), with EmDash 1.4.0's own rules (src/import/sources/
// wordpress-plugin.ts analyze, src/import/utils.ts isTypeCompatible).
//
// Slow (WPM_SLOW=1; Docker, network for images and plugins): the real thing. `business`
// WordPress on 4602 with the Exporter and Yoast (test/sites/seed-emdash-exporter.sh), an
// EmDash site on 4604 (test/emdash/), and EmDash's import API, called the way its admin
// calls it: analyze, prepare, execute. Two procedures:
//   fresh:    the generated seed.json in place before first run; the setup wizard applies it.
//   existing: a site set up with EmDash's default seed; the test follows the steps
//             emdashSteps(seed, "existing") prints: add the fields in Content Types except
//             reference fields, which the import screen's Add fields (prepare) makes.
// Fresh shows every post type Ready with no prepare step; existing after Add fields.
// Then both import service and read its values back.
// WPM_RECORD=1 also rewrites the recorded analyze fixture from the live site.
//
// The seed comes from bin/wp-content-model.mjs on test/samples/business.real.inventory.json,
// the real inventory of the Docker site: level 1 replayed from test/fixtures/business/
// plus its export file (level 2). A fast test keeps the sample in step with the fixtures.
// A second seed comes from the Exporter's analyze response (--emdash-analyze), the path
// steps.ts recommends for an existing WordPress site.

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createReplayFetch } from "../src/http/replay.ts";
import { readPublic } from "../src/sources/public/index.ts";
import { readWxr } from "../src/sources/wxr/index.ts";
import { merge } from "../src/contracts/merge.ts";
import { stringify } from "../src/contracts/write.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { emdashSteps, emdashStepsText, leaveToImport, schemaToAdd, type SeedFile } from "../src/emdash/steps.ts";
import { EmDash } from "./emdash/api.ts";
import { startSite, starterPackage } from "./emdash/site.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const sites = join(root, "test/sites");
const FIXTURE = join(root, "test/fixtures/business/emdash-analyze.json");
const SAMPLE = join(root, "test/samples/business.real.inventory.json");
const slow = process.env.WPM_SLOW === "1";
const WP_PORT = Number(process.env.WPM_BUSINESS_PORT ?? 4602);
const EMDASH_PORT = Number(process.env.WPM_EMDASH_PORT ?? 4604);
const SHIM_HOST = "business.wp-esc.test";
const WP_URL = `http://${SHIM_HOST}/site`;

// ---- EmDash 1.4.0 rules, copied from node_modules/emdash/src/import ----

// utils.ts isTypeCompatible
function isTypeCompatible(required: string, existing: string): boolean {
	if (required === existing) return true;
	const ok: Record<string, string[]> = {
		string: ["string", "text", "slug"],
		text: ["string", "text"],
		portableText: ["portableText", "json"],
		number: ["number", "integer"],
		integer: ["number", "integer"],
	};
	return ok[required]?.includes(existing) ?? false;
}
// utils.ts sanitizeFieldSlug (RESERVED_FIELD_SLUGS from schema/types.ts)
const RESERVED = ["id", "slug", "status", "author_id", "primary_byline_id", "created_at", "updated_at", "published_at", "scheduled_at", "deleted_at", "version", "live_revision_id", "draft_revision_id", "terms", "bylines", "byline"];
function sanitizeFieldSlug(key: string): string {
	const s = key.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^[^a-z]+/, "").slice(0, 63);
	if (!s) return "field";
	return RESERVED.includes(s) ? `wp_${s}` : s;
}
// wordpress-plugin.ts mapInferredFieldType
const VALID_INFERRED = new Set(["string", "text", "number", "integer", "boolean", "datetime", "json", "reference"]);
const mapInferred = (t: string): string => (VALID_INFERRED.has(t) ? t : "string");
// utils.ts mapPostTypeToCollection, sanitizeCollectionSlug (RESERVED_COLLECTION_SLUGS from schema/types.ts)
const POST_TYPE_TO_COLLECTION: Record<string, string> = { post: "posts", page: "pages", attachment: "media", product: "products", portfolio: "portfolio", testimonial: "testimonials", team: "team", event: "events", faq: "faqs" };
const RESERVED_COLLECTIONS = ["content", "media", "users", "revisions", "taxonomies", "options", "audit_logs", "reorder", "relations"];
function sanitizeCollectionSlug(slug: string): string {
	const s = slug.toLowerCase().replace(/[^a-z0-9_]/g, "_").replace(/^[^a-z]+/, "");
	if (!s) return "imported";
	return RESERVED_COLLECTIONS.includes(s) ? `wp_${s}` : s;
}
const collectionFor = (pt: string): string => POST_TYPE_TO_COLLECTION[pt] || sanitizeCollectionSlug(pt);
// utils.ts BASE_REQUIRED_FIELDS, FEATURED_IMAGE_FIELD; execute.ts IMPORT_FIELDS (SEO)
const BASE_FIELDS: Record<string, string> = { title: "string", content: "portableText", excerpt: "text" };
const FEATURED = { slug: "featured_image", type: "image" };
const SEO_FIELDS: Record<string, string> = { seo_title: "string", seo_description: "text" };
// wordpress-plugin.ts ACF_FIELD_TYPES, acfImportFieldType, acfFieldsForPostType, isAcfRowMeta
const ACF_FIELD_TYPES: Record<string, string> = { text: "string", email: "string", url: "string", password: "string", radio: "string", button_group: "string", color_picker: "string", oembed: "string", date_picker: "string", date_time_picker: "string", time_picker: "string", textarea: "text", wysiwyg: "text", number: "number", range: "number", true_false: "boolean" };
function acfImportFieldType(field: AcfField, existingType: string | undefined, metaType: string | undefined): string {
	const acfType = ACF_FIELD_TYPES[field.type] ?? "json";
	if (existingType && metaType && !isTypeCompatible(acfType, existingType) && isTypeCompatible(metaType, existingType)) return existingType;
	return acfType;
}
const ACF_LAYOUT_TYPES = new Set(["tab", "message", "accordion"]);
function acfFieldsForPostType(groups: AcfGroup[] | undefined, postType: string): AcfField[] {
	const fields: AcfField[] = [];
	for (const group of groups ?? []) {
		const assigned = group.location?.some((rules) => rules.some((r) => r.param === "post_type" && r.operator === "==" && r.value === postType));
		if (!assigned) continue;
		for (const field of group.fields) if (field.name && !ACF_LAYOUT_TYPES.has(field.type)) fields.push(field);
	}
	return fields;
}
// utils.ts isPluginBookkeepingMeta
const PLUGIN_META_PREFIXES = ["aawp_", "algolia_", "amazon_polly_", "ampforwp_", "classifai_", "essb_", "eg_", "gnpub_", "jetpack_", "mashsb_", "monsterinsights_", "onesignal_", "penci_", "perfmatters_", "pys_", "rank_math_", "rp4wp_", "saswp_", "sbg_", "snap_", "spay_", "tie_", "wl_", "wpil_", "wprm_", "wpswa_", "wpuf_", "yarpp_"];
const PLUGIN_META_KEYS = new Set(["entity_same_as", "exclude_from_search", "footnotes", "inline_featured_image", "os_meta", "thirstydata"]);
function isPluginBookkeepingMeta(key: string): boolean {
	const n = key.replaceAll("-", "_");
	return PLUGIN_META_KEYS.has(n) || PLUGIN_META_PREFIXES.some((p) => n.startsWith(p));
}
const isAcfRowMeta = (key: string, acf: AcfField[]): boolean => acf.some((f) => (f.type === "repeater" || f.type === "flexible_content") && key.startsWith(f.name) && /^_\d+_/.test(key.slice(f.name.length)));

interface ExporterField { key: string; count: number; inferred_type: string; sample: string | null }
interface ExporterPostType { name: string; total: number; supports: Record<string, unknown>; custom_fields: ExporterField[] }
interface AcfField { name: string; label?: string; type: string }
interface AcfGroup { location?: { param: string; operator: string; value: string }[][]; fields: AcfField[] }
interface ExporterAnalyze { post_types: ExporterPostType[]; authors: { login: string }[]; acf?: AcfGroup[] }

/**
 * The fields EmDash's analysis requires of a post type's collection, as analyze() builds
 * them; `existing` is the collection's fields as the seed makes them (slug -> type).
 */
function requiredFields(pt: ExporterPostType, existing: Map<string, string> = new Map(), from: ExporterAnalyze = exporter): { slug: string; type: string; key?: string }[] {
	const out: { slug: string; type: string; key?: string }[] = Object.entries(BASE_FIELDS).map(([slug, type]) => ({ slug, type }));
	if (pt.supports && "thumbnail" in pt.supports) out.push(FEATURED);
	const seen = new Set(out.map((f) => f.slug));
	const metaTypes = new Map((pt.custom_fields ?? []).map((f) => [sanitizeFieldSlug(f.key), mapInferred(f.inferred_type)]));
	const json: AcfField[] = [];
	for (const f of acfFieldsForPostType(from.acf, pt.name)) {
		const slug = sanitizeFieldSlug(f.name);
		if (seen.has(slug)) continue;
		seen.add(slug);
		const type = acfImportFieldType(f, existing.get(slug), metaTypes.get(slug));
		if (type === "json") json.push(f);
		out.push({ slug, type, key: f.name });
	}
	for (const f of pt.custom_fields ?? []) {
		if (isPluginBookkeepingMeta(f.key)) continue;
		if (isAcfRowMeta(f.key, json)) continue;
		const slug = sanitizeFieldSlug(f.key);
		if (seen.has(slug)) continue;
		seen.add(slug);
		out.push({ slug, type: mapInferred(f.inferred_type), key: f.key });
	}
	return out;
}

// ---- the generated seed ----

function generatedSeed(extra: string[] = []): string {
	const dir = mkdtempSync(join(tmpdir(), "wpm-seed-"));
	try {
		const bin = join(root, "bin/wp-content-model.mjs");
		for (const args of [["--inventory", SAMPLE, "--out", dir], ["--seed", "--inventory", SAMPLE, ...extra, "--out", dir]]) {
			const r = spawnSync(process.execPath, [bin, ...args], { encoding: "utf8" });
			assert.equal(r.status, 0, r.stderr);
		}
		return readFileSync(join(dir, "seed/seed.json"), "utf8");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
/** Writes an analyze response to a temp file, for --emdash-analyze. */
function writeAnalyze(a: ExporterAnalyze): string {
	const file = join(mkdtempSync(join(tmpdir(), "wpm-analyze-")), "analyze.json");
	writeFileSync(file, JSON.stringify(a));
	return file;
}
const seedText = generatedSeed();
const seed = JSON.parse(seedText) as SeedFile;
const analyzeSeedText = generatedSeed(["--emdash-analyze", FIXTURE]);
const analyzeSeed = JSON.parse(analyzeSeedText) as SeedFile;
const exporter = JSON.parse(readFileSync(FIXTURE, "utf8")) as ExporterAnalyze;

/** Every way the seed falls short of Ready for one post type, by EmDash's rules. */
function gaps(postType: string, from: SeedFile = seed, analysis: ExporterAnalyze = exporter): { incompatible: string[]; missing: string[] } {
	const pt = analysis.post_types.find((p) => p.name === postType);
	assert.ok(pt, `no ${postType} in the Exporter analyze fixture`);
	const c = from.collections.find((x) => x.slug === collectionFor(postType));
	const incompatible: string[] = [];
	const missing: string[] = [];
	for (const f of requiredFields(pt, new Map((c?.fields ?? []).map((x) => [x.slug, x.type])), analysis)) {
		const have = c?.fields.find((x) => x.slug === f.slug);
		if (!have) missing.push(`${f.slug} (${f.type})`);
		else if (!isTypeCompatible(f.type, have.type)) incompatible.push(`${f.slug}: seed ${have.type}, Exporter ${f.type}`);
	}
	return { incompatible, missing };
}

// ---- fast ----

test("steps: a fresh site puts the seed in place before first run", () => {
	const s = emdashStepsText(seed, "fresh");
	assert.match(s, /^1\. On the WordPress site, install and activate the EmDash Exporter/);
	assert.match(s, /\n3\. Copy seed\/seed\.json/);
	assert.match(s, /before the site runs for the first time/);
	assert.match(s, /EmDash Exporter/);
	assert.match(s, /Incompatible/);
	assert.doesNotMatch(s, /Content Types \(skip/);
});

test("steps: an existing site lists every seed collection and field, all optional", () => {
	const lines = emdashSteps(seed, "existing");
	assert.match(lines[2], /^3\. .*will not apply seed\.json/);
	assert.match(lines[2], /optional/);
	for (const c of seed.collections) {
		const line = lines.find((l) => l.startsWith(`  - Collection ${c.slug} `));
		assert.ok(line, c.slug);
		for (const f of c.fields) assert.ok(line.includes(`${f.slug} ("${f.label}"), type ${f.type}`), `${c.slug}.${f.slug}`);
		assert.doesNotMatch(line, /required/);
	}
	// Content Types makes a reference field only with a target, so the steps leave it to the import.
	const withRef: SeedFile = { collections: [{ slug: "service", label: "Services", fields: [{ slug: "venue_id", label: "Venue", type: "reference" }] }] };
	assert.match(emdashSteps(withRef, "existing").find((l) => l.startsWith("  - Collection service ")) ?? "", /venue_id \("Venue"\), type reference \(skip it here: the import screen adds it/);
	const add = schemaToAdd(seed);
	assert.deepEqual(add.map((c) => c.slug), seed.collections.map((c) => c.slug));
	assert.ok(add.every((c) => c.fields.every((f) => f.required === undefined)));
	assert.ok(seed.collections.some((c) => c.fields.some((f) => f.required)), "the sample seed has required fields");
	// Numbered steps count up with no gaps.
	const nums = lines.filter((l) => /^\d+\./.test(l)).map((l) => Number.parseInt(l, 10));
	assert.deepEqual(nums, nums.map((_, i) => i + 1));
});

test("steps: both procedures name --emdash-analyze as the most reliable path", () => {
	for (const kind of ["fresh", "existing"] as const) {
		const text = emdashStepsText(seed, kind);
		assert.match(text, /most reliable/i, kind);
		assert.match(text, /--emdash-analyze/, kind);
		assert.match(text, /wp-json\/emdash\/v1\/analyze/, kind);
	}
});

test("Exporter fixture: recorded, scrubbed, with the business types", () => {
	assert.deepEqual(exporter.post_types.map((p) => p.name).sort(), ["page", "post", "service", "team"]);
	assert.ok(!JSON.stringify(exporter).includes("wpm-recorder"));
	const service = exporter.post_types.find((p) => p.name === "service");
	assert.equal(service?.custom_fields.find((f) => f.key === "tagline")?.inferred_type, "string");
});

test("Exporter fixture: no `_` key and no SEO key is reported as a custom field", () => {
	// The Exporter's analyze skips every meta key that starts with "_" (class-content-
	// exporter.php analyze_custom_fields: NOT LIKE '\_%'), so _yoast_wpseo_*, _thumbnail_id
	// and ACF's _<field> keys never ask for a field. SEO arrives through the post's `yoast`
	// block as seo_title / seo_description, which execute.ts makes when it needs them.
	for (const pt of exporter.post_types) {
		for (const f of pt.custom_fields) {
			assert.ok(!f.key.startsWith("_"), `${pt.name}: ${f.key}`);
			assert.ok(!/yoast|rank_math/.test(f.key), `${pt.name}: ${f.key}`);
		}
	}
	// Any SEO or base field the seed does carry has the type the importer writes.
	for (const c of seed.collections) {
		for (const f of c.fields) {
			const want = SEO_FIELDS[f.slug] ?? BASE_FIELDS[f.slug] ?? (f.slug === FEATURED.slug ? FEATURED.type : undefined);
			if (want) assert.ok(isTypeCompatible(want, f.type), `${c.slug}.${f.slug}: ${f.type}, importer writes ${want}`);
		}
	}
});

const SEEDS: [string, SeedFile][] = [["inventory seed", seed], ["--emdash-analyze seed", analyzeSeed]];

test("business.real.inventory.json is the replayed level 1 fixture plus the export file", async () => {
	const dir = new URL("./fixtures/business/", import.meta.url);
	const fetch = createReplayFetch(dir);
	const pub = await readPublic(fetch, `${fetch.origin}/site/`);
	const wxr = await readWxr(join(root, "test/fixtures/business/export.xml"));
	assert.equal(stringify("inventory", merge(pub, wxr)), readFileSync(SAMPLE, "utf8"), "regenerate the sample: wp-inventory level 1 replay + --wxr export.xml");
});

for (const [name, s] of SEEDS) {
	test(`Exporter fixture (${name}): every seed field has a type the Exporter's type accepts`, () => {
		for (const pt of exporter.post_types) assert.deepEqual(gaps(pt.name, s).incompatible, [], pt.name);
	});
	test(`Exporter fixture (${name}): the seed has every field the Exporter asks for (no Add fields)`, () => {
		for (const pt of exporter.post_types) assert.deepEqual(gaps(pt.name, s).missing, [], pt.name);
	});
	test(`Exporter fixture (${name}): no custom field is required`, () => {
		for (const c of s.collections) for (const f of c.fields) if (f.required) assert.equal(f.slug, "title", `${c.slug}.${f.slug}`);
	});
}

// The fixture with each ACF group located by page template instead of post type: EmDash
// then asks for the raw meta types and the flat repeater rows (no ACF typing at all).
const unlocated: ExporterAnalyze = { ...exporter, acf: (exporter.acf ?? []).map((g) => ({ ...g, location: [[{ param: "page_template", operator: "==", value: "default" }]] })) };

test("the inventory seed is Ready whether or not the ACF groups are located on the post type", () => {
	for (const pt of exporter.post_types) {
		assert.deepEqual(gaps(pt.name, seed), { incompatible: [], missing: [] }, `located: ${pt.name}`);
		assert.deepEqual(gaps(pt.name, seed, unlocated), { incompatible: [], missing: [] }, `not located: ${pt.name}`);
	}
	// Without a location the fixture asks for the raw types, so the check above has teeth.
	const service = requiredFields(unlocated.post_types.find((p) => p.name === "service")!, new Map(), unlocated);
	assert.ok(service.some((f) => f.slug === "faq" && f.type === "integer"));
	assert.ok(service.some((f) => f.slug === "faq_0_question"));
});

test("the inventory seed: reported keys take the Exporter's guess, rows stay flat; a one-entry ACF field its ACF type", () => {
	const service = seed.collections.find((c) => c.slug === "service");
	const type = (n: string): string | undefined => service?.fields.find((f) => f.slug === n)?.type;
	assert.equal(type("tagline"), "string");
	assert.equal(type("hero_image"), "reference"); // the key ends in _image; a located group keeps it
	assert.equal(type("related_services"), "json");
	assert.equal(type("faq"), "integer"); // the row count; a located group keeps it, so the rows stay flat
	assert.equal(type("faq_2_question"), "string");
	assert.equal(type("warranty_note"), "string"); // ACF text-like, on one entry: not reported
	for (const c of seed.collections) assert.equal(c.fields.find((f) => f.slug === "featured_image")?.type, "image", c.slug);
	const team = seed.collections.find((c) => c.slug === "team");
	assert.equal(team?.fields.find((f) => f.slug === "credentials_0_year")?.type, "integer");
});

// The --emdash-analyze seed has the groups and their locations, so it takes exactly the
// types EmDash 1.4.0 picks with no existing collection (what Add fields would make).
test("Exporter fixture (--emdash-analyze seed): every field EmDash asks for has the type it picks, not one it only keeps", () => {
	for (const pt of exporter.post_types) {
		const c = analyzeSeed.collections.find((x) => x.slug === collectionFor(pt.name));
		assert.ok(c, pt.name);
		for (const f of requiredFields(pt)) assert.equal(c.fields.find((x) => x.slug === f.slug)?.type, f.type, `${pt.name}.${f.slug}`);
	}
	const service = analyzeSeed.collections.find((c) => c.slug === "service");
	assert.equal(service?.fields.find((f) => f.slug === "faq")?.type, "json");
	assert.ok(!service?.fields.some((f) => f.slug.startsWith("faq_")));
});

test("EmDash's plugin bookkeeping keys never ask for a field (isPluginBookkeepingMeta, 1.4.0 list)", () => {
	const pt = { name: "service", total: 1, supports: {}, custom_fields: ["yarpp_related", "wpswa_x", "wpuf_form", "jetpack-likes", "tagline"].map((key) => ({ key, count: 2, inferred_type: "string", sample: "x" })) };
	assert.deepEqual(requiredFields(pt, new Map(), { ...exporter, acf: [] }).slice(3).map((f) => f.slug), ["tagline"]);
	const s = JSON.parse(generatedSeed(["--emdash-analyze", writeAnalyze({ ...exporter, post_types: exporter.post_types.map((p) => (p.name === "service" ? { ...p, custom_fields: [...p.custom_fields, ...pt.custom_fields.slice(0, 3)] } : p)) })])) as SeedFile;
	const fields = s.collections.find((c) => c.slug === "service")?.fields.map((f) => f.slug) ?? [];
	for (const k of ["yarpp_related", "wpswa_x", "wpuf_form"]) assert.ok(!fields.includes(k), k);
});

test("EmDash 1.4.0 analysis of the fixture: ACF types, rows of json repeaters dropped", () => {
	const service = requiredFields(exporter.post_types.find((p) => p.name === "service")!);
	assert.deepEqual(service.map((f) => `${f.slug}:${f.type}`), ["title:string", "content:portableText", "excerpt:text", "featured_image:image", "tagline:string", "hero_image:json", "related_services:json", "warranty_note:text", "faq:json"]);
	// An existing field keeps its type when the ACF type does not fit it and the meta type does.
	const kept = requiredFields(exporter.post_types.find((p) => p.name === "service")!, new Map([["faq", "integer"]]));
	assert.ok(kept.some((f) => f.slug === "faq" && f.type === "integer"));
	assert.ok(kept.some((f) => f.slug === "faq_0_question"), "a kept non-json repeater keeps its flat rows");
	assert.equal(collectionFor("team-member"), "team_member");
	assert.equal(collectionFor("options"), "wp_options");
	assert.equal(collectionFor("2col"), "col");
	assert.equal(collectionFor("--"), "imported");
});

test("the --emdash-analyze seed takes the slugs and types EmDash makes of the Exporter's report", () => {
	for (const pt of exporter.post_types) {
		const c = analyzeSeed.collections.find((x) => x.slug === collectionFor(pt.name));
		assert.ok(c, pt.name);
		const want = requiredFields(pt).map((f) => `${f.slug}:${f.type}`);
		const have = c.fields.filter((f) => !Object.hasOwn(SEO_FIELDS, f.slug)).map((f) => `${f.slug}:${f.type}`);
		assert.deepEqual([...have].sort(), [...want].sort(), pt.name);
	}
});

// ---- slow ----

const compose = ["compose", "-p", process.env.WPM_EMDASH_PROJECT ?? "wpm-emdash", "--env-file", join(sites, "versions.env"), "-f", join(sites, "compose.yaml")];
function dc(args: string[], capture = false): string {
	const r = spawnSync("docker", [...compose, ...args], { encoding: "utf8", maxBuffer: 1 << 28, stdio: ["ignore", capture ? "pipe" : "ignore", "pipe"] });
	if (r.status !== 0) throw new Error(`docker ${args.slice(0, 5).join(" ")} failed:\n${(r.stderr ?? "").slice(-2000)}`);
	return r.stdout ?? "";
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Remove what must not reach a fixture: the recorder account (its login and email). */
function scrub(a: ExporterAnalyze): ExporterAnalyze {
	return { ...a, authors: a.authors.filter((x) => !/recorder/i.test(JSON.stringify(x))) };
}

interface PostTypeStatus {
	name: string;
	suggestedCollection: string;
	requiredFields: { slug: string; label: string; type: string; required: boolean; searchable?: boolean }[];
	schemaStatus: { exists: boolean; canImport: boolean; reason?: string; fieldStatus: Record<string, { status: string; existingType?: string; requiredType: string }> };
}
/** The admin's badge for a post type (the import screen in @emdash-cms/admin). */
function badge(pt: PostTypeStatus): string {
	const s = pt.schemaStatus;
	if (!s.canImport) return "Incompatible";
	if (!s.exists) return "New collection";
	if (Object.values(s.fieldStatus).some((f) => f.status === "missing")) return "Add fields";
	return "Ready";
}
function describeStatus(pt: PostTypeStatus): string {
	const off = Object.entries(pt.schemaStatus.fieldStatus).filter(([, f]) => f.status !== "compatible").map(([k, f]) => `${k}:${f.status}${f.existingType ? `(${f.existingType}->${f.requiredType})` : `(${f.requiredType})`}`);
	return `${pt.name} ${badge(pt)}${off.length ? ` [${off.join(", ")}]` : ""}`;
}

describe("EmDash import of business through the Exporter plugin (slow)", { skip: !slow ? "set WPM_SLOW=1 to run" : !starterPackage("emdash") ? "run pnpm install (starters/starter)" : false }, () => {
	let token = "";

	before(async () => {
		dc(["down", "-v", "--remove-orphans"]);
		dc(["up", "-d", "--quiet-pull", "db", "business"]);
		for (let i = 0; ; i++) {
			try {
				if ((await fetch(`http://localhost:${WP_PORT}/site/`, { redirect: "manual" })).status < 500) break;
			} catch {}
			if (i > 90) throw new Error("business did not come up");
			await sleep(2000);
		}
		dc(["run", "--rm", "-T", "-e", `WPM_URL=http://localhost:${WP_PORT}/site`, "cli-business", "sh", "/seed/seed-business.sh"]);
		dc(["run", "--rm", "-T", "cli-business", "sh", "/seed/seed-emdash-exporter.sh"]);
		const pw = dc(["run", "--rm", "-T", "cli-business", "wp", "user", "application-password", "create", "wpm-recorder", "wpm-emdash-proof", "--porcelain"], true).trim().split(/\s+/).pop() ?? "";
		assert.ok(pw.length >= 20, "no application password");
		token = Buffer.from(`wpm-recorder:${pw}`).toString("base64");

		// The Exporter's own analyze response, straight from WordPress.
		const res = await fetch(`http://localhost:${WP_PORT}/site/wp-json/emdash/v1/analyze`, { headers: { Authorization: `Basic ${token}` } });
		assert.equal(res.status, 200);
		const live = scrub((await res.json()) as ExporterAnalyze);
		if (process.env.WPM_RECORD === "1") writeFileSync(FIXTURE, `${JSON.stringify(live, null, "\t")}\n`);
		else {
			const fields = (a: ExporterAnalyze) => a.post_types.flatMap((p) => p.custom_fields.map((f) => `${p.name}.${f.key}:${f.inferred_type}`)).sort();
			assert.deepEqual(fields(live), fields(exporter), "the recorded Exporter fixture is out of date; rerun with WPM_RECORD=1");
		}
	});

	after(() => {
		try {
			dc(["run", "--rm", "-T", "cli-business", "wp", "user", "application-password", "delete", "wpm-recorder", "--all", "--quiet"]);
		} catch {}
		dc(["down", "-v", "--remove-orphans"]);
	});

	async function analyze(api: EmDash): Promise<Map<string, PostTypeStatus>> {
		const d = await api.ok("POST", "/_emdash/api/import/wordpress-plugin/analyze", { url: WP_URL, token });
		return new Map((d.analysis.postTypes as PostTypeStatus[]).map((p) => [p.name, p]));
	}

	/** The import screen with Add fields left on: its prepare step adds the missing fields. */
	async function prepare(api: EmDash, types: PostTypeStatus[]): Promise<void> {
		const postTypes = types.filter((p) => p.schemaStatus.canImport).map((p) => ({ name: p.name, collection: p.suggestedCollection, fields: p.requiredFields }));
		const r = await api.ok("POST", "/_emdash/api/import/wordpress/prepare", { postTypes });
		assert.equal(r.success, true, JSON.stringify(r.errors));
	}

	/** Import `service`, then read Leak repair back. */
	async function importService(api: EmDash): Promise<Record<string, unknown>> {
		const r = await api.ok("POST", "/_emdash/api/import/wordpress-plugin/execute", {
			url: WP_URL,
			token,
			config: { postTypeMappings: { service: { collection: "service", enabled: true } }, skipExisting: false, importMenus: false, importSiteTitle: false, importLogo: false, importSeo: true },
		});
		assert.equal(r.result.imported, 8, JSON.stringify(r.result.errors).slice(0, 2000));
		const list = await api.ok("GET", "/_emdash/api/content/service?limit=50");
		const items = (list.items ?? list) as { id: string; slug: string }[];
		const leak = items.find((i) => i.slug === "leak-repair");
		assert.ok(leak, "no leak-repair entry");
		const entry = await api.ok("GET", `/_emdash/api/content/service/${leak.id}`);
		return (entry.item?.data ?? entry.data ?? entry.item ?? entry) as Record<string, unknown>;
	}

	function checkValues(data: Record<string, unknown>, rows: "flat" | "whole"): void {
		assert.equal(data.tagline, "Leak repair without the wait");
		assert.equal(data.seo_title, "Leak repair in Harbor Light | Same-week visits");
		if (rows === "flat") {
			// The inventory seed keeps the row count, so the rows arrive as flat keys.
			assert.equal(data.faq_0_question, "Question 0 about Leak repair?");
			return;
		}
		// The --emdash-analyze seed makes faq json: EmDash fills it from get_fields(), whole.
		const faq = data.faq as { question?: string }[] | undefined;
		assert.ok(Array.isArray(faq), `faq: ${JSON.stringify(data.faq)}`);
		assert.equal(faq[0]?.question, "Question 0 about Leak repair?");
		assert.ok(!("faq_0_question" in data));
	}

	/** Every business post type shows Ready on the import screen, with no prepare step. */
	function assertAllReady(statuses: Map<string, PostTypeStatus>): void {
		assert.deepEqual([...statuses.keys()].sort(), ["page", "post", "service", "team"]);
		for (const pt of statuses.values()) assert.equal(describeStatus(pt), `${pt.name} Ready`);
	}

	for (const [name, text] of [["inventory seed", seedText], ["--emdash-analyze seed", analyzeSeedText]] as const) test(`fresh site (${name}): seed applied on first run, every type Ready, then import`, async (t) => {
		const from = JSON.parse(text) as SeedFile;
		const site = await startSite({ port: EMDASH_PORT, seed: text, shimHost: SHIM_HOST, shimTarget: `http://localhost:${WP_PORT}` });
		try {
			const api = new EmDash(site.origin);
			// The setup wizard's first step applies the seed. It posts again until done.
			for (let i = 0; ; i++) {
				const r = await api.ok("POST", "/_emdash/api/setup", { title: "Harbor Light Home Services", includeContent: false });
				if (r.seedComplete) break;
				assert.ok(i < 20, "seed never completed");
			}
			// The admin account: a passkey in a browser, made by a person. The dev-only
			// bypass stands in for it (see the report).
			await api.ok("POST", "/_emdash/api/setup/dev-bypass");
			const schema = await api.ok("GET", "/_emdash/api/schema/collections");
			const slugs = ((schema.items ?? schema) as { slug: string }[]).map((c) => c.slug).sort();
			assert.deepEqual(slugs, from.collections.map((c) => c.slug).sort());

			const status = await analyze(api);
			t.diagnostic(`fresh (${name}): ${[...status.values()].map(describeStatus).join(" | ")}`);
			assertAllReady(status);
			checkValues(await importService(api), name === "inventory seed" ? "flat" : "whole");
		} catch (e) {
			throw new Error(`${(e as Error).message}\n--- astro dev ---\n${site.log().slice(-3000)}`, { cause: e });
		} finally {
			await site.stop();
		}
	});

	test("existing site: follow the printed steps, every type Ready, then import", async (t) => {
		const site = await startSite({ port: EMDASH_PORT, shimHost: SHIM_HOST, shimTarget: `http://localhost:${WP_PORT}` });
		try {
			const api = new EmDash(site.origin);
			// A site already set up (EmDash's default seed), so seed.json is never applied.
			await api.ok("POST", "/_emdash/api/setup/dev-bypass");
			const have = new Map<string, Set<string>>();
			const schema = await api.ok("GET", "/_emdash/api/schema/collections");
			for (const c of (schema.items ?? schema) as { slug: string }[]) {
				const f = await api.ok("GET", `/_emdash/api/schema/collections/${c.slug}/fields`);
				have.set(c.slug, new Set(((f.items ?? f) as { slug: string }[]).map((x) => x.slug)));
			}
			assert.ok(!have.has("service"), "the default site already has service");
			t.diagnostic(`existing site before: ${[...have.keys()].sort().join(", ")}`);
			// Step 1 of emdashSteps(seed, "existing"), done as the admin's Content Types does.
			for (const c of schemaToAdd(seed)) {
				if (!have.has(c.slug)) {
					await api.ok("POST", "/_emdash/api/schema/collections", { slug: c.slug, label: c.label, labelSingular: c.labelSingular, description: c.description, urlPattern: c.urlPattern, supports: c.supports });
					have.set(c.slug, new Set());
				}
				const now = await api.ok("GET", `/_emdash/api/schema/collections/${c.slug}/fields`);
				const slugs = new Set(((now.items ?? now) as { slug: string }[]).map((x) => x.slug));
				for (const f of c.fields) {
					if (slugs.has(f.slug) || leaveToImport(f)) continue;
					await api.ok("POST", `/_emdash/api/schema/collections/${c.slug}/fields`, { slug: f.slug, label: f.label, type: f.type, required: f.required ?? false, searchable: f.searchable ?? false, validation: null });
				}
			}
			// Only the fields the steps leave to the import screen are missing, and nothing is
			// Incompatible; the screen's Add fields (the prepare step) then makes all Ready.
			const first = await analyze(api);
			t.diagnostic(`existing, after the steps: ${[...first.values()].map(describeStatus).join(" | ")}`);
			const left = new Set(seed.collections.flatMap((c) => c.fields.filter(leaveToImport).map((f) => `${c.slug}.${f.slug}`)));
			for (const pt of first.values()) {
				assert.ok(pt.schemaStatus.canImport, describeStatus(pt));
				for (const [slug, f] of Object.entries(pt.schemaStatus.fieldStatus)) if (f.status !== "compatible") assert.ok(left.has(`${pt.suggestedCollection}.${slug}`), describeStatus(pt));
			}
			await prepare(api, [...first.values()]);
			const status = await analyze(api);
			t.diagnostic(`existing, after Add fields: ${[...status.values()].map(describeStatus).join(" | ")}`);
			assertAllReady(status);
			checkValues(await importService(api), "flat");
		} catch (e) {
			throw new Error(`${(e as Error).message}\n--- astro dev ---\n${site.log().slice(-3000)}`, { cause: e });
		} finally {
			await site.stop();
		}
	});
});
