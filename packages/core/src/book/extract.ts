import { elementSteps, makeRangeCfi, pointToPath, serializeCfi, type CfiStep } from '../locators/cfi';
import { BLOCK, SKIP } from 'file-plus-plus/core';
import type { EpubBook, SpineItem } from './epub';
import { children } from './xml';

/** The plain text of one spine item. */
export interface TextSection {
	spineIndex: number;
	href: string;
	/** Whitespace collapsed; block boundaries become `blockSeparator`, `<br>` a line break. */
	text: string;
}

export interface ExtractOptions {
	/** Inserted between blocks (paragraphs, headings, list items…). Default `"\n\n"`. */
	blockSeparator?: string;
}

export interface CfiOptions {
	/** Include `[id]` assertions (default false, like the reader: they break wikilinks). */
	assertions?: boolean;
}

interface SectionMap {
	item: SpineItem;
	body: Element;
	bodyStep: CfiStep;
	nodes: CharacterData[];
	/** Per UTF-16 unit of the section text: index into `nodes` and offset inside that node. */
	node: Int32Array;
	offset: Int32Array;
}

/**
 * A book's text without rendering it, for other tools to search (e.g. for Bible references), with a
 * way back from text offsets to CFIs. The CFIs are the ones the reader produces for the same text,
 * because rendering keeps the documents' structure.
 */
export class BookText {
	readonly sections: TextSection[] = [];
	private maps: SectionMap[] = [];

	private constructor(private readonly book: EpubBook) {}

	/** Extract every spine item, yielding to the event loop between items now and then. */
	static async extract(book: EpubBook, opts: ExtractOptions = {}): Promise<BookText> {
		const out = new BookText(book);
		let last = performance.now();
		for (const item of book.spine) {
			try {
				out.add(item, opts.blockSeparator ?? '\n\n');
			} catch (e) {
				console.warn(`[epub-pp] could not extract ${item.href}`, e);
			}
			if (performance.now() - last > 30) {
				await new Promise((r) => setTimeout(r, 0));
				last = performance.now();
			}
		}
		return out;
	}

	private add(item: SpineItem, separator: string): void {
		const doc = this.book.loadDocument(item);
		const html = doc.documentElement;
		const body = children(html, 'body')[0] ?? html;
		const bodyStep = body === html ? { index: 4 } : elementSteps(html, body)[0];
		const nodes: CharacterData[] = [];
		const codes: number[] = [];
		const nodeMap: number[] = [];
		const offMap: number[] = [];
		let pendingSpace = false;
		let pendingBreak = '';
		const emit = (s: string, n: number, o: number) => {
			for (let i = 0; i < s.length; i++) {
				codes.push(s.charCodeAt(i));
				nodeMap.push(n);
				offMap.push(o);
			}
		};
		const walk = (el: Element) => {
			for (let n = el.firstChild; n; n = n.nextSibling) {
				if (n.nodeType === 3 || n.nodeType === 4) {
					const t = n as CharacterData;
					const ni = nodes.push(t) - 1;
					const data = t.data;
					for (let i = 0; i < data.length; i++) {
						const c = data.charCodeAt(i);
						if (c === 32 || c === 10 || c === 9 || c === 13 || c === 12 || c === 160) {
							pendingSpace = true;
							continue;
						}
						if (codes.length) {
							if (pendingBreak) emit(pendingBreak, ni, i);
							else if (pendingSpace) emit(' ', ni, i);
						}
						pendingBreak = '';
						pendingSpace = false;
						codes.push(c);
						nodeMap.push(ni);
						offMap.push(i);
					}
				} else if (n.nodeType === 1) {
					const e = n as Element;
					const name = e.localName;
					if (SKIP.has(name)) continue;
					if (name === 'br') {
						if (pendingBreak !== separator) pendingBreak = '\n';
						continue;
					}
					const block = BLOCK.has(name);
					if (block) pendingBreak = separator;
					walk(e);
					if (block) pendingBreak = separator;
				}
			}
		};
		walk(body);
		let text = '';
		for (let i = 0; i < codes.length; i += 8192) text += String.fromCharCode(...codes.slice(i, i + 8192));
		this.sections.push({ spineIndex: item.index, href: item.href, text });
		this.maps.push({ item, body, bodyStep, nodes, node: Int32Array.from(nodeMap), offset: Int32Array.from(offMap) });
	}

	/** The section of a spine item, if it could be extracted. */
	section(spineIndex: number): TextSection | undefined {
		return this.sections.find((s) => s.spineIndex === spineIndex);
	}

	/** A range CFI for `[start, end)` (UTF-16 offsets) in a section's text, or null when out of range. */
	cfi(spineIndex: number, start: number, end: number, opts: CfiOptions = {}): string | null {
		const m = this.maps.find((x) => x.item.index === spineIndex);
		if (!m || start < 0 || end <= start || end > m.node.length) return null;
		// Separators map to the character after them; skip any at the edges.
		const text = this.section(spineIndex)!.text;
		while (start < end && /\s/.test(text[start])) start++;
		while (end > start && /\s/.test(text[end - 1])) end--;
		if (start === end) return null;
		const path = (node: number, offset: number) => {
			const inner = pointToPath(m.body, m.nodes[node], offset);
			return { steps: [...m.item.cfiSteps.map((s) => ({ ...s })), { ...m.bodyStep, indirect: true }, ...inner.steps], offset: inner.offset };
		};
		const from = path(m.node[start], m.offset[start]);
		const to = path(m.node[end - 1], m.offset[end - 1] + 1);
		return serializeCfi(makeRangeCfi(from, to), { assertions: opts.assertions ?? false });
	}
}
