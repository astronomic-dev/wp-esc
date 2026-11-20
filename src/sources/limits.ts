// A budget shared by every paged list one reader makes (REST at level 1, the edit
// lists at level 3). Pages are reduced as they arrive, so what a run keeps grows
// with the items read; the budget bounds that and the bytes fetched.

export const MAX_LIST_ITEMS = 200_000;
export const MAX_LIST_BYTES = 512 * 1024 * 1024;

export interface ListBudget { maxItems: number; maxBytes: number; items: number; bytes: number }

export function newBudget(opts: { maxListItems?: number; maxListBytes?: number } = {}): ListBudget {
	return { maxItems: opts.maxListItems ?? MAX_LIST_ITEMS, maxBytes: opts.maxListBytes ?? MAX_LIST_BYTES, items: 0, bytes: 0 };
}

/** Counts one page's bytes. Returns the plain reason when the page would go over the cap. */
export function spendBytes(b: ListBudget, bytes: number): string | undefined {
	if (b.bytes + bytes > b.maxBytes) return `the cap of ${b.maxBytes} bytes for all lists was reached`;
	b.bytes += bytes;
	return undefined;
}

/** How many of `n` items fit; counts them. `reason` is set when some did not fit. */
export function spendItems(b: ListBudget, n: number): { take: number; reason?: string } {
	const take = Math.max(0, Math.min(n, b.maxItems - b.items));
	b.items += take;
	return take < n ? { take, reason: `the cap of ${b.maxItems} list items was reached` } : { take };
}

/** The most URLs one level 1 run adds that no list names (date archives, later list pages). */
export const MAX_DERIVED_URLS = 10_000;
/** The most later pages added for one list (/page/2/ and on). */
export const MAX_PAGES_PER_LIST = 500;
/** WordPress's default posts per page, used to guess how many pages a list has. */
export const DEFAULT_PER_PAGE = 10;
/** The most feed URLs one level 1 run adds (term, author and archive feeds; post feeds with plain links). */
export const MAX_DERIVED_FEEDS = 5_000;
/** The most draft, private and pending items kept per content type (titles and status only). */
export const MAX_UNPUBLISHED_PER_TYPE = 20;
