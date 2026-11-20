// Fix round F, F4: the assessment on the six real e2e runs (test/fixtures/rf4-runs).
// The fixtures are the round 2 outputs. Where a fix needs an inventory field the other
// builders add this round (unpublished, comments.pending, Menu.kind, level 1 shortcodes),
// the test adds it to its copy, the way the new readers fill it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Inventory } from "../src/contracts/inventory.ts";
import type { Model } from "../src/contracts/model.ts";
import type { Assessment, Finding } from "../src/contracts/assessment.ts";
import { assess } from "../src/assess/index.ts";
import { planRedirects } from "../src/redirects/plan.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const RUNS = ["blog-l1", "blog-l3", "business-l1", "business-l3", "builder-l1", "builder-l3"] as const;
const load = <T>(run: string, file: string): T => JSON.parse(readFileSync(`${root}test/fixtures/rf4-runs/${run}/${file}.json`, "utf8")) as T;
const inventory = (run: string): Inventory => load<Inventory>(run, "inventory");
const model = (run: string): Model => load<Model>(run, "model");
const run = (name: string, inv: Inventory = inventory(name)): Assessment => assess(inv, { model: model(name), themes: false });
const find = (a: Assessment, area: string): Finding | undefined => a.findings.find((f) => f.area === area);

test("rf4 custom-types: plugin types are left out, labels keep their case", () => {
	const f = find(run("business-l3"), "custom-types");
	assert.equal(f?.count, 2);
	assert.deepEqual(f?.items, ["service", "team"]);
	assert.match(f?.reason ?? "", /^2 custom content types: Services \(8\) and Team \(5\)\.$/);
	assert.equal(find(run("builder-l3"), "custom-types"), undefined, "elementor_library and wpcf7_contact_form are plugin data");
});

test("rf4 Flamingo: saved form messages and contacts are data to export", () => {
	const f = run("business-l3").findings.find((x) => x.area === "stored-data" && /Flamingo/.test(x.reason));
	assert.ok(f, "a stored-data finding for Flamingo");
	assert.equal(f.count, 2);
	assert.deepEqual([...(f.items ?? [])].sort(), ["flamingo_contact", "flamingo_inbound"]);
	assert.match(f.reason, /^3 saved form messages and 5 contacts \(Flamingo\)\. Neither EmDash nor plain Astro imports them\. Save them before you switch off WordPress\.$/);
});

test("rf4 menus: count is the menus, EmDash link changes match the seed, slash changes too", () => {
	const blog = find(run("blog-l3"), "menus");
	assert.equal(blog?.count, 1);
	assert.deepEqual(blog?.items, ["Main menu"]);
	assert.match(blog?.reason ?? "", /1 menu with 5 links moves over\./);
	// seed/emdash-steps.md lists 4 changed links: /about/, /category/guides/, /category/guides/beginner/ and /contact/.
	assert.match(blog?.reason ?? "", /On EmDash, 4 links change with the page addresses: About: \/about\/ to \/about, /);
	for (const name of RUNS) {
		const f = find(run(name), "menus");
		if (f?.items) assert.equal(f.count, f.items.length, name);
	}
});

test("rf4 menus: a block theme's Navigation block always gets a finding, keyed on name plus kind", () => {
	const unread = find(run("builder-l3"), "menus");
	assert.ok(unread, "builder level 3 has a wp_navigation post and no classic menu");
	assert.match(unread.reason, /Rebuild the Navigation block by hand\./);
	const inv = inventory("blog-l3");
	const classic = inv.menus[0];
	assert.ok(classic);
	inv.menus.push({ ...classic, kind: "block" });
	const f = find(run("blog-l3", inv), "menus");
	assert.equal(f?.count, 2);
	assert.deepEqual(f?.items, ["Main menu", "Main menu (Navigation block)"]);
	assert.match(f?.reason ?? "", /1 menu with 5 links moves over\./);
	assert.match(f?.reason ?? "", /Rebuild the Navigation block by hand: 5 links\./);
});

test("rf4 addresses: count = items = old URLs not the same on either target; each target's groups add up", () => {
	for (const name of RUNS) {
		const inv = inventory(name);
		const m = model(name);
		const rows = [...planRedirects(inv, m, { target: "astro" }), ...planRedirects(inv, m, { target: "emdash" })];
		const expected = [...new Set(rows.filter((r) => r.status !== "same").map((r) => r.old))].sort();
		const f = find(run(name), "addresses");
		assert.ok(f, name);
		assert.equal(f.count, f.items?.length, name);
		assert.deepEqual([...(f.items ?? [])].sort(), expected, name);
		assert.ok(f.reason.startsWith(`${expected.length} old addresses change`), `${name}: ${f.reason}`);
		for (const target of ["plain Astro", "EmDash"]) {
			const at = f.reason.indexOf(`On ${target}, `);
			assert.ok(at >= 0, `${name}: a number for ${target}`);
			const tail = f.reason.slice(at + `On ${target}, `.length);
			const n = Number(/^(\d+) change/.exec(tail)?.[1]);
			const body = tail.slice(0, tail.search(/ On EmDash, \d+ change| (Post addresses|The old site|On EmDash, (nested|addresses))|$/));
			if (/^\d+ changes?:/.test(body)) {
				const sum = [...body.slice(body.indexOf(":") + 1).matchAll(/(\d+) [a-z]/g)].reduce((s, x) => s + Number(x[1]), 0);
				assert.equal(sum, n, `${name} ${target}: ${body}`);
			} else {
				const moved = Number(/(\d+) get a redirect/.exec(body)?.[1] ?? 0);
				const review = Number(/(\d+) needs? a new page/.exec(body)?.[1] ?? 0);
				assert.equal(moved + review, n, `${name} ${target}: ${body}`);
				for (const [, count, groups] of body.matchAll(/(\d+) (?:get a redirect|needs? a new page picked by hand): ([^.]+)\./g)) {
					const sum = [...(groups as string).matchAll(/(\d+) [a-z]/g)].reduce((s, x) => s + Number(x[1]), 0);
					assert.equal(sum, Number(count), `${name} ${target}: ${groups}`);
				}
			}
		}
	}
});

test("rf4 business addresses name each group with its count", () => {
	const f = find(run("business-l3"), "addresses");
	assert.match(f?.reason ?? "", /5 feeds/);
	assert.match(f?.reason ?? "", /6 attachment pages/);
});

test("rf4 posts and comments: drafts and private titles are named, pending comments counted", () => {
	const inv = inventory("blog-l3");
	const post = inv.types.find((t) => t.slug === "post");
	assert.ok(post);
	post.unpublished = [
		{ title: "Simple Broth No. 121", status: "draft" },
		{ title: "Slow Pickles No. 122", status: "draft" },
		{ title: "Better Pasta No. 123", status: "draft" },
		{ title: "Honest Pancakes No. 124", status: "private" },
	];
	assert.ok(inv.comments);
	inv.comments.pending = 1;
	const a = run("blog-l3", inv);
	const posts = find(a, "posts");
	for (const t of ["Simple Broth No. 121", "Slow Pickles No. 122", "Better Pasta No. 123"]) assert.ok(posts?.reason.includes(`"${t}" (draft)`), t);
	assert.ok(posts?.reason.includes(`"Honest Pancakes No. 124" (private)`));
	assert.match(find(a, "comments")?.reason ?? "", /22 comments are on the site\. 1 of them waits for approval/);
});

test("rf4 hidden-types: plugin types get no advice; others say what shows them", () => {
	assert.equal(find(run("builder-l1"), "hidden-types"), undefined, "elementor_library is plugin data");
	const f = find(run("business-l1"), "hidden-types");
	assert.deepEqual(f?.items, ["team"]);
	assert.equal(f?.next, "An export (level 2) or the password (level 3) shows them.");
	const inv = inventory("business-l1");
	inv.types.push({ slug: "elementor_library", byStatus: {}, fields: [], taxonomies: [], sources: ["rest"] });
	const g = find(run("business-l1", inv), "hidden-types");
	assert.deepEqual(g?.items, ["team"]);
	assert.match(g?.reason ?? "", /elementor_library is plugin data, left out of the move\./);
});

test("rf4 shortcodes: the count is the shortcodes listed, and the first sentence says so", () => {
	const l3 = find(run("builder-l3"), "shortcodes");
	assert.equal(l3?.count, 2);
	assert.equal(l3?.count, l3?.items?.length);
	assert.match(l3?.reason ?? "", /^2 shortcodes need a fix on the new site\./);
	assert.doesNotMatch(l3?.reason ?? "", /already run/);
	const l1 = find(run("builder-l1"), "shortcodes");
	assert.match(l1?.reason ?? "", /^1 shortcode needs a fix/);
	assert.match(l1?.reason ?? "", /WordPress has already run most shortcodes at this level; an export shows them all\./);
});

test("rf4 forms: level 1 names [contact-form-7] once the inventory has it; level 3 points to wpcf7_contact_form", () => {
	const inv = inventory("builder-l1");
	inv.shortcodes.push({ name: "contact-form-7", count: 1, samples: [`${inv.site.url.replace(/\/$/, "")}/?page_id=17`] });
	const l1 = find(run("builder-l1", inv), "forms");
	assert.match(l1?.reason ?? "", /\[contact-form-7\] places them in the content/);
	assert.doesNotMatch(l1?.reason ?? "", /wpcf7_contact_form/);
	assert.match(find(run("builder-l3"), "forms")?.reason ?? "", /The export holds each form's setup .* as a wpcf7_contact_form item\./);
});
