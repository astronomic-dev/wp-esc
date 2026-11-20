// Cloudflare files from the plan.
//
// _redirects (Cloudflare Pages and Workers static assets): one static line per redirect,
// `<old> <new> 301`. Cloudflare reads at most 2,000 static and 100 dynamic lines, each
// under 1,000 characters. Every line here is static: a `*` or `:` in an old path would
// make the line dynamic, so those rows go to the rules file instead. Lines past 2,000 go
// to _redirects.overflow with a warning.
//
// _redirects cannot match query strings, so old URLs with a query (`?p=`, `?page_id=`,
// `?cat=` and the like) go to cloudflare-rules.json: Single Redirect rules for the
// http_request_dynamic_redirect phase, each matching the exact path and query, with a
// static full target URL and a 301. Its `rules` array is the body the Rulesets API takes.
//
// Order: Cloudflare runs Single Redirect rules (the zone's Redirect Rules) before the
// request reaches the site, so before _redirects. That is what makes the query rules
// work: _redirects matches by path only, so `/site/ / 301` alone would also catch
// /site/?p=26. The _redirects header says so whenever there are rules.
//
// Old-site text is made safe before it is written: whitespace, control characters and
// non-ASCII are percent-encoded in paths, rule strings escape `\` and `"`, and the rules
// file is written with JSON.stringify.

import { isSiteRelative, type Row } from "./plan.ts";
import { safeLine, type Pattern } from "./patterns.ts";

export const STATIC_LIMIT = 2000;
export const DYNAMIC_LIMIT = 100; // pattern lines (patterns.ts) are the only dynamic lines
export const LINE_LIMIT = 1000;
export const RULES_WARN = 10; // Single Redirect rules on Cloudflare's Free plan
export const RULES_MAX = 50; // Single Redirect rules on Cloudflare's Business plan, the largest before Enterprise

/** Why the rules in cloudflare-rules.json must be live before (or with) _redirects. */
export const PRECEDENCE = "Cloudflare runs the Single Redirect rules in cloudflare-rules.json before this file, and this file matches by path only. Add those rules to the zone (Rules > Redirect Rules) before or with this file: without them, a line for a path such as / or /site/ also catches its old query URLs (/site/?p=26) and sends them to the wrong page.";

export interface CloudflareOptions {
	origin: string; // the new site's origin, for the rules' full target URLs
	host: string; // the old site's host; every rule matches it, so other hostnames in the zone are left alone
	target?: string; // the target the plan was made for; named in a header comment and in each rule's description
	patterns?: Pattern[]; // dynamic lines, written after the exact lines (patterns.ts)
	answered?: string[]; // paths query-redirects.json answers on the EmDash target, left out of this file (only when the handler is the default)
	handlerDefault?: boolean; // query-redirects.json with its handler is the default, since the rules are past the Free plan's limit
}

export interface CloudflareFiles {
	redirects: string;
	overflow?: string;
	rules: string;
	ruleCount: number;
	lineCount: number; // exact (static) redirect lines; comment lines are not counted
	patternCount: number; // pattern (dynamic) redirect lines
	warnings: string[];
}

interface Rule {
	action: "redirect";
	action_parameters: { from_value: { status_code: 301; target_url: { value: string }; preserve_query_string: false } };
	description: string;
	enabled: true;
	expression: string;
}

function encodeByte(c: string): string {
	return [...new TextEncoder().encode(c)].map((b) => `%${b.toString(16).toUpperCase().padStart(2, "0")}`).join("");
}

/** Percent-encodes whitespace, control characters and non-ASCII; the rest stays as served. */
export function safePath(s: string): string {
	let out = "";
	for (const c of s) out += /[\s\x00-\x1f\x7f]/.test(c) || c > "\x7e" ? encodeByte(c) : c;
	return out;
}

const ruleString = (s: string): string => `"${s.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

// Query params are matched one by one on http.request.uri.args (values as sent, not
// decoded), so a request with extra params such as utm_source still matches.
function rule(host: string, old: string, target: string, planTarget?: string): Rule {
	const q = old.indexOf("?");
	const path = q === -1 ? old : old.slice(0, q);
	const parts = [`http.host eq ${ruleString(host)}`, `http.request.uri.path eq ${ruleString(path)}`];
	if (q !== -1) {
		for (const param of old.slice(q + 1).split("&").filter(Boolean)) {
			const eq = param.indexOf("=");
			const key = eq === -1 ? param : param.slice(0, eq);
			const value = eq === -1 ? "" : param.slice(eq + 1);
			parts.push(`any(http.request.uri.args[${ruleString(key)}][*] eq ${ruleString(value)})`);
		}
	}
	const expression = parts.join(" and ");
	return {
		action: "redirect",
		action_parameters: { from_value: { status_code: 301, target_url: { value: target }, preserve_query_string: false } },
		description: `Old URL ${old}${planTarget ? ` (${planTarget} target)` : ""}`.slice(0, 500),
		enabled: true,
		expression,
	};
}

/** _redirects text, any overflow, and the Single Redirect rules for one plan. */
export function toCloudflare(rows: Row[], options: CloudflareOptions): CloudflareFiles {
	const origin = options.origin.replace(/\/+$/, "");
	const lines: string[] = [];
	const rules: Rule[] = [];
	const unsafe: string[] = [];
	const answered = new Set(options.answered ?? []);
	for (const r of rows) {
		if (r.status !== "301" || !r.old.startsWith("/")) continue;
		if (answered.has(r.old)) continue;
		if (!isSiteRelative(r.new)) {
			unsafe.push(r.old);
			continue;
		}
		const old = safePath(r.old);
		const target = safePath(r.new);
		const line = `${old} ${target} 301`;
		if (old.includes("?") || /[*:]/.test(old) || /[*:]/.test(target) || line.length >= LINE_LIMIT) rules.push(rule(options.host, old, `${origin}${target}`, options.target));
		else lines.push(line);
	}
	const warnings: string[] = [];
	if (unsafe.length) warnings.push(`Left out ${unsafe.length} redirects whose new path is not on the site: ${unsafe.join(", ")}.`);
	const kept = lines.slice(0, STATIC_LIMIT);
	const extra = lines.slice(STATIC_LIMIT);
	if (extra.length) warnings.push(`Cloudflare reads only ${STATIC_LIMIT.toLocaleString("en-US")} static lines from _redirects; the other ${extra.length.toLocaleString("en-US")} are in _redirects.overflow. Add them as a Bulk Redirect list in the Cloudflare dashboard.`);
	if (rules.length > RULES_MAX) warnings.push(`cloudflare-rules.json has ${rules.length} Single Redirect rules, more than any Cloudflare plan up to Business (${RULES_MAX}) allows, so use query-redirects.json with its handler.`);
	else if (rules.length > RULES_WARN) warnings.push(`cloudflare-rules.json has ${rules.length} Single Redirect rules; Cloudflare's Free plan allows ${RULES_WARN} (Pro 25, Business 50), so check your plan's limit before adding them, or use query-redirects.json with its handler, which has no limit.`);
	const text = (list: string[]): string => list.map((l) => `${l}\n`).join("");
	let head = options.target ? `# wp-redirect-plan for the ${options.target} target (${options.target === "emdash" ? "EmDash URL patterns: child pages at /<slug>, no trailing slash" : "the routes in model.json, nested pages kept"}).\n` : "";
	const handler = options.target === "emdash" ? "query-redirects.middleware.ts; keep the paths it names out of this file" : "query-redirects.worker.ts, which runs before this file";
	if (rules.length && options.handlerDefault) head += `# Default for the old query URLs: query-redirects.json with its handler (${handler}), since cloudflare-rules.json has ${rules.length} rules, more than the ${RULES_WARN} on Cloudflare's Free plan.\n# If you use the rules instead: ${PRECEDENCE}\n`;
	else if (rules.length) head += `# ${PRECEDENCE}\n# Or, with no rule limit, use query-redirects.json with its handler in place of the rules (${handler}).\n`;
	if (answered.size) head += `# Not in this file: ${[...answered].sort().join(", ")}. query-redirects.middleware.ts answers ${answered.size === 1 ? "it" : "them"}, with the old query URLs there. If you use the rules instead, add ${answered.size === 1 ? "its line" : "their lines"} here (see redirects.csv).\n`;
	const patterns = (options.patterns ?? []).filter(safeLine).slice(0, DYNAMIC_LIMIT);
	let tail = "";
	if (patterns.length) tail = `# Pattern lines: URL families the inventory cannot list in full. Cloudflare checks the exact lines above first.\n${text(patterns.map((p) => `${p.from} ${p.to} 301`))}`;
	const body = kept.length || patterns.length ? text(kept) + tail : "# Nothing to add: no old URL needs a redirect line here.\n";
	const out: CloudflareFiles = { redirects: head + body, rules: `${JSON.stringify({ rules }, null, "\t")}\n`, ruleCount: rules.length, lineCount: kept.length, patternCount: patterns.length, warnings };
	if (extra.length) out.overflow = text(extra);
	return out;
}
