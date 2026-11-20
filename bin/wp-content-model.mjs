#!/usr/bin/env node
// Proposes the content model, then writes content.config.ts and seed.json.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { parseArgs } from "node:util";
import { writeContract } from "../src/contracts/write.ts";
import { checkCount, leftOutCount, propose, readAnalyze, readModel, seedEvidenceText, writeModelFiles } from "../src/model/index.ts";

const usage = `Usage: wp-content-model --inventory <file> [options]

Proposes model.json from inventory.json. After review, writes the Astro
content config and an EmDash schema-only seed from model.json.

Options:
  --inventory <file>       inventory.json (default: inventory.json)
  --model <file>           A reviewed model.json to build from
  --out <dir>              Where to write (default: current folder)
  --astro                  Write src/content.config.ts from the model
  --seed                   Write seed/seed.json from the model, and
                           seed/emdash-steps.md (the import steps and how the
                           seed differs from the model); the inventory, when
                           found, types its custom fields
  --emdash-analyze <file>  With --seed: the EmDash Exporter's analyze response
                           (GET <site>/wp-json/emdash/v1/analyze). The seed's
                           custom fields then take its slugs and types exactly.
                           The most reliable path for an existing site.
  -h, --help               Show this help
`;

const name = "wp-content-model";
let values;
try {
	({ values } = parseArgs({
		options: {
			inventory: { type: "string" },
			model: { type: "string" },
			out: { type: "string" },
			astro: { type: "boolean" },
			seed: { type: "boolean" },
			"emdash-analyze": { type: "string" },
			help: { type: "boolean", short: "h" },
		},
		strict: true,
		allowPositionals: false,
	}));
} catch (error) {
	process.stderr.write(`${name}: ${error.message}\n\n${usage}`);
	process.exit(2);
}
if (values.help) {
	process.stdout.write(usage);
	process.exit(0);
}

const out = values.out ?? ".";
const show = (file) => relative(process.cwd(), file) || file;

try {
	if (values.astro || values.seed) {
		const model = await readModel(values.model ?? join(out, "model.json"));
		const evidence = {};
		if (values.seed) {
			const invFile = values.inventory ?? "inventory.json";
			if (values.inventory || existsSync(invFile)) evidence.inventory = JSON.parse(await readFile(invFile, "utf8"));
			if (values["emdash-analyze"]) evidence.analyze = await readAnalyze(values["emdash-analyze"]);
		}
		const files = await writeModelFiles(model, out, { astro: values.astro, seed: values.seed }, evidence);
		for (const file of files) process.stdout.write(`Wrote ${show(file)}\n`);
		if (values.seed) {
			process.stdout.write(`Seed field types from ${seedEvidenceText(evidence)}.${evidence.analyze ? "" : " For an exact match, add --emdash-analyze <file>."} The import steps and how the seed differs from model.json are in seed/emdash-steps.md.\n`);
		}
	} else {
		if (values["emdash-analyze"]) throw new Error("--emdash-analyze goes with --seed");
		const inventory = JSON.parse(await readFile(values.inventory ?? "inventory.json", "utf8"));
		const model = propose(inventory);
		const file = join(out, "model.json");
		await writeContract(file, "model", model);
		const checks = checkCount(model);
		const n = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;
		process.stdout.write(`Wrote ${show(file)}: ${n(model.collections.length, "collection")}, ${n(model.taxonomies.length, "taxonomy").replace(/taxonomys$/, "taxonomies")}, ${n(model.menus.length, "menu")}, ${n(checks, "note")} to check, ${n(leftOutCount(model), "\"Left out\" note")}.\n`);
	}
} catch (error) {
	process.stderr.write(`${name}: ${error.message}\n`);
	process.exit(1);
}
