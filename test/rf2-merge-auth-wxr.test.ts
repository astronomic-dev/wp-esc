// Fix round F, builder F2: level 2/3 coverage text, unpublished titles, pending comments,
// block theme navigation, menu numbering, and the README.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createReplayFetch } from "../src/http/replay.ts";
import { readAuth } from "../src/sources/auth/index.ts";
import { readPublic } from "../src/sources/public/index.ts";
import { readWxr } from "../src/sources/wxr/index.ts";
import { DRAFTS_CLAUSE, merge } from "../src/contracts/merge.ts";
import { MAX_UNPUBLISHED_PER_TYPE } from "../src/sources/limits.ts";
import { checkSchema } from "./helpers/check-schema.ts";
import type { Inventory } from "../src/contracts/inventory.ts";

const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));
const schema = JSON.parse(readFileSync(fileURLToPath(new URL("../schema/inventory.schema.json", import.meta.url)), "utf8")) as Record<string, unknown>;
const SITES = {
	blog: { root: "/wp-json/", base: "/" },
	business: { root: "/site/wp-json/", base: "/site/" },
	builder: { root: "/index.php?rest_route=/", base: "/" },
} as const;
type Site = keyof typeof SITES;

const cache = new Map<string, Promise<Inventory>>();
function once(key: string, make: () => Promise<Inventory>): Promise<Inventory> {
	if (!cache.has(key)) cache.set(key, make());
	return cache.get(key)!;
}
const pub = (site: Site) => once(`pub ${site}`, async () => {
	const door = createReplayFetch(`${fixtures}${site}`);
	return readPublic(door, `${door.origin}${SITES[site].base}`);
});
const wxr = (site: Site) => once(`wxr ${site}`, () => readWxr(`${fixtures}${site}/export.xml`));
const auth = (site: Site) => once(`auth ${site}`, async () => {
	const door = createReplayFetch(`${fixtures}${site}`);
	const { root, base } = SITES[site];
	door.setApiRoot(door.origin + root);
	const inv = await readAuth(door, { siteUrl: door.origin + base, apiRoot: door.origin + root });
	assert.deepEqual(door.misses, [], site);
	return inv;
});
const level2 = async (site: Site) => merge(await pub(site), await wxr(site));
const level3 = async (site: Site) => merge(await pub(site), await wxr(site), await auth(site));
const line = (inv: Inventory, area: string) => inv.coverage.find((c) => c.area === area)?.detail ?? "";

test("E4: once the export or the password gave raw content, the html line says so", async () => {
	for (const site of Object.keys(SITES) as Site[]) {
		for (const inv of [await level2(site), await level3(site)]) {
			const html = line(inv, "html");
			assert.doesNotMatch(html, /counted from the REST content/, site);
			assert.doesNotMatch(html, /WordPress has already run the shortcodes/, site);
			assert.match(html, /Builders, shortcodes and blocks are counted from the raw content in the export\./, site);
		}
	}
	// Level 1's two shared sentences go; the password alone names itself.
	const lo = structuredClone(await pub("builder"));
	const html = lo.coverage.find((c) => c.area === "html")!;
	html.detail = "Read a sample of 7 pages. Builders, shortcodes and blocks are counted from the REST content of 12 items, not from this sample. WordPress has already run the shortcodes in that content, so level 1 sees only the ones it can spot from their output; an export shows them all.";
	const out = line(merge(lo, await auth("builder")), "html");
	assert.equal(out, "Read a sample of 7 pages. Builders, shortcodes and blocks are counted from the raw content read with the password.");
});

test("B10, U12, E19: no drafts clause after level 2 or 3, and no \"edit context\"", async () => {
	const lo = structuredClone(await pub("blog"));
	for (const c of lo.coverage) if (c.area === "type:post" || c.area === "type:page") c.detail = `Read 120 posts; ${DRAFTS_CLAUSE}`;
	for (const hi of [await wxr("blog"), await auth("blog")]) {
		const all = merge(lo, hi);
		for (const c of all.coverage) {
			assert.doesNotMatch(c.detail, /drafts and private items need/, c.area);
			assert.doesNotMatch(c.detail, /edit context/, c.area);
		}
	}
	// Level 1 alone keeps the clause.
	assert.match(line(merge(lo), "type:post"), /drafts and private items need an export \(level 2\) or the password \(level 3\)\./);
	for (const site of Object.keys(SITES) as Site[]) {
		for (const c of (await level3(site)).coverage) assert.doesNotMatch(c.detail, /edit context/, `${site} ${c.area}`);
	}
});

test("B3, B7: unpublished titles and pending comments, from the export and the password", async () => {
	for (const inv of [await wxr("blog"), await auth("blog"), await level3("blog")]) {
		const post = inv.types.find((t) => t.slug === "post");
		assert.deepEqual(post?.unpublished?.map((u) => u.status).sort(), ["draft", "draft", "draft", "private"]);
		assert.ok(post?.unpublished?.some((u) => u.title === "Honest Pancakes No. 124" && u.status === "private"));
		assert.equal(inv.comments?.pending, 1);
		assert.match(line(inv, "comments"), /1 comment waits for approval; level 1 sees approved comments only\./);
		assert.deepEqual(checkSchema(schema, inv), []);
	}
	const all = await level3("blog");
	assert.equal(all.comments?.count, 22);
	assert.equal((line(all, "comments").match(/waits for approval/g) ?? []).length, 1, "said once");
	// A site with no drafts has no list.
	assert.ok(!(await level3("business")).types.some((t) => t.unpublished));
});

test("unpublished holds at most MAX_UNPUBLISHED_PER_TYPE titles", async () => {
	const items = Array.from({ length: 25 }, (_, i) => `<item><title>Draft ${i}</title><wp:post_id>${i + 1}</wp:post_id><wp:status>draft</wp:status><wp:post_type>post</wp:post_type></item>`).join("");
	const xml = `<?xml version="1.0"?><rss xmlns:wp="http://wordpress.org/export/1.2/"><channel><wp:base_site_url>https://example.com</wp:base_site_url>${items}</channel></rss>`;
	const { readWxrChunks } = await import("../src/sources/wxr/index.ts");
	const inv = await readWxrChunks((async function* () { yield xml; })());
	assert.equal(inv.types.find((t) => t.slug === "post")?.unpublished?.length, MAX_UNPUBLISHED_PER_TYPE);
	assert.equal(inv.types.find((t) => t.slug === "post")?.count, 25);
});

test("E14: the settings line says when no posts page is set", async () => {
	assert.match(line(await level3("builder"), "settings"), /No posts page is set; the home page is page 12\./);
	assert.match(line(await level3("business"), "settings"), /The home page is page 13\. The posts page is page 25\./);
});

test("E13, B18: Navigation blocks become block menus; the menus line names both kinds", async () => {
	const builder = await level3("builder");
	const block = builder.menus.filter((m) => m.kind === "block");
	assert.equal(block.length, 1);
	assert.equal(block[0]?.name, "Navigation");
	assert.ok((block[0]?.items.length ?? 0) > 0, "the page list adds the published pages");
	assert.ok(block[0]?.items.every((i) => i.target?.kind === "page" && i.url.startsWith("http://localhost:4603/")));
	assert.match(line(builder, "menus"), /The menu is the Navigation block "Navigation"/);

	const blog = await level3("blog");
	assert.deepEqual(blog.menus.map((m) => [m.name, m.kind ?? "classic"]).sort(), [["Main menu", "block"], ["Main menu", "classic"]]);
	const nav = blog.menus.find((m) => m.kind === "block")!;
	assert.deepEqual(nav.items.map((i) => [i.title, i.url.replace("http://localhost:4601", "")]), [["Home", "/"], ["About", "/about/"], ["Guides", "/category/guides/"], ["Beginner", "/category/guides/beginner/"], ["Contact", "/contact/"]]);
	assert.equal(nav.items.find((i) => i.title === "Beginner")?.parent, nav.items.find((i) => i.title === "Guides")?.id);
	assert.deepEqual(nav.items.find((i) => i.title === "About")?.target, { kind: "page", type: "page", id: 134 });
	assert.deepEqual(nav.items.find((i) => i.title === "Guides")?.target, { kind: "category", type: "category", id: 4 });
	const menus = line(blog, "menus");
	assert.match(menus, /the classic menu "Main menu" and the Navigation block "Main menu"\. If the theme's header uses a Navigation block, the header shows that one, so check the live header\./);
	assert.deepEqual(checkSchema(schema, blog), []);
});

test("U19: classic menu items are numbered 1…N; the count matches the export", async () => {
	const xml = readFileSync(`${fixtures}business/export.xml`, "utf8");
	const exported = (xml.match(/<wp:post_type>(<!\[CDATA\[)?nav_menu_item(\]\]>)?<\/wp:post_type>/g) ?? []).length;
	for (const inv of [await wxr("business"), await auth("business"), await level3("business")]) {
		const primary = inv.menus.find((m) => m.name === "Primary" && m.kind !== "block")!;
		assert.deepEqual(primary.items.map((i) => i.order).sort(), [1, 2, 3, 4]);
		assert.equal(primary.items.length, exported);
		assert.match(line(inv, "menus"), new RegExp(`Read 1 menu with ${exported} items\\.`));
	}
});

test("README: pnpm install, the HTTP switch, no lock file claim", () => {
	const readme = readFileSync(fileURLToPath(new URL("../README.md", import.meta.url)), "utf8");
	assert.doesNotMatch(readme, /no lock file/);
	assert.match(readme, /pnpm install/);
	assert.match(readme, /corepack enable/);
	assert.ok(readme.includes("WPM_ALLOW_HTTP_LOCALHOST=1 lets the scripts read an http:// site on localhost, such as a test site on your own computer. Do not set it for a live site."));
	assert.match(readme, /"users" coverage line/);
	assert.match(readme, /may end/);
	assert.match(readme, /new folder/);
});
