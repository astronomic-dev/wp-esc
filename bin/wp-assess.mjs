#!/usr/bin/env node
// Scores the move from inventory.json into assessment.json.
// When model.json is missing, it proposes one from the inventory, so the report has a model to show.
// The model (read or proposed) decides which addresses and menu links change on EmDash.
import { parseArgs } from "node:util";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { assess } from "../src/assess/index.ts";
import { propose, readModel } from "../src/model/index.ts";
import { writeContract } from "../src/contracts/write.ts";

const usage = `Usage: wp-assess --inventory <file> [options]

Scores each part of the move and writes assessment.json.

Options:
  --inventory <file>  inventory.json (default: inventory.json)
  --model <file>      model.json; made from the inventory when missing
  --out <file>        Where to write (default: assessment.json)
  --no-themes         Leave out theme matches
  -h, --help          Show this help
`;

let values;
try {
	({ values } = parseArgs({
		options: {
			inventory: { type: "string" },
			model: { type: "string" },
			out: { type: "string" },
			"no-themes": { type: "boolean" },
			help: { type: "boolean", short: "h" },
		},
		strict: true,
		allowPositionals: false,
	}));
} catch (error) {
	process.stderr.write(`wp-assess: ${error.message}\n\n${usage}`);
	process.exit(2);
}
if (values.help) {
	process.stdout.write(usage);
	process.exit(0);
}

const inventoryFile = resolve(values.inventory ?? "inventory.json");
const outFile = resolve(values.out ?? "assessment.json");
const modelFile = resolve(values.model ?? join(dirname(outFile), "model.json"));
// Paths as the other scripts print them: relative to the current folder when inside it.
const shown = (file) => {
	const rel = relative(process.cwd(), file);
	return rel && !rel.startsWith("..") ? rel : file;
};

let inventory;
try {
	inventory = JSON.parse(readFileSync(inventoryFile, "utf8"));
} catch (error) {
	const why = error.code === "ENOENT" ? "file not found" : error.message;
	process.stderr.write(`wp-assess: cannot read ${inventoryFile}: ${why}\n`);
	process.exit(1);
}

let model;
if (!existsSync(modelFile)) {
	model = propose(inventory);
	await writeContract(modelFile, "model", model);
	process.stdout.write(`wp-assess: wrote ${shown(modelFile)}\n`);
} else {
	try {
		model = await readModel(modelFile);
	} catch (error) {
		process.stderr.write(`wp-assess: cannot read ${modelFile}: ${error.message}\n`);
		process.exit(1);
	}
}

// The model's routes decide which addresses and menu links change.
const assessment = assess(inventory, { themes: !values["no-themes"], model });
await writeContract(outFile, "assessment", assessment);
process.stdout.write(`wp-assess: wrote ${shown(outFile)}\n`);
