// Fix round F, builder F5: the export and the password count the same comments
// (approved and waiting; not spam or trash), so merge fills in the split by type.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readWxrChunks } from "../src/sources/wxr/index.ts";
import { merge } from "../src/contracts/merge.ts";
import type { Inventory } from "../src/contracts/inventory.ts";

const c = (flag: string, id: number) => `<wp:comment><wp:comment_id>${id}</wp:comment_id><wp:comment_approved>${flag}</wp:comment_approved><wp:comment_type>comment</wp:comment_type></wp:comment>`;
const xml = `<?xml version="1.0"?><rss xmlns:wp="http://wordpress.org/export/1.2/"><channel><wp:base_site_url>https://example.com</wp:base_site_url>
<item><title>One</title><wp:post_id>1</wp:post_id><wp:status>publish</wp:status><wp:post_type>post</wp:post_type>${c("1", 1)}${c("1", 2)}${c("0", 3)}${c("spam", 4)}${c("trash", 5)}${c("post-trashed", 6)}</item>
</channel></rss>`;

const read = () => readWxrChunks((async function* () { yield xml; })());

test("the export counts approved and waiting comments only", async () => {
	const inv = await read();
	assert.deepEqual(inv.comments, { count: 3, source: "wxr", byType: { post: 3 }, pending: 1 });
});

test("the password's count (approve + hold) matches the export's, so merge keeps it and fills the split by type", async () => {
	const wxr = await read();
	const auth: Inventory = { ...structuredClone(wxr), levels: [3], comments: { count: 3, source: "auth", pending: 1 } };
	const all = merge(wxr, auth);
	assert.deepEqual(all.comments, { count: 3, source: "auth", byType: { post: 3 }, pending: 1 });
});
