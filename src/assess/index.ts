// wp-assess: inventory.json in, assessment.json out.
// The rules score each part of the move; the theme match is optional.

import type { Inventory } from "../contracts/inventory.ts";
import type { Model } from "../contracts/model.ts";
import { propose } from "../model/propose.ts";
import { ASSESSMENT_VERSION, type Assessment } from "../contracts/assessment.ts";
import { canonical } from "../contracts/write.ts";
import { RULES, storePaths } from "./rules.ts";
import { loadThemes, matchThemes, type ThemeEntry } from "./themes.ts";

export { RULES } from "./rules.ts";
export { loadThemes, matchThemes } from "./themes.ts";

export interface AssessOptions {
	themes?: boolean; // false leaves `themes` out (the --no-themes flag)
	catalog?: ThemeEntry[]; // the themes to match against; data/themes.json by default
	model?: Model; // the content model the move maps to; proposed from the inventory when left out
}

/** Scores the move. Same inventory, same assessment. */
export function assess(input: Inventory, options: AssessOptions = {}): Assessment {
	// Sort the inventory first, so equal facts in any order give the same reasons.
	const inv = canonical("inventory", input);
	const model = options.model ?? propose(inv);
	const findings = RULES.flatMap((rule) => rule.run(inv, { model }));
	const blockers = [...new Set(findings.filter((f) => f.score === "blocker").map((f) => f.area))];
	const out: Assessment = { version: ASSESSMENT_VERSION, findings, blockers };
	const paths = storePaths(inv);
	if (paths) out.storePaths = paths;
	if (options.themes !== false) out.themes = matchThemes(inv, options.catalog ?? loadThemes());
	return canonical("assessment", out);
}
