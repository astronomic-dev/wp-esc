#!/usr/bin/env node
// Maps the old URL ledger to the new routes.
import { readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { readModel } from "../src/model/index.ts";
import { writeRedirectPlan } from "../src/redirects/index.ts";

const usage = `Usage: wp-redirect-plan --inventory <file> --model <file> [options]

Writes redirects.csv, a Cloudflare _redirects file, and, for old query URLs
(?p=, ?page_id=, ?cat= and the like, which _redirects cannot match), two ways
to redirect them: query-redirects.json with a small handler for the new site
(a Worker for the Astro site, middleware for the EmDash site; no rule limit),
and cloudflare-rules.json (Single Redirect rules; Cloudflare Free allows 10).
Writes both the plain Astro plan and the EmDash plan, unless --target picks
one. The summary says where each file goes.

_redirects holds one exact line per old URL, then pattern lines for URL
families no list holds in full (post feeds, later pages, date archives).
Lines past Cloudflare's 2,000 go to _redirects.overflow. The site root is
never sent to another page. A subfolder install (/site/) moves to the root.

Options:
  --inventory <file>  inventory.json (default: inventory.json)
  --model <file>      model.json (default: model.json)
  --target <name>     astro (routes in model.json), emdash (EmDash URL patterns),
                      or both, which writes each set to its own folder, astro/
                      and emdash/ (default: both)
  --origin <url>      The new site's address, for the rules' full target URLs
                      (default: the old site's address). Set it when the new
                      site has another address, for example a test site.
  --out <dir>         Where to write (default: current folder)
  -h, --help          Show this help
`;

const name = "wp-redirect-plan";
let values;
try {
	({ values } = parseArgs({
		options: {
			inventory: { type: "string" },
			model: { type: "string" },
			target: { type: "string" },
			origin: { type: "string" },
			out: { type: "string" },
			help: { type: "boolean", short: "h" },
		},
		strict: true,
		allowPositionals: false,
	}));
	if (values.target !== undefined && !["astro", "emdash", "both"].includes(values.target)) throw new Error(`--target must be astro, emdash or both, not ${values.target}`);
	if (values.origin !== undefined && !/^https?:\/\/[^/?#]+\/?$/i.test(values.origin)) throw new Error(`--origin must be an address like https://example.com, not ${values.origin}`);
} catch (error) {
	process.stderr.write(`${name}: ${error.message}\n\n${usage}`);
	process.exit(2);
}
if (values.help) {
	process.stdout.write(usage);
	process.exit(0);
}

const out = values.out ?? ".";
try {
	const inventory = JSON.parse(await readFile(values.inventory ?? "inventory.json", "utf8"));
	const model = await readModel(values.model ?? "model.json");
	const origin = values.origin ? new URL(values.origin).origin : undefined;
	const target = values.target ?? "both";
	const runs = target === "both" ? [["astro", join(out, "astro")], ["emdash", join(out, "emdash")]] : [[target, out]];
	// The Order and Warning lines are printed once per run, after the plans. A line that only
	// one target gives names that target.
	const notes = new Map();
	for (const [t, dir] of runs) {
		const result = await writeRedirectPlan(inventory, model, dir, { target: t, origin });
		const rel = relative(process.cwd(), dir);
		const shown = rel === "" ? "." : rel.startsWith("..") ? resolve(dir) : rel;
		const own = result.summary.filter((s) => !result.notes.includes(s));
		process.stdout.write(`Wrote the ${t} plan to ${shown}:\n${own.map((s) => `  ${s}\n`).join("")}`);
		for (const n of result.notes) notes.set(n, [...(notes.get(n) ?? []), t]);
	}
	for (const [n, targets] of notes) {
		const label = runs.length > 1 && targets.length < runs.length ? n.replace(/^(Order|Warning):/, `$1 (${targets.join(", ")} plan):`) : n;
		process.stdout.write(`${label}\n`);
	}
} catch (error) {
	process.stderr.write(`${name}: ${error.message}\n`);
	process.exit(1);
}
