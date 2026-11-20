import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeUrlFor, shellQuote } from "../src/emdash/steps.ts";

test("shellQuote keeps a hostile URL as one inert shell word", () => {
	assert.equal(shellQuote("https://example.com/a'b"), "'https://example.com/a'\\''b'");
	assert.equal(shellQuote("https://example.com/$(id)`x`;rm"), "'https://example.com/$(id)`x`;rm'");
});

test("analyzeUrlFor ignores a REST root that is not http(s)", () => {
	assert.equal(analyzeUrlFor("https://example.com", "javascript:x"), "https://example.com/wp-json/emdash/v1/analyze");
	assert.equal(analyzeUrlFor("https://example.com", "https://example.com/?rest_route=/"), "https://example.com/?rest_route=/emdash/v1/analyze");
});
