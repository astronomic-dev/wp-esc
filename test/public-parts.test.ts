// Unit tests for the level 1 parts that need no fixture.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { htmlLinkRoot, linkHeaderRoot } from "../src/sources/public/discover.ts";
import { blockName, frontPageId, scanContent, scanHtml } from "../src/sources/public/html.ts";
import { guessFromSitemap, parseSitemap, robotsSitemaps } from "../src/sources/public/sitemaps.ts";
import { PLUGINS, pluginForNamespace } from "../src/sources/public/plugins-map.ts";
import { routePath, shapeOf } from "../src/sources/public/rest.ts";
import { addUrl, createCollector, guessStructure, relPath } from "../src/sources/public/collect.ts";
import { deriveUrls, pageOf, pageUrl } from "../src/sources/public/derive.ts";
import { MAX_PAGES_PER_LIST } from "../src/sources/limits.ts";

test("Link header discovery picks the api.w.org relation among others", () => {
	assert.equal(linkHeaderRoot('<https://a.example.com/wp-json/>; rel="https://api.w.org/"'), "https://a.example.com/wp-json/");
	assert.equal(
		linkHeaderRoot('<https://a.example.com/?p=5>; rel=shortlink, <https://a.example.com/?rest_route=/>; rel="https://api.w.org/", <https://a.example.com/wp-json/wp/v2/pages/5>; rel="alternate"; type="application/json"'),
		"https://a.example.com/?rest_route=/",
	);
	assert.equal(linkHeaderRoot('<https://a.example.com/x>; rel="https://api.w.org/extra"'), undefined);
	assert.equal(linkHeaderRoot(null), undefined);
});

test("HTML link discovery reads single, double or no quotes", () => {
	assert.equal(htmlLinkRoot(`<link rel='https://api.w.org/' href='https://a.example.com/site/wp-json/' />`), "https://a.example.com/site/wp-json/");
	assert.equal(htmlLinkRoot(`<link href="https://a.example.com/?rest_route=/" rel="https://api.w.org/">`), "https://a.example.com/?rest_route=/");
	assert.equal(htmlLinkRoot(`<link rel="alternate" href="https://a.example.com/feed/">`), undefined);
});

test("routePath builds pretty and ?rest_route= paths, also under a subdirectory", () => {
	assert.equal(routePath(new URL("https://a.example.com/wp-json/"), "/wp/v2/posts"), "/wp-json/wp/v2/posts");
	assert.equal(routePath(new URL("https://a.example.com/site/wp-json/"), "/wp/v2/types"), "/site/wp-json/wp/v2/types");
	assert.equal(routePath(new URL("https://a.example.com/?rest_route=/"), "/wp/v2/posts"), "/?rest_route=/wp/v2/posts");
	assert.equal(routePath(new URL("https://a.example.com/site/?rest_route=/"), "/wp/v2/posts"), "/site/?rest_route=/wp/v2/posts");
});

test("scanHtml finds plugins, theme, builder, blocks, generator and language", () => {
	const s = scanHtml(`<!doctype html><html lang="fr-FR"><head>
<meta name="generator" content="WordPress 6.7.1">
<!-- Search Engine Optimization by Rank Math - https://rankmath.com/ -->
<link rel="stylesheet" href="/wp-content/plugins/woocommerce/assets/css/x.css">
<script src="https://cdn.example.com/wp-content/plugins/Gravityforms/js/y.js"></script>
<script src="https://a.example.com/wp-content/plugins/wpforms-lite/js/z.js"></script><script src="//a.example.com/wp-content/plugins/akismet/a.js"></script>
<script src="//other.example.com/wp-content/plugins/jetpack/a.js"></script><link rel="stylesheet" href="https://cdn.example.com/wp-content/themes/cdn-theme/s.css">
<link rel="stylesheet" href="/wp-content/themes/astra/style.css"><link rel="stylesheet" href="/wp-content/themes/astra-child/style.css">
<link rel="stylesheet" href="/wp-content/themes/astra/x.css">
</head><body><div class="et_pb_section"><div class="wp-block-group wp-block-group-is-layout-flex has-bg"><p class="wp-block-heading">x</p>
<div class="wp-block-button__link wp-block-acme-slider"></div><p class="wp-block-paragraph">p</p><ul class="wp-block-post-template"><li class="wp-block-post">x</li></ul>
<li class="wp-block-navigation-item wp-block-navigation-link">n</li><div class="wp-block-comments-query-loop">c</div></div></div></body></html>`, "https://a.example.com");
	assert.deepEqual(s.plugins, ["akismet", "seo-by-rank-math", "woocommerce", "wpforms-lite"], "only paths on the site's origin or relative");
	assert.equal(s.themes.has("cdn-theme"), false);
	assert.equal(s.themes.get("astra"), 2);
	assert.equal(s.wpVersion, "6.7.1");
	assert.equal(s.lang, "fr-FR");
	assert.deepEqual(s.builders, ["divi"]);
	assert.deepEqual(s.blocks, ["core/comments", "core/group", "core/heading", "core/navigation-link", "core/paragraph", "core/post-template"], "core classes as block names; wrapper parts and unknown classes left out");
});

test("scanHtml lists unrendered shortcodes in visible text only", () => {
	const s = scanHtml(`<p>[pricing_table plan="pro"] [contact-form-7 id="12" title="Contact"] [gallery/] [1] [Read more] [/pricing_table] [link](x)</p>
<pre>[in_pre]</pre><code>[in_code]</code><script>"[in_script]"</script><style>[in_style]{}</style><p>&#91;escaped&#93;</p>`);
	assert.deepEqual(s.shortcodes, ["contact-form-7", "gallery", "pricing_table"]);
});

test("scanHtml detects each page builder from markup", () => {
	const cases: [string, string][] = [
		["elementor", `<div data-elementor-type="wp-page" class="elementor elementor-5">`],
		["beaver-builder", `<div class="fl-builder-content fl-builder-content-5">`],
		["wpbakery", `<div class="vc_row wpb_row">`],
		["bricks", `<section class="brxe-section">`],
	];
	for (const [name, html] of cases) assert.deepEqual(scanHtml(html).builders, [name], name);
	assert.deepEqual(scanHtml(`<meta name="generator" content="Elementor 3.25.0">`).builders, [], "generator tag alone is not a built page");
});

test("parseSitemap reads indexes and URL sets, decodes entities and CDATA, survives bad XML", () => {
	const idx = parseSitemap(`<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>https://a.example.com/?sitemap=posts&amp;paged=1</loc></sitemap></sitemapindex>`);
	assert.deepEqual(idx, { kind: "index", locs: ["https://a.example.com/?sitemap=posts&paged=1"], error: false, over: 0 });
	const set = parseSitemap(`<urlset xmlns:image="x"><url><loc><![CDATA[https://a.example.com/a/]]></loc><image:image><image:loc>https://a.example.com/i.jpg</image:loc></image:image></url><url><loc> https://a.example.com/b/ </loc></url></urlset>`);
	assert.deepEqual(set, { kind: "urlset", locs: ["https://a.example.com/a/", "https://a.example.com/b/"], error: false, over: 0 });
	const bad = parseSitemap(`<urlset><url><loc>https://a.example.com/a/</loc></url><url><loc>broken`);
	assert.deepEqual([bad.locs, bad.error], [["https://a.example.com/a/"], true]);
	assert.equal(parseSitemap("<html>no</html>").kind, "other");
});

test("guessFromSitemap reads core, plain-permalink, Yoast and Rank Math names", () => {
	const tax = new Set(["genre"]);
	const g = (u: string) => guessFromSitemap(new URL(u), tax);
	assert.deepEqual(g("https://a.example.com/wp-sitemap-posts-post-1.xml"), { kind: "post", type: "post" });
	assert.deepEqual(g("https://a.example.com/wp-sitemap-posts-team_member-2.xml"), { kind: "custom", type: "team_member" });
	assert.deepEqual(g("https://a.example.com/wp-sitemap-taxonomies-post_tag-1.xml"), { kind: "tag", taxonomy: "post_tag" });
	assert.deepEqual(g("https://a.example.com/wp-sitemap-users-1.xml"), { kind: "author" });
	assert.deepEqual(g("https://a.example.com/?sitemap=posts&sitemap-subtype=page&paged=1"), { kind: "page", type: "page" });
	assert.deepEqual(g("https://a.example.com/?sitemap=taxonomies&sitemap-subtype=category&paged=1"), { kind: "category", taxonomy: "category" });
	assert.deepEqual(g("https://a.example.com/post-sitemap2.xml"), { kind: "post", type: "post" });
	assert.deepEqual(g("https://a.example.com/genre-sitemap.xml"), { kind: "term", taxonomy: "genre" });
	assert.deepEqual(g("https://a.example.com/author-sitemap.xml"), { kind: "author" });
	assert.equal(g("https://a.example.com/news.xml"), undefined);
});

test("guessStructure from a post link, with and without the post's date", () => {
	const c = createCollector("https://a.example.com/blog/");
	assert.equal(guessStructure(c, "https://a.example.com/blog/2026/03/14/ridge/", { date: "2026-03-14T10:00:00", slug: "ridge", id: 9 }), "/%year%/%monthnum%/%day%/%postname%/");
	assert.equal(guessStructure(c, "https://a.example.com/blog/archives/9", { slug: "ridge", id: 9 }), "/archives/%post_id%");
	assert.equal(guessStructure(c, "https://a.example.com/blog/2026/03/ridge/"), "/%year%/%monthnum%/%postname%/");
	assert.equal(guessStructure(c, "https://a.example.com/blog/ridge/"), "/%postname%/");
	assert.equal(guessStructure(c, "https://a.example.com/blog/?p=9"), "");
	assert.equal(guessStructure(c, "https://other.example.com/blog/x/"), undefined);
});

test("plugins map: about 60 slugs; form plugins and form storage are told apart", () => {
	assert.ok(Object.keys(PLUGINS).length >= 60);
	assert.equal(PLUGINS["contact-form-7"]?.category, "forms");
	for (const slug of ["flamingo", "wpforms", "gravityforms"]) assert.equal(PLUGINS[slug]?.category, "form-storage", slug);
	assert.equal(PLUGINS["wpforms"]?.name, "WPForms Pro");
	assert.equal(PLUGINS["wpforms-lite"]?.category, "forms");
	assert.ok(PLUGINS["flamingo"]?.stores);
	assert.equal(pluginForNamespace("yoast/v1"), "wordpress-seo");
	assert.equal(pluginForNamespace("wc/v3"), "woocommerce");
	assert.equal(pluginForNamespace("wp/v2"), undefined);
});

// CLI (no network: every case stops before a request)

const bin = fileURLToPath(new URL("../bin/wp-inventory.mjs", import.meta.url));
const run = (args: string[], env: Record<string, string> = {}) =>
	spawnSync(process.execPath, [bin, ...args], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", ...env } });

test("wp-inventory: help, missing --url, http refused, level 2 needs --wxr, level 3 needs credentials", () => {
	const help = run(["--help"]);
	assert.equal(help.status, 0);
	assert.match(help.stdout, /Usage: wp-inventory/);
	assert.match(help.stdout, /--level 3 --wxr export\.xml/);
	assert.match(help.stdout, /--level 2 is not needed/);
	assert.match(help.stdout, /--merge only/);
	assert.match(help.stdout, /WPM_ALLOW_HTTP_LOCALHOST=1 lets the scripts read an http:\/\/ site on localhost, such as a test site on your own computer\. Do not set it for a live site\./);
	assert.match(help.stdout, /--out <file>.*inventory\.json/);
	assert.equal(run(["--nope"]).status, 2);
	const none = run([]);
	assert.equal(none.status, 2);
	assert.match(none.stderr, /--url/);
	const http = run(["--url", "http://example.com/"]);
	assert.equal(http.status, 1);
	assert.match(http.stderr, /https/);
	const creds = run(["--url", "https://bob:hunter22@example.com/"]);
	assert.equal(creds.status, 1);
	assert.ok(!creds.stderr.includes("hunter22"));
	const two = run(["--url", "https://example.com/", "--level", "2"]);
	assert.equal(two.status, 2);
	assert.match(two.stderr, /--wxr/);
	const three = run(["--url", "https://example.com/", "--level", "3"]);
	assert.equal(three.status, 2);
	assert.match(three.stderr, /WPM_WP_USER and WPM_WP_APP_PASSWORD/);
	assert.equal(run(["--url", "https://example.com/", "--level", "4"]).status, 2);
});

// Hostile input must not make the scanners slow (no unbounded leading class, no ambiguous nesting).

const fast = (name: string, ms: number, fn: () => void): void => {
	const t = performance.now();
	fn();
	const took = performance.now() - t;
	assert.ok(took < ms, `${name} took ${Math.round(took)} ms`);
};

test("scanHtml stays linear on a 2 MB run with no delimiter and still finds the plugin", () => {
	const html = `${"a".repeat(2 * 1024 * 1024)}/wp-content/plugins/akismet/x.js`;
	let found: string[] = [];
	fast("plugin scan", 200, () => {
		found = scanHtml(html, "https://a.example.com").plugins;
	});
	assert.deepEqual(found, ["akismet"]);
	fast("many plugin paths", 400, () => void scanHtml("/wp-content/plugins/x/".repeat(50_000), "https://a.example.com"));
});

test("discovery, robots, shapes and paths stay fast on hostile text", () => {
	fast("<link without >", 200, () => void htmlLinkRoot("<link ".repeat(200_000)));
	fast("robots blank lines", 200, () => void robotsSitemaps(`${"\n".repeat(200_000)}x`));
	assert.deepEqual(robotsSitemaps("User-agent: *\n  Sitemap: https://a.example.com/s.xml\nsitemap:https://a.example.com/t.xml"), ["https://a.example.com/s.xml", "https://a.example.com/t.xml"]);
	fast("email shape", 200, () => void shapeOf(`a@${"a.".repeat(50_000)} `));
	assert.equal(shapeOf("ruth@example.com"), "email");
	fast("html shape", 200, () => void shapeOf("<a".repeat(100_000)));
	assert.equal(shapeOf("<p>x</p>"), "html");
	const c = createCollector("https://a.example.com/");
	fast("slash run", 200, () => void relPath(c, `https://a.example.com/${"/".repeat(100_000)}x`));
	assert.equal(relPath(c, "https://a.example.com/about/team/"), "about/team");
});

test("wp-inventory: a site that redirects away still writes inventory.json; level 3 sends no password", async () => {
	const seen: { url?: string; auth?: string }[] = [];
	const server = createServer((req, res) => {
		seen.push({ url: req.url, auth: req.headers.authorization });
		if (req.url === "/") res.writeHead(301, { location: "https://www.example.org/" }).end();
		else res.writeHead(404).end();
	});
	await new Promise<void>((done) => server.listen(0, done));
	const port = (server.address() as { port: number }).port;
	const dir = mkdtempSync(join(tmpdir(), "wpm-cli-"));
	try {
		const out = join(dir, "inventory.json");
		const child = spawn(process.execPath, [bin, "--url", `http://localhost:${port}/`, "--level", "3", "--out", out], {
			env: { PATH: process.env.PATH ?? "", WPM_ALLOW_HTTP_LOCALHOST: "1", WPM_WP_USER: "u", WPM_WP_APP_PASSWORD: "abcd efgh ijkl mnop" },
		});
		let stderr = "";
		child.stderr.on("data", (b: Buffer) => (stderr += b));
		const code = await new Promise<number | null>((done) => child.on("close", done));
		assert.equal(code, 1);
		assert.match(stderr, /No password request was sent/);
		assert.match(stderr, /--url https:\/\/www\.example\.org\//);
		const inv = JSON.parse(readFileSync(out, "utf8")) as { coverage: { area: string; status: string }[]; levels: number[] };
		assert.equal(inv.coverage.find((c) => c.area === "site")?.status, "failed");
		assert.deepEqual(inv.levels, [1]);
		assert.ok(seen.length > 1, "fallbacks were tried");
		assert.ok(seen.every((r) => r.auth === undefined), "no request carried the password");
	} finally {
		server.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the front page ID comes from the home page's body classes", () => {
	assert.equal(frontPageId(scanHtml('<body class="home wp-singular page-template-default page page-id-13">x</body>').bodyClasses), 13);
	assert.equal(frontPageId(["home", "blog"]), undefined);
	assert.equal(frontPageId(["page", "page-id-4"]), undefined, "not the home page");
});

test("block names are real names only; part and plugin classes are left out", () => {
	assert.equal(blockName("wp-block-image"), "core/image");
	assert.equal(blockName("wp-block-query-pagination-next-arrow"), undefined);
	assert.equal(blockName("wp-block-acme-slider"), undefined);
	assert.equal(blockName("wp-block-columns-is-layout-flex"), undefined);
});

test("scanContent finds builders, visible shortcodes, blocks and acf markup in rendered content", () => {
	const s = scanContent('<div data-elementor-type="wp-page"><p class="wp-block-heading">[pricing_table plan="pro"] [1]</p><pre>[example]</pre><SCRIPT>"[not_this]"</SCRIPT><div class="acf-block-faq">x</div></div>');
	assert.deepEqual(s.builders, ["elementor"]);
	assert.deepEqual(s.shortcodes, ["pricing_table"]);
	assert.deepEqual(s.blocks, ["core/heading"]);
	assert.equal(s.acf, true);
	assert.deepEqual(scanContent("<code>[a] never closed").shortcodes, []);
	assert.equal(scanContent("<p>plain</p>").acf, false);
});

test("scanContent stays fast on hostile content", () => {
	const t = performance.now();
	scanContent(`${"<code ".repeat(50_000)}${"<".repeat(200_000)}${"[a ".repeat(50_000)}${'class="'.repeat(50_000)}`);
	assert.ok(performance.now() - t < 2000, "linear time");
});

test("later-page URLs: /page/N/ on paths, paged=N on query URLs", () => {
	assert.deepEqual(pageOf("https://example.com/category/x/page/3/"), { list: "https://example.com/category/x/", page: 3 });
	assert.deepEqual(pageOf("https://example.com/?cat=2&paged=4"), { list: "https://example.com/?cat=2", page: 4 });
	assert.equal(pageOf("https://example.com/about/"), undefined);
	assert.equal(pageUrl("https://example.com/site/", 2, true), "https://example.com/site/page/2/");
	assert.equal(pageUrl("https://example.com/site/", 2, true, true), "https://example.com/site/?paged=2");
	assert.equal(pageUrl("https://example.com/news", 5, false), "https://example.com/news/page/5");
});

test("derived URLs: date archives under the permalink front, term pages, bounded per list", () => {
	const c = createCollector("https://example.com/site/");
	c.permalinks = { structure: "/blog/%year%/%monthnum%/%postname%/", source: "rest", confidence: "medium" };
	c.months = new Set(["2024-12", "2025-01"]);
	c.types.set("post", { slug: "post", count: 25, byStatus: {}, fields: [], taxonomies: [], sources: ["rest"] });
	c.homeLists = true;
	addUrl(c, { url: "https://example.com/site/category/big/", kind: "category", source: ["rest"], taxonomy: "category", termId: 3, count: 1_000_000, evidence: "listed" });
	deriveUrls(c);
	const urls = [...c.urls.keys()];
	for (const u of ["blog/2024/12/", "blog/2025/01/", "blog/2024/", "blog/2025/", "page/2/", "page/3/"]) assert.ok(urls.includes(`https://example.com/site/${u}`), u);
	assert.ok(!urls.includes("https://example.com/site/page/4/"));
	const big = urls.filter((u) => u.startsWith("https://example.com/site/category/big/page/"));
	assert.equal(big.length, MAX_PAGES_PER_LIST);
	const plain = createCollector("https://example.com/");
	plain.permalinks = { structure: "", source: "rest", confidence: "medium" };
	plain.months = new Set(["2024-12"]);
	plain.types.set("post", { slug: "post", count: 15, byStatus: {}, fields: [], taxonomies: [], sources: ["rest"] });
	plain.homeLists = true;
	deriveUrls(plain);
	assert.deepEqual([...plain.urls.keys()], ["https://example.com/?m=202412", "https://example.com/?m=2024", "https://example.com/?paged=2"], "query date archives with plain permalinks");
});
