// redirects.csv: one row per old URL, for a person to read and fix. RFC 4180: fields with a
// comma, quote, CR or LF are quoted, quotes are doubled, and records end with CRLF.

import type { Row } from "./plan.ts";

const HEADER = ["old", "new", "status", "kind", "note"];

function field(value: string): string {
	return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/** The plan as CSV text. Rows keep the plan's order. With `target`, a last column names it. */
export function toCsv(rows: Row[], target?: string): string {
	const lines = target ? [[...HEADER, "target"], ...rows.map((r) => [r.old, r.new, r.status, r.kind, r.note, target])] : [HEADER, ...rows.map((r) => [r.old, r.new, r.status, r.kind, r.note])];
	return lines.map((cells) => `${cells.map(field).join(",")}\r\n`).join("");
}
