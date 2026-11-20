// Hostile sizes and broken input for the readers: caps hold, work stays linear,
// and coverage says when a cap or a parse error cut a read short.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { SiteFetch, SiteResponse } from "../src/contracts/fetch.ts";
import type { Inventory } from "../src/contracts/inventory.ts";
import { createCollector } from "../src/sources/public/collect.ts";
import { readSitemaps } from "../src/sources/public/sitemaps.ts";
import { readRest } from "../src/sources/public/rest.ts";
import { readAuth } from "../src/sources/auth/index.ts";
import { readWxrChunks } from "../src/sources/wxr/index.ts";

const ORIGIN = "https://ex.example.com";

type Answer = { status?: number; body?: string; headers?: Record<string, string> } | undefined;

/** An in-memory site. `route` gets the path and query; undefined answers 404. */
function site(route: (path: string, query: Record<string, string>) => Answer): SiteFetch & { calls: string[] } {
	const calls: string[] = [];
	const f = async (path: string, opts?: { query?: Record<string, string> }): Promise<SiteResponse> => {
		const query = opts?.query ?? {};
		calls.push(path + (Object.keys(query).length ? `?${new URLSearchParams(query)}` : ""));
		const a = route(path, query);
		const body = a?.body ?? "";
		return { status: a ? (a.status ?? 200) : 404, headers: new Headers(a?.headers ?? {}), text: async () => body, url: ORIGIN + path };
	};
	return Object.assign(f, { calls });
}

const line = (inv: { coverage: Inventory["coverage"] }, area: string) => inv.coverage.find((c) => c.area === area);

// --- Sitemaps -----------------------------------------------------------------------

test("a sitemap index with 300,000 locs is capped while enqueuing and finishes fast", async () => {
	const index = `<sitemapindex>${Array.from({ length: 300_000 }, (_, i) => `<sitemap><loc>${ORIGIN}/s-${i}.xml</loc></sitemap>`).join("")}</sitemapindex>`;
	const fetch = site((p) => {
		if (p === "/robots.txt") return { body: `Sitemap: ${ORIGIN}/index.xml\n` };
		if (p === "/index.xml") return { body: index };
		const m = /^\/s-(\d+)\.xml$/.exec(p);
		if (m) return { body: `<urlset><url><loc>${ORIGIN}/p-${m[1]}/</loc></url></urlset>` };
		return undefined;
	});
	const c = createCollector(`${ORIGIN}/`);
	const t0 = performance.now();
	await readSitemaps(fetch, c);
	const ms = performance.now() - t0;
	assert.ok(ms < 5000, `took ${Math.round(ms)} ms`);
	assert.ok(fetch.calls.length <= 501, `fetched ${fetch.calls.length}`);
	const sm = line(c, "sitemaps");
	assert.equal(sm?.status, "partial");
	assert.match(sm?.detail ?? "", /child sitemaps? not read: the cap of 500/);
});

test("a sitemap that does not parse cleanly makes coverage partial; none parsing is failed", async () => {
	const broken = `<urlset><url><loc>${ORIGIN}/a/</loc></url><url><loc>broken`;
	const fetch = site((p) => (p === "/robots.txt" ? { body: `Sitemap: ${ORIGIN}/a.xml\n` } : p === "/a.xml" ? { body: broken } : undefined));
	const c = createCollector(`${ORIGIN}/`);
	await readSitemaps(fetch, c);
	const sm = line(c, "sitemaps");
	assert.equal(sm?.status, "partial");
	assert.match(sm?.detail ?? "", /did not parse cleanly/);
	assert.ok(c.urls.has(`${ORIGIN}/a/`));

	const none = site((p) => (p === "/robots.txt" ? { body: `Sitemap: ${ORIGIN}/a.xml\n` } : p === "/a.xml" ? { body: "<<<" } : undefined));
	const c2 = createCollector(`${ORIGIN}/`);
	await readSitemaps(none, c2);
	assert.equal(line(c2, "sitemaps")?.status, "failed");
});

// --- REST and auth lists -------------------------------------------------------------

const posts = (page: number, per = 100) =>
	JSON.stringify(Array.from({ length: per }, (_, i) => {
		const id = (page - 1) * per + i + 1;
		return { id, link: `${ORIGIN}/p-${id}/`, slug: `p-${id}`, status: "publish", title: { rendered: `Post ${id}` }, content: { rendered: "<p>x</p>", raw: "<p>x</p>" }, meta: { sub: `S${id}` } };
	}));

function restSite(totalPages: number) {
	return site((p, q) => {
		if (p === "/wp-json/wp/v2/types") return { body: JSON.stringify({ post: { name: "Posts", rest_base: "posts", rest_namespace: "wp/v2", hierarchical: false, taxonomies: [] } }) };
		if (p === "/wp-json/wp/v2/taxonomies") return { body: "{}" };
		if (p === "/wp-json/wp/v2/users") return { body: "[]", headers: { "x-wp-total": "0", "x-wp-totalpages": "1" } };
		if (p === "/wp-json/wp/v2/posts") {
			const page = Number(q.page ?? 1);
			return { body: posts(page), headers: { "x-wp-total": String(totalPages * 100), "x-wp-totalpages": String(totalPages) } };
		}
		return undefined;
	});
}

const discovery = { apiRoot: `${ORIGIN}/wp-json/`, index: { name: "Ex", namespaces: ["wp/v2"] }, status: 200 } as const;

test("REST lists stop at the item cap; coverage is partial and no count is set", async () => {
	const fetch = restSite(1000);
	const c = createCollector(`${ORIGIN}/`, { maxListItems: 500 });
	await readRest(fetch, c, { ...discovery });
	const post = c.types.get("post");
	assert.equal(post?.count, undefined);
	assert.equal(line(c, "type:post")?.status, "partial");
	assert.match(line(c, "type:post")?.detail ?? "", /cap of 500 list items/);
	assert.equal(line(c, "rest")?.status, "partial");
	assert.ok(fetch.calls.filter((x) => x.startsWith("/wp-json/wp/v2/posts")).length <= 6);
	// Fields and the ledger still come from what was read.
	assert.equal(post?.fields.find((f) => f.key === "sub")?.total, 500);
	assert.ok(c.urls.has(`${ORIGIN}/p-1/`));
});

test("REST lists stop at the byte cap", async () => {
	const fetch = restSite(50);
	const c = createCollector(`${ORIGIN}/`, { maxListBytes: 100_000 });
	await readRest(fetch, c, { ...discovery });
	assert.equal(c.types.get("post")?.count, undefined);
	assert.match(line(c, "type:post")?.detail ?? "", /cap of 100000 bytes/);
});

test("REST fields keep the same samples and counts as before (lowest IDs first)", async () => {
	const fetch = restSite(3);
	const c = createCollector(`${ORIGIN}/`);
	await readRest(fetch, c, { ...discovery });
	const post = c.types.get("post");
	assert.equal(post?.count, 300);
	const sub = post?.fields.find((f) => f.key === "sub");
	assert.deepEqual([sub?.filled, sub?.total, sub?.samples], [300, 300, ["S1", "S2"]]);
});

function authSite(opts: { failPage?: number; totalPages: number }) {
	return site((p, q) => {
		if (p === "/wp-json/wp/v2/types") return { body: JSON.stringify({ post: { name: "Posts", rest_base: "posts", rest_namespace: "wp/v2" } }) };
		if (p === "/wp-json/wp/v2/posts") {
			const page = Number(q.page ?? 1);
			if (page === opts.failPage) return { status: 500 };
			return { body: posts(page), headers: { "x-wp-totalpages": String(opts.totalPages) } };
		}
		return undefined;
	});
}

test("a partial authenticated list leaves count unset (a complete WXR count must not be replaced)", async () => {
	const inv = await readAuth(authSite({ failPage: 2, totalPages: 3 }), { siteUrl: `${ORIGIN}/`, apiRoot: `${ORIGIN}/wp-json/` });
	const post = inv.types.find((t) => t.slug === "post");
	assert.ok(post);
	assert.equal(post.count, undefined);
	assert.deepEqual(post.byStatus, {});
	assert.equal(line(inv, "type:post")?.status, "partial");
});

test("authenticated lists stop at the item cap", async () => {
	const fetch = authSite({ totalPages: 1000 });
	const inv = await readAuth(fetch, { siteUrl: `${ORIGIN}/`, apiRoot: `${ORIGIN}/wp-json/`, maxListItems: 300 });
	assert.equal(inv.types.find((t) => t.slug === "post")?.count, undefined);
	assert.match(line(inv, "type:post")?.detail ?? "", /cap of 300 list items/);
	assert.ok(fetch.calls.filter((x) => x.startsWith("/wp-json/wp/v2/posts")).length <= 4);
});

// --- WXR --------------------------------------------------------------------------------

const HEAD = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:excerpt="http://wordpress.org/export/1.2/excerpt/" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:wp="http://wordpress.org/export/1.2/">
<channel><title>T</title><wp:base_blog_url>https://example.com</wp:base_blog_url>\n`;
const item = (id: number, extra = "", link = `https://example.com/p-${id}/`, guid = link) =>
	`<item><title>Post ${id}</title><link>${link}</link><guid>${guid}</guid><wp:post_id>${id}</wp:post_id><wp:status>publish</wp:status><wp:post_type>post</wp:post_type>${extra}</item>\n`;

async function* chunks(...parts: string[]): AsyncIterable<string> {
	for (const p of parts) yield p;
}

test("WXR ledger URLs are deduped in canonical form", async () => {
	const inv = await readWxrChunks(chunks(HEAD, item(5, "", "https://example.com/?p=5", "https://EXAMPLE.com:443/?p=5"), "</channel></rss>"));
	assert.equal(inv.urls.filter((u) => u.url === "https://example.com/?p=5").length, 1);
});

const reader = fileURLToPath(new URL("../src/sources/wxr/index.ts", import.meta.url));

test("one 200 MB CDATA value streams under a small heap; the value is cut and coverage says so", { timeout: 120_000 }, () => {
	const script = `import { readWxrChunks } from ${JSON.stringify(reader)};
const HEAD = ${JSON.stringify(HEAD)};
async function* gen() {
	yield HEAD + '<item><title>Big</title><link>https://example.com/big/</link><wp:post_id>1</wp:post_id><wp:status>publish</wp:status><wp:post_type>post</wp:post_type><content:encoded><![CDATA[[gallery] ';
	const buf = Buffer.from("<p>soup and bread</p> ".repeat(3000));
	let sent = 0;
	// A fresh string per chunk, as a file stream gives.
	while (sent < 200 * 1024 * 1024) { yield buf.toString("latin1"); sent += buf.length; }
	yield ' [late]]]></content:encoded></item>\\n';
	yield ${JSON.stringify(item(2, "<content:encoded><![CDATA[[after]]]></content:encoded>"))};
	yield "</channel></rss>";
}
const inv = await readWxrChunks(gen());
const t = inv.types.find((x) => x.slug === "post");
process.stdout.write(JSON.stringify({ count: t.count, codes: inv.shortcodes.map((s) => s.name).sort(), wxr: inv.coverage.find((c) => c.area === "wxr"), heap: (globalThis.gc(), process.memoryUsage().heapUsed) }));`;
	// 96 MB: far below the 200 MB value, with room for GC lag when the suite runs in parallel.
	const r = spawnSync(process.execPath, ["--max-old-space-size=96", "--expose-gc", "--input-type=module", "-e", script], { encoding: "utf8" });
	assert.equal(r.status, 0, `${r.signal ?? ""} ${r.stderr.slice(0, 1500)}`);
	const out = JSON.parse(r.stdout) as { count: number; codes: string[]; wxr: { status: string; detail: string }; heap: number };
	assert.equal(out.count, 2);
	assert.deepEqual(out.codes, ["after", "gallery"]);
	assert.equal(out.wxr.status, "partial");
	assert.match(out.wxr.detail, /longer than/);
});

test("WXR: a billion-laughs DOCTYPE and an external entity are rejected, never expanded", async () => {
	const doctype = `<?xml version="1.0"?>
<!DOCTYPE rss [
<!ENTITY lol "lol">
<!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">
<!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">
<!ENTITY lol9 "&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;">
<!ENTITY xxe SYSTEM "file:///etc/passwd">
]>
`;
	const body = HEAD.replace(/^<\?xml[^>]*>\n/, "") + item(1).replace("<title>Post 1</title>", "<title>&lol9;&xxe;</title>") + "</channel></rss>";
	for (const dt of [doctype, doctype.replace("<!DOCTYPE", "<!doctype")]) {
		const inv = await readWxrChunks(chunks(dt + body));
		const text = JSON.stringify(inv);
		assert.ok(!text.includes("lollol"), "no entity expansion");
		assert.ok(!text.includes("root:"), "no external entity read");
		assert.equal(inv.types.length, 0, "nothing after the DOCTYPE is read");
		assert.equal(line(inv, "wxr")?.status, "failed");
		assert.equal(line(inv, "wxr")?.detail, "This export has a DOCTYPE, which WordPress never writes; the file was not read.");
	}
});

test("a DOCTYPE with a 100 MB internal subset is rejected fast under a small heap", { timeout: 60_000 }, () => {
	const script = `import { readWxrChunks } from ${JSON.stringify(reader)};
async function* gen() {
	yield '<?xml version="1.0"?><!DOCTYPE rss [ <!ENTITY a "x"> ';
	const buf = Buffer.from('<!ENTITY b "y"> '.repeat(4000));
	let sent = 0;
	while (sent < 100 * 1024 * 1024) { yield buf.toString("latin1"); sent += buf.length; }
	yield ']><rss><channel></channel></rss>';
}
const t0 = performance.now();
const inv = await readWxrChunks(gen());
process.stdout.write(JSON.stringify({ wxr: inv.coverage.find((c) => c.area === "wxr"), ms: performance.now() - t0 }));`;
	const r = spawnSync(process.execPath, ["--max-old-space-size=32", "--input-type=module", "-e", script], { encoding: "utf8" });
	assert.equal(r.status, 0, `${r.signal ?? ""} ${r.stderr.slice(0, 1500)}`);
	const out = JSON.parse(r.stdout) as { wxr: { status: string }; ms: number };
	assert.equal(out.wxr.status, "failed");
	assert.ok(out.ms < 5000, `took ${Math.round(out.ms)} ms`);
});

test("a 10 MB single tag and an over-long processing instruction are rejected; a normal export still parses", async () => {
	const big = await readWxrChunks(chunks(HEAD, `<item a="${"x".repeat(10 * 1024 * 1024)}">`, "</item></channel></rss>"));
	assert.equal(line(big, "wxr")?.status, "partial");
	assert.match(line(big, "wxr")?.detail ?? "", /tag, declaration or processing instruction is longer than/);
	const pi = await readWxrChunks(chunks(HEAD, `<?x ${"a>".repeat(3 * 1024 * 1024)}?>`, "</channel></rss>"));
	assert.match(line(pi, "wxr")?.detail ?? "", /longer than/);
	const ok = await readWxrChunks(chunks(HEAD, `<?pi a>b?>`, item(1), item(2), "</channel></rss>"));
	assert.equal(line(ok, "wxr")?.status, "complete");
	assert.equal(ok.types.find((t) => t.slug === "post")?.count, 2);
});

test("the run limiter passes XML through unchanged under the limit, at every chunk split", async () => {
	const { RunLimiter, CUT } = await import("../src/sources/wxr/limit.ts");
	const xml = `<?xml version="1.0"?><r a="x>y" b='q"'><!-- c -- d --><t>a &amp; b</t><c><![CDATA[x ]] ]> y]]]]><![CDATA[>]]></c><e/></r>`;
	for (let at = 0; at <= xml.length; at++) {
		const l = new RunLimiter(1000);
		const out = [...l.push(xml.slice(0, at)), ...l.push(xml.slice(at))];
		assert.equal(out.join(""), xml, `split at ${at}`);
		assert.ok(!out.includes(CUT));
	}
});

test("the run limiter cuts long runs and keeps the XML well formed", async () => {
	const { RunLimiter, CUT } = await import("../src/sources/wxr/limit.ts");
	const { SaxesParser } = await import("saxes");
	const xml = `<r><t>${"a &amp; ".repeat(50)}</t><c><![CDATA[${"z".repeat(300)}]]></c><!--${"x-".repeat(200)}--><e>ok</e></r>`;
	for (let at = 0; at <= xml.length; at += 7) for (const max of [64, 65]) {
		const l = new RunLimiter(max);
		const out = [...l.push(xml.slice(0, at)), ...l.push(xml.slice(at))];
		assert.equal(out.filter((p) => p === CUT).length, 3, `split at ${at}`);
		const errors: string[] = [];
		const p = new SaxesParser();
		p.on("error", (e) => errors.push(e.message));
		p.write(out.filter((x): x is string => typeof x === "string").join("")).close();
		assert.deepEqual(errors, [], `split at ${at}`);
	}
	const long = new RunLimiter(64);
	long.push(`<r a="${"x".repeat(100)}">`);
	assert.match(long.error ?? "", /longer than 64/);
});

test("WXR: a page whose link is already ?page_id=16 keeps its kind, slug, type and path for the redirect plan", async () => {
	const page = `<item><title>Pricing</title><link>https://example.com/?page_id=16</link><guid>https://example.com/?page_id=16</guid><wp:post_id>16</wp:post_id><wp:post_name>pricing</wp:post_name><wp:post_parent>15</wp:post_parent><wp:status>publish</wp:status><wp:post_type>page</wp:post_type></item>\n`;
	const parent = `<item><title>Plans</title><link>https://example.com/?page_id=15</link><wp:post_id>15</wp:post_id><wp:post_name>plans</wp:post_name><wp:status>publish</wp:status><wp:post_type>page</wp:post_type></item>\n`;
	const inv = await readWxrChunks(chunks(HEAD, parent, page, "</channel></rss>"));
	const e = inv.urls.find((u) => u.url === "https://example.com/?page_id=16");
	assert.equal(e?.kind, "page", "the same kind level 1 gives it");
	assert.equal(e?.type, "page");
	assert.equal(e?.slug, "pricing");
	assert.equal(e?.path, "plans/pricing");
	assert.equal(e?.parentId, 15);
});

test("WXR: a cut or rejected export gives no authors, media or comments count", async () => {
	const comment = "<wp:comment><wp:comment_id>1</wp:comment_id><wp:comment_approved>1</wp:comment_approved><wp:comment_type>comment</wp:comment_type></wp:comment>";
	const cut = await readWxrChunks(chunks(HEAD, item(1, comment), "<item><title>Broken</title><link>https://example.com/b/</link><wp:post_id>2</wp:post_id></wp:status>"));
	assert.notEqual(line(cut, "wxr")?.status, "complete");
	assert.equal(cut.comments, undefined);
	assert.equal(cut.media, undefined);
	assert.equal(cut.authors, undefined);
	assert.match(line(cut, "comments")?.detail ?? "", /no count/);
	const rejected = await readWxrChunks(chunks(`<?xml version="1.0"?>\n<!DOCTYPE rss>\n` + HEAD.replace(/^<\?xml[^>]*>\n/, "") + item(1, comment) + "</channel></rss>"));
	assert.equal(line(rejected, "wxr")?.status, "failed");
	assert.equal(rejected.comments, undefined);
	const whole = await readWxrChunks(chunks(HEAD, item(1, comment), "</channel></rss>"));
	assert.equal(whole.comments?.count, 1);
	assert.equal(whole.media?.count, 0);
});
