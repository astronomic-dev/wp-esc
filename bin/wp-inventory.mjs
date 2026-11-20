#!/usr/bin/env node
// Reads a WordPress site into inventory.json.
// Level 1 reads the public URL; --wxr adds the export file (level 2); --level 3 adds the
// application password. Each level is read on its own, then all are merged (merge.ts).
// --wxr without --url reads only the export.
import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import { createSiteFetch } from "../src/http/site-fetch.ts";
import { readPublic } from "../src/sources/public/index.ts";
import { readWxr } from "../src/sources/wxr/index.ts";
import { readAuth } from "../src/sources/auth/index.ts";
import { merge } from "../src/contracts/merge.ts";
import { writeContract } from "../src/contracts/write.ts";

const name = "wp-inventory";
const usage = `Usage: wp-inventory --url <site> [options]

Reads a WordPress site and writes inventory.json.

Options:
  --url <site>       The site's address (https only)
  --level <1|2|3>    1: public URL (default); 2: add an export file; 3: add an application password
  --wxr <file>       The WordPress export file. --wxr alone is level 2, so --level 2 is not needed.
                     Without --url, only the file is read.
  --merge <file>     An earlier inventory.json to merge with (repeatable)
  --out <file>       Where to write inventory.json (default: inventory.json in this folder)
  -h, --help         Show this help

Common runs:
  Level 1:              wp-inventory --url https://example.com
  Level 2:              wp-inventory --url https://example.com --wxr export.xml
  Level 3 with export:  wp-inventory --url https://example.com --level 3 --wxr export.xml
Keep --level 3 when you add --wxr; --level 2 would leave out the password step.

Use --merge only to join an inventory.json from an earlier run, for example a
level 1 run on another day. One run with --level 3 --wxr already reads all levels.

Level 3 reads WPM_WP_USER and WPM_WP_APP_PASSWORD from the environment.
Only the file named by --out is written.

WPM_ALLOW_HTTP_LOCALHOST=1 lets the scripts read an http:// site on localhost, such as a test site on your own computer. Do not set it for a live site.
`;

function fail(code, message) {
	process.stderr.write(`${name}: ${message}\n`);
	process.exit(code);
}

let values;
try {
	({ values } = parseArgs({
		options: {
			url: { type: "string" },
			level: { type: "string" },
			wxr: { type: "string" },
			merge: { type: "string", multiple: true },
			out: { type: "string" },
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
const level = values.level ?? (values.wxr ? "2" : "1");
if (!["1", "2", "3"].includes(level)) {
	process.stderr.write(`${name}: --level must be 1, 2 or 3\n\n${usage}`);
	process.exit(2);
}
if (level === "2" && !values.wxr) {
	process.stderr.write(`${name}: level 2 needs --wxr <file>\n\n${usage}`);
	process.exit(2);
}
if (!values.url && !(values.wxr && level !== "3")) {
	process.stderr.write(`${name}: --url is required\n\n${usage}`);
	process.exit(2);
}
if (level === "3" && (!process.env.WPM_WP_USER || !process.env.WPM_WP_APP_PASSWORD)) {
	fail(2, "level 3 needs WPM_WP_USER and WPM_WP_APP_PASSWORD in the environment");
}

try {
	const parts = [];
	let fetch;
	if (values.url) {
		fetch = createSiteFetch({ url: values.url });
		parts.push(await readPublic(fetch, values.url));
	}
	if (values.wxr) parts.push(await readWxr(values.wxr));
	// Level 3 needs the API root that level 1 found. Without it, no password request is sent,
	// and what levels 1 and 2 read is still written.
	let noAuth;
	if (level === "3") {
		const pub = parts[0];
		if (pub.site.apiRoot) parts.push(await readAuth(fetch, { siteUrl: pub.site.url, apiRoot: pub.site.apiRoot }));
		else {
			const site = pub.coverage.find((c) => c.area === "site" && c.status === "failed");
			noAuth = [
				"level 3 needs the REST API, and level 1 did not find it. No password request was sent.",
				site ? site.detail : "Check that the site address is right and that the REST API is on.",
				site || values.wxr ? "" : "An export file can still be read with --wxr.",
			].filter(Boolean).join(" ");
		}
	}
	const earlier = await Promise.all((values.merge ?? []).map(async (f) => JSON.parse(await readFile(f, "utf8"))));
	const inventory = merge(...earlier, ...parts);
	const out = values.out ?? "inventory.json";
	await writeContract(out, "inventory", inventory);
	const requests = fetch ? `, ${fetch.requests()} requests` : "";
	process.stdout.write(`${name}: wrote ${out} (${inventory.urls.length} URLs${requests})\n`);
	if (noAuth) fail(1, `${noAuth} Wrote ${out} without level 3.`);
	const offsite = inventory.coverage.find((c) => c.area === "site" && c.status === "failed");
	if (offsite) process.stderr.write(`${name}: ${offsite.detail}\n`);
	if (level === "3") process.stdout.write(`${name}: done with the application password. Revoke it now: Users > Profile > Application Passwords > Revoke. Then run: unset WPM_WP_USER WPM_WP_APP_PASSWORD\n`);
} catch (error) {
	fail(1, error?.message ?? String(error));
}
