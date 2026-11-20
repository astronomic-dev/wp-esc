// Findings the e2e runs found wrong or missing: addresses, fields, posts, comments,
// core shortcodes and the custom-types count.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Inventory } from "../src/contracts/inventory.ts";
import type { Assessment, Finding } from "../src/contracts/assessment.ts";
import { assess } from "../src/assess/index.ts";
import { propose } from "../src/model/index.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const sample = (name: string): Inventory => JSON.parse(readFileSync(`${root}test/samples/${name}.inventory.json`, "utf8")) as Inventory;
const find = (a: Assessment, area: string): Finding | undefined => a.findings.find((f) => f.area === area);
const shortSentences = (f: Finding | undefined): void => {
	for (const t of [f?.reason ?? "", f?.next ?? ""]) for (const s of t.split(/(?<=\.)\s+/)) assert.ok(s.split(/\s+/).length <= 25, `short sentence: ${s}`);
};

test("addresses: every changed post address is counted, with the permalink change and EmDash's missing slash", () => {
	const a = assess(sample("blog"), { themes: false });
	const f = find(a, "addresses");
	assert.ok(f, "an addresses finding whenever an address changes");
	assert.equal(f.count, f.items?.length, "count equals items");
	assert.ok(f.items?.includes("/2026/03/up-the-north-ridge/"), "post addresses are counted");
	assert.match(f.reason, /Post addresses change from \/%year%\/%monthnum%\/%postname%\/ to \/blog\/\{slug\}\//);
	assert.match(f.reason, /On EmDash, addresses lose the slash at the end/);
	assert.ok(f.items?.some((i) => i.includes("?")), "query URLs that change are counted too");
	shortSentences(f);
});

test("addresses: a subfolder install says every address moves out of the old base path", () => {
	const f = find(assess(sample("business"), { themes: false }), "addresses");
	assert.match(f?.reason ?? "", /The old site is at \/site\/, and the new site is at the root, so the addresses move out of \/site\//);
	shortSentences(f);
});

test("addresses: with plain permalinks, ?p= and ?page_id= are the real addresses and count", () => {
	const inv = sample("builder");
	inv.permalinks = { ...inv.permalinks, structure: "" };
	const f = find(assess(inv, { themes: false }), "addresses");
	assert.match(f?.reason ?? "", /plain addresses such as \/\?p=123/);
	assert.ok(f?.items?.some((i) => i.includes("?page_id=")));
});

test("fields: the count equals the items, and the check count comes from model.json", () => {
	const inv = sample("blog");
	const page = inv.types.find((t) => t.slug === "page")!;
	const post = inv.types.find((t) => t.slug === "post")!;
	page.fields.push({ ...post.fields.find((x) => x.key === "_yoast_wpseo_title")!, confidence: "low" });
	const model = propose(inv);
	for (const c of model.collections) for (const fl of c.fields) if (fl.from === "_yoast_wpseo_title") delete fl.check;
	const f = find(assess(inv, { themes: false, model }), "fields");
	assert.equal(f?.count, f?.items?.length);
	assert.doesNotMatch(f?.reason ?? "", /marked "check this"/, "no field in model.json has a check note");
	const c = model.collections.find((x) => x.from === "post")!;
	const fl = c.fields.find((x) => x.from === "_yoast_wpseo_title")!;
	fl.check = "Check this.";
	assert.match(find(assess(inv, { themes: false, model }), "fields")?.reason ?? "", /1 is marked "check this"/);
});

test("posts: drafts and private posts are named", () => {
	const inv = sample("blog");
	const post = inv.types.find((t) => t.slug === "post")!;
	post.count = 124;
	post.byStatus = { publish: 120, draft: 3, private: 1 };
	const f = find(assess(inv, { themes: false }), "posts");
	assert.match(f?.reason ?? "", /^124 posts, with 3 drafts and 1 private post\./);
	assert.match(f?.next ?? "", /Decide which unpublished ones to move/);
	shortSentences(f);
});

test("comments: a finding when the site has comments, none when it has none", () => {
	const inv = sample("blog");
	assert.equal(find(assess(inv, { themes: false }), "comments"), undefined);
	inv.comments = { count: 22, source: "wxr" };
	const f = find(assess(inv, { themes: false }), "comments");
	assert.equal(f?.count, 22);
	assert.match(f?.reason ?? "", /Plain Astro has no comments/);
	assert.match(f?.reason ?? "", /EmDash Exporter plugin brings comments over/);
	assert.match(f?.reason ?? "", /export file does not/);
	shortSentences(f);
});

test("shortcodes: core shortcodes are listed with what they need, with item counts", () => {
	const inv = sample("blog");
	inv.shortcodes = [{ name: "gallery", count: 2, samples: [] }, { name: "pricing_table", count: 4, samples: [] }];
	const f = find(assess(inv, { themes: false }), "shortcodes");
	assert.deepEqual(f?.items, ["gallery", "pricing_table"]);
	assert.match(f?.reason ?? "", /\[pricing_table\] \(4 items\)/);
	assert.match(f?.reason ?? "", /\[gallery\] \(2 items\) is WordPress core; it needs a gallery or embed section on plain Astro/);
});

test("custom-types: the count is the number of types", () => {
	const f = find(assess(sample("business"), { themes: false }), "custom-types");
	assert.equal(f?.count, f?.items?.length);
});
