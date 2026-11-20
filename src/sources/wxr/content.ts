// Scans raw post content for shortcodes and block comments.
//
// - A shortcode is `[name ...]` or `[name]` where the name starts with a letter.
//   `[[name]]` is WordPress's escape and is skipped; closing tags `[/name]` are not counted.
//   The export cannot say which shortcodes are registered, so every one is listed.
// - A block is `<!-- wp:name -->` or `<!-- wp:ns/name ... /-->`; a bare name is `core/name`.

import type { Usage } from "../../contracts/inventory.ts";

const SHORTCODE = /(^|[^[])\[([A-Za-z][\w-]*)(?=[\s\]/])/g;
const BLOCK = /<!--\s+wp:([a-z][a-z0-9_-]*(?:\/[a-z][a-z0-9_-]*)?)[\s/]/g;

export interface ContentScan {
	shortcodes: Set<string>;
	blocks: Set<string>;
}

export function scanContent(text: string, into: ContentScan = { shortcodes: new Set(), blocks: new Set() }): ContentScan {
	if (text.includes("[")) {
		for (const m of text.matchAll(SHORTCODE)) into.shortcodes.add(m[2] as string);
	}
	if (text.includes("<!--")) {
		for (const m of text.matchAll(BLOCK)) {
			const name = m[1] as string;
			into.blocks.add(name.includes("/") ? name : `core/${name}`);
		}
	}
	return into;
}

const SAMPLE_CAP = 3;

/** Counts names across items: one count per item that uses the name, a few sample URLs. */
export class UsageCounter {
	private readonly counts = new Map<string, { count: number; samples: string[] }>();

	add(names: Iterable<string>, sample: string | undefined): void {
		for (const name of names) {
			let u = this.counts.get(name);
			if (!u) this.counts.set(name, (u = { count: 0, samples: [] }));
			u.count++;
			if (sample !== undefined && u.samples.length < SAMPLE_CAP && !u.samples.includes(sample)) u.samples.push(sample);
		}
	}

	list(): Usage[] {
		return [...this.counts].map(([name, u]) => ({ name, count: u.count, samples: u.samples }));
	}
}
