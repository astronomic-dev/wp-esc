// Fix round F (F3): the content model, seed and EmDash steps, checked on the inventories
// of the round 2 e2e runs (test/fixtures/rf3-runs: blog, business and builder sites, levels 1 and 3).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Inventory } from "../src/contracts/inventory.ts";
import type { Model, ModelField } from "../src/contracts/model.ts";
import { checkCount, leftOutCount, propose, seedOf, toAstroConfig, writeModelFiles } from "../src/model/index.ts";
import { checkSchema } from "./helpers/check-schema.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const SITES = ["blog", "business", "builder"] as const;
const inventory = (name: string): Inventory => JSON.parse(readFileSync(join(root, `test/fixtures/rf3-runs/${name}.inventory.json`), "utf8")) as Inventory;
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
	for (const mm of m.menus) if (mm.check) out.push(mm.check);
	return out;
};
const modelSchema = JSON.parse(readFileSync(join(root, "schema/model.schema.json"), "utf8")) as Record<string, unknown>;

async function steps(name: string, inv: Inventory = inventory(name)): Promise<{ model: Model; text: string; seed: Record<string, unknown> }> {
	const dir = mkdtempSync(join(tmpdir(), "wpm-rf3-"));
	try {
		const model = propose(inv);
		await writeModelFiles(model, dir, { seed: true }, { inventory: inv });
		return { model, text: readFileSync(join(dir, "seed/emdash-steps.md"), "utf8"), seed: JSON.parse(readFileSync(join(dir, "seed/seed.json"), "utf8")) };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test("every proposed model validates against the schema, leftOut included", () => {
	for (const s of SITES) for (const l of [1, 3]) assert.deepEqual(checkSchema(modelSchema, propose(inventory(`${s}-l${l}`))), [], `${s}-l${l}`);
});

// --- 1. The home page and the posts page --------------------------------------------------

test("business level 3: the pages note names the front page and the posts page", () => {
	const m = propose(inventory("business-l3"));
	const check = m.collections.find((c) => c.from === "page")?.check ?? "";
	assert.ok(check.includes("Page 13 (Home) is the front page. Build it at / and do not also publish it at /home/."), check);
	assert.ok(check.includes("Page 25 (News) is the posts page. The posts list takes /news/; drop this page or move its text onto the list."), check);
	assert.doesNotMatch(check, /Level 1 cannot see/);
});

test("business level 3: no two items land on one path without a note", () => {
	const inv = inventory("business-l3");
	const m = propose(inv);
	const pages = m.collections.find((c) => c.from === "page")!;
	const fill = (route: string, slug: string, path: string): string => route.replace("{slug}", slug).replace("{path}", path);
	const at = new Map<string, string[]>();
	const add = (path: string, what: string): void => void at.set(path, [...(at.get(path) ?? []), what]);
	for (const r of m.routes) add(r.pattern, `route ${r.kind}`);
	// Every WordPress page, the front page and the posts page too, is an entry in pages.
	for (const u of inv.urls) {
		if (u.id === undefined || !u.slug) continue;
		if (u.type === "page" || (u.kind === "archive" && u.type === "post")) add(fill(pages.route!, u.slug, u.path ?? u.slug), `page ${u.id}`);
	}
	const home = inv.urls.find((u) => u.kind === "home")!;
	add("/", `page ${home.id}`); // the front page is built at /
	for (const [path, what] of at) {
		if (what.length < 2) continue;
		for (const w of what.filter((x) => x.startsWith("page "))) assert.ok((pages.check ?? "").includes(`Page ${w.slice(5)} (`), `${path}: ${what.join(", ")}`);
	}
});

test("level 1: a page called news is flagged as a possible posts page", () => {
	const check = propose(inventory("business-l1")).collections.find((c) => c.from === "page")?.check ?? "";
	assert.ok(check.includes("Level 1 cannot see which page lists the posts. Check whether /news/ is the blog."), check);
	assert.ok(check.includes("Page 13 (Home) is the front page."), check);
});

// --- 2. Left out notes ---------------------------------------------------------------------

test("builder level 3: Left out notes are in leftOut, never in check; the printed count is the check notes", () => {
	const inv = inventory("builder-l3");
	const m = propose(inv);
	for (const c of allChecks(m)) assert.doesNotMatch(c, /Left out/i);
	const lo = (m.leftOut ?? []).join("\n");
	assert.match(lo, /Left out post types that hold plugin, builder or theme data, not site content: e-floating-buttons, elementor_library, wp_global_styles, wp_navigation\./);
	assert.ok(lo.includes("holds your form setup (fields and mail settings); use it to rebuild the forms"), lo);
	assert.ok(m.collections.find((c) => c.from === "page")?.leftOut?.some((n) => n.startsWith("Left out WordPress internal keys")));
	assert.equal(checkCount(m), allChecks(m).length);
	assert.equal(checkCount(m), (JSON.stringify(m).match(/"check":/g) ?? []).length);

	const dir = mkdtempSync(join(tmpdir(), "wpm-rf3-"));
	try {
		const file = join(dir, "inventory.json");
		writeFileSync(file, JSON.stringify(inv));
		const r = spawnSync(process.execPath, [join(root, "bin/wp-content-model.mjs"), "--inventory", file, "--out", dir], { encoding: "utf8" });
		assert.equal(r.status, 0, r.stderr);
		const written = JSON.parse(readFileSync(join(dir, "model.json"), "utf8")) as Model;
		assert.equal(Number(/(\d+) notes? to check/.exec(r.stdout)?.[1]), allChecks(written).length, r.stdout);
		assert.equal(Number(/(\d+) "Left out" notes?/.exec(r.stdout)?.[1]), leftOutCount(written), r.stdout);
		// content.config.ts: one "Check:" per check note on collections and fields; Left out notes are not Check lines.
		const config = toAstroConfig(written);
		for (const line of config.split("\n").filter((x) => x.includes("Check:"))) assert.doesNotMatch(line.slice(line.indexOf("Check:")), /Check: Left out/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("business level 3: Flamingo messages get their own Left out note", () => {
	const lo = propose(inventory("business-l3")).leftOut ?? [];
	assert.ok(lo.includes("Left out flamingo_inbound: it holds saved form messages; save them before you switch."), lo.join("\n"));
	assert.ok(!lo.some((n) => n.startsWith("Left out post types") && n.includes("flamingo")), lo.join("\n"));
});

// --- 3. Field notes follow one rule --------------------------------------------------------

test("blog level 3: sparse SEO fields ask Keep it?, empty ones ask Remove it?", () => {
	const m = propose(inventory("blog-l3"));
	assert.equal(field(m, "posts", "seo_title")?.check, "Filled on 31 of 124. Keep it?");
	assert.equal(field(m, "posts", "seo_description")?.check, "Filled on 31 of 124. Keep it?");
	assert.match(field(m, "posts", "excerpt")?.check ?? "", /^Filled on 41 of 124\. Keep it\?$/);
	assert.match(field(m, "posts", "featured_image")?.check ?? "", /^Filled on 12 of 124\. Keep it\?$/);
	assert.match(field(m, "pages", "seo_description")?.check ?? "", /^No entry has one\. Remove it\?/);
	for (const c of allChecks(m)) {
		for (const part of c.match(/Filled on \d+ of \d+\.[^.]*/g) ?? []) assert.match(part, /Filled on \d+ of \d+\. Keep it\?/, c);
	}
});

test("level 1: excerpt and SEO notes quote the count and warn that it can be high", () => {
	const service = field(propose(inventory("business-l1")), "service", "excerpt")?.check ?? "";
	assert.doesNotMatch(service, /made from the content/);
	assert.equal(service, "Filled on 8 of 8. Level 1 counts can be high: WordPress fills these from defaults.");
	const blog = propose(inventory("blog-l1"));
	for (const name of ["seo_title", "seo_description", "excerpt"]) assert.match(field(blog, "posts", name)?.check ?? "", /Level 1 counts can be high: WordPress fills these from defaults\.$/, name);
	// Level 3 reads the export, so the warning goes away.
	assert.doesNotMatch(JSON.stringify(propose(inventory("blog-l3"))), /Level 1 counts/);
});

// --- 4. Plain permalinks -------------------------------------------------------------------

test("builder: plain permalinks are named as plain links, at level 1 and 3", () => {
	for (const l of [1, 3]) {
		const m = propose(inventory(`builder-l${l}`));
		for (const from of ["page", "post"]) {
			const check = m.collections.find((c) => c.from === from)?.check ?? "";
			assert.ok(check.includes("Old URLs are plain links (?p=, ?page_id=); each one moves to a readable path."), `${l} ${from}: ${check}`);
		}
		assert.doesNotMatch(JSON.stringify(m), /did not share one pattern/);
	}
});

// --- 5. Routes and docs --------------------------------------------------------------------

test("every route kind in the models is named in the SKILL", () => {
	const skill = readFileSync(join(root, "skills/wp-content-model/SKILL.md"), "utf8");
	const kinds = new Set<string>();
	for (const s of SITES) for (const l of [1, 3]) for (const r of propose(inventory(`${s}-l${l}`)).routes) kinds.add(r.kind);
	assert.ok(kinds.size >= 5, [...kinds].join(", "));
	for (const k of kinds) assert.ok(skill.includes(`- \`${k}\`:`), k);
	assert.match(skill, /Each kind appears only when the old site had it/);
});

test("author pages with plain links still get an author route", () => {
	assert.ok(propose(inventory("builder-l3")).routes.some((r) => r.kind === "author" && r.pattern === "/author/{slug}/"));
});

test("EmDash steps say what to build for the feed and author pages", async () => {
	const { text } = await steps("business-l3");
	assert.match(text, /## Pages EmDash does not make/);
	assert.match(text, /EmDash does not make one .*build it at \/rss\.xml/);
	assert.match(text, /build a page at \/author\/\{slug\}/);
});

// --- 6. seed/emdash-steps.md ---------------------------------------------------------------

test("business level 3 steps: duplicate slugs are named, and the analyze paragraph appears once", async () => {
	const { text } = await steps("business-l3");
	assert.ok(text.includes("two pages use the slug pricing: /site/what-we-do/commercial/pricing/ and /site/what-we-do/residential/pricing/"), text);
	assert.equal(text.split("Make a new application password").length - 1, 1);
	assert.equal(text.split("printf 'user").length - 1, 1);
	assert.match(text, /## An EmDash site that is already set up\n\n1\. [^\n]+\n2\. [^\n]*as step 2 under "A fresh EmDash site" says\./);
});

test("business level 3 steps: serialized relation lists get an import note", async () => {
	const { text } = await steps("business-l3");
	assert.match(text, /related_services: the WordPress export stores these as serialized PHP .*does not turn it into an ID list/);
});

// --- 7. Menus ------------------------------------------------------------------------------

test("builder level 3: a Navigation block menu stays a menu, with a note, and the seed lists its links", async () => {
	const inv = inventory("builder-l3");
	const home = inv.urls.find((u) => u.kind === "home")!;
	const page = inv.urls.find((u) => u.kind === "page" && u.type === "page")!;
	inv.menus.push({ id: 40, name: "Navigation", kind: "block", source: "auth", items: [
		{ id: 1, order: 1, title: "Home", url: home.url },
		{ id: 2, order: 2, title: "About", url: page.url, target: { kind: "page", type: "page", id: page.id } },
	] });
	const { model, seed } = await steps("builder-l3", inv);
	assert.equal(model.menus.length, 1);
	assert.match(model.menus[0]!.check ?? "", /Navigation block .*Compare its links with the header on the live site/);
	const menus = seed.menus as { items: { label: string; url?: string }[] }[];
	assert.deepEqual(menus[0]!.items.map((i) => i.label), ["Home", "About"]);
	assert.ok((model.leftOut ?? []).some((n) => n.includes("wp_navigation") && n.includes("kept in the menus")));
	assert.equal(checkCount(model), allChecks(model).length);

	inv.menus.push({ id: 41, name: "Main menu", kind: "classic", source: "rest", items: [{ id: 3, order: 1, title: "Home", url: home.url }] });
	const both = propose(inv);
	assert.equal(both.menus.length, 2);
	const note = both.menus.find((x) => x.from === "Navigation")?.check ?? "";
	assert.match(note, /also has the classic menu Main menu\. Check which one the live header shows/);
	assert.ok(seedOf(both));
});

// --- 8. A later level after a reviewed model -----------------------------------------------

test("the SKILL says how to carry a reviewed model over to a later level", () => {
	const skill = readFileSync(join(root, "skills/wp-content-model/SKILL.md"), "utf8");
	assert.match(skill, /do not propose over the reviewed file/);
	assert.match(skill, /new folder/);
	assert.match(skill, /Carry the user's edits over/);
});
