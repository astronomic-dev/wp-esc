// Slow (WPM_SLOW=1): the generated files work in the real tools.
// - content.config.ts builds in a temp Astro project with one sample entry per collection,
//   using the starter's installed Astro (linked in; wp-esc adds no dependency).
// - seed.json passes validateSeed from the starter's installed `emdash` package (emdash/seed).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Inventory } from "../src/contracts/inventory.ts";
import type { Collection, Model, ModelField } from "../src/contracts/model.ts";
import { propose, toAstroConfig, toSeed } from "../src/model/index.ts";
import { hostileModel, liveCode } from "./helpers/hostile.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const starter = join(root, "../../starters/starter/package.json");
const SAMPLES = ["blog", "business", "builder", "store", "multilingual"];
const slow = process.env.WPM_SLOW === "1";
const inventory = (name: string): Inventory => JSON.parse(readFileSync(join(root, `test/samples/${name}.inventory.json`), "utf8")) as Inventory;

function resolveFromStarter(spec: string): string | undefined {
	try {
		return createRequire(starter).resolve(spec);
	} catch {
		return undefined;
	}
}

const astroPkg = resolveFromStarter("astro/package.json");
const emdashSeed = resolveFromStarter("emdash/seed");
const skipAstro = !slow ? "set WPM_SLOW=1 to run" : !astroPkg ? "cannot resolve astro from starters/starter; run pnpm install" : false;
const skipSeed = !slow ? "set WPM_SLOW=1 to run" : !emdashSeed ? "cannot resolve emdash/seed from starters/starter; run pnpm install" : false;

// A 1x1 PNG, for image fields.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");

function sampleValue(f: ModelField): unknown {
	switch (f.type) {
		case "string":
		case "text":
		case "slug":
		case "portableText":
		case "file":
			return `Sample ${f.name}`;
		case "url":
			return "https://example.com/";
		case "number":
			return 1.5;
		case "integer":
			return 2;
		case "boolean":
			return true;
		case "datetime":
			return "2026-01-15";
		case "select":
			return f.options?.[0] ?? "a";
		case "multiSelect":
			return f.options?.slice(0, 1) ?? ["a"];
		case "image":
			return "./sample.png";
		case "reference":
			return "sample";
		case "repeater":
			return [Object.fromEntries((f.subfields ?? []).map((s) => [s.name, sampleValue(s)]))];
		default:
			return { any: ["json", 1] };
	}
}

function entry(c: Collection): string {
	const lines = ["---"];
	for (const f of c.fields) {
		if (f.name === "content" && f.type === "portableText") continue;
		lines.push(`${JSON.stringify(f.name)}: ${JSON.stringify(sampleValue(f))}`);
	}
	for (const t of c.taxonomies) lines.push(`${JSON.stringify(t)}: ["sample"]`);
	lines.push("---", "", "The body.", "");
	return lines.join("\n");
}

function project(model: Model, dir: string, astroDir: string): void {
	mkdirSync(join(dir, "node_modules"), { recursive: true });
	symlinkSync(astroDir, join(dir, "node_modules/astro"), "dir");
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "wpm-build-check", private: true, type: "module" }));
	writeFileSync(join(dir, "astro.config.mjs"), "export default {};\n");
	mkdirSync(join(dir, "src/pages"), { recursive: true });
	writeFileSync(join(dir, "src/content.config.ts"), toAstroConfig(model));
	const names = model.collections.map((c) => c.slug);
	if (model.taxonomies.length) names.push("taxonomies");
	if (model.menus.length) names.push("menus");
	writeFileSync(
		join(dir, "src/pages/index.astro"),
		`---\nimport { getCollection } from "astro:content";\nconst names = ${JSON.stringify(names)};\nconst counts = await Promise.all(names.map(async (n) => \`\${n}:\${(await getCollection(n as never)).length}\`));\n---\n<p>{counts.join(" ")}</p>\n`,
	);
	for (const c of model.collections) {
		const folder = join(dir, "content", c.slug);
		mkdirSync(folder, { recursive: true });
		writeFileSync(join(folder, "sample.md"), entry(c));
		writeFileSync(join(folder, "sample.png"), PNG);
	}
	if (model.taxonomies.length) writeFileSync(join(dir, "content/taxonomies.json"), JSON.stringify(Object.fromEntries(model.taxonomies.map((t) => [t.slug, [{ slug: "sample", label: "Sample" }]]))));
	if (model.menus.length) writeFileSync(join(dir, "content/menus.json"), JSON.stringify(Object.fromEntries(model.menus.map((m) => [m.name, m.items.map((i) => ({ label: i.label, href: i.url }))]))));
}

function astroBin(): { astroDir: string; bin: string } {
	const astroDir = realpathSync(dirname(astroPkg as string));
	const bin = join(astroDir, (JSON.parse(readFileSync(astroPkg as string, "utf8")) as { bin: Record<string, string> }).bin.astro as string);
	return { astroDir, bin };
}

function build(dir: string, bin: string) {
	return spawnSync(process.execPath, [bin, "build", "--silent"], { cwd: dir, encoding: "utf8", env: { ...process.env, ASTRO_TELEMETRY_DISABLED: "1" } });
}

for (const name of SAMPLES) {
	test(`${name}: the generated content.config.ts builds in Astro`, { skip: skipAstro }, () => {
		const { astroDir, bin } = astroBin();
		const model = propose(inventory(name));
		const dir = mkdtempSync(join(tmpdir(), `wpm-build-${name}-`));
		try {
			project(model, dir, astroDir);
			const run = build(dir, bin);
			assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
			const html = readFileSync(join(dir, "dist/index.html"), "utf8");
			for (const c of model.collections) assert.match(html, new RegExp(`\\b${c.slug}:1\\b`), c.slug);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
}

test("a config made from hostile old-site values builds and runs no injected code", { skip: skipAstro }, () => {
	const { astroDir, bin } = astroBin();
	const model = hostileModel();
	const dir = mkdtempSync(join(tmpdir(), "wpm-build-hostile-"));
	try {
		project(model, dir, astroDir);
		const ts = readFileSync(join(dir, "src/content.config.ts"), "utf8");
		assert.doesNotMatch(liveCode(ts), /process\.exit/);
		const run = build(dir, bin);
		assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
		const html = readFileSync(join(dir, "dist/index.html"), "utf8");
		for (const c of model.collections) assert.match(html, new RegExp(`\\b${c.slug}:1\\b`), c.slug);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the build fails when an entry breaks the schema", { skip: skipAstro }, () => {
	const { astroDir, bin } = astroBin();
	const model = propose(inventory("business"));
	const dir = mkdtempSync(join(tmpdir(), "wpm-build-bad-"));
	try {
		project(model, dir, astroDir);
		const file = join(dir, "content/service/sample.md");
		writeFileSync(file, readFileSync(file, "utf8").replace(/^"tagline": .*\n/m, "").replace(/^"price_band": .*$/m, '"price_band": "Free"'));
		const run = build(dir, bin);
		assert.notEqual(run.status, 0);
		assert.match(`${run.stdout}${run.stderr}`, /tagline|price_band/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("every sample's seed passes EmDash's own validateSeed", { skip: skipSeed }, async () => {
	const { validateSeed } = (await import(pathToFileURL(emdashSeed as string).href)) as { validateSeed: (seed: unknown) => { valid: boolean; errors: string[]; warnings: string[] } };
	for (const name of SAMPLES) {
		const result = validateSeed(JSON.parse(toSeed(propose(inventory(name)))));
		assert.deepEqual(result.errors, [], name);
		assert.equal(result.valid, true, name);
		assert.deepEqual(result.warnings, [], name);
	}
	// The validator is real: a broken seed fails.
	assert.equal(validateSeed({ version: "1", collections: [{ slug: "Bad-Slug", label: "X", fields: [] }] }).valid, false);
});
