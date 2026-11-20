import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { checkSchema, readContract, schemaShape, tsShape, type Member } from "./helpers/check-schema.ts";
import { INVENTORY_VERSION, type Inventory } from "../src/contracts/inventory.ts";
import { MODEL_VERSION, type Model } from "../src/contracts/model.ts";
import { ASSESSMENT_VERSION, type Assessment } from "../src/contracts/assessment.ts";
import { stringify, type ContractKind } from "../src/contracts/write.ts";
import { merge } from "../src/contracts/merge.ts";
import { normalizeUrl } from "../src/contracts/url.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (p: string): string => readFileSync(root + p, "utf8");
const json = <T>(p: string): T => JSON.parse(read(p)) as T;

const schemas = {
	inventory: json<Record<string, unknown>>("schema/inventory.schema.json"),
	model: json<Record<string, unknown>>("schema/model.schema.json"),
	assessment: json<Record<string, unknown>>("schema/assessment.schema.json"),
};

const samples = readdirSync(root + "test/samples").sort();
const kindOf = (file: string): ContractKind => file.split(".").at(-2) as ContractKind;

const INVENTORY_SAMPLES = ["blog", "business", "builder", "store", "multilingual"];

test("all five inventory samples exist", () => {
	for (const name of INVENTORY_SAMPLES) assert.ok(samples.includes(`${name}.inventory.json`), name);
});

test("every sample validates against its schema", () => {
	for (const file of samples) {
		const errors = checkSchema(schemas[kindOf(file)], json(`test/samples/${file}`));
		assert.deepEqual(errors, [], file);
	}
});

test("every sample carries the current contract version", () => {
	const want = { inventory: INVENTORY_VERSION, model: MODEL_VERSION, assessment: ASSESSMENT_VERSION };
	for (const file of samples) assert.equal(json<{ version: number }>(`test/samples/${file}`).version, want[kindOf(file)], file);
});

test("schemas reject a wrong shape", () => {
	const inv = json<Record<string, unknown>>("test/samples/blog.inventory.json");
	assert.notDeepEqual(checkSchema(schemas.inventory, { ...inv, version: 2 }), []);
	assert.notDeepEqual(checkSchema(schemas.inventory, { ...inv, extra: true }), []);
	const { urls: _urls, ...noUrls } = inv;
	assert.notDeepEqual(checkSchema(schemas.inventory, noUrls), []);
	const types = inv.types as Record<string, unknown>[];
	const badType = { ...inv, types: [{ ...types[0], sources: ["ftp"] }] };
	assert.notDeepEqual(checkSchema(schemas.inventory, badType), []);
});

// Types and schemas agree: every interface member is a schema property with the same
// shape (primitive, $ref, array items, unions), optional members are the ones not
// required, and every string union is the schema enum. Types one contract imports from
// another (for example Locale) are checked against the file that defines them.

function resolveDef(schema: Record<string, unknown>, node: Record<string, unknown>): Record<string, unknown> {
	const ref = node.$ref;
	if (typeof ref !== "string") return node;
	const defs = schema.$defs as Record<string, Record<string, unknown>>;
	const def = defs[ref.replace("#/$defs/", "")];
	assert.ok(def, `missing ${ref}`);
	return def;
}

function compareMembers(schema: Record<string, unknown>, node: Record<string, unknown>, members: Member[], where: string): void {
	const def = resolveDef(schema, node);
	const props = (def.properties ?? {}) as Record<string, Record<string, unknown>>;
	assert.deepEqual(Object.keys(props).sort(), members.map((m) => m.name).sort(), `${where}: property names`);
	const required = ((def.required ?? []) as string[]).slice().sort();
	assert.deepEqual(required, members.filter((m) => !m.optional).map((m) => m.name).sort(), `${where}: required`);
	assert.equal(def.additionalProperties, false, `${where}: closed`);
	for (const m of members) {
		const prop = props[m.name] as Record<string, unknown>;
		assert.equal(schemaShape(prop), tsShape(m.type), `${where}.${m.name}: type`);
		if (m.inline) compareMembers(schema, prop, m.inline, `${where}.${m.name}`);
	}
}

const CONTRACTS: { kind: ContractKind; file: string; rootName: string }[] = [
	{ kind: "inventory", file: "src/contracts/inventory.ts", rootName: "Inventory" },
	{ kind: "model", file: "src/contracts/model.ts", rootName: "Model" },
	{ kind: "assessment", file: "src/contracts/assessment.ts", rootName: "Assessment" },
];

const parsed = new Map(CONTRACTS.map((c) => [c.kind, readContract(read(c.file))]));
const allInterfaces = new Map([...parsed.values()].flatMap((p) => [...p.interfaces]));
const allUnions = new Map([...parsed.values()].flatMap((p) => [...p.unions]));

test("shape strings read both sides the same way", () => {
	assert.equal(tsShape("string | null"), schemaShape({ type: ["string", "null"] }));
	assert.equal(tsShape("ThemeMatch[] | \"none-fit\""), "array<ref:ThemeMatch>|const");
	assert.equal(tsShape("Record<string, number>"), "record<number>");
	assert.equal(tsShape("\"b\" | \"a\""), "enum:a,b");
	assert.notEqual(tsShape("string[]"), schemaShape({ type: "string" }));
});

for (const c of CONTRACTS) {
	test(`${c.kind}: TypeScript types and JSON Schema agree`, () => {
		const schema = schemas[c.kind];
		assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
		const { interfaces, unions } = parsed.get(c.kind)!;
		assert.ok(interfaces.has(c.rootName));
		const defs = schema.$defs as Record<string, Record<string, unknown>>;
		for (const name of interfaces.keys()) {
			assert.ok(name === c.rootName || defs[name], `${c.kind}: $defs.${name} missing`);
		}
		for (const name of unions.keys()) assert.ok(defs[name], `${c.kind}: $defs.${name} missing`);
		compareMembers(schema, schema, interfaces.get(c.rootName)!, c.rootName);
		for (const [name, def] of Object.entries(defs)) {
			const members = allInterfaces.get(name);
			const values = allUnions.get(name);
			assert.ok(members || values, `${c.kind}: $defs.${name} has no TypeScript type`);
			if (members) compareMembers(schema, def, members, name);
			if (values) assert.equal(schemaShape(def), tsShape(values.map((v) => (typeof v === "string" ? `"${v}"` : String(v))).join(" | ")), `${name} enum`);
		}
	});
}

// Hand checks of the rules the types encode.

test("a type seen only by name has no count and its coverage says not-visible", () => {
	for (const name of INVENTORY_SAMPLES) {
		const inv = json<Inventory>(`test/samples/${name}.inventory.json`);
		for (const type of inv.types) {
			if (type.inRest === false && type.sources.every((s) => s === "sitemap")) {
				assert.equal(type.count, undefined, `${name}: ${type.slug}`);
				assert.ok(
					inv.coverage.some((c) => c.area === `type:${type.slug}` && c.status === "not-visible"),
					`${name}: ${type.slug} coverage`,
				);
			}
		}
	}
	const builder = json<Inventory>("test/samples/builder.inventory.json");
	assert.ok(builder.types.some((t) => t.count === undefined && t.inRest === false), "builder sample has a hidden type");
});

test("URL ledger keys are unique and duplicate slugs are allowed", () => {
	for (const name of INVENTORY_SAMPLES) {
		const inv = json<Inventory>(`test/samples/${name}.inventory.json`);
		const urls = inv.urls.map((u) => u.url);
		assert.equal(new Set(urls).size, urls.length, name);
	}
	const business = json<Inventory>("test/samples/business.inventory.json");
	const pages = business.urls.filter((u) => u.kind === "page" && u.slug === "pricing");
	assert.equal(pages.length, 2, "duplicate page slug under two parents");
	assert.notEqual(pages[0]?.path, pages[1]?.path);
});

test("model samples map every collection and field from WordPress", () => {
	for (const file of samples.filter((f) => kindOf(f) === "model")) {
		const model = json<Model>(`test/samples/${file}`);
		for (const col of model.collections) {
			assert.ok(col.from, `${file}: ${col.slug}`);
			const fields = [...col.fields, ...col.fields.flatMap((f) => f.subfields ?? [])];
			for (const f of fields) assert.ok(f.from, `${file}: ${col.slug}.${f.name}`);
		}
	}
});

// write: byte-stable output.

function rng(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (s * 1664525 + 1013904223) >>> 0;
		return s / 2 ** 32;
	};
}

const ORDERED: Record<ContractKind, Set<string>> = {
	inventory: new Set(["options"]),
	model: new Set(["fields", "subfields", "items", "children", "options"]),
	assessment: new Set(["themes", "links"]),
};

function shuffle(value: unknown, kind: ContractKind, rand: () => number, prop = ""): unknown {
	if (Array.isArray(value)) {
		const items = value.map((v) => shuffle(v, kind, rand));
		if (ORDERED[kind].has(prop)) return items;
		for (let i = items.length - 1; i > 0; i--) {
			const j = Math.floor(rand() * (i + 1));
			[items[i], items[j]] = [items[j], items[i]];
		}
		return items;
	}
	if (value && typeof value === "object") {
		const entries = Object.entries(value).map(([k, v]) => [k, shuffle(v, kind, rand, k)] as const);
		entries.sort(() => rand() - 0.5);
		return Object.fromEntries(entries);
	}
	return value;
}

test("write is byte-stable on shuffled input", () => {
	for (const file of samples) {
		const kind = kindOf(file);
		const value = json<unknown>(`test/samples/${file}`);
		const once = stringify(kind, value);
		assert.ok(once.endsWith("}\n"), file);
		assert.ok(once.startsWith('{\n\t"version": '), `${file}: version first`);
		for (let seed = 1; seed <= 5; seed++) {
			assert.equal(stringify(kind, shuffle(value, kind, rng(seed))), once, `${file} seed ${seed}`);
		}
		assert.equal(stringify(kind, JSON.parse(once)), once, `${file}: idempotent`);
	}
});

test("write keeps meaningful order in model fields and theme ranks", () => {
	const model = json<Model>("test/samples/business.model.json");
	const out = JSON.parse(stringify("model", model)) as Model;
	for (const [i, col] of model.collections.entries()) {
		const back = out.collections.find((c) => c.slug === col.slug);
		assert.deepEqual(back?.fields.map((f) => f.name), col.fields.map((f) => f.name), `collection ${i}`);
	}
	const assessment: Assessment = {
		version: ASSESSMENT_VERSION,
		findings: [],
		blockers: [],
		themes: [
			{ slug: "vesper", name: "Vesper", reason: "b", url: "https://astronomic.dev/themes/vesper/" },
			{ slug: "dispatch", name: "Dispatch", reason: "a", url: "https://astronomic.dev/themes/dispatch/" },
		],
	};
	const themes = (JSON.parse(stringify("assessment", assessment)) as Assessment).themes;
	assert.ok(Array.isArray(themes));
	assert.deepEqual(themes.map((t) => t.slug), ["vesper", "dispatch"]);
});

test("write sorts the inventory ledger and nested lists", () => {
	const inv = json<Inventory>("test/samples/blog.inventory.json");
	const out = JSON.parse(stringify("inventory", { ...inv, urls: [...inv.urls].reverse() })) as Inventory;
	const urls = out.urls.map((u) => u.url);
	assert.deepEqual(urls, [...urls].sort());
	assert.deepEqual(out.levels, [...out.levels].sort((a, b) => a - b));
});

// merge: levels combine.

function levelOne(): Inventory {
	return {
		version: INVENTORY_VERSION,
		site: { url: "https://example.com/", apiRoot: "https://example.com/wp-json/", name: "Example", locales: [{ code: "en-US", default: true }] },
		levels: [1],
		coverage: [{ area: "rest", source: "rest", status: "complete", detail: "read 3 lists" }],
		types: [
			{
				slug: "post",
				count: 2,
				byStatus: { publish: 2 },
				inRest: true,
				fields: [
					{ key: "price", owner: "meta", shape: "text", source: "html", filled: 1, total: 1, samples: ["$10"], confidence: "low", note: "seen in HTML" },
				],
				taxonomies: ["category"],
				sources: ["rest"],
			},
		],
		taxonomies: [{ slug: "category", types: ["post"], sources: ["rest"] }],
		plugins: [{ slug: "wordpress-seo", category: "seo", source: "html", confidence: "medium" }],
		builders: [],
		shortcodes: [{ name: "gallery", count: 1, samples: ["https://example.com/a/"] }],
		blocks: [],
		menus: [],
		authors: { count: 1, source: "rest" },
		media: { count: 4, source: "rest" },
		permalinks: { structure: "/%postname%/", source: "html", confidence: "medium" },
		urls: [
			{ url: "https://example.com/a/", kind: "post", source: ["rest"], type: "post", id: 1, slug: "a", evidence: "listed" },
			{ url: "https://example.com/category/news/", kind: "category", source: ["html"], taxonomy: "category", evidence: "linked" },
		],
		storedElsewhere: [],
	};
}

function levelTwo(): Inventory {
	return {
		version: INVENTORY_VERSION,
		site: { url: "https://example.com/", name: "Example Site", locales: [{ code: "en-US", default: true }] },
		levels: [2],
		coverage: [{ area: "wxr", source: "wxr", status: "complete", detail: "read the export" }],
		types: [
			{
				slug: "post",
				count: 3,
				byStatus: { publish: 2, draft: 1 },
				fields: [
					{ key: "price", owner: "acf", label: "Price", shape: "number", source: "wxr", filled: 3, total: 3, samples: ["10", "12"], confidence: "high" },
					{ key: "subtitle", owner: "acf", shape: "text", source: "wxr", filled: 2, total: 3, samples: ["Hi"], confidence: "medium" },
				],
				taxonomies: ["category", "post_tag"],
				sources: ["wxr"],
			},
		],
		taxonomies: [{ slug: "category", hierarchical: true, count: 2, types: ["post"], sources: ["wxr"] }],
		plugins: [],
		builders: [],
		shortcodes: [{ name: "gallery", count: 2, samples: ["https://example.com/b/"] }],
		blocks: [{ name: "core/paragraph", count: 3, samples: ["https://example.com/a/"] }],
		menus: [],
		authors: { count: 2, source: "wxr" },
		media: { count: 5, source: "wxr" },
		permalinks: { source: "wxr", confidence: "low" },
		urls: [
			{ url: "https://example.com/a/", kind: "post", source: ["wxr"], type: "post", id: 1, slug: "a", evidence: "listed" },
			{ url: "https://example.com/?p=3", kind: "query", source: ["wxr"], type: "post", id: 3, evidence: "listed" },
		],
		storedElsewhere: [],
	};
}

test("merge keeps level 1 URLs that WXR lacks and adds up sources", () => {
	const merged = merge(levelOne(), levelTwo());
	const urls = merged.urls.map((u) => u.url).sort();
	assert.deepEqual(urls, ["https://example.com/?p=3", "https://example.com/a/", "https://example.com/category/news/"]);
	assert.deepEqual(merged.urls.find((u) => u.url === "https://example.com/a/")?.source, ["rest", "wxr"]);
	assert.deepEqual(merged.levels, [1, 2]);
	assert.deepEqual(merged.types[0]?.sources, ["rest", "wxr"]);
	assert.deepEqual(merged.types[0]?.taxonomies, ["category", "post_tag"]);
	assert.equal(merged.coverage.length, 2);
	assert.equal(merged.plugins.length, 1, "nothing is dropped");
	assert.equal(merged.site.apiRoot, "https://example.com/wp-json/", "level 1 facts the WXR lacks stay");
});

test("merge keeps each area's best coverage lines and drops the ones a better source answered", () => {
	const a = levelOne();
	a.coverage.push(
		{ area: "type:post", source: "rest", status: "partial", detail: "drafts need level 3" },
		{ area: "menus", source: "html", status: "not-visible", detail: "menus need level 2" },
		{ area: "html", source: "html", status: "partial", detail: "read 3 pages" },
	);
	const b = levelTwo();
	b.coverage.push(
		{ area: "type:post", source: "wxr", status: "complete", detail: "3 items" },
		{ area: "menus", source: "wxr", status: "partial", detail: "1 menu" },
	);
	const merged = merge(a, b);
	const at = (area: string) => merged.coverage.filter((c) => c.area === area).map((c) => c.source);
	assert.deepEqual(at("type:post"), ["wxr"]);
	assert.deepEqual(at("menus"), ["wxr"]);
	assert.deepEqual(at("html"), ["html"], "an area with one line keeps it");
	assert.deepEqual(at("rest"), ["rest"]);
});

test("merge takes WXR field data over HTML guesses", () => {
	const merged = merge(levelOne(), levelTwo());
	const post = merged.types.find((t) => t.slug === "post");
	const price = post?.fields.find((f) => f.key === "price");
	assert.equal(price?.shape, "number");
	assert.equal(price?.owner, "acf");
	assert.equal(price?.confidence, "high");
	assert.equal(price?.filled, 3);
	assert.deepEqual(price?.samples, ["10", "12"]);
	assert.ok(post?.fields.some((f) => f.key === "subtitle"));
	assert.equal(post?.count, 3);
	assert.deepEqual(post?.byStatus, { draft: 1, publish: 2 });
	assert.equal(post?.inRest, true);
	assert.equal(merged.site.name, "Example Site");
	assert.equal(merged.authors?.count, 2);
	assert.equal(merged.shortcodes.find((s) => s.name === "gallery")?.count, 2);
});

test("merge keeps the known permalink structure over an unknown one", () => {
	const merged = merge(levelOne(), levelTwo());
	assert.deepEqual(merged.permalinks, { structure: "/%postname%/", source: "html", confidence: "medium" });
});

test("merge does not depend on argument order", () => {
	assert.equal(stringify("inventory", merge(levelOne(), levelTwo())), stringify("inventory", merge(levelTwo(), levelOne())));
});

test("merge output validates and does not change its inputs", () => {
	const a = levelOne();
	const b = levelTwo();
	const before = JSON.stringify([a, b]);
	const merged = merge(a, b);
	assert.equal(JSON.stringify([a, b]), before);
	assert.deepEqual(checkSchema(schemas.inventory, JSON.parse(stringify("inventory", merged))), []);
	assert.deepEqual(checkSchema(schemas.inventory, merge(json("test/samples/business.inventory.json"), b)), []);
});

// Review fixes: one test per rule.

test("authors and media may be absent, and merge never trades a count for nothing", () => {
	const a = levelOne();
	const b = levelTwo();
	delete b.authors;
	delete b.media;
	const merged = merge(a, b);
	assert.deepEqual(merged.authors, { count: 1, source: "rest" });
	assert.deepEqual(merged.media, { count: 4, source: "rest" });
	const c = levelOne();
	delete c.authors;
	const d = levelTwo();
	delete d.authors;
	assert.equal(merge(c, d).authors, undefined);
	assert.deepEqual(checkSchema(schemas.inventory, JSON.parse(stringify("inventory", c))), []);
});

test("comments: the export's split count wins over the REST total; an absent count never erases one", () => {
	const a = { ...levelOne(), comments: { count: 21, source: "rest" as const } };
	const b = { ...levelTwo(), comments: { count: 22, source: "wxr" as const, byType: { post: 22 } } };
	assert.deepEqual(merge(a, b).comments, { count: 22, source: "wxr", byType: { post: 22 } });
	assert.deepEqual(merge(a, levelTwo()).comments, { count: 21, source: "rest" });
	assert.deepEqual(checkSchema(schemas.inventory, JSON.parse(stringify("inventory", merge(a, b)))), []);
});

test("merge ranks field data by source: wxr over auth over rest over html", () => {
	const wxr = levelTwo();
	wxr.types[0]!.fields = [
		{
			key: "steps", owner: "acf", shape: "repeater", source: "wxr", filled: 2, total: 2, samples: ["2"], confidence: "low",
			subfields: [{ key: "step_title", owner: "acf", shape: "text", source: "wxr", filled: 4, total: 4, samples: ["Call"], confidence: "high" }],
		},
	];
	const auth: Inventory = { ...levelOne(), levels: [3] };
	auth.types = [{ ...auth.types[0]!, fields: [
		{ key: "steps", owner: "meta", shape: "text", source: "rest", filled: 2, total: 2, samples: ["2"], confidence: "medium" },
		{ key: "price", owner: "meta", shape: "text", source: "auth", filled: 3, total: 3, samples: ["$10"], confidence: "medium" },
	] }];
	const html = levelOne();
	for (const merged of [merge(wxr, auth, html), merge(html, auth, wxr), merge(auth, wxr)]) {
		const steps = merged.types[0]!.fields.find((f) => f.key === "steps");
		assert.equal(steps?.source, "wxr");
		assert.equal(steps?.subfields?.length, 1);
	}
	const price = merge(html, auth).types[0]!.fields.find((f) => f.key === "price");
	assert.equal(price?.source, "auth");
});

test("normalizeUrl: origin case, default port, query order and fragment; the path is kept as served", () => {
	assert.equal(normalizeUrl("HTTPS://Example.COM:443/a/?b=2&a=1#top"), "https://example.com/a/?a=1&b=2");
	assert.equal(normalizeUrl("http://localhost:4601/x?p=3"), "http://localhost:4601/x?p=3");
	assert.equal(normalizeUrl("https://example.com"), "https://example.com/");
	assert.notEqual(normalizeUrl("https://example.com/a"), normalizeUrl("https://example.com/a/"));
	assert.equal(normalizeUrl("https://example.com/A/"), "https://example.com/A/", "path case kept");
	assert.equal(normalizeUrl("https://example.com/?a=2&a=1"), "https://example.com/?a=2&a=1", "repeated keys keep their order");
	assert.equal(normalizeUrl("https://example.com/%C3%A9t%C3%A9/"), "https://example.com/%C3%A9t%C3%A9/");
});

test("merge and write key the ledger by the normal URL", () => {
	const a = levelOne();
	const b = levelTwo();
	b.urls.push({ url: "HTTPS://EXAMPLE.com:443/a/#x", kind: "post", source: ["wxr"], evidence: "resolved" });
	b.urls.push({ url: "https://example.com/a", kind: "other", source: ["wxr"], evidence: "listed" });
	const merged = merge(a, b);
	assert.equal(merged.urls.filter((u) => u.url === "https://example.com/a/").length, 1);
	assert.equal(merged.urls.find((u) => u.url === "https://example.com/a/")?.evidence, "resolved");
	assert.ok(merged.urls.some((u) => u.url === "https://example.com/a"), "no trailing slash stays its own key");
	const written = JSON.parse(stringify("inventory", { ...a, urls: [{ url: "https://Example.com/?b=1&a=2", kind: "query", source: ["rest"], evidence: "listed" }] })) as Inventory;
	assert.equal(written.urls[0]?.url, "https://example.com/?a=2&b=1");
});

test("flexible fields carry layouts; relation and choice fields carry targets and options", () => {
	const inv = json<Inventory>("test/samples/business.inventory.json");
	const fields = inv.types.flatMap((t) => t.fields);
	const flex = fields.find((f) => f.shape === "flexible");
	assert.ok(flex?.layouts && flex.layouts.length >= 2 && flex.layouts.every((l) => l.subfields.length > 0));
	assert.deepEqual(fields.find((f) => f.shape === "relation")?.targets, ["service"]);
	const choice = fields.find((f) => f.options);
	assert.ok(choice, "a choice field");
	const out = JSON.parse(stringify("inventory", inv)) as Inventory;
	const back = out.types.flatMap((t) => t.fields).find((f) => f.key === choice.key);
	assert.deepEqual(back?.options, choice.options, "write keeps choice order");
	assert.ok(fields.some((f) => typeof f.order === "number"), "source order");
});

test("locales are objects with a code, prefix and default, in inventory and model", () => {
	const inv = json<Inventory>("test/samples/multilingual.inventory.json");
	assert.deepEqual(inv.site.locales.map((l) => l.code).sort(), ["en-US", "fr-CA"]);
	assert.equal(inv.site.locales.filter((l) => l.default).length, 1);
	assert.equal(inv.site.locales.find((l) => l.code === "fr-CA")?.prefix, "fr");
	const model = json<Model>("test/samples/business.model.json");
	assert.ok(Array.isArray(model.locales) && model.locales[0]?.code === "en-US");
	const merged = merge(levelOne(), { ...levelTwo(), site: { url: "https://example.com/", locales: [{ code: "fr-CA", prefix: "fr" }] } });
	assert.deepEqual(merged.site.locales.map((l) => l.code), ["en-US", "fr-CA"]);
});

test("post type archives have a URL kind and a model route kind", () => {
	const inv = json<Inventory>("test/samples/business.inventory.json");
	assert.ok(inv.urls.some((u) => u.kind === "archive" && u.type === "service"));
	const model = json<Model>("test/samples/business.model.json");
	assert.ok(model.routes.some((r) => r.kind === "archive" && r.collection === "service"));
});

test("merge keys menus by WordPress term ID, by name only when an ID is missing", () => {
	const item = { id: 1, title: "Home", url: "https://example.com/", order: 1 };
	const a: Inventory = { ...levelOne(), menus: [{ id: 5, name: "Main", items: [item], source: "html" }, { name: "Footer", items: [], source: "html" }] };
	const b: Inventory = { ...levelTwo(), menus: [{ id: 5, name: "Main menu", location: "primary", items: [], source: "wxr" }, { id: 6, name: "Main", items: [], source: "wxr" }, { id: 7, name: "Footer", items: [], source: "wxr" }] };
	const merged = merge(a, b);
	assert.deepEqual(merged.menus.map((m) => [m.id, m.name]), [[5, "Main menu"], [6, "Main"], [7, "Footer"]]);
	assert.equal(merged.menus.find((m) => m.id === 5)?.items.length, 1);
});

test("the model has no blocks field type", () => {
	const schema = schemas.model as { $defs: { ModelFieldType: { enum: string[] } } };
	assert.ok(!schema.$defs.ModelFieldType.enum.includes("blocks"));
	assert.doesNotMatch(read("src/contracts/model.ts"), /"blocks"/);
});

// CLI stubs.

for (const name of ["wp-inventory", "wp-assess", "wp-content-model", "wp-redirect-plan"]) {
	test(`${name} stub parses flags and says it is not built yet`, () => {
		// Only bins still on the stub say "not built yet"; each chunk's own tests cover its filled bin.
		if (read(`bin/${name}.mjs`).includes("runStub(")) {
			const run = spawnSync(process.execPath, [`${root}bin/${name}.mjs`, "--out", "out"], { encoding: "utf8" });
			assert.equal(run.status, 1);
			assert.match(run.stderr, /not built yet/);
		}
		const bad = spawnSync(process.execPath, [`${root}bin/${name}.mjs`, "--nope"], { encoding: "utf8" });
		assert.equal(bad.status, 2);
		const help = spawnSync(process.execPath, [`${root}bin/${name}.mjs`, "--help"], { encoding: "utf8" });
		assert.equal(help.status, 0);
		assert.match(help.stdout, new RegExp(`Usage: ${name}`));
	});
}

test("merge: a WXR that lists fewer items than REST keeps the higher count and becomes partial", () => {
	const a = levelOne();
	a.types[0]!.count = 120;
	a.types[0]!.byStatus = { publish: 120 };
	a.comments = { count: 21, source: "rest" };
	a.coverage.push({ area: "type:post", source: "rest", status: "partial", detail: "120 published items" });
	const b = levelTwo();
	b.types[0]!.count = 2;
	b.types[0]!.byStatus = { publish: 1, draft: 1 };
	b.comments = { count: 1, source: "wxr" };
	b.coverage.push({ area: "type:post", source: "wxr", status: "complete", detail: "2 items in the export" });
	const merged = merge(a, b);
	const post = merged.types.find((t) => t.slug === "post");
	assert.equal(post?.count, 121);
	assert.deepEqual(post?.byStatus, { draft: 1, publish: 120 });
	const lines = merged.coverage.filter((c) => c.area === "type:post");
	assert.deepEqual(lines.map((c) => `${c.source} ${c.status}`), ["wxr partial"]);
	assert.match(lines[0]?.detail ?? "", /^2 items in the export Another source lists more.* 120 published items$/);
	assert.equal(merged.comments?.count, 21, "a short export does not lower the comment count");
	assert.equal(merged.media?.count, 5, "a larger count from the export still wins");
});

test("merge keeps an area's failed lines when no source is complete", () => {
	const a = levelOne();
	a.coverage.push({ area: "menus", source: "html", status: "not-visible", detail: "menus need level 2" });
	const b = levelTwo();
	b.coverage.push({ area: "menus", source: "wxr", status: "partial", detail: "locations are not in the export" });
	const c = levelTwo();
	c.levels = [3];
	c.coverage = [{ area: "menus", source: "auth", status: "failed", detail: "403" }, { area: "type:post", source: "auth", status: "failed", detail: "403" }];
	const merged = merge(a, b, c);
	const at = (area: string) => merged.coverage.filter((x) => x.area === area).map((x) => `${x.source} ${x.status}`).sort();
	// One line per area: the partial status, with the failed source's reason joined in.
	assert.deepEqual(at("menus"), ["wxr partial"]);
	assert.equal(merged.coverage.find((x) => x.area === "menus")?.detail, "403 locations are not in the export");
	assert.deepEqual(at("wxr"), ["wxr complete"]);
});

test("merge drops the level 1 fields plugin guess when a higher source names the real plugin", () => {
	const guess = { slug: "advanced-custom-fields", name: "Advanced Custom Fields or Secure Custom Fields", category: "fields" as const, source: "rest" as const, confidence: "low" as const };
	for (const real of ["secure-custom-fields", "advanced-custom-fields", "advanced-custom-fields-pro"]) {
		const lo = { ...levelOne(), plugins: [guess] };
		const hi = { ...levelTwo(), levels: [3], plugins: [{ slug: real, active: true, category: "fields" as const, source: "auth" as const, confidence: "high" as const }] };
		const fields = merge(lo, hi).plugins.filter((p) => p.category === "fields");
		assert.deepEqual(fields.map((p) => [p.slug, p.confidence]), [[real, "high"]], real);
	}
	const alone = merge({ ...levelOne(), plugins: [guess] }, levelTwo()).plugins;
	assert.deepEqual(alone.map((p) => p.slug), ["advanced-custom-fields"], "the guess stays when nothing better lists a fields plugin");
});
