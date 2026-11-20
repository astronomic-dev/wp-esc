// The site root is never redirected to another page, and the rows that the e2e runs found
// wrong: the front page at level 1, feeds, attachments and later pages of the post list.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Inventory, UrlEntry } from "../src/contracts/inventory.ts";
import type { Model } from "../src/contracts/model.ts";
import { propose } from "../src/model/index.ts";
import { planRedirects, writeRedirectPlan, type Row } from "../src/redirects/index.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const json = <T>(p: string): T => JSON.parse(readFileSync(root + p, "utf8")) as T;
const sample = (name: string): Inventory => json<Inventory>(`test/samples/${name}.inventory.json`);
const rowFor = (rows: Row[], old: string): Row => {
	const r = rows.find((x) => x.old === old);
	assert.ok(r, `no row for ${old}`);
	return r;
};

/** The business sample as a level 1 run sees it: the root is the front page, kind "page". */
function frontPageAsPage(): Inventory {
	const inv = sample("business");
	const base = "https://example.com/site/";
	const urls = inv.urls.filter((u) => u.url !== base);
	const front: UrlEntry = { url: base, kind: "page", type: "page", id: 14, slug: "home", path: "home", source: ["html", "rest"], evidence: "resolved" };
	const query: UrlEntry = { url: `${base}?page_id=14`, kind: "query", type: "page", id: 14, source: ["html"], evidence: "linked" };
	return { ...inv, urls: [...urls, front, query] };
}

for (const target of ["astro", "emdash"] as const) {
	test(`${target}: a root page is the home page, and so is its ?page_id= URL`, () => {
		const inv = frontPageAsPage();
		const rows = planRedirects(inv, propose(inv), { target });
		assert.equal(rowFor(rows, "/site/").new, "/");
		assert.equal(rowFor(rows, "/site/?page_id=14").new, "/");
		assert.ok(!rows.some((r) => r.new === "/home/" || r.new === "/home"), "nothing goes to /home");
	});
}

test("the root of a root install is same, never a redirect", () => {
	const inv = sample("builder");
	const urls = inv.urls.filter((u) => u.url !== "https://builder.example.com/");
	urls.push({ url: "https://builder.example.com/", kind: "page", type: "page", id: 12, slug: "home", path: "home", source: ["rest"], evidence: "resolved" });
	const fixed = { ...inv, urls };
	for (const target of ["astro", "emdash"] as const) assert.equal(rowFor(planRedirects(fixed, propose(fixed), { target }), "/").status, "same");
});

test("with no front page ID, a top-level page with the slug home goes to the home page, with a check note", () => {
	const inv = sample("builder");
	inv.urls.push({ url: "https://builder.example.com/home/", kind: "page", type: "page", id: 99, slug: "home", path: "home", source: ["rest"], evidence: "listed" });
	const r = rowFor(planRedirects(inv, propose(inv), { target: "astro" }), "/home/");
	assert.equal(r.new, "/");
	assert.match(r.note, /Check this/);
});

test("emdash: _redirects and query-redirects.json never send the root anywhere but /", async () => {
	const inv = frontPageAsPage();
	const out = mkdtempSync(join(tmpdir(), "wpm-root-"));
	try {
		const { summary } = await writeRedirectPlan(inv, propose(inv), out, { target: "emdash" });
		const lines = readFileSync(join(out, "_redirects"), "utf8").split("\n").filter((l) => l && !l.startsWith("#"));
		// 10 rules or fewer: cloudflare-rules.json is the default, so _redirects keeps /site/.
		assert.ok(lines.includes("/site/ / 301"), lines.join("\n"));
		const map = JSON.parse(readFileSync(join(out, "query-redirects.json"), "utf8")) as { redirects: Record<string, string> };
		assert.equal(map.redirects["/site/"], "/");
		assert.ok(!Object.values(map.redirects).some((v) => v === "/home"));
		assert.ok(summary.some((s) => s.includes("Keep /site/ out")));
	} finally {
		rmSync(out, { recursive: true, force: true });
	}
});

test("emdash: path-only rows leave _redirects only when the handler is the default", async () => {
	const out = mkdtempSync(join(tmpdir(), "wpm-default-"));
	try {
		const read = (dir: string, f: string): string => readFileSync(join(dir, f), "utf8");
		const exact = (dir: string): string[] => read(dir, "_redirects").split("\n").filter((l) => l && !l.startsWith("#"));
		// 10 rules or fewer: the rules are the default; /site/ stays in _redirects, and every file says so.
		const small = frontPageAsPage();
		const a = join(out, "small");
		const sa = (await writeRedirectPlan(small, propose(small), a, { target: "emdash" })).summary.join("\n");
		assert.ok(exact(a).includes("/site/ / 301"));
		assert.match(sa, /^Choice: /m);
		assert.match(sa, /_redirects keeps the line for \/site\/, since cloudflare-rules\.json is the default\. If you use this file in place of the rules, take that line out of _redirects\./);
		assert.doesNotMatch(sa, /already leaves/);
		assert.doesNotMatch(read(a, "_redirects"), /Not in this file/);
		assert.match(read(a, "_redirects"), /^# Cloudflare runs the Single Redirect rules/m);
		assert.match(read(a, "redirects.csv"), /In _redirects, since cloudflare-rules\.json is the default\./);
		assert.doesNotMatch(read(a, "redirects.csv"), /not _redirects: the handler answers/);
		// More than 10 rules: the handler is the default; /site/ leaves _redirects, and every file says so.
		const big = sample("business.real");
		const b = join(out, "big");
		const sb = (await writeRedirectPlan(big, propose(big), b, { target: "emdash" })).summary.join("\n");
		assert.ok(!exact(b).some((l) => l.startsWith("/site/ ")));
		assert.match(sb, /^Default: query-redirects\.json with query-redirects\.middleware\.ts/m);
		assert.match(sb, /_redirects already leaves \/site\/ out/);
		assert.match(read(b, "_redirects"), /^# Default for the old query URLs: query-redirects\.json with its handler/m);
		assert.match(read(b, "_redirects"), /^# Not in this file: \/site\/\./m);
		assert.match(read(b, "redirects.csv"), /not _redirects: the handler answers this path/);
		assert.doesNotMatch(read(b, "redirects.csv"), /In _redirects, since cloudflare-rules\.json is the default/);
	} finally {
		rmSync(out, { recursive: true, force: true });
	}
});

test("feeds: the comments feed goes home, an entry's feed goes to the entry, the site feed to the new feed", () => {
	const inv = sample("blog");
	const base = "https://blog.example.com";
	inv.urls.push(
		{ url: `${base}/comments/feed/`, kind: "feed", source: ["html"], evidence: "linked" },
		{ url: `${base}/2026/03/up-the-north-ridge/feed/`, kind: "feed", source: ["html"], evidence: "linked" },
	);
	const rows = planRedirects(inv, propose(inv), { target: "astro" });
	assert.equal(rowFor(rows, "/comments/feed/").new, "/");
	assert.equal(rowFor(rows, "/2026/03/up-the-north-ridge/feed/").new, "/blog/up-the-north-ridge/");
	assert.equal(rowFor(rows, "/feed/").new, "/rss.xml");
});

test("attachments: placed by parent; with only a file URL, the review note names the file", () => {
	const inv = sample("blog");
	inv.urls.push({ url: "https://blog.example.com/lone-photo/", kind: "attachment", type: "attachment", id: 500, slug: "lone-photo", file: "https://blog.example.com/wp-content/uploads/2026/03/lone.jpg", source: ["wxr"], evidence: "listed" });
	const rows = planRedirects(inv, propose(inv), { target: "astro" });
	assert.equal(rowFor(rows, "/2026/03/up-the-north-ridge/ridge-view/").new, "/blog/up-the-north-ridge/");
	const lone = rowFor(rows, "/lone-photo/");
	assert.equal(lone.status, "review");
	assert.match(lone.note, /wp-content\/uploads\/2026\/03\/lone\.jpg/);
});

test("a menu archive that is not in the inventory says why it has a row", () => {
	const inv = json<Inventory>("test/samples/business.real.inventory.json");
	const model = json<Model>("test/samples/business.model.json");
	const rows = planRedirects(inv, model, { target: "astro" });
	for (const r of rows) if (r.note.includes("Not in the inventory")) assert.equal(r.kind, "archive");
});

const written = async (inv: Inventory, target: "astro" | "emdash", model?: Model) => {
	const out = mkdtempSync(join(tmpdir(), "wpm-plan-"));
	try {
		const { summary } = await writeRedirectPlan(inv, model ?? propose(inv), out, { target });
		const read = (f: string): string => readFileSync(join(out, f), "utf8");
		return { summary, redirects: read("_redirects"), csv: read("redirects.csv") };
	} finally {
		rmSync(out, { recursive: true, force: true });
	}
};

test("pattern lines: per-year post feeds, later home pages and date archives, after the exact lines", async () => {
	const { redirects, csv, summary } = await written(sample("blog"), "astro");
	const lines = redirects.split("\n").filter((l) => l && !l.startsWith("#"));
	const first = lines.findIndex((l) => /[*:]/.test(l));
	assert.ok(first > 0 && lines.slice(first).every((l) => /[*:]/.test(l)), "pattern lines come after every exact line");
	assert.ok(lines.includes("/2026/:month/:slug/feed/* /blog/:slug/ 301"));
	assert.ok(lines.includes("/page/* /blog/ 301"));
	assert.ok(lines.includes("/2026/* /blog/ 301"));
	assert.ok(lines.indexOf("/2026/:month/:slug/feed/* /blog/:slug/ 301") < lines.indexOf("/2026/* /blog/ 301"), "feeds before the year line");
	assert.ok(!lines.some((l) => l.startsWith("/:year/")), "never a bare placeholder first segment");
	assert.match(csv, /Pattern: the feed of every post from 2026/);
	assert.ok(summary.some((s) => /exact lines and \d+ pattern lines \(comment lines not counted\)/.test(s)));
});

test("pattern lines are left out when they would catch a path that stays the same", async () => {
	const inv = sample("blog");
	// A page at /2026/plans/ keeps its path on the new site: the year line would catch it.
	inv.urls.push({ url: "https://blog.example.com/2026/plans/", kind: "page", type: "page", id: 900, slug: "plans", path: "2026/plans", source: ["rest"], evidence: "listed" });
	const model = propose(inv);
	const { redirects, summary } = await written(inv, "astro", model);
	assert.ok(!redirects.includes("/2026/* "));
	assert.ok(summary.some((s) => s.startsWith("Warning: Left out the pattern line /2026/*")));
});

test("no pattern lines for a /%postname%/ site: a placeholder there would catch every page", async () => {
	const { redirects, summary } = await written(sample("business"), "astro", json<Model>("test/samples/business.model.json"));
	const dynamic = redirects.split("\n").filter((l) => !l.startsWith("#") && /[*:]\S* \S+ 301/.test(l));
	assert.ok(!dynamic.some((l) => l.split(" ")[0]?.includes(":")), "no placeholder line");
	// Only the fixed later-page and feed lines of each term and author page.
	for (const l of dynamic) assert.match(l, /^\/site\/[^*:]+\/(page|feed)\/\* \S+ 301$/, l);
	assert.ok(summary.some((s) => /^Pattern lines: none for post feeds, since /.test(s)), summary.join("\n"));
});

test("summary: line counts say one line and nothing to add; query notes name the default file", async () => {
	const inv = sample("builder");
	inv.urls = inv.urls.filter((u) => u.kind === "home" || u.url.endsWith("?page_id=5"));
	const { summary, redirects, csv } = await written(inv, "emdash");
	assert.ok(summary.some((s) => s === "_redirects: no redirect lines, so nothing to add. It holds only comments."), summary.join("\n"));
	assert.match(redirects, /# Nothing to add/);
	assert.match(csv, /Query URL: in cloudflare-rules\.json, the default\./);
	const one = sample("blog");
	one.urls = one.urls.filter((u) => u.kind === "home" || u.url.endsWith("/2026/03/up-the-north-ridge/"));
	const s1 = (await written(one, "astro", propose(sample("blog")))).summary;
	assert.ok(s1.some((s) => s.startsWith("_redirects: 1 exact line")), s1.join("\n"));
	const many = (await written(sample("blog"), "astro")).csv;
	if (/\?p=/.test(many)) assert.ok(!/Query URL: in cloudflare-rules.json\b(?!, the default)/.test(many));
});

test("a subfolder install: the summary says every URL moves out of the old base path", async () => {
	const { summary } = await written(sample("business"), "astro", json<Model>("test/samples/business.model.json"));
	assert.ok(summary.some((s) => s.startsWith("The old site is at /site/. The plan puts the new site at the root")));
});

test("nested terms: plain Astro keeps the path, EmDash flattens to the slug", () => {
	const inv = sample("blog");
	const astro = rowFor(planRedirects(inv, propose(inv), { target: "astro" }), "/category/trips/coast/");
	assert.equal(astro.new, "/category/trips/coast/");
	const emdash = rowFor(planRedirects(inv, propose(inv), { target: "emdash" }), "/category/trips/coast/");
	assert.equal(emdash.new, "/category/coast");
	assert.match(emdash.note, /EmDash serves terms by slug/);
});

test("pattern lines are left out when they would catch a review row", async () => {
	const inv = sample("blog");
	// An unresolved live page: the year line must not send it to the blog index.
	inv.urls.push({ url: "https://blog.example.com/2026/special/", kind: "other", source: ["html"], evidence: "linked" });
	const model = propose(sample("blog"));
	const rows = planRedirects(inv, model, { target: "astro" });
	assert.equal(rowFor(rows, "/2026/special/").status, "review");
	const { redirects, summary } = await written(inv, "astro", model);
	assert.ok(!redirects.includes("/2026/* "));
	assert.ok(summary.some((s) => s.startsWith("Warning: Left out the pattern line /2026/*") && s.includes("/2026/special/")), summary.join("\n"));
	assert.ok(redirects.includes("/2026/03/up-the-north-ridge/ /blog/up-the-north-ridge/ 301"), "exact lines stay");
});

test("pattern lines never point off the site or hold whitespace", async () => {
	const { patternLines } = await import("../src/redirects/index.ts");
	const inv = sample("blog");
	for (const route of ["//evil.example.com/{slug}/", "/blog/\\{slug}/", "/a b/{slug}/", "/a\n/x 301\n/{slug}/"]) {
		const model = propose(inv);
		model.collections.find((c) => c.from === "post")!.route = route;
		model.routes = model.routes.map((r) => (r.kind === "blog" ? { ...r, pattern: route.replace("{slug}/", "") } : r));
		for (const target of ["astro", "emdash"] as const) {
			const rows = planRedirects(inv, model, { target });
			const { patterns } = patternLines(inv, model, target, rows);
			for (const p of patterns) {
				assert.ok(!p.to.startsWith("//") && !p.to.includes("\\"), `${route}: ${p.to}`);
				assert.ok(!/[\s\x00-\x1f\x7f]/.test(p.to + p.from), `${route}: ${JSON.stringify(p)}`);
			}
			const { redirects } = await written(inv, target, model);
			for (const line of redirects.split("\n").filter((l) => l && !l.startsWith("#"))) {
				assert.equal(line.split(" ").length, 3, `${route}: ${JSON.stringify(line)}`);
				assert.ok(!line.split(" ")[1]!.startsWith("//"), line);
			}
		}
	}
});

test("toCloudflare drops a pattern line that points off the site or holds whitespace", async () => {
	const { toCloudflare } = await import("../src/redirects/index.ts");
	const bad = [
		{ from: "/2026/*", to: "//evil.example.com/", kind: "date" as const, note: "" },
		{ from: "/2026/*", to: "/a b/", kind: "date" as const, note: "" },
		{ from: "/2025/*\n/x", to: "/blog/", kind: "date" as const, note: "" },
		{ from: "/2024/*", to: "/blog/", kind: "date" as const, note: "" },
	];
	const cf = toCloudflare([], { origin: "https://example.com", host: "example.com", patterns: bad });
	const lines = cf.redirects.split("\n").filter((l) => l && !l.startsWith("#"));
	assert.deepEqual(lines, ["/2024/* /blog/ 301"]);
	assert.equal(cf.patternCount, 1);
});
