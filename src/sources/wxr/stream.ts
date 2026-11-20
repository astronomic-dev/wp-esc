// Streams a WXR file with saxes and hands over one small record at a time:
// the channel facts, each author, each term, and each item. Nothing else is kept,
// so memory stays flat however large the export is.
//
// Author records carry no name, login or email: the reader only counts them.
// Comments inside items are counted, then skipped whole (they hold commenter emails and addresses);
// only each comment's comment_approved flag is read. Only approved (1) and waiting (0) comments
// count; spam and trash are not real comments for a move, and the level 3 reader counts the same
// two (REST status approve + hold), so the two counts agree.

import { createReadStream } from "node:fs";
import { SaxesParser } from "saxes";
import { CUT, RunLimiter } from "./limit.ts";

export interface WxrChannel { title?: string; description?: string; language?: string; baseSiteUrl?: string; baseBlogUrl?: string; generator?: string; wxrVersion?: string }
export interface WxrTerm { taxonomy: string; id?: number; slug: string; parent?: string; name?: string }
export interface WxrMeta { key: string; value: string }
export interface WxrItem {
	title: string; link: string; guid: string; id: number; name: string; status: string; parent: number;
	menuOrder: number; type: string; content: string; excerpt: string; date: string;
	attachmentUrl: string; // attachments only: the upload file URL
	terms: { domain: string; slug: string }[]; meta: WxrMeta[];
	comments: number; // how many approved or waiting <wp:comment> the item holds (not spam or trash); their contents are never read
	pendingComments: number; // of those, how many wait for approval (comment_approved 0); only that flag is read
}

export interface WxrHandlers {
	channel?: (c: WxrChannel) => void;
	author?: () => void;
	term?: (t: WxrTerm) => void;
	item?: (i: WxrItem) => void;
}

/**
 * cut: values cut at maxValueChars or maxItemChars. stopped: the parse ended early on a limit.
 * doctype: the file has a DOCTYPE (WordPress never writes one) and was not read past it.
 */
export interface WxrStreamResult { errors: string[]; items: number; meta: number; bytes: number; cut: number; stopped: boolean; doctype: boolean; limits: WxrLimits }

/**
 * Limits in characters. Past `maxValueChars` a value (one field, or any text run in the
 * file) is cut; past `maxItemChars` an item's later values are dropped. The run goes on.
 */
export interface WxrLimits { maxValueChars: number; maxItemChars: number }
export const WXR_LIMITS: WxrLimits = { maxValueChars: 4 * 1024 * 1024, maxItemChars: 16 * 1024 * 1024 };

const CHANNEL_FIELDS: Record<string, keyof WxrChannel> = {
	title: "title", description: "description", language: "language", generator: "generator",
	"wp:base_site_url": "baseSiteUrl", "wp:base_blog_url": "baseBlogUrl", "wp:wxr_version": "wxrVersion",
};
const ITEM_TEXT = new Set(["title", "link", "guid", "wp:post_id", "wp:post_name", "wp:status", "wp:post_parent", "wp:menu_order",
	"wp:post_type", "content:encoded", "excerpt:encoded", "wp:post_date", "wp:attachment_url", "category", "wp:meta_key", "wp:meta_value"]);
const TERM_TEXT = new Set(["wp:term_id", "wp:term_taxonomy", "wp:term_slug", "wp:term_parent", "wp:term_name",
	"wp:category_nicename", "wp:category_parent", "wp:cat_name", "wp:tag_slug", "wp:tag_name"]);
const MAX_ERRORS = 5;

// Parser text is sliced from big input chunks; a kept slice would keep its whole chunk alive.
// `own` copies a short value into a string of its own, so memory stays flat.
const own = (s: string): string => (s.length > 0 && s.length < 8192 ? Buffer.from(s, "utf8").toString("utf8") : s);

const num = (s: string | undefined): number => {
	const n = Number.parseInt(s ?? "", 10);
	return Number.isFinite(n) ? n : 0;
};

function newItem(): WxrItem {
	return { title: "", link: "", guid: "", id: 0, name: "", status: "", parent: 0, menuOrder: 0, type: "", content: "", excerpt: "", date: "", attachmentUrl: "", terms: [], meta: [], comments: 0, pendingComments: 0 };
}

/** Parses WXR text arriving in chunks. */
export async function streamWxrChunks(chunks: AsyncIterable<string>, on: WxrHandlers, opts: Partial<WxrLimits> = {}): Promise<WxrStreamResult> {
	const limits: WxrLimits = { ...WXR_LIMITS, ...opts };
	const parser = new SaxesParser({ xmlns: false });
	const limiter = new RunLimiter(limits.maxValueChars);
	const errors: string[] = [];
	const stack: string[] = [];
	let text = "";
	let capture = false;
	const channel: WxrChannel = {};
	let item: WxrItem | undefined;
	let term: Record<string, string> | undefined;
	let termKind = "";
	let category: { domain: string; slug: string } | undefined;
	let meta: Partial<WxrMeta> | undefined;
	let inComment = 0;
	let approved: string | undefined; // the text of a top-level comment's comment_approved, while read
	let flag: string | undefined; // a top-level comment's comment_approved, once read
	let items = 0;
	let metaRows = 0;
	let bytes = 0;
	let cut = 0;
	let cutHere = false; // the run being read was cut before the parser saw all of it
	let full = false; // the value being read is at its limit; later text is dropped
	let itemChars = 0;

	parser.on("error", (e) => {
		if (errors.length < MAX_ERRORS) errors.push(e.message);
	});
	parser.on("opentag", (tag) => {
		const name = tag.name;
		stack.push(name);
		if (name === "wp:comment") {
			if (inComment === 0) flag = undefined;
			inComment++;
		}
		if (inComment) {
			if (inComment === 1 && name === "wp:comment_approved" && stack.at(-2) === "wp:comment") approved = "";
			return;
		}
		const parent = stack[stack.length - 2];
		if (name === "item") {
			item = newItem();
			itemChars = 0;
		}
		else if (!item && (name === "wp:category" || name === "wp:tag" || name === "wp:term") && parent === "channel") {
			term = {};
			termKind = name;
		} else if (item && name === "wp:postmeta") meta = {};
		else if (item && name === "category" && parent === "item") {
			const attrs = tag.attributes as Record<string, string>;
			category = { domain: attrs.domain ?? "", slug: attrs.nicename ?? "" };
		}
		text = "";
		cutHere = false;
		full = false;
		capture = item ? ITEM_TEXT.has(name) : term ? TERM_TEXT.has(name) : parent === "channel" && name in CHANNEL_FIELDS;
	});
	const onText = (t: string): void => {
		if (approved !== undefined) {
			if (approved.length < 16) approved += t;
			return;
		}
		if (!capture || inComment || full) return;
		const room = Math.min(limits.maxValueChars - text.length, item ? limits.maxItemChars - itemChars : Infinity);
		if (t.length <= room) {
			text += t;
			if (item) itemChars += t.length;
			return;
		}
		const part = t.slice(0, Math.max(0, room));
		text += part;
		if (item) itemChars += part.length;
		full = true;
		if (!cutHere) cut++;
		cutHere = true;
	};
	parser.on("text", onText);
	parser.on("cdata", onText);
	parser.on("closetag", (tag) => {
		const name = tag.name;
		stack.pop();
		if (name === "wp:comment") {
			inComment--;
			// Counted: approved (1) and waiting (0); a comment with no flag counts as approved.
			// Not counted: spam, trash and post-trashed.
			if (inComment === 0 && item && (flag === undefined || flag === "1" || flag === "0")) {
				item.comments++;
				if (flag === "0") item.pendingComments++;
			}
			return;
		}
		if (inComment) {
			if (approved !== undefined && name === "wp:comment_approved") {
				flag = approved.trim();
				approved = undefined;
			}
			return;
		}
		const value = own(text);
		text = "";
		capture = false;
		cutHere = false;
		full = false;
		if (item) {
			switch (name) {
				case "item":
					items++;
					on.item?.(item);
					item = undefined;
					return;
				case "title": if (stack.at(-1) === "item") item.title = value; return;
				case "link": item.link = value.trim(); return;
				case "guid": item.guid = value.trim(); return;
				case "wp:post_id": item.id = num(value); return;
				case "wp:post_name": item.name = value.trim(); return;
				case "wp:status": item.status = value.trim(); return;
				case "wp:post_parent": item.parent = num(value); return;
				case "wp:menu_order": item.menuOrder = num(value); return;
				case "wp:post_type": item.type = value.trim(); return;
				case "wp:post_date": item.date = value.trim(); return;
				case "wp:attachment_url": item.attachmentUrl = value.trim(); return;
				case "content:encoded": item.content = value; return;
				case "excerpt:encoded": item.excerpt = value; return;
				case "category":
					if (category) item.terms.push(category);
					category = undefined;
					return;
				case "wp:meta_key": if (meta) meta.key = value; return;
				case "wp:meta_value": if (meta) meta.value = value; return;
				case "wp:postmeta":
					if (meta?.key !== undefined) {
						item.meta.push({ key: meta.key, value: meta.value ?? "" });
						metaRows++;
					}
					meta = undefined;
					return;
			}
			return;
		}
		if (term) {
			if (name === termKind) {
				const taxonomy = termKind === "wp:category" ? "category" : termKind === "wp:tag" ? "post_tag" : term["wp:term_taxonomy"] ?? "";
				const slug = term["wp:term_slug"] ?? term["wp:category_nicename"] ?? term["wp:tag_slug"] ?? "";
				const parent = term["wp:term_parent"] ?? term["wp:category_parent"];
				const id = term["wp:term_id"] ? num(term["wp:term_id"]) : undefined;
				const out: WxrTerm = { taxonomy, slug };
				if (id) out.id = id;
				if (parent) out.parent = parent;
				const label = term["wp:term_name"] ?? term["wp:cat_name"] ?? term["wp:tag_name"];
				if (label) out.name = label;
				if (taxonomy && slug) on.term?.(out);
				term = undefined;
			} else term[name] = value.trim();
			return;
		}
		if (name === "wp:author") {
			on.author?.();
			return;
		}
		const key = CHANNEL_FIELDS[name];
		if (key && stack.at(-1) === "channel") channel[key] = value.trim();
	});

	for await (const chunk of chunks) {
		bytes += Buffer.byteLength(chunk);
		for (const piece of limiter.push(chunk)) {
			if (piece === CUT) {
				if (!cutHere) cut++;
				cutHere = true;
			}
			else parser.write(piece);
		}
		if (limiter.error) {
			errors.unshift(limiter.error);
			break;
		}
	}
	if (!limiter.error) parser.close();
	on.channel?.(channel);
	return { errors, items, meta: metaRows, bytes, cut, stopped: limiter.error !== undefined, doctype: limiter.doctype, limits };
}

/** Parses a WXR file from disk, streaming it. */
export function streamWxrFile(file: string, on: WxrHandlers, opts: Partial<WxrLimits> = {}): Promise<WxrStreamResult> {
	return streamWxrChunks(createReadStream(file, { encoding: "utf8", highWaterMark: 1 << 16 }) as AsyncIterable<string>, on, opts);
}
