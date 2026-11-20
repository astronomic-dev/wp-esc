// Bounds every run of text, CDATA and comment before the XML parser sees it.
//
// saxes keeps a whole text run or CDATA section in one string until it ends, so one
// 200 MB value would be held whole. This pass sits in front of the parser: past
// `max` characters a run's content is dropped (its end marker is kept, so the XML
// stays well formed) and a CUT marker is handed back at the place it happened.
// A tag, declaration or processing instruction longer than `max` cannot be cut safely;
// the pass stops with an error instead. A DOCTYPE stops it at once: WordPress never
// writes one, and its internal subset (with `>` inside) would otherwise reach the parser whole.

export const CUT = Symbol("cut");
export type Piece = string | typeof CUT;

type State = "text" | "lt" | "bang" | "tag" | "quote" | "cdata" | "comment" | "pi";
const CDATA_OPEN = "<![CDATA[";
const COMMENT_OPEN = "<!--";
const DOCTYPE_OPEN = "<!DOCTYPE";

export class RunLimiter {
	private state: State = "text";
	private run = 0; // characters in the current run
	private dropping = false;
	private prefix = ""; // markup read since "<", until its kind is known
	private quote = "";
	private carry = ""; // the last characters of a CDATA or comment run, to find an end marker split across chunks
	/** Set when a tag ran past the limit or a DOCTYPE was found; nothing more should be parsed. */
	error?: string;
	/** The input has a DOCTYPE. */
	doctype = false;

	private readonly max: number;

	constructor(max: number) {
		this.max = max;
	}

	/** The pieces to hand the parser for one chunk, with CUT where a run was cut. */
	push(chunk: string): Piece[] {
		const out: Piece[] = [];
		let i = 0;
		const len = chunk.length;
		while (i < len && !this.error) {
			switch (this.state) {
				case "text": {
					let j = chunk.indexOf("<", i);
					if (j === -1) j = len;
					this.keep(out, chunk.slice(i, j), "text");
					if (j < len) {
						this.state = "lt";
						this.prefix = "<";
						this.run = 0;
						this.dropping = false;
						out.push("<");
					}
					i = j + 1;
					break;
				}
				case "lt":
				case "bang": {
					const c = chunk[i] as string;
					this.prefix += c;
					out.push(c);
					i++;
					const upper = this.prefix.toUpperCase();
					if (upper === DOCTYPE_OPEN) {
						this.doctype = true;
						this.error = "the export has a DOCTYPE";
						return out;
					}
					if (this.prefix === CDATA_OPEN) this.enter("cdata");
					else if (this.prefix === COMMENT_OPEN) this.enter("comment");
					else if (this.prefix === "<?") {
						this.enter("pi");
						this.run = 2;
					} else if (!CDATA_OPEN.startsWith(this.prefix) && !COMMENT_OPEN.startsWith(this.prefix) && !DOCTYPE_OPEN.startsWith(upper)) {
						// A tag, end tag, declaration or processing instruction.
						const run = this.prefix.length;
						this.enter("tag");
						this.run = run;
						if (c === '"' || c === "'") [this.state, this.quote] = ["quote", c];
						else if (c === ">") this.state = "text", this.run = 0;
					} else this.state = "bang";
					break;
				}
				case "tag":
				case "quote": {
					const re = this.state === "quote" ? (this.quote === '"' ? /"/g : /'/g) : /[>"']/g;
					re.lastIndex = i;
					const m = re.exec(chunk);
					const j = m ? m.index : len;
					this.run += j - i + (m ? 1 : 0);
					if (this.run > this.max) {
						this.error = `a tag, declaration or processing instruction is longer than ${this.max} characters`;
						return out;
					}
					out.push(chunk.slice(i, m ? j + 1 : len));
					i = m ? j + 1 : len;
					if (!m) break;
					const c = m[0];
					if (this.state === "quote") this.state = "tag";
					else if (c === ">") [this.state, this.run] = ["text", 0];
					else [this.state, this.quote] = ["quote", c];
					break;
				}
				case "pi": {
					// Ends at "?>", not at the first ">"; bounded as one run, never cut.
					const hay = this.carry + chunk.slice(i);
					const p = hay.indexOf("?>");
					const after = p === -1 ? len : i + p + 2 - this.carry.length;
					this.run += after - i;
					if (this.run > this.max) {
						this.error = `a tag, declaration or processing instruction is longer than ${this.max} characters`;
						return out;
					}
					out.push(chunk.slice(i, after));
					i = after;
					if (p === -1) this.carry = hay.slice(-1);
					else [this.state, this.run, this.carry] = ["text", 0, ""];
					break;
				}
				case "cdata":
				case "comment": {
					const end = this.state === "cdata" ? "]]>" : "-->";
					const hay = this.carry + chunk.slice(i);
					const p = hay.indexOf(end);
					if (p === -1) {
						const body = chunk.slice(i);
						this.keep(out, body, this.state);
						this.carry = hay.slice(-2);
						i = len;
						break;
					}
					const bodyEnd = i + Math.max(0, p - this.carry.length); // end of content in this chunk
					const after = i + p + 3 - this.carry.length; // just past the end marker
					this.keep(out, chunk.slice(i, bodyEnd), this.state);
					out.push(this.dropping ? end : chunk.slice(bodyEnd, after));
					this.carry = "";
					this.state = "text";
					this.run = 0;
					this.dropping = false;
					i = after;
					break;
				}
			}
		}
		return out;
	}

	private enter(s: State): void {
		this.state = s;
		this.prefix = "";
		this.run = 0;
		this.dropping = false;
		this.carry = "";
	}

	/** Passes run content on while under the limit; past it, drops the rest and marks the cut once. */
	private keep(out: Piece[], s: string, kind: State): void {
		if (s === "" || this.dropping) return;
		if (this.run + s.length <= this.max) {
			this.run += s.length;
			out.push(s);
			return;
		}
		let part = s.slice(0, this.max - this.run);
		if (kind === "text") {
			// Never end inside an entity reference such as "&amp;".
			const amp = part.lastIndexOf("&");
			if (amp !== -1 && part.indexOf(";", amp) === -1) part = part.slice(0, amp);
		}
		// "--" may not come before the comment's end marker.
		if (kind === "comment") while (part.endsWith("-")) part = part.slice(0, -1);
		if (part) out.push(part);
		this.run = this.max;
		this.dropping = true;
		out.push(CUT);
	}
}
