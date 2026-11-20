import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { checkSchema } from "./helpers/check-schema.ts";
import type { Inventory } from "../src/contracts/inventory.ts";
import type { Model, ModelField } from "../src/contracts/model.ts";
import { stringify } from "../src/contracts/write.ts";
import { hostileModel, liveCode, PAYLOAD } from "./helpers/hostile.ts";
import { collectionSlugFor, emdashUrlFor, exporterGuess, fieldSlugFor, flatKeys, guessField, isPlumbingKey, propose, readAnalyze, seedGuess, seedNotes, seedOf, toAstroConfig, toSeed, validateModel, writeModelFiles } from "../src/model/index.ts";
import { acfFieldsForPostType, isAcfRowMeta, keyRuleType, rowsArriveWhole } from "../src/model/exporter.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const json = <T>(p: string): T => JSON.parse(readFileSync(root + p, "utf8")) as T;
const inventory = (name: string): Inventory => json<Inventory>(`test/samples/${name}.inventory.json`);
const modelSchema = json<Record<string, unknown>>("schema/model.schema.json");
const SAMPLES = ["blog", "business", "builder", "store", "multilingual"];

const field = (m: Model, collection: string, name: string): ModelField | undefined =>
	m.collections.find((c) => c.slug === collection)?.fields.find((f) => f.name === name);

const shuffle = <T>(list: T[]): T[] => [...list].reverse();
function shuffled(inv: Inventory): Inventory {
	const copy = structuredClone(inv);
	copy.types = shuffle(copy.types).map((t) => ({ ...t, fields: shuffle(t.fields) }));
	copy.taxonomies = shuffle(copy.taxonomies);
	copy.urls = shuffle(copy.urls);
	copy.menus = copy.menus.map((m) => ({ ...m, items: shuffle(m.items) }));
	return copy;
}

test("collection names follow EmDash's WordPress importer", () => {
	assert.equal(collectionSlugFor("post"), "posts");
	assert.equal(collectionSlugFor("page"), "pages");
	assert.equal(collectionSlugFor("service"), "service");
	assert.equal(collectionSlugFor("product"), "products");
	assert.equal(collectionSlugFor("team"), "team");
	assert.equal(collectionSlugFor("case-study"), "case_study");
	assert.equal(collectionSlugFor("2col"), "col");
	assert.equal(collectionSlugFor("options"), "wp_options");
	assert.equal(fieldSlugFor("hero-image"), "hero_image");
	assert.equal(fieldSlugFor("status"), "wp_status");
	assert.equal(fieldSlugFor("_internal"), "internal");
});

test("every sample gives a model that matches the schema and passes our checks", () => {
	for (const name of SAMPLES) {
		const m = propose(inventory(name));
		assert.deepEqual(checkSchema(modelSchema, JSON.parse(stringify("model", m))), [], name);
		assert.deepEqual(validateModel(m), [], name);
	}
});

test("every collection and field names its WordPress source", () => {
	for (const name of SAMPLES) {
		const m = propose(inventory(name));
		for (const c of m.collections) {
			assert.ok(c.from, `${name}:${c.slug}`);
			const walk = (fields: ModelField[]): void => {
				for (const f of fields) {
					assert.ok(f.from, `${name}:${c.slug}.${f.name}`);
					if (f.subfields) walk(f.subfields);
				}
			};
			walk(c.fields);
		}
		for (const t of m.taxonomies) assert.ok(t.from, `${name}:${t.slug}`);
		for (const menu of m.menus) assert.ok(menu.from, `${name}:${menu.name}`);
	}
});

test("business: service keeps its slug, custom fields, and loose low-confidence fields", () => {
	const m = propose(inventory("business"));
	assert.deepEqual(m.collections.map((c) => c.slug).sort(), ["pages", "service", "team"]);
	const service = m.collections.find((c) => c.slug === "service");
	assert.ok(service);
	assert.equal(service.from, "service");
	assert.deepEqual(service.taxonomies, ["service_area"]);
	assert.deepEqual(
		service.fields.map((f) => f.name),
		["title", "content", "excerpt", "featured_image", "tagline", "hero_image", "related_services", "award", "steps", "price_band", "sections"],
	);
	assert.equal(field(m, "service", "tagline")?.type, "string");
	assert.equal(field(m, "service", "tagline")?.required, true);
	assert.equal(field(m, "service", "hero_image")?.type, "image");
	assert.equal(field(m, "service", "price_band")?.type, "select");
	assert.deepEqual(field(m, "service", "price_band")?.options, ["Under $500", "$500 to $2,000", "Over $2,000"]);

	const steps = field(m, "service", "steps");
	assert.equal(steps?.type, "repeater");
	assert.equal(steps?.required, false);
	assert.ok(steps?.check);
	// The inventory gives the subfields no `order`, so they fall back to key order.
	assert.deepEqual(steps?.subfields?.map((f) => [f.name, f.type, f.required]), [
		["step_body", "string", false],
		["step_title", "string", true],
	]);

	for (const name of ["related_services", "award", "steps", "sections"]) {
		const f = field(m, "service", name);
		assert.equal(f?.required, false, name);
		assert.ok(f?.check, name);
	}
	assert.equal(field(m, "service", "related_services")?.type, "json");
	assert.equal(field(m, "service", "sections")?.type, "json");
	assert.match(field(m, "service", "sections")?.check ?? "", /quote, gallery/);
	assert.match(field(m, "service", "sections")?.check ?? "", /JSON/);
	assert.equal(field(m, "service", "tagline")?.check, undefined);
	assert.equal(service.route, "/service/{slug}/");
});

test("business: no plumbing keys, SEO goes where EmDash's import writes it", () => {
	const m = propose(inventory("business"));
	for (const c of m.collections) {
		for (const f of c.fields) {
			if (f.name !== "seo_title" && f.name !== "seo_description" && f.name !== "featured_image") assert.ok(!f.from.startsWith("_"), `${c.slug}.${f.from}`);
			assert.match(f.name, /^[a-z][a-z0-9_]*$/);
		}
	}
	const pages = m.collections.find((c) => c.slug === "pages");
	assert.ok(pages?.supports.includes("seo"));
	assert.equal(pages?.route, "/{path}/");
	assert.equal(pages?.hierarchical, true);
});

test("business: menus, taxonomy and routes", () => {
	const m = propose(inventory("business"));
	assert.deepEqual(m.taxonomies, [
		{ slug: "service_area", from: "service_area", label: "Service areas", labelSingular: "Service area", hierarchical: false, collections: ["service"], route: "/service-area/{slug}/" },
	]);
	assert.deepEqual(m.menus, [
		{
			name: "primary",
			from: "Main",
			label: "Main",
			items: [
				{ label: "Services", url: "/service/" },
				{ label: "Plans", url: "/plans/", children: [{ label: "Pricing", url: "/plans/pricing/" }] },
				{ label: "Contact", url: "/contact/" },
			],
		},
	]);
	assert.deepEqual(
		m.routes.map((r) => [r.kind, r.pattern, r.collection]),
		[
			["archive", "/service/", "service"],
			["home", "/", undefined],
			["search", "/search/", undefined],
		],
	);
});

test("blog: posts and pages, tag renamed, dated URLs flagged", () => {
	const m = propose(inventory("blog"));
	const posts = m.collections.find((c) => c.slug === "posts");
	assert.equal(posts?.from, "post");
	assert.deepEqual(posts?.taxonomies, ["category", "tag"]);
	assert.equal(posts?.route, "/blog/{slug}/");
	assert.match(posts?.check ?? "", /redirect/);
	assert.deepEqual(posts?.fields.map((f) => f.name), ["title", "content", "excerpt", "featured_image", "date", "modified", "seo_title"]);
	assert.equal(m.taxonomies.find((t) => t.slug === "tag")?.from, "post_tag");
	assert.equal(m.taxonomies.find((t) => t.slug === "category")?.route, "/category/{path}/");
	assert.ok(m.routes.some((r) => r.kind === "feed" && r.pattern === "/rss.xml"));
	assert.ok(m.routes.some((r) => r.kind === "author" && r.pattern === "/author/{slug}/"));
	assert.ok(m.routes.some((r) => r.kind === "blog" && r.pattern === "/blog/"));
	assert.deepEqual(m.menus[0]?.items.map((i) => i.url), ["/", "/category/trips/", "/about/"]);
	assert.deepEqual(m.menus[0]?.items[1]?.children, [{ label: "Coast", url: "/category/trips/coast/" }]);
});

test("store: WooCommerce internals are left out and named in a note", () => {
	const m = propose(inventory("store"));
	const products = m.collections.find((c) => c.slug === "products");
	assert.ok(products);
	assert.deepEqual(products.fields.map((f) => f.name), ["title", "content", "excerpt", "featured_image"]);
	assert.match((products.leftOut ?? []).join(" "), /_price/);
	assert.equal(products.route, "/product/{slug}/");
});

test("multilingual: locales kept, prefixes stripped from patterns, shared root flagged", () => {
	const m = propose(inventory("multilingual"));
	assert.deepEqual(m.locales, [{ code: "en-US", default: true }, { code: "fr-CA", prefix: "fr" }]);
	assert.equal(m.collections.find((c) => c.slug === "posts")?.route, "/{slug}/");
	assert.match(m.collections.find((c) => c.slug === "posts")?.check ?? "", /pages/);
	assert.equal(m.taxonomies[0]?.route, "/category/{path}/");
});

test("builder: a type seen by name only, plain links", () => {
	const m = propose(inventory("builder"));
	const portfolio = m.collections.find((c) => c.slug === "portfolio");
	assert.ok(portfolio?.check);
	assert.equal(m.collections.find((c) => c.slug === "pages")?.route, "/{path}/");
});

test("output is byte-stable, whatever the input order", () => {
	for (const name of SAMPLES) {
		const a = propose(inventory(name));
		const b = propose(shuffled(inventory(name)));
		assert.equal(stringify("model", a), stringify("model", b), name);
		assert.equal(toAstroConfig(a), toAstroConfig(b), name);
		assert.equal(toSeed(a), toSeed(b), name);
	}
});

test("Astro config: glob loaders, Zod, a comment on every check field", () => {
	const m = propose(inventory("business"));
	const ts = toAstroConfig(m);
	assert.match(ts, /import \{ defineCollection \} from "astro:content";/);
	assert.match(ts, /service: defineCollection\(\{\n\t\tloader: glob\(\{ pattern: "\*\*\/\*\.\{md,mdx\}", base: "\.\/content\/service" \}\)/);
	assert.match(ts, /tagline: z\.string\(\),/);
	assert.match(ts, /price_band: z\.enum\(\["Under \$500", "\$500 to \$2,000", "Over \$2,000"\]\),/);
	assert.match(ts, /steps: z\.array\(z\.object\(\{ step_body: z\.string\(\)\.optional\(\), step_title: z\.string\(\) \}\)\)\.optional\(\),/);
	assert.match(ts, /sections: z\.unknown\(\)\.optional\(\),/);
	assert.match(ts, /hero_image: image\(\)\.optional\(\),/);
	assert.match(ts, /service_area: z\.array\(z\.string\(\)\)\.default\(\[\]\),/);
	for (const c of m.collections) {
		for (const f of c.fields) {
			if (!f.check) continue;
			const at = ts.indexOf(`\t${f.name}: `, ts.indexOf(`\t${c.slug}: defineCollection`));
			const before = ts.slice(0, at).trimEnd().split("\n").at(-1) ?? "";
			assert.match(before, /\/\*\* Check: .+ \*\//, `${c.slug}.${f.name}`);
		}
	}
	assert.doesNotMatch(ts, /\tcontent: /, "the body is the content");
});

test("seed: schema only, EmDash field shapes", () => {
	const m = propose(inventory("business"));
	const seed = JSON.parse(toSeed(m)) as Record<string, unknown>;
	assert.deepEqual(Object.keys(seed), ["$schema", "version", "meta", "collections", "taxonomies", "menus"]);
	assert.equal(seed.version, "1");
	assert.equal("content" in seed, false);
	const collections = seed.collections as { slug: string; urlPattern?: string; fields: Record<string, unknown>[] }[];
	const service = collections.find((c) => c.slug === "service");
	assert.equal(service?.urlPattern, "/service/{slug}");
	assert.equal(collections.find((c) => c.slug === "pages")?.urlPattern, "/{slug}");
	const byName = new Map(service?.fields.map((f) => [f.slug, f]));
	assert.deepEqual(byName.get("title"), { slug: "title", label: "Title", type: "string", required: true, searchable: true });
	assert.deepEqual(byName.get("excerpt"), { slug: "excerpt", label: "Excerpt", type: "text" });
	// Custom fields take the Exporter's type and are never required, so no entry is rejected.
	assert.deepEqual(byName.get("price_band"), { slug: "price_band", label: "Price band", type: "string" });
	assert.deepEqual(byName.get("steps"), { slug: "steps", label: "Steps", type: "integer" });
	assert.deepEqual(byName.get("tagline"), { slug: "tagline", label: "Tagline", type: "string" });
	assert.deepEqual(seed.taxonomies, [{ name: "service_area", label: "Service areas", labelSingular: "Service area", hierarchical: false, collections: ["service"] }]);
	const menus = seed.menus as { items: { type: string; children?: unknown[] }[] }[];
	assert.equal(menus[0]?.items[0]?.type, "custom");
	assert.equal(menus[0]?.items[1]?.children?.length, 1);
});

test("validateModel catches hand edits that would break the files", () => {
	const m = propose(inventory("business"));
	const bad = structuredClone(m);
	bad.collections[0]!.slug = "Bad-Slug";
	bad.collections[1]!.fields.push({ name: "x", from: "x", label: "X", type: "select", required: false });
	bad.collections[1]!.fields.push({ name: "title", from: "t", label: "T", type: "string", required: false });
	bad.taxonomies[0]!.collections = ["nope"];
	const errors = validateModel(bad);
	assert.ok(errors.some((e) => /Bad-Slug/.test(e)));
	assert.ok(errors.some((e) => /options/.test(e)));
	assert.ok(errors.some((e) => /duplicate/.test(e)));
	assert.ok(errors.some((e) => /nope/.test(e)));
});

test("CLI: proposes model.json, then writes the config and the seed", () => {
	const dir = mkdtempSync(join(tmpdir(), "wpm-model-cli-"));
	try {
		const bin = join(root, "bin/wp-content-model.mjs");
		const run = (...args: string[]) => spawnSync(process.execPath, [bin, ...args], { encoding: "utf8" });
		const first = run("--inventory", join(root, "test/samples/business.inventory.json"), "--out", dir);
		assert.equal(first.status, 0, first.stderr);
		const written = readFileSync(join(dir, "model.json"), "utf8");
		assert.equal(written, stringify("model", propose(inventory("business"))));
		const second = run("--model", join(dir, "model.json"), "--out", dir, "--astro", "--seed");
		assert.equal(second.status, 0, second.stderr);
		assert.ok(existsSync(join(dir, "src/content.config.ts")));
		assert.ok(existsSync(join(dir, "seed/seed.json")));
		const bad = run("--nope");
		assert.equal(bad.status, 2);
		const missing = run("--inventory", join(dir, "missing.json"), "--out", dir);
		assert.equal(missing.status, 1);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// --- Review fixes -------------------------------------------------------------------

test("old-site values cannot inject code into content.config.ts", () => {
	const m = hostileModel();
	const ts = toAstroConfig(m);
	assert.doesNotMatch(liveCode(ts), /process\.exit/);
	// Every comment is one line and closes only at its end.
	for (const line of ts.split("\n")) {
		const at = line.indexOf("/**");
		if (at === -1) continue;
		const body = line.slice(at + 3);
		assert.equal(body.indexOf("*/"), body.length - 2, line);
	}
	assert.match(ts, /\t"bad-tax\\"": z\.array/);
	assert.doesNotMatch(ts, /\u2028/);
	// The seed is plain JSON and round-trips the hostile values.
	const seed = JSON.parse(toSeed(m)) as { collections: { label: string }[] };
	assert.ok(seed.collections.some((c) => c.label === PAYLOAD));
});

test("identifiers in the config are safe or quoted", () => {
	const m = hostileModel();
	m.collections[0]!.fields.push({ name: "__proto__", from: "x", label: "X", type: "string", required: false });
	const ts = toAstroConfig(m);
	assert.match(ts, /\["__proto__"\]: z\.string\(\)\.optional\(\),/);
});

test("validateModel needs an http(s) site URL", () => {
	const m = propose(inventory("business"));
	assert.deepEqual(validateModel({ ...m, site: { url: "javascript:alert(1)" } }).length, 1);
	assert.deepEqual(validateModel({ ...m, site: { url: "not a url" } }).length, 1);
	assert.deepEqual(validateModel(m), []);
});

// EmDash 1.4.0 isTypeCompatible (src/import/utils.ts): which existing types accept a required type.
const COMPATIBLE: Record<string, string[]> = { string: ["string", "text", "slug"], text: ["string", "text"], portableText: ["portableText", "json"], number: ["number", "integer"], integer: ["number", "integer"] };
const compatible = (required: string, existing: string): boolean => required === existing || (COMPATIBLE[required]?.includes(existing) ?? false);
// What the Exporter should guess from the stored value, per model type (non-ACF custom fields).
const GUESS: Record<string, string> = { string: "string", text: "string", url: "string", select: "string", multiSelect: "json", number: "number", integer: "integer", boolean: "integer", datetime: "string", image: "integer", file: "integer", reference: "integer", repeater: "integer", json: "json", slug: "string", portableText: "json" };
// What EmDash 1.4.0 takes for an ACF field (wordpress-plugin.ts ACF_FIELD_TYPES, else json), per inventory shape.
const ACF: Record<string, string> = { text: "string", html: "text", number: "number", boolean: "boolean", date: "string", url: "string", email: "string", image: "json", file: "json", relation: "json", list: "json", object: "json", repeater: "json", flexible: "json", serialized: "json" };

test("every seed custom field has a type EmDash 1.4.0 accepts", () => {
	for (const name of SAMPLES) {
		const inv = inventory(name);
		const m = propose(inv);
		const seed = JSON.parse(toSeed(m, { inventory: inv })) as { collections: { slug: string; fields: { slug: string; type: string }[] }[] };
		const notes = seedNotes(m, { inventory: inv });
		for (const c of m.collections) {
			for (const f of c.fields) {
				if (["post_title", "post_content", "post_excerpt", "_thumbnail_id"].includes(f.from)) continue;
				if (["post_date", "post_modified"].includes(f.from)) {
					assert.ok(!seed.collections.find((x) => x.slug === c.slug)?.fields.some((x) => x.slug === f.name), `${name}:${c.slug}.${f.name}: EmDash keeps the dates itself`);
					continue;
				}
				const s = seed.collections.find((x) => x.slug === c.slug)?.fields.find((x) => x.slug === f.name);
				assert.ok(s, `${name}:${c.slug}.${f.name}`);
				assert.ok(["string", "text", "number", "integer", "boolean", "datetime", "json", "reference"].includes(s.type), `${c.slug}.${f.name}: ${s.type}`);
				const invField = inv.types.find((t) => t.slug === c.from)?.fields.find((x) => x.key === f.from);
				// An ACF field on two or more entries is reported, and takes the Exporter's guess; on fewer, its ACF type.
				const sparseAcf = invField?.owner === "acf" && invField.filled < 2 && !(invField.shape === "text" && invField.options?.length);
				const want = sparseAcf ? (ACF[invField.shape] as string) : (keyRuleType(f.from) ?? (GUESS[f.type] as string));
				assert.ok(compatible(want, s.type), `${name}:${c.slug}.${f.name}: ${f.type} -> ${s.type}, want ${want}`);
				if (s.type !== f.type) assert.ok(notes.some((n) => n.startsWith(`${c.slug}: ${f.name} is ${s.type} in the seed`)), `${c.slug}.${f.name} needs a seed note`);
				assert.doesNotMatch(f.check ?? "", /EmDash seed|EmDash's Exporter/, `${c.slug}.${f.name}: seed notes stay out of model.json`);
			}
		}
	}
	const inv = inventory("business");
	const seed = JSON.parse(toSeed(propose(inv), { inventory: inv })) as { collections: { slug: string; fields: { slug: string; type: string; validation?: unknown }[] }[] };
	const service = seed.collections.find((c) => c.slug === "service");
	const type = (n: string): string | undefined => service?.fields.find((f) => f.slug === n)?.type;
	assert.equal(type("hero_image"), "reference"); // reported: the Exporter's key-name rule (ends in _image)
	assert.equal(type("price_band"), "string");
	assert.equal(type("steps"), "integer"); // reported: the row count, rows flat
	assert.ok(service?.fields.some((f) => f.slug.startsWith("steps_")), "flat rows for a reported repeater");
	assert.equal(type("sections"), "json");
	assert.equal(type("featured_image") ?? "image", "image");
	// model.json and the Astro config keep the richer types.
	const m = propose(inv);
	assert.equal(field(m, "service", "hero_image")?.type, "image");
	assert.equal(field(m, "service", "steps")?.type, "repeater");
	assert.ok(seedNotes(m, { inventory: inv }).some((n) => n.startsWith("service: steps: EmDash's import brings the rows in as flat fields")));
});

test("seedGuess: Ready whether or not the ACF group is located; ACF types only for unreported keys", () => {
	const f = (owner: string, shape: string, samples: string[], extra: Record<string, unknown> = {}) => ({ key: "k", owner, shape, source: "wxr", filled: samples.length, total: 5, samples, confidence: "high", ...extra }) as never;
	// Reported (two or more entries): the Exporter's guess, which EmDash accepts either way.
	assert.deepEqual(seedGuess("hero_image", f("acf", "image", ["8", "9"])), { type: "reference" });
	assert.equal(seedGuess("faq", f("acf", "repeater", ["2", "1"])).type, "integer");
	assert.deepEqual(seedGuess("on", f("acf", "boolean", ["1", "1"])), { type: "integer" });
	assert.ok(!rowsArriveWhole("faq", f("acf", "repeater", ["2", "1"])));
	// On one entry: not reported, so only a located group asks for it, by its ACF type.
	assert.deepEqual(seedGuess("hero_image", f("acf", "image", ["8"])), { type: "json" });
	assert.deepEqual(seedGuess("count", f("acf", "number", ["3"])), { type: "number" });
	assert.deepEqual(seedGuess("on", f("acf", "boolean", ["1"])), { type: "boolean" });
	assert.deepEqual(seedGuess("bio", f("acf", "html", ["<p>x</p>"])), { type: "text" });
	assert.deepEqual(seedGuess("when", f("acf", "date", ["20240101"])), { type: "string" });
	assert.deepEqual(seedGuess("faq", f("acf", "repeater", ["2"])), { type: "json" });
	assert.ok(rowsArriveWhole("faq", f("acf", "repeater", ["2"])));
	// An unknown ACF type falls back to the stored value's type, with a note.
	assert.equal(seedGuess("band", f("acf", "text", ["12"], { options: ["12", "34"] })).type, "integer");
	const guessed = seedGuess("x", f("acf", "number", ["3"], { note: "Field settings are not in the export; the type is guessed from the values." }));
	assert.equal(guessed.type, "integer");
	assert.match(guessed.risk ?? "", /--emdash-analyze/);
	// REST: the type it reports is used; without one, a {value, label} choice is its stored value.
	assert.deepEqual(seedGuess("pick", f("acf", "object", ['{"value":"red","label":"Red"}'], { source: "rest", note: 'Field type "radio" as the REST API reports it.' })), { type: "string" });
	assert.equal(seedGuess("pick", f("acf", "object", ['{"value":"red","label":"Red"}', '{"value":"blue","label":"Blue"}'], { source: "rest", note: "Read from the acf field in REST; check the field group for the real type." })).type, "string");
	assert.equal(seedGuess("pick", f("acf", "object", ['{"value":"red","label":"Red"}'], { source: "rest", note: "Read from the acf field in REST; check the field group for the real type." })).type, "string");
	assert.equal(guessField("link", f("acf", "object", ['{"url":"x","title":"y"}'], { source: "rest" })).type, "json");
	// Non-ACF meta keeps the Exporter's guess rules.
	assert.deepEqual(seedGuess("hero_image", f("meta", "image", ["8"])), { type: "reference" });
	assert.ok(!rowsArriveWhole("faq", f("meta", "repeater", ["1"])));
});

test("acfFieldsForPostType and isAcfRowMeta follow EmDash 1.4.0", () => {
	const groups = [
		{ location: [[{ param: "post_type", operator: "==", value: "service" }]], fields: [{ name: "faq", type: "repeater" }, { name: "", type: "text" }, { name: "t", type: "tab" }, { name: "tagline", type: "text" }] },
		{ location: [[{ param: "post_type", operator: "!=", value: "service" }]], fields: [{ name: "other", type: "text" }] },
		{ location: [[{ param: "page_template", operator: "==", value: "x" }], [{ param: "post_type", operator: "==", value: "service" }]], fields: [{ name: "sections", type: "flexible_content" }] },
	];
	const fields = acfFieldsForPostType(groups, "service");
	assert.deepEqual(fields.map((x) => x.name), ["faq", "tagline", "sections"]);
	assert.ok(isAcfRowMeta("faq_0_question", fields));
	assert.ok(isAcfRowMeta("sections_12_body", fields));
	assert.ok(!isAcfRowMeta("faq", fields));
	assert.ok(!isAcfRowMeta("faq_question", fields));
	assert.ok(!isAcfRowMeta("tagline_0_x", fields));
});

test("hierarchical pages: the seed notes, not model.json, carry EmDash's /{slug} pattern", () => {
	const m = propose(inventory("business"));
	assert.doesNotMatch(m.collections.find((c) => c.slug === "pages")?.check ?? "", /EmDash/);
	const note = seedNotes(m).find((n) => n.startsWith("pages: urlPattern")) ?? "";
	assert.match(note, /urlPattern is \/\{slug\}, not \/\{path\}\//);
	assert.match(note, /duplicate slugs will clash/);
});

test("post types EmDash names alike import into one collection, with the union of their fields", () => {
	const inv = inventory("business");
	const team = inv.types.find((t) => t.slug === "team")!;
	const other = structuredClone(team);
	other.slug = "Team";
	other.fields.push({ ...structuredClone(team.fields.find((f) => f.key === "role")!), key: "pronouns", label: "Pronouns" });
	inv.types.push(other, { ...structuredClone(team), slug: "team-" });
	const m = propose(inv);
	assert.deepEqual(m.collections.filter((c) => c.slug.startsWith("team")).map((c) => c.slug), ["team", "team_"]);
	const merged = m.collections.find((c) => c.slug === "team");
	assert.equal(merged?.from, "team");
	assert.match(merged?.check ?? "", /puts post type Team into this collection too/);
	assert.equal(field(m, "team", "pronouns")?.required, false);
	assert.deepEqual(validateModel(m), []);
	// The first post type in inventory order keeps the collection.
	const inv2 = inventory("business");
	inv2.types.unshift({ ...structuredClone(team), slug: "Team" });
	assert.equal(propose(inv2).collections.find((c) => c.slug === "team")?.from, "Team");
	// The seed asks for the fields of both, and the redirect plan sends both types' URLs there.
	const seed = JSON.parse(toSeed(m, { inventory: inv })) as { collections: { slug: string; fields: { slug: string }[] }[] };
	assert.ok(seed.collections.find((c) => c.slug === "team")?.fields.some((f) => f.slug === "pronouns"));
	assert.ok(!seed.collections.some((c) => c.slug === "team_1"));
});

// --- Codex review fixes -------------------------------------------------------------

test("Exporter naming: EmDash 1.4.0 sanitizes every post type the same way, so no mapping note", () => {
	assert.equal(collectionSlugFor("team-member"), "team_member");
	assert.equal(collectionSlugFor("options"), "wp_options");
	assert.equal(collectionSlugFor("9lives"), "lives");
	assert.equal(collectionSlugFor("--"), "imported");
	const inv = inventory("business");
	const team = inv.types.find((t) => t.slug === "team")!;
	inv.types.push({ ...structuredClone(team), slug: "case-study" }, { ...structuredClone(team), slug: "options" }, { ...structuredClone(team), slug: "acf-field-group" });
	const m = propose(inv);
	const cs = m.collections.find((c) => c.from === "case-study");
	assert.equal(cs?.slug, "case_study");
	assert.doesNotMatch(cs?.check ?? "", /import screen/);
	assert.equal(m.collections.find((c) => c.from === "options")?.slug, "wp_options");
	assert.ok(!m.collections.some((c) => c.from === "acf-field-group"), "ACF's own post types are internal");
});

test("SEO keys become EmDash's seo_title and seo_description fields", () => {
	const inv = inventory("business");
	const page = inv.types.find((t) => t.slug === "page")!;
	page.fields.push({ ...structuredClone(page.fields.find((f) => f.key === "_yoast_wpseo_title")!), key: "_yoast_wpseo_metadesc", label: "Meta description" });
	const m = propose(inv);
	assert.deepEqual(field(m, "pages", "seo_title"), { name: "seo_title", from: "_yoast_wpseo_title", label: "SEO Title", type: "string", required: false });
	assert.deepEqual(field(m, "pages", "seo_description"), { name: "seo_description", from: "_yoast_wpseo_metadesc", label: "SEO Description", type: "text", required: false });
	const seed = JSON.parse(toSeed(m)) as { collections: { slug: string; fields: { slug: string; type: string }[] }[] };
	const fields = seed.collections.find((c) => c.slug === "pages")?.fields ?? [];
	assert.deepEqual(fields.filter((f) => f.slug.startsWith("seo_")).map((f) => [f.slug, f.type]), [["seo_title", "string"], ["seo_description", "text"]]);
	assert.ok(m.collections.find((c) => c.slug === "pages")?.supports.includes("seo"));
	assert.equal(fieldSlugFor("_yoast_wpseo_title"), "yoast_wpseo_title");
});

test("multilingual menu links keep their locale prefix", () => {
	const inv = inventory("multilingual");
	inv.menus.push({
		name: "Menu FR",
		source: "wxr",
		items: [
			{ id: 1, title: "À propos", url: "https://lingua.example.com/fr/a-propos/", order: 1 },
			{ id: 2, title: "Pains", url: "https://lingua.example.com/fr/category/pains/", order: 2 },
			{ id: 3, title: "Pain", url: "https://lingua.example.com/fr/pain-du-printemps/", order: 3 },
			{ id: 4, title: "Accueil", url: "https://lingua.example.com/fr/", order: 4 },
			{ id: 5, title: "About", url: "https://lingua.example.com/about/", order: 5 },
		],
	});
	const m = propose(inv);
	assert.deepEqual(m.menus[0]?.items.map((i) => i.url), ["/fr/a-propos/", "/fr/category/pains/", "/fr/pain-du-printemps/", "/fr/", "/about/"]);
});

// The Exporter's infer_field_type (emdash-exporter 1.2.0, includes/class-content-exporter.php 349-383).
test("exporterGuess follows the Exporter's rules: key name first, then one sample", () => {
	const cases: [string, string | null, string][] = [
		["hero_image", "8", "reference"],
		["post_id", "abc", "reference"],
		["event_date", "20240101", "datetime"],
		["start_time", null, "datetime"],
		["item_count", "3", "number"],
		["is_featured", "1", "boolean"],
		["tagline", "Leak repair", "string"],
		["faq", "2", "integer"],
		["faq", "0", "string"], // PHP `!$sample`: "0" is empty
		["faq", null, "string"],
		["rate", "4.5", "number"],
		["related", 'a:2:{i:0;s:2:"45";i:1;s:2:"46";}', "json"],
		["flag", "yes", "boolean"],
		["flag", "1", "integer"],
		["opened", "2024-03-01 10:00:00", "datetime"],
		["bio", "x".repeat(501), "text"],
		["bio", "x".repeat(500), "string"],
	];
	for (const [key, sample, want] of cases) assert.equal(exporterGuess(key, sample), want, `${key}=${sample}`);
});

test("guessField: the type most samples give, a note when they disagree or rows can be empty", () => {
	const f = (shape: string, samples: string[], extra: Record<string, unknown> = {}) => ({ key: "k", owner: "acf", shape, source: "wxr", filled: samples.length, total: samples.length, samples, confidence: "high", ...extra }) as never;
	assert.deepEqual(guessField("tagline", f("text", ["a", "b"])), { type: "string" });
	const mixed = guessField("code", f("text", ["12", "AB", "34"]));
	assert.equal(mixed.type, "integer");
	assert.match(mixed.risk ?? "", /integer \(2\), string \(1\)/);
	// A tie goes to the first sample.
	assert.equal(guessField("code", f("text", ["AB", "12"])).type, "string");
	// Row counts on a repeater with empty entries can flip to string.
	assert.match(guessField("credentials", f("repeater", ["1", "2"], { filled: 3, total: 5 })).risk ?? "", /row count of 0/);
	// Level 1 values are not stored values.
	const rest = guessField("hero", f("image", ["8"], { source: "rest" }));
	assert.equal(rest.type, "integer");
	assert.match(rest.risk ?? "", /--emdash-analyze/);
	// Flat row keys for each row seen.
	const rep = f("repeater", ["2", "1"], { key: "faq", subfields: [{ key: "q", shape: "text", source: "wxr", samples: ["Q"], filled: 1, total: 1, owner: "acf", confidence: "high" }] });
	assert.deepEqual(flatKeys("faq", rep).map((x) => x.key), ["faq_0_q", "faq_1_q"]);
});

test("plugin bookkeeping keys follow EmDash 1.4.0's list", () => {
	for (const k of ["wpswa_index", "wpuf_form_id", "yarpp_related", "jetpack-likes", "footnotes"]) assert.ok(isPlumbingKey(k), k);
	assert.ok(!isPlumbingKey("tagline"));
});

// --- Checkpoint K review fixes --------------------------------------------------------

const realBusiness = (): Inventory => json<Inventory>("test/samples/business.real.inventory.json");
const realAnalyze = () => readAnalyze(join(root, "test/fixtures/business/emdash-analyze.json"));

test("seed notes follow the seed written; model.json and content.config.ts carry none", async () => {
	const inv = realBusiness();
	const m = propose(inv);
	for (const c of m.collections) {
		assert.doesNotMatch(c.check ?? "", /EmDash|urlPattern/, c.slug);
		for (const f of c.fields) assert.doesNotMatch(f.check ?? "", /seed|EmDash's Exporter|_0_/, `${c.slug}.${f.name}`);
	}
	assert.doesNotMatch(toAstroConfig(m), /EmDash seed|EmDash's Exporter|urlPattern|faq_0_/);
	const analyze = await realAnalyze();
	const exact = seedNotes(m, { inventory: inv, analyze });
	const guessed = seedNotes(m, { inventory: inv });
	assert.ok(exact.includes("service: hero_image is json in the seed and image in model.json and content.config.ts: the type EmDash's Exporter analysis reports, so EmDash's import accepts it."));
	assert.ok(guessed.some((n) => n.startsWith("service: hero_image is reference in the seed")));
	assert.ok(!exact.some((n) => /faq_0_question|integer/.test(n)), "the analyze seed has no flat rows and no row counts");
	assert.ok(exact.includes("service: faq: EmDash's import brings the rows in whole, as json; content.config.ts keeps the faq list."));
	assert.ok(guessed.some((n) => n.startsWith("service: faq: EmDash's import brings the rows in as flat fields (faq_0_answer")));
	// Every note names a field or setting the seed really has.
	const seed = seedOf(m, { inventory: inv, analyze }) as { collections: { slug: string; fields: { slug: string; type: string }[] }[] };
	for (const n of exact) {
		const hit = /^(\w+): (\w+) is (\w+) in the seed/.exec(n);
		if (hit) assert.equal(seed.collections.find((c) => c.slug === hit[1])?.fields.find((f) => f.slug === hit[2])?.type, hit[3], n);
	}
});

test("seed notes explain featured_image, optional fields and Exporter types", async () => {
	const inv = realBusiness();
	const notes = seedNotes(propose(inv), { inventory: inv, analyze: await realAnalyze() });
	assert.ok(!notes.some((n) => n.startsWith("team: featured_image is in the seed but not in model.json")), "the model keeps featured_image too");
	assert.ok(notes.some((n) => n.startsWith("service: tagline, hero_image are required in model.json but optional in the seed")));
	assert.ok(notes.some((n) => n.startsWith("team: job_title, headshot are required in model.json but optional in the seed")));
	assert.ok(notes.some((n) => n.startsWith("service: warranty_note is text in the seed and string in model.json")));
});

test("the seed menu uses EmDash URLs: child pages at /<slug>, no trailing slash", () => {
	const inv = realBusiness();
	const m = propose(inv);
	const seed = seedOf(m, { inventory: inv }) as { menus: { items: { url: string; children?: { url: string }[] }[] }[] };
	const items = seed.menus[0]?.items ?? [];
	assert.deepEqual(items.map((i) => i.url), ["/what-we-do", "/services", "/contact"]);
	assert.equal(items[0]?.children?.[0]?.url, "/residential");
	assert.deepEqual(m.menus[0]?.items.map((i) => i.url), ["/what-we-do/", "/services/", "/contact/"], "model.json keeps the Astro paths; the plain ?post_type= link goes to the archive route");
	assert.ok(seedNotes(m).some((n) => n.startsWith("menus: links use the EmDash URLs") && n.includes("/what-we-do/residential/ -> /residential")));
	assert.equal(emdashUrlFor(m, "/"), "/");
	assert.equal(emdashUrlFor(m, "https://elsewhere.example.com/a/"), "https://elsewhere.example.com/a/");
	assert.equal(emdashUrlFor(m, "/team/rosa-lind/"), "/team/rosa-lind");
	assert.equal(emdashUrlFor(m, "/company/about-us/history/?x=1#top"), "/history?x=1#top");
});

test("a post type archive linked from the menu gets an archive route", () => {
	// The menu links ?post_type=service: the archive goes where the entries live.
	const inv = realBusiness();
	const archive = (m: Model) => m.routes.find((r) => r.kind === "archive" && r.collection === "service");
	assert.deepEqual(archive(propose(inv)), { kind: "archive", pattern: "/services/", collection: "service" });
	assert.ok(!propose(inv).routes.some((r) => r.kind === "archive" && r.collection === "team"), "no archive without evidence of one");
	// A pretty archive link keeps its own path.
	const item = inv.menus[0]!.items.find((i) => i.target?.kind === "archive")!;
	item.url = "http://localhost:4602/site/our-services/";
	const m = propose(inv);
	assert.equal(archive(m)?.pattern, "/our-services/");
	assert.ok(m.menus[0]?.items.some((i) => i.url === "/our-services/"));
});

test("a missing label gives a sensible singular: Team / Team member", () => {
	const inv = realBusiness();
	const team = propose(inv).collections.find((c) => c.slug === "team");
	assert.equal(team?.label, "Team");
	assert.equal(team?.labelSingular, "Team member");
	inv.types.find((t) => t.slug === "team")!.label = "Team";
	assert.equal(propose(inv).collections.find((c) => c.slug === "team")?.labelSingular, "Team", "a label from WordPress is kept as it is");
});

test("--seed also writes seed/emdash-steps.md with the notes and both kinds of steps", async () => {
	const dir = mkdtempSync(join(tmpdir(), "wpm-steps-"));
	try {
		const inv = realBusiness();
		const files = await writeModelFiles(propose(inv), dir, { seed: true }, { inventory: inv, analyze: await realAnalyze() });
		assert.ok(files.some((f) => f.endsWith("seed/emdash-steps.md")));
		const text = readFileSync(join(dir, "seed/emdash-steps.md"), "utf8");
		assert.match(text, /field types come from the Exporter's analyze response/);
		assert.match(text, /- service: hero_image is json in the seed/);
		assert.match(text, /## A fresh EmDash site\n\n1\. /);
		assert.match(text, /## An EmDash site that is already set up\n\n1\. /);
		assert.match(text, /  - Collection service \("Services"/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ---- Checkpoint K2 review fixes ----

test("an explicit label like News or Series keeps its singular", () => {
	const inv = realBusiness();
	inv.types.find((t) => t.slug === "team")!.label = "News";
	assert.equal(propose(inv).collections.find((c) => c.slug === "team")?.labelSingular, "News");
	inv.types.find((t) => t.slug === "team")!.label = "Series";
	assert.equal(propose(inv).collections.find((c) => c.slug === "team")?.labelSingular, "Series");
	assert.equal(propose(inv).taxonomies.find((t) => t.slug === "service_area")?.labelSingular, "Service area", "a real plural is still made singular");
});

test("featured_image is labeled Featured image everywhere, the seed too", () => {
	const inv = realBusiness();
	const seed = seedOf(propose(inv), { inventory: inv }) as { collections: { slug: string; fields: { slug: string; label: string }[] }[] };
	const labels = new Set(seed.collections.flatMap((c) => c.fields.filter((f) => f.slug === "featured_image").map((f) => f.label)));
	assert.deepEqual([...labels], ["Featured image"]);
});

test("base fields with no evidence, no values or level 1 counts carry a check note", () => {
	const inv = realBusiness();
	const page = inv.types.find((t) => t.slug === "page")!;
	page.fields.find((f) => f.key === "_thumbnail_id")!.filled = 0;
	const excerpt = page.fields.find((f) => f.key === "post_excerpt")!;
	excerpt.shape = "html";
	excerpt.source = "rest";
	page.sources = page.sources.filter((x) => x !== "wxr");
	const m = propose(inv);
	assert.match(field(m, "team", "excerpt")?.check ?? "", /shows no excerpt for this type/, "team has no post_excerpt in the inventory");
	assert.match(field(m, "pages", "featured_image")?.check ?? "", /^No entry has one\. Remove it\?/);
	assert.match(field(m, "pages", "excerpt")?.check ?? "", /Level 1 counts can be high: WordPress fills these from defaults\.$/);
	assert.doesNotMatch(field(m, "pages", "excerpt")?.check ?? "", /made from the content/);
	assert.equal(field(m, "service", "title")?.check, undefined);
});

test("a taxonomy with no terms is kept with a check note, in the model and content.config.ts", () => {
	const inv = realBusiness();
	const tag = inv.taxonomies.find((t) => t.slug === "post_tag") ?? inv.taxonomies[0]!;
	tag.count = 0;
	const m = propose(inv);
	const tx = m.taxonomies.find((t) => t.from === tag.slug);
	assert.match(tx?.check ?? "", /no terms/);
	assert.deepEqual(checkSchema(modelSchema, JSON.parse(stringify("model", m))), []);
	assert.match(toAstroConfig(m), new RegExp(`Terms of the ${tx!.label} taxonomy, by slug\\. Check: The old site has no terms`));
});

test("posts keep their dates: date and modified in the model and content.config.ts, not in the seed", () => {
	const inv = realBusiness();
	const m = propose(inv);
	assert.deepEqual(field(m, "posts", "date"), { name: "date", from: "post_date", label: "Date", type: "datetime", required: true });
	assert.deepEqual(field(m, "posts", "modified"), { name: "modified", from: "post_modified", label: "Modified", type: "datetime", required: false });
	assert.equal(field(m, "pages", "date"), undefined, "pages show no date");
	const posts = toAstroConfig(m).split("posts: defineCollection(")[1]!.split("defineCollection(")[0]!;
	assert.match(posts, /\bdate: z\.coerce\.date\(\),/);
	assert.match(posts, /\bmodified: z\.coerce\.date\(\)\.optional\(\),/);
	const seed = seedOf(m, { inventory: inv }) as { collections: { slug: string; fields: { slug: string }[] }[] };
	assert.ok(!seed.collections.find((c) => c.slug === "posts")!.fields.some((f) => f.slug === "date" || f.slug === "modified"));
	assert.ok(seedNotes(m, { inventory: inv }).some((n) => /^posts: date and modified are not in the seed/.test(n)));
});

test("content.config.ts makes image fields optional until the media is copied, and says so", () => {
	const m = propose(realBusiness());
	assert.equal(field(m, "service", "hero_image")?.required, true, "model.json keeps required");
	const text = toAstroConfig(m);
	assert.match(text, /\bhero_image: image\(\)\.optional\(\),/);
	assert.match(text, /\bheadshot: image\(\)\.optional\(\),/);
	assert.doesNotMatch(text, /image\(\),/);
	assert.match(text, /Check: Required in model\.json; optional here so the site builds before the media files are copied/);
	assert.match(text.split("\n")[0]!, /Image fields are optional until the media files are copied/);
});

test("EmDash menu links keep their locale prefix", () => {
	const m: Model = {
		version: 1,
		site: { url: "https://x.example.com/" },
		locales: [{ code: "en", default: true }, { code: "fr", prefix: "fr" }],
		collections: [{ slug: "pages", from: "page", label: "Pages", hierarchical: true, route: "/{path}/", supports: [], taxonomies: [], fields: [] }],
		taxonomies: [],
		menus: [],
		routes: [{ kind: "home", pattern: "/" }],
	};
	assert.equal(emdashUrlFor(m, "/fr/company/history/"), "/fr/history");
	assert.equal(emdashUrlFor(m, "/company/history/"), "/history");
	assert.equal(emdashUrlFor(m, "/fr/"), "/fr");
	assert.equal(emdashUrlFor(m, "/fr/company/history/?x=1#y"), "/fr/history?x=1#y");
	assert.equal(emdashUrlFor(m, "/french/"), "/french", "only a whole-segment prefix counts");
});

test("an analyze response that lacks a type or a field: the steps say which types are guesses", async () => {
	const inv = realBusiness();
	const analyze = await realAnalyze();
	const team = analyze.post_types.find((p) => p.name === "team")!;
	team.custom_fields = team.custom_fields!.filter((f) => f.key !== "job_title");
	analyze.acf = (analyze.acf ?? []).map((g) => ({ ...g, fields: g.fields.filter((f) => f.name !== "job_title") }));
	analyze.post_types = analyze.post_types.filter((p) => p.name !== "service");
	const dir = mkdtempSync(join(tmpdir(), "wpm-guess-"));
	try {
		await writeModelFiles(propose(inv), dir, { seed: true }, { inventory: inv, analyze });
		const text = readFileSync(join(dir, "seed/emdash-steps.md"), "utf8");
		const has = (re: RegExp, what: string) => assert.ok(re.test(text), what);
		has(/field types come from the Exporter's analyze response, except [^\n]*team\.job_title/, "intro names the guessed field");
		has(/except [^\n]*service\.tagline/, "intro names the type the response lacks");
		has(/\n- team: job_title: the analyze response does not list job_title for team, so its type \(\w+\) is a guess/, "per-field note");
		has(/\n- service: The analyze response has no post type service, so the types of tagline, [^\n]* are guesses/, "per-type note");
		has(/\n2\. This seed was built from the Exporter's own analysis[^\n]*does not list [^\n]*team\.job_title/, "step 2");
		assert.ok(!/Without it, the seed's field types follow/.test(text), "no contradiction");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the steps explain what an image field turned json holds and how to make it an image", () => {
	const inv = realBusiness();
	const notes = seedNotes(propose(inv), { inventory: inv });
	assert.ok(notes.some((n) => /^service: hero_image: after the import it holds .*add a new image field in Content Types/.test(n)), notes.join("\n"));
	assert.ok(notes.some((n) => /^team: headshot: after the import it holds /.test(n)));
});

test("the SEO step names only the SEO plugins the old site has", async () => {
	const inv = realBusiness();
	const dir = mkdtempSync(join(tmpdir(), "wpm-seo-"));
	try {
		const m = propose(inv);
		await writeModelFiles(m, dir, { seed: true }, { inventory: { ...inv, plugins: inv.plugins.filter((p) => p.category !== "seo") } });
		let text = readFileSync(join(dir, "seed/emdash-steps.md"), "utf8");
		const hasSeoFields = m.collections.some((c) => c.fields.some((f) => f.name.startsWith("seo_")));
		if (!hasSeoFields) assert.doesNotMatch(text, /Yoast|Rank Math|Leave SEO on/);
		await writeModelFiles(m, dir, { seed: true }, { inventory: { ...inv, plugins: [...inv.plugins, { slug: "wordpress-seo", category: "seo", source: "wxr", confidence: "high" }] } });
		text = readFileSync(join(dir, "seed/emdash-steps.md"), "utf8");
		assert.match(text, /Leave SEO on\. Yoast SEO titles and descriptions arrive/);
		assert.doesNotMatch(text, /Rank Math/);
		await writeModelFiles(m, dir, { seed: true }, { inventory: { ...inv, plugins: [...inv.plugins, { slug: "all-in-one-seo-pack", name: "All in One SEO", category: "seo", source: "rest", confidence: "high" }] } });
		text = readFileSync(join(dir, "seed/emdash-steps.md"), "utf8");
		assert.match(text, /those from All in One SEO do not come across/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a seed menu link to an address two old pages clash on gets # and a note, not the clashing link", async () => {
	const inv = inventory("business");
	const m = propose(inv);
	const seed = seedOf(m, { inventory: inv, clashes: ["/pricing"] }) as { menus: { items: { label: string; url: string; children?: { label: string; url: string }[] }[] }[] };
	const pricing = seed.menus[0]!.items.flatMap((i) => [i, ...(i.children ?? [])]).find((i) => i.label === "Pricing");
	assert.equal(pricing?.url, "#");
	assert.ok(seedNotes(m, { inventory: inv, clashes: ["/pricing"] }).some((n) => /^menus: check "Pricing" \(\/pricing\): two or more old pages land on that address/.test(n)));
	// writeModelFiles finds the clash itself from the inventory, with the redirect planner.
	const dir = mkdtempSync(join(tmpdir(), "wpm-clash-"));
	try {
		await writeModelFiles(m, dir, { seed: true }, { inventory: inv });
		const written = JSON.parse(readFileSync(join(dir, "seed/seed.json"), "utf8")) as typeof seed;
		assert.ok(!JSON.stringify(written.menus).includes('"/pricing"'));
		assert.match(readFileSync(join(dir, "seed/emdash-steps.md"), "utf8"), /- menus: check "Pricing" \(\/pricing\)/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("validateModel rejects routes that start with // or hold whitespace or control characters", () => {
	const m = propose(inventory("business"));
	for (const route of ["//evil.example.com/{slug}/", "/a b/{slug}/", "/a\n/{slug}/", "/a\t{slug}/", "/a\x7f/{slug}/"]) {
		const bad = structuredClone(m);
		bad.collections[0]!.route = route;
		assert.ok(validateModel(bad).some((e) => e.includes("route")), JSON.stringify(route));
		const badRoute = structuredClone(m);
		badRoute.routes = [...badRoute.routes, { kind: "feed", pattern: route }];
		assert.ok(validateModel(badRoute).some((e) => e.includes("route")), `routes: ${JSON.stringify(route)}`);
		if (bad.taxonomies[0]) {
			const badTax = structuredClone(m);
			badTax.taxonomies[0]!.route = route;
			assert.ok(validateModel(badTax).some((e) => e.includes("route")), `taxonomy: ${JSON.stringify(route)}`);
		}
	}
});
