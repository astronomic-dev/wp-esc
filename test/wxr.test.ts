// The WXR reader (level 2) on the recorded exports.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readWxr } from "../src/sources/wxr/index.ts";
import { unserialize } from "../src/sources/wxr/acf.ts";
import { scanContent } from "../src/sources/wxr/content.ts";
import { stringify } from "../src/contracts/write.ts";
import { merge } from "../src/contracts/merge.ts";
import { PLUGINS } from "../src/sources/public/plugins-map.ts";
import { checkSchema } from "./helpers/check-schema.ts";
import type { ContentType, Field, Inventory } from "../src/contracts/inventory.ts";

const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));
const schema = JSON.parse(readFileSync(fileURLToPath(new URL("../schema/inventory.schema.json", import.meta.url)), "utf8")) as Record<string, unknown>;
const cache = new Map<string, Promise<Inventory>>();
const read = (site: string): Promise<Inventory> => {
	if (!cache.has(site)) cache.set(site, readWxr(`${fixtures}${site}/export.xml`));
	return cache.get(site)!;
};
const type = (inv: Inventory, slug: string): ContentType => {
	const t = inv.types.find((x) => x.slug === slug);
	assert.ok(t, `no type ${slug}`);
	return t!;
};
const field = (t: ContentType, key: string): Field => {
	const f = t.fields.find((x) => x.key === key);
	assert.ok(f, `${t.slug}: no field ${key}`);
	return f!;
};

test("unserialize reads PHP values, with byte lengths", () => {
	assert.deepEqual(unserialize('a:2:{i:0;s:2:"45";i:1;s:2:"46";}'), ["45", "46"]);
	assert.deepEqual(unserialize('a:1:{s:4:"type";s:6:"café!";}'), { type: "café!" });
	assert.deepEqual(unserialize("a:2:{s:1:\"a\";b:1;s:1:\"b\";d:1.5;}"), { a: true, b: 1.5 });
	assert.equal(unserialize("N;"), null);
	assert.equal(unserialize("not php"), undefined);
	assert.equal(unserialize('s:9:"short";'), undefined);
});

test("scanContent finds shortcodes and block comments", () => {
	const s = scanContent('<!-- wp:paragraph --><p>[gallery ids="1"] [[escaped]] [/gallery] [1] [pricing_table plan="x"]</p><!-- /wp:paragraph --><!-- wp:acme/hero {"a":1} /-->');
	assert.deepEqual([...s.shortcodes].sort(), ["gallery", "pricing_table"]);
	assert.deepEqual([...s.blocks].sort(), ["acme/hero", "core/paragraph"]);
});

test("every WXR inventory fits the schema and is byte-stable", async () => {
	for (const site of ["blog", "business", "builder"]) {
		const inv = await read(site);
		assert.deepEqual(checkSchema(schema, inv), [], site);
		const again = await readWxr(`${fixtures}${site}/export.xml`);
		assert.equal(stringify("inventory", again), stringify("inventory", inv), site);
		assert.deepEqual(inv.levels, [2]);
	}
});

test("business: types and statuses; plugin and site data types are counted, plumbing is left out", async () => {
	const inv = await read("business");
	const counts = Object.fromEntries(inv.types.map((t) => [t.slug, t.count]));
	assert.deepEqual(counts, {
		page: 13, post: 3, service: 8, team: 5,
		"acf-field": 13, "acf-field-group": 2, flamingo_contact: 5, flamingo_inbound: 3, wp_global_styles: 1, wp_navigation: 1, wpcf7_contact_form: 1,
	});
	for (const slug of ["acf-field", "flamingo_inbound", "wpcf7_contact_form", "wp_navigation"]) {
		const t = type(inv, slug);
		assert.deepEqual([t.fields, t.taxonomies, t.sources], [[], [], ["wxr"]], slug);
		assert.equal(inv.coverage.find((c) => c.area === `type:${slug}`)?.status, "complete", slug);
	}
	assert.deepEqual(type(inv, "flamingo_inbound").byStatus, { publish: 3 });
	assert.match(inv.coverage.find((c) => c.area === "type:flamingo_inbound")?.detail ?? "", /in this export file, but EmDash does not import them/);
	assert.match(inv.coverage.find((c) => c.area === "acf")?.detail ?? "", /2 field groups, 13 fields/);
	assert.deepEqual(type(inv, "team").byStatus, { publish: 5 });
	assert.deepEqual(type(inv, "team").sources, ["wxr"]);
	assert.equal(inv.media?.count, 6);
	assert.equal(inv.authors?.count, 1);
	assert.equal(inv.site.url, "http://localhost:4602/site/");
	assert.equal(inv.site.name, "Harbor Light Home Services");
	assert.equal(inv.site.wpVersion, "7.1.4");
	assert.deepEqual(inv.site.locales, [{ code: "en-US", default: true }]);
	const wxr = inv.coverage.find((c) => c.area === "wxr");
	assert.equal(wxr?.status, "complete");
	assert.match(wxr?.detail ?? "", /not in the export/);
});

test("business: ACF fields with shapes, groups, order and confidence", async () => {
	const inv = await read("business");
	const service = type(inv, "service");
	const tagline = field(service, "tagline");
	assert.deepEqual(
		{ owner: tagline.owner, shape: tagline.shape, label: tagline.label, group: tagline.group, order: tagline.order, filled: tagline.filled, total: tagline.total, confidence: tagline.confidence },
		{ owner: "acf", shape: "text", label: "Tagline", group: "Service details", order: 0, filled: 8, total: 8, confidence: "high" },
	);
	assert.equal(field(service, "hero_image").shape, "image");
	const related = field(service, "related_services");
	assert.equal(related.shape, "relation");
	assert.deepEqual(related.targets, ["service"]);
	assert.equal(related.confidence, "low");
	const warranty = field(service, "warranty_note");
	assert.deepEqual([warranty.filled, warranty.total, warranty.confidence], [1, 8, "low"]);
	assert.match(warranty.note ?? "", /1 of 8/);
	const thumb = field(service, "_thumbnail_id");
	assert.deepEqual([thumb.owner, thumb.shape, thumb.filled], ["core", "image", 8]);
	assert.equal(field(service, "post_title").owner, "core");
	assert.ok(service.fields.every((f) => f.source === "wxr"));
	assert.ok(!service.fields.some((f) => f.key.startsWith("_faq") || f.key.startsWith("faq_")), "row keys are folded into the repeater");
	assert.deepEqual(service.taxonomies, ["service_area"]);
});

test("business: repeaters carry their subfields", async () => {
	const inv = await read("business");
	const faq = field(type(inv, "service"), "faq");
	assert.equal(faq.shape, "repeater");
	assert.equal(faq.confidence, "low");
	assert.deepEqual(faq.subfields?.map((s) => [s.key, s.label, s.shape, s.filled, s.total, s.order]), [
		["answer", "Answer", "text", 15, 15, 1],
		["question", "Question", "text", 15, 15, 0],
	]);
	const team = type(inv, "team");
	const creds = field(team, "credentials");
	assert.deepEqual([creds.shape, creds.filled, creds.total], ["repeater", 3, 5]);
	assert.deepEqual(creds.subfields?.map((s) => [s.key, s.shape, s.filled, s.total]), [
		["credential", "text", 4, 4],
		["year", "number", 4, 4],
	]);
	assert.equal(field(team, "team_services").shape, "relation");
	assert.equal(field(team, "job_title").group, "Team profile");
});

test("business: taxonomies, menus, ledger, plugins and stored data", async () => {
	const inv = await read("business");
	const area = inv.taxonomies.find((t) => t.slug === "service_area");
	assert.deepEqual([area?.count, area?.hierarchical, area?.types], [4, true, ["service"]]);
	assert.ok(!inv.taxonomies.some((t) => t.slug === "nav_menu"));
	assert.deepEqual(inv.menus.map((m) => [m.name, m.kind]).sort(), [["Primary", "block"], ["Primary", "classic"]]);
	const menu = inv.menus.find((m) => m.kind === "classic")!;
	assert.deepEqual([menu.id, menu.name, menu.source, menu.items.length], [6, "Primary", "wxr", 4]);
	const archive = menu.items.find((i) => i.target?.kind === "archive");
	assert.deepEqual(archive?.target, { kind: "archive", type: "service" });
	assert.equal(archive?.title, "All services");
	const sub = menu.items.find((i) => i.parent !== undefined);
	assert.equal(sub?.title, "Residential");
	assert.equal(sub?.url, "http://localhost:4602/site/what-we-do/residential/");
	assert.equal(menu.items.find((i) => i.id === sub?.parent)?.title, "What we do");
	const pricing = inv.urls.filter((u) => u.slug === "pricing");
	assert.equal(pricing.length, 2);
	assert.deepEqual(pricing.map((u) => u.path).sort(), ["what-we-do/commercial/pricing", "what-we-do/residential/pricing"]);
	assert.ok(pricing.every((u) => u.kind === "page" && u.parentId !== undefined && u.evidence === "listed"));
	assert.ok(inv.urls.some((u) => u.type === "team" && u.kind === "custom" && u.url.endsWith("/team/ines-duarte/")));
	assert.ok(inv.urls.some((u) => u.kind === "home"));
	const queries = inv.urls.filter((u) => u.kind === "query" && u.type === "team").map((u) => [u.url, u.id]);
	assert.deepEqual(queries, [52, 53, 54, 55, 56].map((id) => [`http://localhost:4602/site/?p=${id}`, id]), "team gets ?p= forms from WXR IDs");
	assert.ok(inv.urls.some((u) => u.kind === "query" && u.url === "http://localhost:4602/site/?page_id=13" && u.id === 13));
	assert.ok(!inv.urls.some((u) => u.kind === "query" && u.type === "attachment"));
	const photo = inv.urls.find((u) => u.url === "http://localhost:4602/site/services/roof-tarping/harbor-light-photo-1/");
	assert.deepEqual([photo?.kind, photo?.parentId, photo?.file], ["attachment", 49, "http://localhost:4602/site/wp-content/uploads/2026/11/harbor-light-photo-1.png"]);
	assert.ok(!inv.urls.some((u) => u.url.includes("acf-field") || u.url.includes("flamingo")));
	assert.deepEqual(inv.storedElsewhere, [], "the Flamingo messages are in the export");
	const slugs = inv.plugins.map((p) => p.slug);
	assert.ok(slugs.includes("flamingo") && slugs.includes("contact-form-7"));
	assert.equal(inv.permalinks.structure, "/%postname%/");
});

test("business: no emails, logins or form messages in the output", async () => {
	const text = stringify("inventory", await read("business"));
	assert.doesNotMatch(text, /@example\.com/);
	assert.doesNotMatch(text, /dana-whitlock/);
	assert.doesNotMatch(text, /Lena Ortiz|Quote request/);
});

test("builder: Contact Form 7 alone stores nothing elsewhere; Elementor and shortcodes", async () => {
	const inv = await read("builder");
	assert.deepEqual(inv.storedElsewhere, []);
	assert.deepEqual(inv.builders.map((b) => [b.name, b.count]), [["elementor", 3]]);
	const sc = Object.fromEntries(inv.shortcodes.map((s) => [s.name, s.count]));
	// pricing_table: once in the Pricing page content, and in a shortcode widget on three Elementor pages.
	assert.deepEqual(sc, { "contact-form-7": 1, gallery: 1, pricing_table: 4 });
	const pricing = inv.shortcodes.find((s) => s.name === "pricing_table");
	assert.equal(pricing?.samples.length, 3);
	const blocks = inv.blocks.map((b) => b.name);
	assert.ok(blocks.includes("core/heading") && blocks.includes("core/columns"));
	assert.deepEqual(["elementor_library", "wpcf7_contact_form"].map((slug) => type(inv, slug).count), [1, 1]);
	const page = type(inv, "page");
	assert.ok(!page.fields.some((f) => f.key.startsWith("_elementor")), "Elementor data is usage, not a field");
	assert.equal(field(page, "_wp_page_template").owner, "core");
	assert.ok(inv.plugins.some((p) => p.slug === "elementor" && p.category === "builder"));
	// A plain-permalink link keeps its type's kind and slug, as level 1 gives it.
	const pricingPage = inv.urls.find((u) => u.url === "http://localhost:4603/?page_id=16");
	assert.deepEqual([pricingPage?.kind, pricingPage?.slug, pricingPage?.id], ["page", "pricing", 16]);
	assert.equal(inv.urls.find((u) => u.url === "http://localhost:4603/?p=20")?.kind, "post");
	const att = inv.urls.find((u) => u.url === "http://localhost:4603/?attachment_id=6");
	assert.deepEqual([att?.kind, att?.file, att?.parentId], ["attachment", "http://localhost:4603/wp-content/uploads/2026/11/studio-work-1.png", undefined]);
	assert.equal(inv.permalinks.structure, "");
});

test("blog: drafts and private posts, Yoast fields, nested categories, one menu", async () => {
	const inv = await read("blog");
	const post = type(inv, "post");
	assert.equal(post.count, 124);
	assert.deepEqual(post.byStatus, { publish: 120, draft: 3, private: 1 });
	const seo = field(post, "_yoast_wpseo_title");
	assert.deepEqual([seo.owner, seo.label], ["seo", "SEO title"]);
	assert.ok(!post.fields.some((f) => f.key === "_encloseme" || f.key === "_pingme"));
	assert.equal(inv.authors?.count, 2);
	assert.ok(inv.plugins.some((p) => p.slug === "wordpress-seo" && p.source === "wxr"));
	assert.equal(inv.permalinks.structure, "/%year%/%monthnum%/%postname%/");
	const cat = inv.taxonomies.find((t) => t.slug === "category");
	assert.deepEqual([cat?.count, cat?.hierarchical], [8, true]);
	assert.equal(inv.taxonomies.find((t) => t.slug === "post_tag")?.count, 25);
	assert.deepEqual(inv.menus.map((m) => [m.name, m.kind, m.items.length]).sort(), [["Main menu", "block", 5], ["Main menu", "classic", 5]]);
	const termItem = inv.menus.find((m) => m.kind === "classic")?.items.find((i) => i.target?.kind === "category");
	assert.ok(termItem?.target?.id !== undefined);
	assert.ok(!inv.urls.some((u) => /\?p=13[123]$/.test(u.url)), "drafts are not in the ledger");
	// An attachment with no post_parent takes the first published post that uses it as its featured image.
	const photo = inv.urls.find((u) => u.url === "http://localhost:4601/kitchen-photo-2/");
	assert.deepEqual([photo?.kind, photo?.parentId, photo?.file], ["attachment", 19, "http://localhost:4601/wp-content/uploads/2026/11/kitchen-photo-2.png"]);
});

test("wp-inventory --wxr alone writes the level 2 inventory", async () => {
	const dir = mkdtempSync(join(tmpdir(), "wpm-wxr-bin-"));
	try {
		const out = join(dir, "inventory.json");
		const bin = fileURLToPath(new URL("../bin/wp-inventory.mjs", import.meta.url));
		const r = spawnSync(process.execPath, [bin, "--wxr", `${fixtures}business/export.xml`, "--out", out], { encoding: "utf8", env: { PATH: process.env.PATH ?? "" } });
		assert.equal(r.status, 0, r.stderr);
		assert.equal(readFileSync(out, "utf8"), stringify("inventory", merge(await read("business"))), "the CLI runs merge's whole-inventory rules too");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("comments: counted per type, never read; a site with none says so", async () => {
	const blog = await read("blog");
	assert.deepEqual(blog.comments, { count: 22, source: "wxr", byType: { post: 22 }, pending: 1 });
	assert.equal(blog.coverage.find((c) => c.area === "comments")?.status, "complete");
	const business = await read("business");
	assert.deepEqual(business.comments, { count: 0, source: "wxr" });
	assert.match(business.coverage.find((c) => c.area === "comments")?.detail ?? "", /No comments/);
});
