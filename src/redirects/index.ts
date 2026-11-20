// The redirect plan: map the old URL ledger to the new routes and write redirects.csv,
// _redirects (exact lines, then pattern lines for URL families; plus _redirects.overflow when needed), cloudflare-rules.json, and, when the plan
// has query URLs, query-redirects.json with its handler (query.ts).

import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Inventory } from "../contracts/inventory.ts";
import type { Model } from "../contracts/model.ts";
import { planRedirects, QUERY_NOTE, siteBase, type Row, type Target } from "./plan.ts";
import { patternLines } from "./patterns.ts";
import { toCsv } from "./csv.ts";
import { PRECEDENCE, RULES_MAX, RULES_WARN, toCloudflare } from "./cloudflare.ts";
import { MAP_FILE, MIDDLEWARE_FILE, WORKER_FILE, toQueryRedirects } from "./query.ts";

export { clashingPaths, encodeSegment, isSiteRelative, planRedirects, settleGraph, siteBase, type Row, type Status, type Target } from "./plan.ts";
export { patternLines, patternRegExp, type Pattern } from "./patterns.ts";
export { toCsv } from "./csv.ts";
export { PRECEDENCE, RULES_MAX, RULES_WARN, safePath, toCloudflare, type CloudflareFiles } from "./cloudflare.ts";
export { MAP_FILE, MIDDLEWARE_FILE, WORKER_FILE, toQueryRedirects, type QueryFiles } from "./query.ts";
export { createQueryRedirect, queryKey, queryParams, safeTarget, type QueryMap } from "./query-handler.ts";

export interface WriteOptions {
	target: Target;
	origin?: string; // the new site's origin; defaults to the old site's
}

export interface Written {
	files: string[];
	summary: string[]; // one line per file, then the Order and Warning lines
	notes: string[]; // the Order and Warning lines alone, so a run over both targets can print them once
}

const list = (items: string[]): string => (items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);
const lines = (n: number, what: string): string => `${n} ${what} ${n === 1 ? "line" : "lines"}`;

export async function writeRedirectPlan(inv: Inventory, model: Model, out: string, options: WriteOptions): Promise<Written> {
	const planned = planRedirects(inv, model, { target: options.target });
	const origin = options.origin ?? new URL(inv.site.url).origin;
	const host = new URL(inv.site.url).host;
	const q = toQueryRedirects(planned, options.target);
	// The default for query URLs: the rules, unless there are more than the Free plan allows;
	// then the map and its handler. On EmDash, the paths the map answers leave _redirects only
	// when the handler is the default; with the rules as the default they stay, or nothing
	// would redirect them.
	const over = !!q && toCloudflare(planned, { origin, host }).ruleCount > RULES_WARN;
	const skip = over ? (q?.answered ?? []) : [];
	const { patterns, warnings: patternWarnings, skipped } = patternLines(inv, model, options.target, planned, skip);
	const cf = toCloudflare(planned, { origin, host, target: options.target, patterns, answered: skip, handlerDefault: over });
	// Each query row's note names the file that holds it by default.
	const answered = new Set(skip);
	const keptForRules = new Set(over ? [] : (q?.answered ?? []));
	const queryNote = `Query URL: in ${over ? `${MAP_FILE}, the default past ${RULES_WARN} rules` : "cloudflare-rules.json, the default"}.`;
	const rows: Row[] = planned.map((r) => {
		if (r.note.endsWith(QUERY_NOTE)) return { ...r, note: `${r.note.slice(0, -QUERY_NOTE.length)}${queryNote}` };
		if (answered.has(r.old)) return { ...r, note: `${r.note} In ${MAP_FILE}, not _redirects: the handler answers this path with its old query URLs.` };
		if (keptForRules.has(r.old)) return { ...r, note: `${r.note} In _redirects, since cloudflare-rules.json is the default. ${MAP_FILE} also holds it: if you use the handler in place of the rules, take this line out of _redirects.` };
		return r;
	});
	await mkdir(out, { recursive: true });
	const files: string[] = [];
	const put = async (name: string, text: string): Promise<string> => {
		const file = join(out, name);
		await writeFile(file, text, "utf8");
		files.push(file);
		return file;
	};
	const count = (s: string): number => rows.filter((r) => r.status === s).length;
	const summary: string[] = [];
	const patternRows: Row[] = patterns.map((p) => ({ old: p.from, new: p.to, status: "301", kind: p.kind, note: p.note }));
	await put("redirects.csv", toCsv([...rows, ...patternRows], options.target));
	const extra = patternRows.length ? `, then ${lines(patternRows.length, "pattern")} for URL families` : "";
	summary.push(`redirects.csv: ${rows.length} old URLs for the ${options.target} target (${count("301")} redirects, ${count("same")} already the same, ${count("review")} to review)${extra}.`);
	const base = siteBase(new URL(inv.site.url));
	if (base !== "/") {
		const eg = rows.find((r) => r.status === "301" && r.old !== base && r.old.startsWith(base) && !r.old.includes("?"));
		summary.push(`The old site is at ${base}. The plan puts the new site at the root, so every old URL moves out of ${base}${eg ? `, for example ${eg.old} to ${eg.new}` : ""}.`);
	}
	await put("_redirects", cf.redirects);
	if (!cf.lineCount && !cf.patternCount) summary.push("_redirects: no redirect lines, so nothing to add. It holds only comments.");
	else summary.push(`_redirects: ${lines(cf.lineCount, "exact")}${cf.patternCount ? ` and ${lines(cf.patternCount, "pattern")}` : ""} (comment lines not counted).`);
	if (skipped.length) summary.push(`Pattern lines: ${skipped.join("; ")}.`);
	if (cf.overflow) {
		await put("_redirects.overflow", cf.overflow);
		summary.push(`_redirects.overflow: ${lines(cf.overflow.split("\n").length - 1, "exact")} past Cloudflare's limit.`);
	} else {
		await rm(join(out, "_redirects.overflow"), { force: true });
	}
	const stale = [MAP_FILE, WORKER_FILE, MIDDLEWARE_FILE];
	if (q) {
		await put(MAP_FILE, q.map);
		await put(q.handlerFile, q.handler);
		const goes = options.target === "emdash" ? `src/${MAP_FILE}, beside src/middleware.ts` : `worker/${MAP_FILE}, beside worker/query-redirects.ts`;
		summary.push(`${MAP_FILE}: ${q.queryCount} old query URLs (${q.params.map((n) => `?${n}=`).join(", ")}) and their new paths, with no rule limit. Goes in ${goes}.`);
		if (options.target === "emdash") {
			const n = q.answered.length;
			const left = !n ? "" : over ? ` _redirects already leaves ${list(q.answered)} out. If you use cloudflare-rules.json instead of this file, add ${n === 1 ? "its line" : "their lines"} to _redirects (see redirects.csv).` : ` _redirects keeps the ${n === 1 ? "line" : "lines"} for ${list(q.answered)}, since cloudflare-rules.json is the default. If you use this file in place of the rules, take ${n === 1 ? "that line" : "those lines"} out of _redirects.`;
			summary.push(`${MIDDLEWARE_FILE}: the handler that answers them, as Astro middleware. Goes in src/middleware.ts (or add its onRequest to the one there with sequence()). Keep ${list(q.paths)} out of EmDash's redirects; this file answers ${q.paths.length === 1 ? "it" : "them"}.${left}`);
		} else summary.push(`${WORKER_FILE}: the handler that answers them, a Worker in front of the static assets. Goes in worker/query-redirects.ts; in wrangler.jsonc set "main": "worker/query-redirects.ts" and, under "assets", "binding": "ASSETS" and "run_worker_first": the paths named in its header.`);
	}
	for (const f of stale) if (!q || (f !== MAP_FILE && f !== q.handlerFile)) await rm(join(out, f), { force: true });
	await put("cloudflare-rules.json", cf.rules);
	const where = options.origin ? origin : `${origin}, the old site's address, since no --origin was given; if the new site has another address, run again with --origin <its address>`;
	const rulesLine = `cloudflare-rules.json: ${cf.ruleCount} Single Redirect ${cf.ruleCount === 1 ? "rule" : "rules"} for URLs _redirects cannot match (query strings), on ${host}, targeting ${where}.`;
	summary.push(over ? rulesLine.replace("cloudflare-rules.json:", "cloudflare-rules.json (optional):") : rulesLine);
	const tooMany = cf.ruleCount > RULES_MAX; // the warning says so in one line
	if (over && q && tooMany) summary.push(`Default: ${MAP_FILE} with ${q.handlerFile}.`);
	else if (over && q) summary.push(`Default: ${MAP_FILE} with ${q.handlerFile}. cloudflare-rules.json has ${cf.ruleCount} rules, more than the ${RULES_WARN} Cloudflare's Free plan allows, so use the rules only on a plan that allows them.`);
	else if (q && cf.ruleCount) summary.push(`Choice: add the rules to the zone, or use ${MAP_FILE} with ${q.handlerFile} in place of them; the handler has no rule limit.`);
	const notes: string[] = [];
	if (cf.ruleCount && !tooMany) notes.push(`Order: ${over ? "If you use the rules instead: " : ""}${PRECEDENCE.replaceAll("this file", "_redirects")}`);
	for (const w of [...cf.warnings, ...patternWarnings]) notes.push(`Warning: ${w}`);
	return { files, summary: [...summary, ...notes], notes };
}
