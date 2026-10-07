/**
 * A flattened, normalized view of the rendered book text with a mapping back to DOM positions.
 *
 * - `text`: whitespace collapsed, block boundaries become a single space.
 * - `folded`: `text` lower-cased with diacritics removed and typographic quotes simplified; used for
 *   case/diacritic-insensitive search and Text Fragment matching.
 */

const BLOCK = new Set(
	'address article aside blockquote br dd details dialog div dl dt fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hgroup hr li main nav ol p pre section summary table tbody td tfoot th thead tr ul img'.split(
		' ',
	),
);
const SKIP = new Set(['script', 'style', 'template', 'head', 'title', 'noscript']);

const QUOTES: Record<string, string> = {
	'‘': "'",
	'’': "'",
	'‚': "'",
	'‛': "'",
	'“': '"',
	'”': '"',
	'„': '"',
	' ': ' ',
	'­': '',
};

export function foldChar(c: string): string {
	const q = QUOTES[c];
	if (q !== undefined) return q;
	if (c.charCodeAt(0) < 128) return c.toLowerCase();
	return c.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

export function foldString(s: string): string {
	let out = '';
	let space = false;
	for (const c of s) {
		if (/\s/.test(c)) {
			if (!space && out) out += ' ';
			space = true;
			continue;
		}
		const f = foldChar(c);
		out += f;
		if (f) space = false;
	}
	return out.trimEnd();
}

export interface Section {
	start: number;
	spineIndex: number;
}

export class TextIndex {
	text = '';
	private nodes: Text[] = [];
	private nodeStarts: number[] = [];
	private nodeIndex = new Map<Node, number>();
	/** normalized index → raw global offset (start of node + offset). */
	private rawMap!: Int32Array;
	private _folded: string | null = null;
	private foldMap: Int32Array | null = null;
	readonly sections: Section[] = [];

	constructor(readonly root: Element) {
		this.build();
	}

	private build(): void {
		const chunks: string[] = [];
		const map: number[] = [];
		let raw = 0;
		let lastSpace = true;
		let pendingBreak = false;
		let len = 0;
		const emit = (c: string, rawPos: number) => {
			chunks.push(c);
			map.push(rawPos);
			len++;
		};
		const walk = (el: Element) => {
			for (let n = el.firstChild; n; n = n.nextSibling) {
				if (n.nodeType === 3 || n.nodeType === 4) {
					const t = n as Text;
					this.nodeIndex.set(t, this.nodes.length);
					this.nodes.push(t);
					this.nodeStarts.push(raw);
					const data = t.data;
					for (let i = 0; i < data.length; i++) {
						const c = data[i];
						if (c === ' ' || c === '\n' || c === '\t' || c === '\r' || c === '\f' || c === ' ') {
							if (!lastSpace) {
								emit(' ', raw + i);
								lastSpace = true;
							}
						} else {
							if (pendingBreak && !lastSpace) emit(' ', raw + i);
							pendingBreak = false;
							emit(c, raw + i);
							lastSpace = false;
						}
					}
					raw += data.length;
				} else if (n.nodeType === 1) {
					const e = n as Element;
					const name = e.localName;
					if (SKIP.has(name)) continue;
					const spine = e.getAttribute('data-epp-spine');
					if (spine !== null) {
						if (!lastSpace) emit(' ', raw);
						lastSpace = true;
						this.sections.push({ start: len, spineIndex: Number(spine) });
					}
					const block = BLOCK.has(name);
					if (block) pendingBreak = true;
					walk(e);
					if (block) pendingBreak = true;
				}
			}
		};
		walk(this.root);
		this.text = chunks.join('');
		this.rawMap = Int32Array.from(map);
	}

	get folded(): string {
		if (this._folded === null) {
			const out: string[] = [];
			const fmap: number[] = [];
			const t = this.text;
			for (let i = 0; i < t.length; i++) {
				let c = t[i];
				// keep surrogate pairs together
				const code = t.charCodeAt(i);
				if (code >= 0xd800 && code <= 0xdbff && i + 1 < t.length) c = t[i] + t[i + 1];
				const f = foldChar(c);
				for (let k = 0; k < f.length; k++) {
					out.push(f[k]);
					fmap.push(i);
				}
				if (c.length === 2) i++;
			}
			this._folded = out.join('');
			this.foldMap = Int32Array.from(fmap);
		}
		return this._folded;
	}

	/** Convert a [start, end) range in `folded` coordinates to `text` coordinates. */
	foldedToText(start: number, end: number): [number, number] {
		void this.folded;
		const m = this.foldMap!;
		return [m[start], end > start ? m[end - 1] + 1 : m[start]];
	}

	/** Convert a [start, end) range in `text` coordinates to `folded` coordinates. */
	textToFolded(start: number, end: number): [number, number] {
		void this.folded;
		const m = this.foldMap!;
		return [lowerBound(m, start), lowerBound(m, end)];
	}

	private rawToPoint(raw: number, preferEnd: boolean): { node: Text; offset: number } {
		// last node whose start <= raw (or < raw when preferring the end of the previous node)
		let lo = 0;
		let hi = this.nodeStarts.length - 1;
		while (lo < hi) {
			const mid = (lo + hi + 1) >> 1;
			const s = this.nodeStarts[mid];
			if (preferEnd ? s < raw : s <= raw) lo = mid;
			else hi = mid - 1;
		}
		const node = this.nodes[lo];
		return { node, offset: Math.min(raw - this.nodeStarts[lo], node.length) };
	}

	/** DOM range for a [start, end) range in `text` coordinates. */
	toRange(start: number, end: number): Range {
		const range = this.root.ownerDocument.createRange();
		const s = this.rawToPoint(this.rawMap[Math.min(start, this.rawMap.length - 1)], false);
		const e = end > start ? this.rawToPoint(this.rawMap[end - 1] + 1, true) : s;
		range.setStart(s.node, s.offset);
		range.setEnd(e.node, e.offset);
		return range;
	}

	/** Map a DOM boundary point to a `text` offset (first normalized char at or after the point). */
	pointToOffset(container: Node, offset: number): number {
		let raw: number;
		const idx = this.nodeIndex.get(container);
		if (idx !== undefined) raw = this.nodeStarts[idx] + offset;
		else {
			// element boundary: find the first text node at or after the point
			const doc = this.root.ownerDocument;
			const walker = doc.createTreeWalker(this.root, NodeFilter.SHOW_TEXT);
			const child = container.childNodes[offset];
			let target: Node | null;
			if (child) {
				walker.currentNode = child;
				target = child.nodeType === 3 ? child : walker.nextNode();
			} else {
				walker.currentNode = container;
				// skip past container's subtree
				let n: Node | null = container;
				while (n && !n.nextSibling) n = n.parentNode;
				target = n?.nextSibling ?? null;
				if (target && target.nodeType !== 3) {
					walker.currentNode = target;
					target = walker.nextNode();
				}
			}
			while (target && !this.nodeIndex.has(target)) target = walker.nextNode();
			raw = target ? this.nodeStarts[this.nodeIndex.get(target)!] : Number.MAX_SAFE_INTEGER;
		}
		return lowerBound(this.rawMap, raw);
	}

	rangeToOffsets(range: Range): [number, number] {
		const s = this.pointToOffset(range.startContainer, range.startOffset);
		const e = this.pointToOffset(range.endContainer, range.endOffset);
		return [s, Math.max(s, e)];
	}

	spineIndexAt(offset: number): number {
		let lo = 0;
		let hi = this.sections.length - 1;
		if (hi < 0) return 0;
		while (lo < hi) {
			const mid = (lo + hi + 1) >> 1;
			if (this.sections[mid].start <= offset) lo = mid;
			else hi = mid - 1;
		}
		return this.sections[lo].spineIndex;
	}
}

/** First index i with arr[i] >= value. */
function lowerBound(arr: Int32Array, value: number): number {
	let lo = 0;
	let hi = arr.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (arr[mid] < value) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}
