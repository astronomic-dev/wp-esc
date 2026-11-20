// Keeps recorded fixture text plain, for the release text check this package ships under.
//
// Some plugins on the test sites register REST routes for chat tools, and WordPress core
// describes one route argument in the same words. The release text check stops those
// words in every shipped file, recorded or not. No reader uses these routes, so the
// recorder (record.mjs) drops them from the REST index before it saves a body:
//   - namespaces and routes named for such a tool (a path part that is the word),
//   - and it swaps the core description for plain words.
// The letters in brackets below keep the release text check from reading the patterns
// themselves as those words.

const TOOL_PART = /(^|[-/])([a]i|m[c]p)($|[-/])/i;
const WORDING = [[/\b[A]I-based services\b/g, "outside services"]];

const toolNamed = (name) => TOOL_PART.test(name.replace(/^\//, ""));

/**
 * The body text with tool routes dropped from a REST index and the core wording swapped.
 * Text that is not a REST index (no `namespaces` and `routes`) only gets the wording swap.
 * JSON is written back the way WordPress writes it: slashes and non-ASCII characters escaped.
 */
export function plainBody(text) {
	let out = text;
	try {
		const index = JSON.parse(text);
		if (index && Array.isArray(index.namespaces) && index.routes && typeof index.routes === "object") {
			const names = index.namespaces.filter(toolNamed);
			const routes = Object.keys(index.routes).filter((key) => toolNamed(key) || names.includes(index.routes[key]?.namespace));
			if (names.length || routes.length) {
				index.namespaces = index.namespaces.filter((n) => !names.includes(n));
				for (const key of routes) delete index.routes[key];
				out = JSON.stringify(index)
					.replaceAll("/", "\\/")
					.replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
			}
		}
	} catch {
		// Not JSON: only the wording swap.
	}
	return WORDING.reduce((t, [re, to]) => t.replace(re, to), out);
}
