// Fix round F, builder F1: the level 1 reader over the recorded blog, business and
// builder fixtures. Paged term and author lists and their feeds, post type archives and
// the posts page, shortcodes seen from their output, fill counts REST invents, plain
// coverage text, the urls line, and attachment files.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createReplayFetch, type Manifest } from "../src/http/replay.ts";
import { readPublic } from "../src/sources/public/index.ts";
import { isAutoExcerpt, isDefaultSeoDescription, isDefaultSeoTitle } from "../src/sources/public/rest.ts";
import { scanContent } from "../src/sources/public/html.ts";
import { createCollector } from "../src/sources/public/collect.ts";
import { deriveUrls } from "../src/sources/public/derive.ts";
import { propose } from "../src/model/index.ts";
import { planRedirects } from "../src/redirects/plan.ts";
import type { Inventory } from "../src/contracts/inventory.ts";

const DRAFTS = "drafts and private items need an export (level 2) or the password (level 3).";
const HTML_1 = "Builders, shortcodes and blocks are counted from the REST content of";
const HTML_2 = "WordPress has already run the shortcodes in that content, so level 1 sees only the ones it can spot from their output; an export shows them all.";
const HTTP = "WPM_ALLOW_HTTP_LOCALHOST=1 lets the scripts read an http:// site on localhost, such as a test site on your own computer. Do not set it for a live site.";

const dirs: string[] = [];
after(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A copy of a fixture's manifest with extra GET entries (bodies written to a temp folder). */
function variant(from: string, extra: { path: string; status: number; body: string }[]): URL {
	const src = new URL(`./fixtures/${from}/`, import.meta.url);
	const m = JSON.parse(readFileSync(new URL("manifest.json", src), "utf8")) as Manifest;
	for (const e of m.entries) if (e.body) e.body = new URL(e.body, src).href;
	const dir = mkdtempSync(join(tmpdir(), "wpm-rf1-"));
	dirs.push(dir);
	mkdirSync(join(dir, "bodies"));
	extra.forEach((x, i) => {
		writeFileSync(join(dir, `bodies/x${i}.txt`), x.body);
		m.entries.unshift({ method: "GET", path: x.path, auth: false, status: x.status, headers: { "content-type": "text/html; charset=UTF-8" }, body: `bodies/x${i}.txt` });
	});
	writeFileSync(join(dir, "manifest.json"), JSON.stringify(m));
	return pathToFileURL(`${dir}/`);
}

const cache = new Map<string, Promise<{ inv: Inventory; o: string }>>();
function read(fixture: string, base: string, dir?: URL): Promise<{ inv: Inventory; o: string }> {
	const key = `${fixture}${base}${dir?.href ?? ""}`;
	let p = cache.get(key);
	if (!p) {
		p = (async () => {
			const fetch = createReplayFetch(dir ?? new URL(`./fixtures/${fixture}/`, import.meta.url));
			return { inv: await readPublic(fetch, fetch.origin + base), o: fetch.origin };
		})();
		cache.set(key, p);
	}
	return p;
}
const blog = () => read("blog", "/");
const builder = () => read("builder", "/");
const archivePage = (type: string) => `<!doctype html><html lang="en-US"><head><title>Archive</title></head><body class="archive post-type-archive post-type-archive-${type} wp-theme-twentytwentyfive"><main>List</main></body></html>`;
const businessDir = variant("business", [
	{ path: "/site/team/", status: 200, body: archivePage("team") },
	{ path: "/site/services/", status: 200, body: archivePage("service") },
]);
const business = () => read("business", "/site/", businessDir);

const has = (inv: Inventory, url: string) => inv.urls.find((u) => u.url === url);
const detail = (inv: Inventory, area: string): string => {
	const c = inv.coverage.find((x) => x.area === area);
	assert.ok(c, `coverage ${area}`);
	return c.detail;
};

test("blog: later pages of categories (with their children's posts) and authors, and their feeds, stop at the last page", async () => {
	const { inv, o } = await blog();
	for (const p of [
		"/category/guides/page/6/", "/category/guides/beginner/page/3/", "/category/news/page/3/",
		"/author/dana-whitlock/page/2/", "/author/dana-whitlock/page/3/", "/author/dana-whitlock/page/4/", "/author/dana-whitlock/page/5/", "/author/dana-whitlock/page/6/",
		"/author/theo-marsh/page/2/",
	]) assert.equal(has(inv, o + p)?.kind, "paged", p);
	for (const p of ["/category/guides/feed/", "/author/dana-whitlock/feed/", "/tag/bread/feed/", "/category/guides/beginner/feed/"]) assert.equal(has(inv, o + p)?.kind, "feed", p);
	for (const p of ["/category/guides/page/7/", "/category/guides/beginner/page/4/", "/category/news/page/4/", "/author/dana-whitlock/page/7/", "/author/theo-marsh/page/7/", "/page/13/"]) {
		assert.equal(has(inv, o + p), undefined, `no page past the last: ${p}`);
	}
});

test("business: the team and services archives and the posts page are in the ledger", async () => {
	const { inv, o } = await business();
	const team = has(inv, `${o}/site/team/`);
	assert.deepEqual([team?.kind, team?.type], ["archive", "team"]);
	assert.deepEqual([has(inv, `${o}/site/services/`)?.kind, has(inv, `${o}/site/services/`)?.type], ["archive", "service"]);
	const news = has(inv, `${o}/site/news/`);
	assert.deepEqual([news?.kind, news?.type, news?.id], ["archive", "post", 25], "body class blog on a page that is not the root");
	assert.equal(has(inv, `${o}/site/team/feed/`)?.kind, "feed");
	const home = has(inv, `${o}/site/`);
	assert.deepEqual([home?.kind, home?.type, home?.id], ["home", "page", 13], "the root is never kind page");
	const rows = planRedirects(inv, propose(inv), { target: "astro" });
	assert.ok(!rows.some((r) => r.note.startsWith("Not in the inventory")));
	assert.equal(rows.length, inv.urls.length, "one plan row per ledger URL");
});

test("an archive candidate that does not answer as the type's archive is not added", async () => {
	const { inv, o } = await read("business", "/site/");
	assert.equal(has(inv, `${o}/site/team/`), undefined, "no recording: 404");
	const wrong = await read("business", "/site/", variant("business", [{ path: "/site/team/", status: 200, body: archivePage("other") }]));
	assert.equal(has(wrong.inv, `${wrong.o}/site/team/`), undefined, "body class names another type");
});

test("level 1 shortcodes: known output in REST content counts as the shortcode, and the html line says how", async () => {
	const b = (await builder()).inv;
	assert.ok(b.shortcodes.some((s) => s.name === "contact-form-7" && s.count === 1));
	assert.ok(b.shortcodes.some((s) => s.name === "gallery" && s.count === 1));
	const biz = (await business()).inv;
	assert.deepEqual(biz.shortcodes.map((s) => s.name), ["contact-form-7"]);
	for (const inv of [b, biz]) {
		assert.ok(detail(inv, "html").includes(HTML_1));
		assert.ok(detail(inv, "html").includes(HTML_2));
		assert.match(detail(inv, "html"), /seen from its output\./);
	}
	const s = scanContent('<div class="wpcf7 no-js"></div><div class="gallery galleryid-4"></div><audio class="wp-audio-shortcode"></audio><div class="wp-video"></div><div class="wp-playlist wp-audio-playlist"></div>');
	assert.deepEqual(s.shortcodes, ["audio", "contact-form-7", "gallery", "playlist", "video"]);
	assert.deepEqual(scanContent('<div class="wp-block-gallery"></div><p>a gallery galleryid-1</p>').shortcodes, [], "block galleries and plain text do not count");
});

test("fill counts: an automatic excerpt and Yoast defaults are not counted as filled", async () => {
	const post = (await blog()).inv.types.find((t) => t.slug === "post");
	const f = (k: string) => post?.fields.find((x) => x.key === k);
	for (const k of ["post_excerpt", "_yoast_wpseo_title", "_yoast_wpseo_metadesc"]) {
		assert.equal(f(k)?.total, 120);
		assert.ok((f(k)?.filled ?? 120) < 60, `${k}: ${f(k)?.filled} of 120`);
	}
	const service = (await business()).inv.types.find((t) => t.slug === "service");
	const ex = service?.fields.find((x) => x.key === "post_excerpt");
	assert.deepEqual([ex?.filled, ex?.total], [8, 8], "hand-written service excerpts");
	const pages = (await builder()).inv.types.find((t) => t.slug === "page");
	assert.equal(pages?.fields.find((x) => x.key === "post_excerpt")?.filled, 0, "an excerpt that skips a form's output is still automatic");

	assert.equal(isAutoExcerpt("<p>Notes from batch 3. We tried it [&hellip;]</p>", "<p>Notes from batch 3.</p><p>We tried it three ways.</p>"), true);
	assert.equal(isAutoExcerpt("<p>Leak repair, done right.</p>", "<p>Leak repair for the Harbor Light area.</p>"), false);
	assert.equal(isDefaultSeoTitle("Post One | Mini Blog", "Post One", "Mini Blog"), true);
	assert.equal(isDefaultSeoTitle("Post One – Mini Blog", "Post One", "Mini Blog"), true);
	assert.equal(isDefaultSeoTitle("A better title", "Post One", "Mini Blog"), false);
	assert.equal(isDefaultSeoDescription("Notes from batch 3.", "", "<p>Notes from batch 3. More.</p>"), true);
	assert.equal(isDefaultSeoDescription("What we learned.", "<p>A short take.</p>", "<p>Notes.</p>"), false);
});

test("level 1 coverage text is plain: the drafts clause, no developer words", async () => {
	for (const { inv } of [await blog(), await business(), await builder()]) {
		for (const c of inv.coverage) {
			// "?paged=N" names a query URL family; "paged" as a word is developer talk.
			assert.ok(!/namespace|(?<!\?)paged|need level 3/.test(c.detail), `${c.area}: ${c.detail}`);
			if (c.area.startsWith("type:") && c.source === "rest" && c.status === "partial" && c.detail.includes("published item")) assert.ok(c.detail.endsWith(DRAFTS), c.detail);
		}
	}
	assert.equal(detail((await blog()).inv, "rest"), "Read 6 content lists to the end.");
	assert.equal(detail((await builder()).inv, "rest"), "Read 7 content lists to the end. Could not read in full: elementor_library.");
});

test("the urls line is always written, and its numbers are the ledger's entries by kind", async () => {
	for (const { inv } of [await blog(), await business(), await builder()]) assert.ok(inv.coverage.some((c) => c.area === "urls"));
	const { inv } = await blog();
	const count = (k: string) => inv.urls.filter((u) => u.kind === k).length;
	const html = (k: string) => inv.urls.filter((u) => u.kind === k && u.source.includes("html")).length;
	const d = detail(inv, "urls");
	assert.ok(d.includes(`The ledger has ${count("date")} date archives, ${count("paged")} later list pages and ${count("feed")} feeds.`), d);
	assert.ok(d.includes(`Of these, ${html("paged")} later list pages and ${html("feed")} feeds were also seen in the page HTML.`), d);
	const added = inv.urls.filter((u) => ["date", "paged", "feed"].includes(u.kind) && !u.source.includes("html")).length;
	assert.ok(d.startsWith(`Added ${added} URLs`), d);

	const plain = detail((await builder()).inv, "urls");
	assert.match(plain, /\?m=YYYYMM, \?paged=N and \?p=N&feed=rss2/);
	const b = (await builder()).inv;
	assert.ok(b.urls.some((u) => u.kind === "date" && /\?m=\d{6}$/.test(u.url)));
	assert.ok(b.urls.some((u) => u.kind === "feed" && /[?&]p=\d+/.test(u.url) && u.url.includes("feed=rss2")));
	assert.ok(b.urls.some((u) => u.kind === "feed" && u.url.endsWith("?cat=1&feed=rss2")));

	const empty = createCollector("https://example.com/");
	deriveUrls(empty);
	assert.deepEqual(empty.coverage.map((c) => [c.area, c.status, c.detail]), [["urls", "complete", "Added no URLs from post dates and counts. The ledger has no date archives, later list pages or feeds."]]);
});

test("level 1 attachments keep their file and parent from the media list", async () => {
	for (const { inv } of [await business(), await builder()]) {
		const att = inv.urls.filter((u) => u.kind === "attachment");
		assert.ok(att.length > 0);
		for (const a of att) assert.match(a.file ?? "", /^https?:\/\/.+\/wp-content\/uploads\//, a.url);
	}
	const { inv } = await builder();
	for (const target of ["astro", "emdash"] as const) {
		const rows = planRedirects(inv, propose(inv), { target }).filter((r) => r.kind === "attachment" && r.status === "review");
		for (const r of rows) assert.match(r.note, /Its file is http/, r.note);
	}
});

test("the HTTP switch is described the same way in the SKILL and in --help", () => {
	const skill = readFileSync(new URL("../skills/wp-inventory/SKILL.md", import.meta.url), "utf8");
	const bin = readFileSync(new URL("../bin/wp-inventory.mjs", import.meta.url), "utf8");
	assert.ok(skill.includes(HTTP));
	assert.ok(bin.includes(HTTP));
});
