// Round E fixes to the content model, seed and EmDash steps (from the e2e runs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Field, Inventory, UrlEntry } from "../src/contracts/inventory.ts";
import type { Model, ModelField } from "../src/contracts/model.ts";
import { checkCount, emdashUrlFor, propose, seedNotes, seedOf, writeModelFiles } from "../src/model/index.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const inventory = (name: string): Inventory => JSON.parse(readFileSync(join(root, `test/samples/${name}.inventory.json`), "utf8")) as Inventory;
const field = (m: Model, collection: string, name: string): ModelField | undefined => m.collections.find((c) => c.slug === collection)?.fields.find((f) => f.name === name);
const allChecks = (m: Model): string[] => {
	const out: string[] = [];
	const walk = (fields: ModelField[]): void => {
		for (const f of fields) {
			if (f.check) out.push(f.check);
			walk(f.subfields ?? []);
		}
	};
	for (const c of m.collections) {
		if (c.check) out.push(c.check);
		walk(c.fields);
	}
	for (const t of m.taxonomies) if (t.check) out.push(t.check);
	return out;
};

test("checkCount counts every check note: collections, fields, repeater rows, taxonomies", () => {
	for (const name of ["blog", "business", "builder", "store", "multilingual"]) {
		const m = propose(inventory(name));
		assert.equal(checkCount(m), allChecks(m).length, name);
		assert.equal(checkCount(m), (JSON.stringify(m).match(/"check":/g) ?? []).length, name);
	}
});

test("CLI: the printed note count equals the check notes in model.json", () => {
	const dir = mkdtempSync(join(tmpdir(), "wpm-e-"));
	try {
		const inv = inventory("business");
		inv.taxonomies.push({ slug: "post_tag", count: 0, types: ["post"], sources: ["rest"] });
		const file = join(dir, "inventory.json");
		writeFileSync(file, JSON.stringify(inv));
		const r = spawnSync(process.execPath, [join(root, "bin/wp-content-model.mjs"), "--inventory", file, "--out", dir], { encoding: "utf8" });
		assert.equal(r.status, 0, r.stderr);
		const m = JSON.parse(readFileSync(join(dir, "model.json"), "utf8")) as Model;
		const printed = Number(/(\d+) notes? to check/.exec(r.stdout)?.[1]);
		assert.equal(printed, (JSON.stringify(m).match(/"check":/g) ?? []).length);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("dated permalinks: the posts note says the URLs fit the structure, not that they share no pattern", () => {
	const m = propose(inventory("blog"));
	const posts = m.collections.find((c) => c.slug === "posts");
	assert.equal(posts?.route, "/blog/{slug}/");
	assert.doesNotMatch(posts?.check ?? "", /did not share one pattern/);
	assert.match(posts?.check ?? "", /follow the permalink structure \/%year%\/%monthnum%\/%postname%\//);
});

test("posts that really break the structure still get the no-pattern note", () => {
	const inv = inventory("blog");
	const post = inv.urls.find((u) => u.kind === "post") as UrlEntry;
	post.url = post.url.replace(/\d{4}\/\d{2}\//, "odd/");
	const posts = propose(inv).collections.find((c) => c.slug === "posts");
	assert.match(posts?.check ?? "", /did not share one pattern/);
});

test("a root page (the front page) does not break the pages pattern", () => {
	const inv = inventory("business");
	inv.urls.push({ url: inv.site.url, kind: "page", type: "page", id: 99, slug: "home", source: ["rest"], evidence: "resolved" });
	const pages = propose(inv).collections.find((c) => c.slug === "pages");
	assert.equal(pages?.route, "/{path}/");
	assert.doesNotMatch(pages?.check ?? "", /did not share one pattern/);
});

test("plugin and builder post types are left out, with a note naming them", () => {
	const inv = inventory("builder");
	const base = { byStatus: {}, fields: [], taxonomies: [], sources: ["wxr" as const] };
	inv.types.push({ slug: "elementor_library", count: 2, ...base }, { slug: "e-floating-buttons", count: 0, ...base }, { slug: "wpcf7_contact_form", count: 1, ...base }, { slug: "wp_navigation", count: 1, ...base }, { slug: "revision", count: 9, ...base }, { slug: "e-landing-page", count: 1, ...base }, { slug: "shop_order_placehold", count: 1, ...base }, { slug: "memberpressproduct", count: 1, ...base }, { slug: "wpforms", count: 1, ...base });
	const m = propose(inv);
	const slugs = m.collections.map((c) => c.from);
	for (const t of ["elementor_library", "e-floating-buttons", "wpcf7_contact_form", "wp_navigation", "revision", "e-landing-page", "shop_order_placehold", "memberpressproduct", "wpforms"]) assert.ok(!slugs.includes(t), t);
	const note = (m.leftOut ?? []).join(" ");
	assert.match(note, /Left out post types that hold plugin, builder or theme data, not site content: e-floating-buttons, e-landing-page, elementor_library, memberpressproduct, shop_order_placehold, wp_navigation, wpforms\./);
	assert.match(note, /Left out wpcf7_contact_form: it holds your form setup \(fields and mail settings\); use it to rebuild the forms\./);
	assert.doesNotMatch(note, /revision/);
	assert.doesNotMatch(m.collections.find((c) => c.from === "page")?.check ?? "", /Left out/);
});

test("every inventory field is in the model or named in a Left out note; the focus keyphrase is kept", () => {
	const inv = inventory("blog");
	const post = inv.types.find((t) => t.slug === "post")!;
	const seo = (key: string): Field => ({ key, owner: "seo", shape: "text", confidence: "low", filled: 3, total: 10, samples: ["a"], source: "wxr" });
	post.fields.push(seo("_yoast_wpseo_focuskw"), seo("_yoast_wpseo_canonical"));
	const page = inv.types.find((t) => t.slug === "page")!;
	page.fields.push({ key: "post_date", owner: "core", shape: "date", confidence: "high", filled: 2, total: 2, samples: ["2026-01-01"], source: "rest" });
	const m = propose(inv);
	const kp = field(m, "posts", "seo_focus_keyphrase");
	assert.deepEqual(kp && { from: kp.from, type: kp.type, required: kp.required }, { from: "_yoast_wpseo_focuskw", type: "string", required: false });
	for (const t of inv.types) {
		const c = m.collections.find((x) => x.from === t.slug)!;
		for (const f of t.fields) {
			const inModel = c.fields.some((x) => x.from === f.key);
			const named = (c.leftOut ?? []).some((n) => n.includes(f.key));
			assert.ok(inModel || named, `${t.slug}.${f.key}`);
		}
	}
	assert.match((m.collections.find((c) => c.from === "post")?.leftOut ?? []).join(" "), /Left out SEO plugin keys .*_yoast_wpseo_canonical/);
	assert.match((m.collections.find((c) => c.from === "page")?.leftOut ?? []).join(" "), /Left out the WordPress dates \(post_date\)/);
});

test("with the export read, a REST-only excerpt counts as 0 written by hand", () => {
	const inv = inventory("business");
	const page = inv.types.find((t) => t.slug === "page")!;
	page.sources = [...page.sources, "wxr"];
	const excerpt = page.fields.find((f) => f.key === "post_excerpt");
	if (excerpt) Object.assign(excerpt, { shape: "html", source: "rest", filled: 3, total: 3 });
	else page.fields.push({ key: "post_excerpt", owner: "core", shape: "html", confidence: "medium", filled: 3, total: 3, samples: ["<p>x</p>"], source: "rest" });
	const check = field(propose(inv), "pages", "excerpt")?.check ?? "";
	assert.match(check, /^No entry has one\. Remove it\?/);
	assert.doesNotMatch(check, /made from the content|Level 1 counts/);
});

test("excerpt and featured_image: every collection keeps both, with one reason", () => {
	const inv = inventory("business");
	inv.types.push({ slug: "team", count: 3, byStatus: {}, fields: [{ key: "job_title", owner: "acf", shape: "text", confidence: "high", filled: 3, total: 3, samples: ["Lead"], source: "wxr" }], taxonomies: [], sources: ["wxr"] });
	const m = propose(inv);
	for (const c of m.collections) {
		assert.ok(c.fields.some((f) => f.name === "excerpt"), c.slug);
		assert.ok(c.fields.some((f) => f.name === "featured_image"), c.slug);
	}
	const reason = /Kept \(optional\), since EmDash's import can ask for it\./;
	assert.match(field(m, "team", "excerpt")?.check ?? "", reason);
	assert.match(field(m, "team", "featured_image")?.check ?? "", reason);
});

test("collection names: one note says post and page become posts and pages", () => {
	const m = propose(inventory("business"));
	const notes = allChecks(m).filter((n) => /Collection names/.test(n));
	assert.equal(notes.length, 1);
	assert.match(notes[0] as string, /page becomes pages.*Other post types keep their WordPress names \(service/);
});

test("routes: home always; a home that listed posts gets a blog route and a note", () => {
	const blog = propose(inventory("blog"));
	assert.ok(blog.routes.some((r) => r.kind === "home" && r.pattern === "/"));
	assert.match(blog.collections.find((c) => c.slug === "posts")?.check ?? "", /The old home page listed the latest posts\. On the new site the post list is at \/blog\//);
	const inv = inventory("business");
	inv.urls = inv.urls.filter((u) => u.kind !== "home");
	const m = propose(inv);
	assert.ok(m.routes.some((r) => r.kind === "home" && r.pattern === "/"));
	assert.ok(!allChecks(m).some((n) => /listed the latest posts/.test(n)));
});

test("a home page that lists posts, with posts at /{slug}/, gets /blog/", () => {
	const inv = inventory("multilingual");
	if (!inv.urls.some((u) => u.kind === "home")) inv.urls.push({ url: inv.site.url, kind: "home", source: ["html"], evidence: "resolved" });
	for (const u of inv.urls) if (u.kind === "home") delete u.type;
	const m = propose(inv);
	assert.equal(m.collections.find((c) => c.slug === "posts")?.route, "/{slug}/");
	assert.ok(m.routes.some((r) => r.kind === "blog" && r.pattern === "/blog/"));
});

test("term routes: plain-link terms get the usual path; nested terms route by {path}", () => {
	const inv = inventory("builder");
	inv.taxonomies = [{ slug: "category", hierarchical: true, count: 1, types: ["post"], sources: ["rest"] }];
	inv.urls = inv.urls.filter((u) => u.taxonomy !== "category");
	inv.urls.push({ url: new URL("?cat=1", inv.site.url).href, kind: "category", taxonomy: "category", slug: "uncategorized", source: ["rest"], evidence: "listed" });
	const cat = propose(inv).taxonomies.find((t) => t.slug === "category");
	assert.equal(cat?.route, "/category/{path}/");
	assert.match(cat?.check ?? "", /plain links/);

	const biz = inventory("business");
	const area = biz.taxonomies.find((t) => t.slug === "service_area")!;
	area.hierarchical = true;
	biz.urls.push({ url: new URL("service-area/same-day/", biz.site.url).href, kind: "term", taxonomy: "service_area", slug: "same-day", path: "emergency/same-day", source: ["rest"], evidence: "listed" });
	const tx = propose(biz).taxonomies.find((t) => t.slug === "service_area");
	assert.equal(tx?.route, "/service-area/{path}/");
	assert.match(tx?.check ?? "", /Old term URLs were flat/);
});


// --- Seed and EmDash steps -------------------------------------------------------------

const S = (inv: Inventory) => ({ seed: seedOf(propose(inv), { inventory: inv }) as { collections: { slug: string; fields: { slug: string; type: string }[] }[] }, notes: seedNotes(propose(inv), { inventory: inv }) });

test("level 1 seed: repeater rows from samples cut short, and the subfield counts, are all listed", () => {
	const inv = inventory("business");
	const service = inv.types.find((t) => t.slug === "service")!;
	const faq: Field = {
		key: "faq", owner: "acf", shape: "repeater", confidence: "low", filled: 2, total: 2, source: "rest", note: 'Field type "repeater" as the REST API reports it.',
		samples: ['[{"question":"Q0?","answer":"A0."}]', '[{"question":"Q0?","answer":"A0."},{"question":"Q1?","answer":"A1."},{"question":"Q2 about…'],
		subfields: [
			{ key: "question", owner: "acf", shape: "text", confidence: "medium", filled: 4, total: 4, samples: ["Q0?"], source: "rest" },
			{ key: "answer", owner: "acf", shape: "text", confidence: "medium", filled: 4, total: 4, samples: ["A0."], source: "rest" },
		],
	};
	service.fields = service.fields.filter((f) => f.key !== "faq").concat(faq);
	const { seed, notes } = S(inv);
	const slugs = seed.collections.find((c) => c.slug === "service")!.fields.map((f) => f.slug);
	for (const k of ["faq_0_question", "faq_1_question", "faq_2_question", "faq_2_answer"]) assert.ok(slugs.includes(k), k);
	assert.ok(notes.some((n) => n.startsWith("service: faq: ") && /cut short/.test(n)));
});

test("seed: image notes match the seed type; text and textarea get one name", () => {
	const inv = inventory("business");
	const service = inv.types.find((t) => t.slug === "service")!;
	const img = (key: string): Field => ({ key, owner: "acf", shape: "image", confidence: "medium", filled: 3, total: 3, samples: ["10", "11"], source: "rest", note: 'Field type "image" as the REST API reports it.' });
	const note = (key: string, acf: string, sample: string): Field => ({ key, owner: "acf", shape: "text", confidence: "medium", filled: 1, total: 3, samples: [sample], source: "rest", note: `Field type "${acf}" as the REST API reports it.` });
	service.fields = service.fields.filter((f) => !["hero_image", "headshot", "warranty_note"].includes(f.key)).concat(img("hero_image"), img("headshot"), note("warranty_note", "textarea", "One year."));
	const { seed, notes } = S(inv);
	const fields = seed.collections.find((c) => c.slug === "service")!.fields;
	const typeOf = (slug: string) => fields.find((f) => f.slug === slug)?.type;
	assert.equal(typeOf("hero_image"), "reference");
	assert.equal(typeOf("headshot"), "integer");
	assert.match(notes.find((n) => n.startsWith("service: hero_image: after the import")) ?? "", /as a reference field/);
	assert.match(notes.find((n) => n.startsWith("service: headshot: after the import")) ?? "", /as an integer/);
	assert.equal(typeOf("warranty_note"), "string", "a one-line textarea is string, as in the model");
	assert.ok(!notes.some((n) => /warranty_note is \w+ in the seed/.test(n)));
	// The same field read from the export gives the same type.
	const wxr = inventory("business");
	const s2 = wxr.types.find((t) => t.slug === "service")!;
	s2.fields = s2.fields.filter((f) => f.key !== "warranty_note").concat({ ...note("warranty_note", "textarea", "One year."), source: "wxr", note: "Filled on 1 of 3." });
	assert.equal(S(wxr).seed.collections.find((c) => c.slug === "service")!.fields.find((f) => f.slug === "warranty_note")?.type, "string");
});

test("EmDash: nested term paths flatten to /<prefix>/<slug>, and the seed notes say so", () => {
	const m = propose(inventory("blog"));
	assert.equal(m.taxonomies.find((t) => t.slug === "category")?.route, "/category/{path}/");
	assert.equal(emdashUrlFor(m, "/category/guides/beginner/setup/"), "/category/setup");
	assert.equal(emdashUrlFor(m, "/category/guides/"), "/category/guides");
	assert.equal(emdashUrlFor(m, "/tag/bread/"), "/tag/bread");
	assert.ok(seedNotes(m).some((n) => n.startsWith("category: term pages are at /category/{slug}, not /category/{path}/")));
});

test("the seed keeps seo_focus_keyphrase and says the import does not fill it", () => {
	const inv = inventory("blog");
	inv.types.find((t) => t.slug === "post")!.fields.push({ key: "_yoast_wpseo_focuskw", owner: "seo", shape: "text", confidence: "low", filled: 3, total: 10, samples: ["bread"], source: "wxr" });
	const { seed, notes } = S(inv);
	assert.equal(seed.collections.find((c) => c.slug === "posts")!.fields.find((f) => f.slug === "seo_focus_keyphrase")?.type, "string");
	assert.ok(notes.some((n) => n.startsWith("posts: seo_focus_keyphrase: EmDash's import does not bring the focus keyphrase")));
});

test("emdash-steps.md: the password stays out of commands, the site URL is real, the re-run is whole", async () => {
	for (const [name, apiRoot, want] of [
		["business", undefined, "wp-json/emdash/v1/analyze"],
		["builder", "http://localhost:4603/index.php?rest_route=/", "http://localhost:4603/index.php?rest_route=/emdash/v1/analyze"],
	] as const) {
		const inv = inventory(name);
		if (apiRoot) inv.site.apiRoot = apiRoot;
		else delete inv.site.apiRoot;
		const dir = mkdtempSync(join(tmpdir(), "wpm-e-steps-"));
		try {
			await writeModelFiles(propose(inv), dir, { seed: true }, { inventory: inv });
			const text = readFileSync(join(dir, "seed/emdash-steps.md"), "utf8");
			assert.doesNotMatch(text, /USER:APPLICATION-PASSWORD|your-site\.example\.com/, name);
			assert.ok(text.includes(`printf 'user = "%s:%s"\\n' "$WPM_WP_USER" "$WPM_WP_APP_PASSWORD" | curl -K - '${apiRoot ? want : new URL(want, inv.site.url).href}' -o emdash-analyze.json`), name);
			assert.doesNotMatch(text, /curl -u/, `${name}: -u puts the password in curl's arguments`);
			assert.ok(text.includes("`node ~/wp-esc/bin/wp-content-model.mjs --model model.json --seed --emdash-analyze emdash-analyze.json`"), name);
			assert.ok(text.includes("`unset WPM_WP_USER WPM_WP_APP_PASSWORD`"), name);
			assert.match(text, /revoke the password/);
			assert.doesNotMatch(text, /use the application password|user name and application password/, name);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}
});
