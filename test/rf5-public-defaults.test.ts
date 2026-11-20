// Fix round F, builder F5: automatic excerpts and default Yoast descriptions match only
// at the content start; the only gap allowed is the output of a known shortcode.

import { test } from "node:test";
import assert from "node:assert/strict";
import { isAutoExcerpt, isDefaultSeoDescription } from "../src/sources/public/rest.ts";

const FORM = '<div class="wpcf7 no-js" id="wpcf7-f5-o1"><div class="screen-reader-response"><p role="status"></p></div><form class="wpcf7-form init"><p><label> Your name<br /><span><input type="text" name="your-name" /></span></label></p><p><label> Your email<br /><input type="email" /></label></p><p><input type="submit" value="Submit" /></p><div class="wpcf7-response-output"></div></form></div>';

test("an excerpt whose words are spread through the content is written by hand", () => {
	const content = "<p>Leak repair for the Harbor Light area, done by a crew that knows old pipes and right angles.</p>";
	assert.equal(isAutoExcerpt("<p>Leak repair, done right.</p>", content), false, "ordered words with gaps of plain text");
	assert.equal(isAutoExcerpt("<p>Leak repair the area.</p>", content), false, "small gaps of plain text");
});

test("an excerpt may skip only the output of a known shortcode", () => {
	const content = `<p>Tell us about your shop.</p>\n<p>\n${FORM}\n</p>\n<p>We reply within two days.</p>`;
	assert.equal(isAutoExcerpt("<p>Tell us about your shop. We reply within two days.</p>", content), true);
	const gallery = '<p>Our work.</p><div id="gallery-1" class="gallery galleryid-4 gallery-columns-3"><figure class="gallery-item"><div class="gallery-icon"><img src="a.jpg" alt="Kitchen sink" /></div><figcaption>Kitchen sink</figcaption></figure></div><p>Call today.</p>';
	assert.equal(isAutoExcerpt("<p>Our work. Call today. [&hellip;]</p>", gallery), true);
	assert.equal(isAutoExcerpt("<p>Our work. Kitchen sink.</p>", gallery), false, "gallery captions are not in the excerpt");
	const open = '<p>Tell us.</p><div class="wpcf7"><p>Your name</p><p>We reply.</p>';
	assert.equal(isAutoExcerpt("<p>Tell us. We reply.</p>", open), false, "a wrapper with no close tag is left in");
});

test("a Yoast description that copies a later sentence is written by hand", () => {
	const content = "<p>Notes from batch 3.</p><p>We tried it three ways. The second one won.</p>";
	assert.equal(isDefaultSeoDescription("The second one won.", "", content), false);
	assert.equal(isDefaultSeoDescription("We tried it three ways.", "<p>A short take on batch 3. We tried it three ways.</p>", content), false, "a later sentence of the excerpt");
	assert.equal(isDefaultSeoDescription("Notes from batch 3. We tried it", "", content), true, "the content start, cut short");
	assert.equal(isDefaultSeoDescription("A short take on batch 3.", "<p>A short take on batch 3.</p>", content), true, "the excerpt");
});

test("withoutShortcodeOutput stays fast on many unclosed wrappers", async () => {
	const { withoutShortcodeOutput } = await import("../src/sources/public/html.ts");
	const body = `<p>Hello there friend.</p>${'<div class="wpcf7">x '.repeat(20_000)}`;
	const t = performance.now();
	const out = withoutShortcodeOutput(body);
	assert.ok(performance.now() - t < 2000, "bounded");
	assert.ok(out.startsWith("<p>Hello there friend.</p>"));
});
