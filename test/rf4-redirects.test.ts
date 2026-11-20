// Fix round F, F4: the redirect plan on the real e2e runs (test/fixtures/rf4-runs).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Inventory } from "../src/contracts/inventory.ts";
import type { Model } from "../src/contracts/model.ts";
import { patternRegExp, planRedirects, writeRedirectPlan } from "../src/redirects/index.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const fixture = (run: string): string => `${root}test/fixtures/rf4-runs/${run}`;
const load = <T>(run: string, file: string): T => JSON.parse(readFileSync(`${fixture(run)}/${file}.json`, "utf8")) as T;
const inventory = (run: string): Inventory => load<Inventory>(run, "inventory");
const model = (run: string): Model => load<Model>(run, "model");

const temp = async <T>(fn: (dir: string) => Promise<T>): Promise<T> => {
	const dir = mkdtempSync(join(tmpdir(), "wpm-rf4-"));
	try {
		return await fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
};

/** The pattern lines of a written _redirects: from, to. */
const patternsIn = (redirects: string): [string, string][] => redirects.split("\n").filter((l) => !l.startsWith("#") && /[*:]\S* \S+ 301$/.test(l)).map((l) => l.split(" ") as [string, string]);

test("rf4 patterns: later pages and feeds of terms and authors match a line on both targets", async () => {
	const inv = inventory("blog-l3");
	const m = model("blog-l3");
	for (const target of ["astro", "emdash"] as const) {
		await temp(async (dir) => {
			await writeRedirectPlan(inv, m, dir, { target });
			const lines = patternsIn(readFileSync(join(dir, "_redirects"), "utf8"));
			for (const path of ["/category/guides/page/6/", "/author/dana-whitlock/page/2/", "/tag/baking/feed/"]) {
				assert.ok(lines.some(([from]) => patternRegExp(from).test(path)), `${target}: ${path}`);
			}
			const page = lines.find(([from]) => from === "/category/guides/page/*");
			assert.equal(page?.[1], target === "emdash" ? "/category/guides" : "/category/guides/", "page 1 of the term");
			// One splat per line, and no placeholder in a term or author line.
			for (const [from] of lines) assert.equal(from.split("*").length, 2, from);
			// Safe: no line catches an old path that is not an exact 301.
			const rows = planRedirects(inv, m, { target });
			const notExact = rows.filter((r) => r.status !== "301" && r.old.startsWith("/")).map((r) => r.old.split("?")[0] as string);
			for (const [from] of lines) assert.ok(!notExact.some((p) => patternRegExp(from).test(p)), from);
		});
	}
});

test("rf4 patterns: the summary says why a family gets no line", async () => {
	await temp(async (dir) => {
		const { summary } = await writeRedirectPlan(inventory("business-l3"), model("business-l3"), dir, { target: "astro" });
		assert.ok(summary.some((s) => s === "Pattern lines: none for post feeds, since /%postname%/ makes a feed pattern unsafe."), summary.join("\n"));
	});
});

test("rf4 plain permalinks: ?m=, ?paged= and ?feed= rows go in the query map with real targets", async () => {
	const inv = inventory("builder-l1");
	const origin = inv.site.url.replace(/\/$/, "");
	inv.urls.push(
		{ url: `${origin}/?m=202611`, kind: "query", source: ["html"], evidence: "linked" },
		{ url: `${origin}/?paged=2`, kind: "paged", source: ["html"], evidence: "linked" },
		{ url: `${origin}/?feed=rss2&p=20`, kind: "feed", source: ["html"], evidence: "linked" },
	);
	const m = model("builder-l1");
	const rows = planRedirects(inv, m, { target: "astro" });
	const row = (old: string) => rows.find((r) => r.old === old);
	assert.equal(row("/?m=202611")?.status, "301");
	assert.equal(row("/?m=202611")?.new, m.routes.find((r) => r.kind === "blog")?.pattern);
	assert.equal(row("/?paged=2")?.status, "301");
	assert.equal(row("/?feed=rss2&p=20")?.new, row("/?p=20")?.new, "a post's own feed goes to the post");
	assert.equal(row("/?feed=comments-rss2")?.new, "/", "the comments feed goes to the home page");
	await temp(async (dir) => {
		await writeRedirectPlan(inv, m, dir, { target: "astro" });
		const map = JSON.parse(readFileSync(join(dir, "query-redirects.json"), "utf8")).redirects as Record<string, string>;
		assert.ok(Object.keys(map).some((k) => k.includes("m=202611")));
		assert.ok(Object.keys(map).some((k) => k.includes("paged=2")));
	});
});

test("rf4 summary: the query map lists only the params it holds", async () => {
	await temp(async (dir) => {
		const { summary } = await writeRedirectPlan(inventory("builder-l1"), model("builder-l1"), dir, { target: "emdash" });
		const line = summary.find((s) => s.startsWith("query-redirects.json:"));
		assert.ok(line);
		assert.doesNotMatch(line, /\?attachment_id=/, "every attachment row is a review row");
		assert.match(line, /\?p=/);
	});
});

test("rf4 CLI: one Order paragraph per run; past 50 rules, one line says so", () => {
	const plan = (run: string): string => {
		const out = mkdtempSync(join(tmpdir(), "wpm-rf4-cli-"));
		try {
			const r = spawnSync(process.execPath, [`${root}bin/wp-redirect-plan.mjs`, "--inventory", `${fixture(run)}/inventory.json`, "--model", `${fixture(run)}/model.json`, "--out", out], { encoding: "utf8" });
			assert.equal(r.status, 0, r.stderr);
			return r.stdout;
		} finally {
			rmSync(out, { recursive: true, force: true });
		}
	};
	const builder = plan("builder-l1");
	assert.equal(builder.match(/^\s*Order:/gm)?.length, 1, builder);
	const warnings = builder.match(/^\s*Warning.*$/gm) ?? [];
	assert.equal(new Set(warnings).size, warnings.length, "no warning twice");
	const blog = plan("blog-l3");
	assert.equal(blog.match(/more than any Cloudflare plan up to Business \(50\) allows/g)?.length, 1, blog);
	assert.doesNotMatch(blog, /Order:/, "the rules cannot be used, so no order to explain");
});

test("rf4 wp-assess prints a relative path", () => {
	const out = mkdtempSync(join(tmpdir(), "wpm-rf4-assess-"));
	try {
		const r = spawnSync(process.execPath, [`${root}bin/wp-assess.mjs`, "--inventory", `${fixture("builder-l3")}/inventory.json`, "--model", `${fixture("builder-l3")}/model.json`, "--no-themes"], { encoding: "utf8", cwd: out });
		assert.equal(r.status, 0, r.stderr);
		assert.match(r.stdout, /^wp-assess: wrote assessment\.json$/m);
	} finally {
		rmSync(out, { recursive: true, force: true });
	}
});
