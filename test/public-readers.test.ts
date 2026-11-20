// Level 1 readers over recorded fixtures. Each case lists a fixture and what the
// inventory must show. The mini-* fixtures are hand-made; the real recordings (blog,
// business, builder, blog-rest-off) run as soon as their folders exist.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createReplayFetch, type Manifest } from "../src/http/replay.ts";
import { createCollector } from "../src/sources/public/collect.ts";
import { discover } from "../src/sources/public/discover.ts";
import { readPublic } from "../src/sources/public/index.ts";
import { stringify } from "../src/contracts/write.ts";
import type { Inventory } from "../src/contracts/inventory.ts";
import { checkSchema } from "./helpers/check-schema.ts";

const schema = JSON.parse(readFileSync(new URL("../schema/inventory.schema.json", import.meta.url), "utf8")) as Record<string, unknown>;

interface Case {
	fixture: string;
	/** The site's base path on the fixture origin. */
	base: string;
	check: (inv: Inventory, origin: string, requests: string[]) => void;
}

const type = (inv: Inventory, slug: string) => {
	const t = inv.types.find((x) => x.slug === slug);
	assert.ok(t, `type ${slug}`);
	return t;
};
const coverage = (inv: Inventory, area: string) => {
	const c = inv.coverage.find((x) => x.area === area);
	assert.ok(c, `coverage ${area}`);
	return c;
};
const url = (inv: Inventory, u: string) => {
	const e = inv.urls.find((x) => x.url === u);
	assert.ok(e, `url ${u}`);
	return e;
};
const has = (list: { name: string }[], name: string): boolean => list.some((x) => x.name === name);

const CASES: Case[] = [
	{
		fixture: "mini-blog",
		base: "/",
		check(inv, o, requests) {
			assert.equal(inv.site.apiRoot, `${o}/wp-json/`);
			assert.equal(inv.site.name, "Mini Blog");
			assert.equal(inv.site.wpVersion, "6.8.3");
			assert.equal(inv.site.theme, "twentytwentyfour");
			assert.deepEqual(inv.site.locales, [{ code: "en-US", default: true }]);
			const post = type(inv, "post");
			assert.equal(post.count, 150);
			assert.deepEqual(post.byStatus, { publish: 150 });
			assert.deepEqual(post.sources, ["rest", "sitemap"], "the sampled pages' body classes do not name the type");
			assert.ok(requests.includes("GET /wp-json/wp/v2/posts?per_page=100&page=2"));
			assert.ok(!requests.includes("GET /wp-json/wp/v2/posts?per_page=100&page=3"));
			assert.equal(coverage(inv, "type:post").status, "partial");
			assert.equal(coverage(inv, "rest").status, "complete");
			assert.equal(type(inv, "page").count, 3);
			assert.ok(!inv.types.some((t) => t.slug === "attachment" || t.slug === "wp_block"));
			assert.deepEqual(inv.media, { count: 1, source: "rest" });
			assert.deepEqual(inv.authors, { count: 1, source: "rest" });
			const local = url(inv, `${o}/category/news/local/`);
			assert.equal(local.kind, "category");
			assert.equal(local.parentId, 1);
			assert.equal(local.path, "news/local");
			assert.equal(inv.taxonomies.find((t) => t.slug === "category")?.count, 2);
			assert.ok(!inv.taxonomies.some((t) => t.slug === "wp_pattern_category"));
			const team = url(inv, `${o}/about/team/`);
			assert.equal(team.path, "about/team");
			assert.equal(team.parentId, 1000);
			assert.equal(url(inv, `${o}/?p=150`).kind, "query");
			assert.equal(url(inv, `${o}/2026/06/post-150/`).evidence, "resolved", "newest first, as REST lists them");
			assert.deepEqual(url(inv, `${o}/2026/06/post-150/`).source, ["html", "rest", "sitemap"]);
			assert.equal(url(inv, `${o}/2026/01/post-1/`).evidence, "listed");
			assert.equal(url(inv, `${o}/2026/05/post-5/`).evidence, "listed");
			assert.equal(url(inv, `${o}/`).kind, "home");
			assert.equal(url(inv, `${o}/feed/`).kind, "feed");
			assert.equal(url(inv, `${o}/page/2/`).kind, "paged");
			assert.equal(url(inv, `${o}/2026/03/`).kind, "date");
			assert.equal(url(inv, `${o}/author/ruth/`).kind, "author");
			assert.ok(!inv.urls.some((u) => u.url.includes("elsewhere")));
			assert.deepEqual(inv.permalinks, { structure: "/%year%/%monthnum%/%postname%/", source: "rest", confidence: "medium" });
			const slugs = inv.plugins.map((p) => `${p.slug}:${p.category}`);
			assert.ok(slugs.includes("contact-form-7:forms"));
			assert.ok(slugs.includes("wordpress-seo:seo"));
			assert.ok(post.fields.some((f) => f.key === "_yoast_wpseo_title" && f.owner === "seo" && f.filled === 0), "every title is Yoast's default");
			const thumb = post.fields.find((f) => f.key === "_thumbnail_id");
			assert.equal(thumb?.filled, 75);
			assert.equal(type(inv, "page").fields.find((f) => f.key === "post_content")?.filled, 2);
			assert.ok(has(inv.blocks, "core/image"));
			assert.ok(has(inv.blocks, "core/columns"));
			assert.ok(!inv.blocks.some((b) => b.name.includes("__")));
			assert.ok(inv.blocks.every((b) => /^[a-z0-9-]+\/[a-z0-9-]+$/.test(b.name)), "real block names only");
			assert.deepEqual(inv.blocks.find((b) => b.name === "core/image")?.samples, [`${o}/2026/06/post-150/`], "from content, not the theme");
			assert.equal(coverage(inv, "sitemaps").status, "complete");
			assert.equal(coverage(inv, "html").status, "partial");
		},
	},
	{
		fixture: "mini-sub",
		base: "/site/",
		check(inv, o) {
			assert.equal(inv.site.url, `${o}/site/`);
			assert.equal(inv.site.apiRoot, `${o}/site/wp-json/`);
			assert.equal(inv.site.theme, "kadence");
			const service = type(inv, "service");
			assert.equal(service.count, 2);
			assert.equal(service.inRest, true);
			assert.deepEqual(service.taxonomies, ["service_area"]);
			assert.ok(service.fields.some((f) => f.key === "price" && f.owner === "meta" && f.shape === "number" && f.filled === 1 && f.total === 2));
			const team = type(inv, "team");
			assert.deepEqual(team.sources, ["sitemap"]);
			assert.equal(team.count, undefined);
			assert.equal(team.inRest, false);
			assert.equal(coverage(inv, "type:team").status, "partial");
			assert.match(coverage(inv, "type:team").detail, /^The REST API does not list it\. Seen in the sitemap \(\d+ URLs?\)/);
			const ana = url(inv, `${o}/site/team/ana/`);
			assert.equal(ana.kind, "custom");
			assert.equal(ana.type, "team");
			assert.equal(ana.slug, "ana");
			assert.equal(url(inv, `${o}/site/about/history/`).path, "about/history");
			assert.equal(url(inv, `${o}/site/services-info/history/`).path, "services-info/history");
			assert.equal(url(inv, `${o}/site/service_area/north/`).kind, "term");
			assert.equal(url(inv, `${o}/site/?p=20`).kind, "query");
			assert.equal(inv.permalinks.structure, "/%postname%/");
		},
	},
	{
		fixture: "mini-query",
		base: "/",
		check(inv, o, requests) {
			assert.equal(inv.site.apiRoot, `${o}/?rest_route=/`);
			assert.ok(requests.includes("GET /wp-json/"));
			assert.ok(requests.includes("GET /?rest_route=/wp/v2/posts&per_page=100&page=1"));
			assert.equal(type(inv, "post").count, 2);
			assert.equal(url(inv, `${o}/?p=1`).kind, "post");
			assert.equal(url(inv, `${o}/?page_id=5`).kind, "page");
			assert.equal(inv.permalinks.structure, "");
			const el = inv.builders.find((b) => b.name === "elementor");
			assert.equal(el?.count, 1, "items with Elementor markup in their content (page 5 is also the home page: one item)");
			assert.deepEqual(el?.samples, [`${o}/?page_id=5`]);
			assert.ok(has(inv.builders, "divi"));
			assert.ok(inv.plugins.some((p) => p.slug === "elementor" && p.category === "builder"));
			assert.deepEqual(inv.shortcodes.map((s) => s.name).sort(), ["gallery", "pricing_table"]);
			assert.equal(inv.shortcodes.find((s) => s.name === "pricing_table")?.count, 1);
			assert.match(coverage(inv, "html").detail, /counted from the REST content of 3 items/);
			assert.equal(coverage(inv, "sitemaps").status, "complete");
			assert.equal(url(inv, `${o}/?p=2`).source.includes("sitemap"), true);
		},
	},
	{
		fixture: "mini-off",
		base: "/",
		check(inv, o) {
			assert.equal(coverage(inv, "rest").status, "failed");
			assert.match(coverage(inv, "rest").detail, /401/);
			const post = type(inv, "post");
			assert.deepEqual(post.sources, ["sitemap"]);
			assert.equal(post.count, undefined);
			assert.equal(coverage(inv, "type:post").status, "partial");
			assert.equal(url(inv, `${o}/2026/03/ridge/`).kind, "post");
			assert.equal(url(inv, `${o}/2026/03/ridge/`).evidence, "resolved");
			assert.equal(url(inv, `${o}/category/trips/coast/`).kind, "category");
			assert.equal(url(inv, `${o}/category/trips/coast/`).path, "trips/coast");
			assert.ok(inv.taxonomies.some((t) => t.slug === "category" && t.count === undefined));
			assert.deepEqual(inv.permalinks, { structure: "/%year%/%monthnum%/%postname%/", source: "sitemap", confidence: "low" });
			assert.equal(inv.authors, undefined);
			assert.ok(!inv.urls.some((u) => u.url.includes("elsewhere")));
		},
	},
	// Real recordings from Task 2.
	{
		fixture: "blog",
		base: "/",
		check(inv, o, requests) {
			const post = type(inv, "post");
			assert.equal(post.count, 120);
			assert.ok(requests.some((r) => /\/wp\/v2\/posts\?per_page=100&page=2$/.test(r)));
			const nested = inv.urls.filter((u) => u.kind === "category" && u.parentId !== undefined);
			assert.ok(nested.length > 0, "nested categories");
			assert.equal(inv.permalinks.structure, "/%year%/%monthnum%/%postname%/");
			assert.ok(inv.plugins.some((p) => p.slug === "wordpress-seo"));
			assert.equal(inv.site.apiRoot, `${o}/wp-json/`);
			assert.deepEqual(inv.comments, { count: 21, source: "rest" }, "X-WP-Total of the comment list");
			const home = url(inv, `${o}/`);
			assert.deepEqual([home.kind, home.type], ["home", undefined], "the home page lists posts");
			// Ledger gaps filled from post dates and counts.
			assert.equal(url(inv, `${o}/2024/12/`).kind, "date");
			assert.equal(url(inv, `${o}/2024/`).kind, "date");
			for (let p = 2; p <= 12; p++) assert.equal(url(inv, `${o}/page/${p}/`).kind, "paged", `page ${p}`);
			assert.ok(!inv.urls.some((u) => u.url === `${o}/page/13/`), "120 posts at 10 a page");
			assert.equal(url(inv, `${o}/category/guides/page/2/`).kind, "paged");
			const cat = inv.urls.find((u) => u.url.startsWith(`${o}/?cat=`));
			assert.deepEqual([cat?.kind, cat?.taxonomy, typeof cat?.termId], ["query", "category", "number"]);
			assert.ok(inv.urls.some((u) => u.url.startsWith(`${o}/?tag=`) && u.taxonomy === "post_tag" && u.termId !== undefined));
			const author = inv.urls.find((u) => u.url.startsWith(`${o}/?author=`));
			assert.deepEqual([author?.kind, author?.id, typeof author?.slug], ["query", undefined, "string"], "no post id on an author link");
			assert.match(coverage(inv, "urls").detail, /^Added \d+ URLs that no content list names, from post dates and counts\. The ledger has \d+ date archives, \d+ later list pages and \d+ feeds\./);
			assert.match(coverage(inv, "sitemaps").detail, /^Read 5 sitemaps listed in the index/);
			assert.equal(coverage(inv, "comments").status, "partial");
		},
	},
	{
		fixture: "business",
		base: "/site/",
		check(inv, o) {
			assert.equal(inv.site.apiRoot, `${o}/site/wp-json/`);
			const service = type(inv, "service");
			assert.equal(service.inRest, true);
			assert.equal(service.count, 8);
			const f = (k: string) => service.fields.find((x) => x.key === k);
			assert.ok(!service.fields.some((x) => x.key.endsWith("_source") || x.key.startsWith("_acf")), "no SCF metadata or internal keys as fields");
			assert.deepEqual([f("tagline")?.label, f("tagline")?.shape, f("tagline")?.owner], ["Tagline", "text", "acf"]);
			assert.equal(f("hero_image")?.shape, "image");
			assert.equal(f("related_services")?.shape, "relation");
			assert.equal(f("faq")?.shape, "repeater");
			assert.deepEqual(f("faq")?.subfields?.map((x) => x.key), ["answer", "question"]);
			assert.equal(f("warranty_note")?.filled, 1);
			assert.equal(f("warranty_note")?.total, 8);
			assert.equal(type(inv, "page").count, 13);
			const home = url(inv, `${o}/site/`);
			assert.deepEqual([home.kind, home.type, home.id], ["home", "page", 13]);
			assert.ok(inv.urls.some((u) => u.type === "team" && u.kind === "custom"));
			const team = type(inv, "team");
			assert.deepEqual(team.sources, ["html", "sitemap"], "body class single-team");
			assert.equal(team.count, undefined);
			assert.equal(coverage(inv, "type:team").status, "partial");
			assert.match(coverage(inv, "type:team").detail, /Seen in the sitemap and the HTML sample \(5 URLs\)/);
			assert.match(coverage(inv, "sitemaps").detail, /^Read 7 sitemaps listed in the index at \/site\/wp-sitemap\.xml\./, "the index is not counted");
			const term = (slug: string) => inv.urls.find((u) => u.taxonomy === "service_area" && u.slug === slug);
			assert.equal(term("emergency")?.count, 0, "an empty term says so, so the redirect plan can choose");
			assert.ok((term("residential")?.count ?? 0) > 0);
			assert.equal(coverage(inv, "html").detail, "Read a sample of 13 pages: the home page and up to 3 pages of each type, at most 30. Pages outside the sample are not read. Builders, shortcodes and blocks are counted from the REST content of 24 items, not from this sample. WordPress has already run the shortcodes in that content, so level 1 sees only the ones it can spot from their output; an export shows them all. contact-form-7 was seen from its output.");
		},
	},
	{
		fixture: "builder",
		base: "/",
		check(inv, o) {
			assert.match(inv.site.apiRoot ?? "", /^http:\/\/localhost:\d+\/(index\.php)?\?rest_route=\/$/);
			assert.ok(has(inv.builders, "elementor"));
			assert.ok(has(inv.shortcodes, "pricing_table"));
			const home = url(inv, `${o}/`);
			assert.deepEqual([home.kind, home.type, home.id, home.path], ["home", "page", 12, undefined], "the front page is the home, never a page");
			assert.equal(url(inv, `${o}/?page_id=12`).kind, "query");
		},
	},
	{
		fixture: "blog-rest-off",
		base: "/",
		check(inv) {
			assert.equal(coverage(inv, "rest").status, "failed");
			const post = type(inv, "post");
			assert.ok(post.sources.includes("sitemap"));
			assert.ok(inv.urls.filter((u) => u.kind === "post").length >= 100);
		},
	},
];

for (const c of CASES) {
	const dir = new URL(`./fixtures/${c.fixture}/`, import.meta.url);
	test(`level 1 reads ${c.fixture}`, async () => {
		const requests: string[] = [];
		const fetch = createReplayFetch(dir);
		const logged = (path: string, opts?: Parameters<typeof fetch>[1]) => {
			const q = opts?.query ? (path.includes("?") ? "&" : "?") + new URLSearchParams(opts.query).toString() : "";
			requests.push(`${opts?.method ?? "GET"} ${path}${q}`);
			return fetch(path, opts);
		};
		const site = fetch.origin + c.base;
		const inv = await readPublic(Object.assign(logged, { setApiRoot: fetch.setApiRoot, origin: fetch.origin, requests: fetch.requests }), site);
		assert.deepEqual(checkSchema(schema, JSON.parse(stringify("inventory", inv))), [], "schema");
		c.check(inv, fetch.origin, requests);
		const again = await readPublic(createReplayFetch(dir), site);
		assert.equal(stringify("inventory", again), stringify("inventory", inv), "byte-stable over two runs");
	});
}

// Variants of a mini fixture, written to a temp folder (bodies stay where they are).
// Each folder is removed when the file's tests end.

const variantDirs: string[] = [];
after(() => {
	for (const dir of variantDirs) rmSync(dir, { recursive: true, force: true });
});

function variant(from: string, edit: (m: Manifest, put: (text: string) => string) => void): URL {
	const src = new URL(`./fixtures/${from}/`, import.meta.url);
	const m = JSON.parse(readFileSync(new URL("manifest.json", src), "utf8")) as Manifest;
	for (const e of m.entries) if (e.body) e.body = new URL(e.body, src).href;
	const dir = mkdtempSync(join(tmpdir(), "wpm-variant-"));
	variantDirs.push(dir);
	mkdirSync(join(dir, "bodies"));
	let n = 0;
	edit(m, (text) => {
		const file = `bodies/v${++n}.txt`;
		writeFileSync(join(dir, file), text);
		return file;
	});
	writeFileSync(join(dir, "manifest.json"), JSON.stringify(m));
	return pathToFileURL(`${dir}/`);
}

const spied = (dir: URL) => {
	const fetch = createReplayFetch(dir);
	const roots: string[] = [];
	const setApiRoot = (r: string): void => {
		roots.push(r);
		fetch.setApiRoot(r);
	};
	return { door: Object.assign((p: string, o?: Parameters<typeof fetch>[1]) => fetch(p, o), { setApiRoot }), roots, origin: fetch.origin };
};

test("a failed users or media list keeps the rest coverage from being complete", async () => {
	const dir = variant("mini-blog", (m) => {
		for (const e of m.entries) {
			if (e.path.startsWith("/wp-json/wp/v2/users")) e.status = 401;
			if (e.path.startsWith("/wp-json/wp/v2/media")) e.status = 404;
		}
	});
	const { door, origin } = spied(dir);
	const inv = await readPublic(door, `${origin}/`);
	const rest = inv.coverage.find((c) => c.area === "rest");
	assert.equal(rest?.status, "partial");
	assert.match(rest?.detail ?? "", /users/);
	assert.match(rest?.detail ?? "", /media/);
});

test("the API root is set on the door only when it answered an index, 401 or 403", async () => {
	const cases: [string, (m: Manifest, put: (t: string) => string) => void, string[]][] = [
		["404 root", (m) => void (m.entries = m.entries.filter((e) => !e.path.startsWith("/wp-json/"))), []],
		["non-JSON root", (m, put) => {
			m.entries = m.entries.filter((e) => !e.path.startsWith("/wp-json/"));
			m.entries.push({ method: "GET", path: "/wp-json/", auth: false, status: 200, headers: { "content-type": "text/html" }, body: put("<html>nope</html>") });
		}, []],
		["401 root", (m) => {
			for (const e of m.entries) if (e.path === "/wp-json/") e.status = 401;
		}, ["http://localhost:4701/wp-json/"]],
	];
	for (const [name, edit, want] of cases) {
		const { door, roots, origin } = spied(variant("mini-blog", edit));
		const inv = await readPublic(door, `${origin}/`);
		assert.deepEqual(roots, want, name);
		if (want.length === 0) assert.equal(inv.site.apiRoot, undefined, name);
	}
});

test("a failed Link-header root still lets the HTML <link> root be tried", async () => {
	const dir = variant("mini-blog", (m, put) => {
		const home = m.entries.find((e) => e.path === "/" && e.method === "GET");
		assert.ok(home);
		home.headers.link = '<http://localhost:4701/gone/>; rel="https://api.w.org/"';
		home.body = put(`<html><head><link rel="https://api.w.org/" href="http://localhost:4701/wp-json/"></head></html>`);
	});
	const fetch = createReplayFetch(dir);
	const c = createCollector(`${fetch.origin}/`);
	const d = await discover(fetch, c);
	assert.equal(d.via, "html-link");
	assert.equal(d.apiRoot, "http://localhost:4701/wp-json/");
	assert.ok(d.index);
});

test("the ledger has a total URL cap; hitting it makes coverage partial", async () => {
	const fetch = createReplayFetch(new URL("./fixtures/mini-blog/", import.meta.url));
	const inv = await readPublic(fetch, `${fetch.origin}/`, { maxUrls: 50 });
	assert.ok(inv.urls.length <= 50, String(inv.urls.length));
	const sm = inv.coverage.find((c) => c.area === "sitemaps");
	assert.equal(sm?.status, "partial");
	assert.match(sm?.detail ?? "", /cap of 50 URLs/);
	assert.notEqual(inv.coverage.find((c) => c.area === "rest")?.status, "complete");
});

test("a home page that redirects to another site does not stop the run; coverage names the target", async () => {
	const dir = variant("mini-blog", (m) => {
		const home = m.entries.find((e) => e.path === "/" && e.method === "GET");
		assert.ok(home);
		home.status = 301;
		home.headers = { location: "https://www.example.org/" };
		delete home.body;
	});
	const { door, origin } = spied(dir);
	const inv = await readPublic(door, `${origin}/`);
	const site = inv.coverage.find((c) => c.area === "site");
	assert.equal(site?.status, "failed");
	assert.match(site?.detail ?? "", /redirects to https:\/\/www\.example\.org\//);
	assert.match(site?.detail ?? "", /--url https:\/\/www\.example\.org\//);
	assert.match(site?.detail ?? "", /WordPress Address and Site Address/);
	assert.match(site?.detail ?? "", /--wxr/);
	// The fallbacks on this origin still ran.
	assert.equal(inv.site.apiRoot, `${origin}/wp-json/`);
	assert.equal(inv.types.find((t) => t.slug === "post")?.count, 150);
	assert.equal(inv.coverage.find((c) => c.area === "sitemaps")?.status, "complete");
});

test("an inner page that redirects to another site is one failed request, noted as partial", async () => {
	const dir = variant("mini-blog", (m) => {
		const e = m.entries.find((x) => x.path === "/robots.txt");
		assert.ok(e);
		e.status = 302;
		e.headers = { location: "https://cdn.example.org/robots.txt" };
		delete e.body;
	});
	const { door, origin } = spied(dir);
	const inv = await readPublic(door, `${origin}/`);
	const site = inv.coverage.find((c) => c.area === "site");
	assert.equal(site?.status, "partial");
	assert.match(site?.detail ?? "", /\/robots\.txt to https:\/\/cdn\.example\.org\/robots\.txt/);
});
