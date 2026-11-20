// The WXR reader streams: a 50 MB generated export parses under a small, fixed heap.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ITEMS = 9_000;
const HEAP_MB = 32; // the export alone, read whole, would not fit
const reader = fileURLToPath(new URL("../src/sources/wxr/index.ts", import.meta.url));

async function writeExport(file: string): Promise<void> {
	const out = createWriteStream(file);
	const write = (s: string): Promise<void> => new Promise((ok) => (out.write(s) ? ok() : out.once("drain", ok)));
	await write(`<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:excerpt="http://wordpress.org/export/1.2/excerpt/" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:wp="http://wordpress.org/export/1.2/">
<channel><title>Big</title><wp:base_blog_url>https://example.com</wp:base_blog_url>\n`);
	const body = `<!-- wp:paragraph --><p>${"A long paragraph about soup and bread. ".repeat(140)}</p><!-- /wp:paragraph -->`;
	for (let i = 1; i <= ITEMS; i++) {
		await write(`<item><title><![CDATA[Post ${i}]]></title><link>https://example.com/post-${i}/</link><guid isPermaLink="false">https://example.com/?p=${i}</guid>
<content:encoded><![CDATA[${body} [gallery ids="${i}"]]]></content:encoded><excerpt:encoded><![CDATA[]]></excerpt:encoded>
<wp:post_id>${i}</wp:post_id><wp:post_date>2024-01-01 09:00:00</wp:post_date><wp:post_name>post-${i}</wp:post_name><wp:status>publish</wp:status>
<wp:post_parent>0</wp:post_parent><wp:menu_order>0</wp:menu_order><wp:post_type>post</wp:post_type>
<wp:postmeta><wp:meta_key>subtitle</wp:meta_key><wp:meta_value><![CDATA[Subtitle ${i}]]></wp:meta_value></wp:postmeta></item>\n`);
	}
	await write("</channel></rss>\n");
	await new Promise<void>((ok, fail) => out.end((e?: Error | null) => (e ? fail(e) : ok())));
}

test("a 50 MB export parses under a fixed heap", { timeout: 120_000 }, async () => {
	const dir = await mkdtemp(join(tmpdir(), "wpm-wxr-"));
	try {
		const file = join(dir, "big.xml");
		await writeExport(file);
		assert.ok((await stat(file)).size >= 50 * 1024 * 1024, "export is at least 50 MB");
		const script = `import { readWxr } from ${JSON.stringify(reader)};
const inv = await readWxr(${JSON.stringify(file)});
const t = inv.types.find((x) => x.slug === "post");
process.stdout.write(JSON.stringify({ count: t.count, urls: inv.urls.length, gallery: inv.shortcodes.find((s) => s.name === "gallery")?.count, heap: (globalThis.gc(), process.memoryUsage().heapUsed) }));`;
		const r = spawnSync(process.execPath, [`--max-old-space-size=${HEAP_MB}`, "--expose-gc", "--input-type=module", "-e", script], { encoding: "utf8" });
		assert.equal(r.status, 0, r.stderr.slice(-2000));
		const out = JSON.parse(r.stdout) as { count: number; urls: number; gallery: number; heap: number };
		assert.deepEqual([out.count, out.urls, out.gallery], [ITEMS, ITEMS * 2, ITEMS]);
		assert.ok(out.heap < 24 * 1024 * 1024, `heap after the run: ${out.heap}`);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
