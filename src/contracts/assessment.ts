// The assessment contract: one scored finding per part of the move.
// Frozen after Chunk 0a. schema/assessment.schema.json mirrors it; a test keeps them in step.
//
// `themes` is left out when the user turns theme matches off. It is the string
// "none-fit" when no listed theme fits. Theme order is rank: best first.
// Links are plain links, never affiliate links.

export const ASSESSMENT_VERSION = 1;

export type Score = "easy" | "some-work" | "hard" | "blocker";
export type StoreKind = "digital" | "physical" | "buy-button" | "ready-made";

export interface Assessment {
	version: typeof ASSESSMENT_VERSION;
	findings: Finding[];
	blockers: string[]; // areas of the findings scored "blocker"; always present, [] when none
	storePaths?: StorePath[];
	themes?: ThemeMatch[] | "none-fit";
}

export interface Finding {
	area: string; // for example "posts", "fields", "builders", "shortcodes", "store", "hidden-types"
	score: Score;
	reason: string;
	next: string;
	count?: number; // how many items the finding covers, for example builder pages
	items?: string[]; // what it covers, for example unknown shortcode names
}

export interface StorePath { kind: StoreKind; title: string; reason: string; links: Link[] }
export interface Link { label: string; url: string }
export interface ThemeMatch { slug: string; name: string; reason: string; url: string }
