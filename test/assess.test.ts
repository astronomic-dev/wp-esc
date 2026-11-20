import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { checkSchema } from "./helpers/check-schema.ts";
import type { Inventory } from "../src/contracts/inventory.ts";
import type { Assessment, Finding, ThemeMatch } from "../src/contracts/assessment.ts";
import { stringify } from "../src/contracts/write.ts";
import { assess } from "../src/assess/index.ts";
import { propose } from "../src/model/index.ts";
import { loadThemes, matchThemes, type ThemeEntry } from "../src/assess/themes.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const json = <T>(p: string): T => JSON.parse(readFileSync(root + p, "utf8")) as T;
const sample = (name: string): Inventory => json<Inventory>(`test/samples/${name}.inventory.json`);
const schema = json<Record<string, unknown>>("schema/assessment.schema.json");
const SAMPLES = ["blog", "business", "builder", "store", "multilingual"];

const find = (a: Assessment, area: string): Finding | undefined => a.findings.find((f) => f.area === area);
const themeSlugs = (a: Assessment): string[] => (Array.isArray(a.themes) ? a.themes.map((t) => t.slug) : []);

test("every sample gives a valid, byte-stable assessment", () => {
	for (const name of SAMPLES) {
		const a = assess(sample(name));
		assert.deepEqual(checkSchema(schema, a), [], name);
		assert.equal(stringify("assessment", a), stringify("assessment", assess(sample(name))), name);
	}
});

test("blog: mostly easy, and a blog theme fits", () => {
	const a = assess(sample("blog"));
	assert.equal(find(a, "posts")?.score, "easy");
	assert.match(find(a, "posts")?.reason ?? "", /120 posts/);
	assert.equal(find(a, "pages")?.score, "easy");
	const easy = a.findings.filter((f) => f.score === "easy").length;
	assert.ok(easy > a.findings.length / 2, "most findings are easy");
	assert.ok(!a.findings.some((f) => f.score === "blocker" || f.score === "hard"));
	assert.deepEqual(a.blockers, [], "an explicit empty blockers list");
	assert.equal(a.storePaths, undefined);
	assert.ok(Array.isArray(a.themes));
	assert.equal(themeSlugs(a)[0], "vesper");
	assert.ok((a.themes as ThemeMatch[]).length <= 2);
});

test("business: simple fields easy, repeater and flexible some-work, form data stored elsewhere", () => {
	const a = assess(sample("business"));
	const fields = find(a, "fields");
	assert.equal(fields?.score, "easy");
	assert.ok(fields?.items?.includes("tagline"));
	assert.ok(!fields?.items?.includes("steps"));
	const rep = find(a, "repeaters");
	assert.equal(rep?.score, "some-work");
	assert.deepEqual(rep?.items, ["sections", "steps"]);
	assert.equal(rep?.count, 2);
	assert.equal(find(a, "custom-types")?.score, "easy");
	const stored = find(a, "stored-data");
	assert.equal(stored?.score, "some-work");
	assert.match(stored?.reason ?? "", /Save them before you switch off WordPress/);
	assert.match(stored?.next ?? "", /Flamingo/);
	assert.equal(find(a, "forms")?.score, "some-work");
	assert.equal(themeSlugs(a)[0], "lodestar");
});

test("builder: hard, with the page count, plus unknown shortcodes and hidden types", () => {
	const a = assess(sample("builder"));
	const b = find(a, "builders");
	assert.equal(b?.score, "hard");
	assert.equal(b?.count, 6);
	assert.match(b?.next ?? "", /[Rr]ebuild these pages/);
	assert.match(b?.reason ?? "", /Elementor/);
	const sc = find(a, "shortcodes");
	assert.equal(sc?.score, "some-work");
	assert.deepEqual(sc?.items, ["gallery", "pricing_table"], "the form plugin's shortcode is in the forms finding; core [gallery] is listed");
	assert.match(sc?.reason ?? "", /\[gallery\] \(\d+ items?\) is WordPress core; it needs a gallery or embed section on plain Astro/);
	assert.match(find(a, "forms")?.reason ?? "", /\[contact-form-7\] places them/);
	const hidden = find(a, "hidden-types");
	assert.deepEqual(hidden?.items, ["portfolio"]);
	assert.match(hidden?.next ?? "", /level 2/);
	assert.deepEqual(themeSlugs(a).sort(), ["apogee", "vesper"]);
});

test("store: blocker with all four store paths and plain links", () => {
	const a = assess(sample("store"));
	const s = find(a, "store");
	assert.equal(s?.score, "blocker");
	assert.deepEqual(a.blockers, ["store"]);
	assert.match(s?.reason ?? "", /WooCommerce/);
	assert.match(s?.reason ?? "", /42 products/);
	assert.deepEqual(a.storePaths?.map((p) => p.kind).sort(), ["buy-button", "digital", "physical", "ready-made"]);
	const digital = a.storePaths?.find((p) => p.kind === "digital");
	assert.ok(digital?.links.some((l) => l.label === "Polar"));
	for (const p of a.storePaths ?? []) {
		for (const l of p.links) {
			const u = new URL(l.url);
			assert.equal(u.protocol, "https:");
			assert.equal(u.search, "", `no query (affiliate tags) on ${l.url}`);
		}
	}
	// Store meta is part of the store finding, not a custom field.
	assert.ok(!(find(a, "fields")?.items ?? []).includes("_price"));
	assert.ok(!a.findings.some((f) => f.area === "custom-types" && /product/i.test(f.reason)));
	assert.equal(find(a, "stored-data")?.score, "some-work");
	assert.deepEqual(find(a, "shortcodes")?.items, ["woocommerce_cart"]);
	assert.equal(a.themes, "none-fit");
});

test("multilingual: languages need a plan", () => {
	const a = assess(sample("multilingual"));
	const l = find(a, "languages");
	assert.equal(l?.score, "some-work");
	assert.deepEqual(l?.items, ["en-US", "fr-CA"]);
});

test("members and courses are blockers with the ready-made path", () => {
	const inv = sample("blog");
	inv.plugins.push({ slug: "memberpress", name: "MemberPress", category: "members", source: "html", confidence: "high" });
	inv.plugins.push({ slug: "sfwd-lms", name: "LearnDash", category: "courses", source: "html", confidence: "high" });
	const a = assess(inv);
	assert.equal(find(a, "members")?.score, "blocker");
	assert.equal(find(a, "courses")?.score, "blocker");
	assert.deepEqual([...a.blockers].sort(), ["courses", "members"]);
	const ready = a.storePaths?.find((p) => p.kind === "ready-made");
	assert.ok(ready?.links.some((l) => l.label === "Podia"));
	assert.ok(ready?.links.some((l) => l.label === "Memberful"));
	assert.equal(a.storePaths?.length, 1, "no store, so only the ready-made path");
});

test("hidden types at level 2 point to level 3", () => {
	const inv = sample("business");
	inv.types.push({ slug: "event", byStatus: {}, fields: [], taxonomies: [], sources: ["rest"] });
	const hidden = find(assess(inv), "hidden-types");
	assert.match(hidden?.next ?? "", /level 3/);
});

test("--no-themes option leaves the themes key out", () => {
	const a = assess(sample("blog"), { themes: false });
	assert.ok(!("themes" in a));
	assert.ok(!stringify("assessment", a).includes('"themes"'));
});

test("themes.json: unlisted themes are skipped, every listed theme has a page link", () => {
	const all = json<{ themes: ThemeEntry[] }>("data/themes.json").themes;
	assert.ok(all.some((t) => t.slug === "agency" && t.listed === false));
	const listed = loadThemes();
	assert.ok(!listed.some((t) => t.slug === "agency"));
	for (const t of listed) {
		assert.equal(t.url, `https://astronomic.dev/themes/${t.slug}`);
		assert.ok(t.fits.length > 0);
	}
	// Even a perfect agency match never picks an unlisted theme.
	const inv = sample("builder");
	inv.site.name = "Halden Studio agency";
	assert.ok(!themeSlugs(assess(inv)).includes("agency"));
});

test("theme match gives up to two, best first, each with a reason", () => {
	for (const name of SAMPLES) {
		const m = matchThemes(sample(name), loadThemes());
		if (m === "none-fit") continue;
		assert.ok(m.length >= 1 && m.length <= 2, name);
		for (const t of m) assert.ok(t.reason.length > 0 && t.url.startsWith("https://"), name);
	}
});

test("reasons and next steps are plain, short sentences", () => {
	for (const name of SAMPLES) {
		const a = assess(sample(name));
		const texts = [...a.findings.flatMap((f) => [f.reason, f.next]), ...(a.storePaths ?? []).flatMap((p) => [p.title, p.reason])];
		for (const t of texts) {
			assert.match(t, /^[A-Z0-9]/, `starts with a capital: ${t}`);
			assert.doesNotMatch(t, /\bAI\b|undefined|NaN|\[object/, t);
			for (const s of t.split(/(?<=\.)\s+/)) assert.ok(s.split(/\s+/).length <= 25, `short sentence: ${s}`);
		}
	}
});

test("wp-assess CLI writes assessment.json and honors --no-themes", () => {
	const dir = mkdtempSync(join(tmpdir(), "wpm-assess-"));
	try {
		const out = join(dir, "a.json");
		const model = join(dir, "model.json");
		const bin = `${root}bin/wp-assess.mjs`;
		const run = spawnSync(process.execPath, [bin, "--inventory", `${root}test/samples/business.inventory.json`, "--model", `${root}test/samples/business.model.json`, "--out", out], { encoding: "utf8" });
		assert.equal(run.status, 0, run.stderr);
		const a = JSON.parse(readFileSync(out, "utf8")) as Assessment;
		assert.deepEqual(checkSchema(schema, a), []);
		assert.ok(Array.isArray(a.themes));
		const off = spawnSync(process.execPath, [bin, "--inventory", `${root}test/samples/blog.inventory.json`, "--model", model, "--out", out, "--no-themes"], { encoding: "utf8" });
		assert.equal(off.status, 0, off.stderr);
		assert.ok(!("themes" in JSON.parse(readFileSync(out, "utf8"))));
		const missing = spawnSync(process.execPath, [bin, "--inventory", join(dir, "nope.json"), "--out", out], { encoding: "utf8" });
		assert.equal(missing.status, 1);
		assert.match(missing.stderr, /nope\.json/);
		assert.ok(!existsSync(join(dir, "nope.json")));
		const help = spawnSync(process.execPath, [bin, "--help"], { encoding: "utf8" });
		assert.equal(help.status, 0);
		assert.match(help.stdout, /Usage: wp-assess/);
		const bad = spawnSync(process.execPath, [bin, "--nope"], { encoding: "utf8" });
		assert.equal(bad.status, 2);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("theme match ignores inactive plugins", () => {
	const inv = sample("multilingual");
	inv.plugins.push({ slug: "estatik", name: "Estatik", active: false, category: "other", source: "auth", confidence: "high" });
	assert.equal(assess(inv).themes, "none-fit");
	inv.plugins[inv.plugins.length - 1]!.active = true;
	assert.ok(themeSlugs(assess(inv)).includes("vega"));
});

test("a hidden store type is covered by the store finding, not hidden-types", () => {
	const inv = sample("store");
	inv.types.push({ slug: "product_variation", byStatus: {}, fields: [], taxonomies: [], sources: ["rest"] });
	assert.equal(find(assess(inv), "hidden-types"), undefined);
});

test("no finding calls the new site static", () => {
	const inv = sample("store");
	inv.plugins.push({ slug: "memberpress", name: "MemberPress", category: "members", source: "html", confidence: "high" });
	inv.plugins.push({ slug: "sfwd-lms", name: "LearnDash", category: "courses", source: "html", confidence: "high" });
	for (const f of assess(inv).findings) assert.doesNotMatch(`${f.reason} ${f.next}`, /static site/i);
});

test("wp-assess CLI writes a valid model.json beside the output when --model is not given", () => {
	const dir = mkdtempSync(join(tmpdir(), "wpm-assess-model-"));
	try {
		const run = spawnSync(process.execPath, [`${root}bin/wp-assess.mjs`, "--inventory", `${root}test/samples/business.inventory.json`, "--out", join(dir, "assessment.json")], { encoding: "utf8" });
		assert.equal(run.status, 0, run.stderr);
		const modelFile = join(dir, "model.json");
		assert.ok(existsSync(modelFile));
		const modelSchema = json<Record<string, unknown>>("schema/model.schema.json");
		assert.deepEqual(checkSchema(modelSchema, JSON.parse(readFileSync(modelFile, "utf8"))), []);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("builder shortcodes are hidden only for the builder that was found", () => {
	const inv = sample("builder");
	inv.shortcodes.push({ name: "vc_row", count: 3, samples: [] }, { name: "et_pb_section", count: 2, samples: [] });
	inv.builders.push({ name: "divi", count: 2, samples: [] });
	const items = find(assess(inv), "shortcodes")?.items ?? [];
	assert.ok(items.includes("vc_row"), "Elementor and Divi do not own vc_ shortcodes");
	assert.ok(!items.includes("et_pb_section"), "Divi owns et_pb_ shortcodes");
});

test("each builder gets its own page count, never a sum", () => {
	const inv = sample("builder");
	inv.builders.push({ name: "divi", count: 4, samples: [] });
	const found = assess(inv).findings.filter((f) => f.area === "builders");
	assert.equal(found.length, 2);
	const byName = Object.fromEntries(found.map((f) => [f.items?.[0], f.count]));
	assert.deepEqual(byName, { divi: 4, elementor: 6 });
	for (const f of found) assert.equal(f.score, "hard");
});

function shuffle(value: unknown, key = ""): unknown {
	if (Array.isArray(value)) {
		const items = value.map((v) => shuffle(v));
		return key === "options" ? items : items.reverse();
	}
	if (value !== null && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>).reverse();
		return Object.fromEntries(entries.map(([k, v]) => [k, shuffle(v, k)]));
	}
	return value;
}

test("a reordered but equal inventory gives byte-identical output", () => {
	for (const name of SAMPLES) {
		const inv = sample(name);
		inv.plugins.push({ slug: "zz-forms", name: "Zed Forms", category: "forms", source: "html", confidence: "high" });
		inv.storedElsewhere.push({ plugin: "zz-forms", what: "entries" });
		inv.builders.push({ name: "divi", count: 1, samples: [] });
		const again = shuffle(structuredClone(inv)) as Inventory;
		assert.equal(stringify("assessment", assess(again)), stringify("assessment", assess(inv)), name);
		assert.deepEqual(matchThemes(again), matchThemes(inv), name);
	}
});

test("unclear-fields skips empty fields and WordPress core meta such as footnotes", () => {
	const inv = sample("blog");
	const post = inv.types.find((t) => t.slug === "post")!;
	post.fields.push(
		{ key: "footnotes", owner: "meta", shape: "unknown", source: "rest", filled: 0, total: 16, samples: [], confidence: "low" },
		{ key: "blank_blob", owner: "meta", shape: "serialized", source: "wxr", filled: 0, total: 16, samples: [], confidence: "low" },
	);
	assert.equal(find(assess(inv), "unclear-fields"), undefined);
	post.fields.push({ key: "packed", owner: "meta", shape: "serialized", source: "wxr", filled: 3, total: 16, samples: ["a:1:{}"], confidence: "low" });
	assert.deepEqual(find(assess(inv), "unclear-fields")?.items, ["packed"]);
});

test("posts only in Uncategorized: the reason says so instead of 'categories move cleanly'", () => {
	const inv = sample("business");
	inv.types.push({ slug: "post", count: 3, byStatus: { publish: 3 }, fields: [], taxonomies: ["category"], sources: ["wxr"] });
	inv.taxonomies.push({ slug: "category", count: 1, types: ["post"], sources: ["rest"] });
	inv.urls.push({ url: "https://example.com/category/uncategorized/", kind: "category", source: ["rest"], taxonomy: "category", termId: 1, slug: "uncategorized", evidence: "listed" });
	const reason = find(assess(inv), "posts")?.reason ?? "";
	assert.match(reason, /Uncategorized/);
	assert.doesNotMatch(reason, /categories move cleanly/);
	assert.match(find(assess(sample("blog")), "posts")?.reason ?? "", /categories move cleanly/, "real categories still move");
});

test("business (real replay): addresses, media and menus get findings from the model's routes", () => {
	const inv = sample("business.real");
	const a = assess(inv, { themes: false });
	const addr = find(a, "addresses");
	assert.equal(addr?.score, "some-work", "two pages clash on one EmDash address");
	assert.match(addr?.reason ?? "", /On EmDash, nested pages move to \/<slug>/);
	assert.match(addr?.reason ?? "", /\/site\/what-we-do\/commercial\/pricing\/ and \/site\/what-we-do\/residential\/pricing\//);
	assert.match(addr?.reason ?? "", /Plain Astro keeps the nested paths/);
	assert.ok(addr?.items?.includes("/site/company/about-us/history/"));
	assert.doesNotMatch(find(a, "pages")?.next ?? "", /keep each page's address/);
	const media = find(a, "media");
	assert.equal(media?.count, 6);
	assert.match(media?.reason ?? "", /does not download them/);
	const menus = find(a, "menus");
	assert.match(menus?.reason ?? "", /Residential: \/what-we-do\/residential\/ to \/residential/);
	const fields = find(a, "fields");
	assert.doesNotMatch(fields?.reason ?? "", /plain values/);
	assert.match(fields?.reason ?? "", /link to other entries by WordPress post ID: related_services and team_services/);
	assert.match(find(a, "forms")?.reason ?? "", /\[contact-form-7\]/);
	assert.equal(find(a, "shortcodes"), undefined, "the form's shortcode is not counted twice");
	assert.deepEqual(checkSchema(schema, a), []);
	for (const f of a.findings) {
		for (const t of [f.reason, f.next]) for (const s of t.split(/(?<=\.)\s+/)) assert.ok(s.split(/\s+/).length <= 25, `short sentence: ${s}`);
	}
});

test("assess uses the model it is given for addresses", () => {
	const inv = sample("business.real");
	const model = propose(inv);
	for (const c of model.collections) if (c.route?.includes("{path}")) c.route = c.route.replace("{path}", "{slug}");
	const a = assess(inv, { themes: false, model });
	const addr = find(a, "addresses");
	assert.doesNotMatch(addr?.reason ?? "", /nested/, "no nested routes, so no nested page moves on EmDash");
	assert.match(addr?.reason ?? "", /out of \/site\//, "the subfolder move is still counted");
});

test("theme reasons count published items, not drafts or private ones", () => {
	const inv = sample("blog");
	const post = inv.types.find((t) => t.slug === "post");
	assert.ok(post);
	post.count = 124;
	post.byStatus = { publish: 110, draft: 10, private: 4 };
	inv.types.push({ slug: "project", label: "Projects", count: 9, byStatus: { publish: 6, draft: 3 }, fields: [], taxonomies: [], sources: ["rest"] });
	const themes: ThemeEntry[] = [{ slug: "t", name: "T", listed: true, url: "https://example.com/t/", fits: "It fits.", types: ["project"], keywords: [], plugins: [], pluginCategories: [], blog: 3, authors: 0 }];
	const m = matchThemes(inv, themes);
	assert.ok(m !== "none-fit");
	assert.match(m[0]?.reason ?? "", /110 posts and projects \(6\)/);
	assert.doesNotMatch(m[0]?.reason ?? "", /124|\(9\)/);
});
