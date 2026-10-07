/**
 * EPUB Canonical Fragment Identifiers (https://idpf.org/epub/linking/cfi/).
 *
 * Supports points and ranges, indirection (`!`), id assertions on steps, and character offsets.
 * Temporal/spatial offsets are parsed but ignored.
 */

export interface CfiStep {
	/** Even = element child (index/2), odd = text chunk between elements. */
	index: number;
	/** Optional id assertion. */
	id?: string;
	/** True when this step is preceded by `!` (crosses into a referenced document). */
	indirect?: boolean;
}

export interface CfiPath {
	steps: CfiStep[];
	/** Character offset into the text chunk addressed by the final (odd) step. */
	offset?: number;
	/** Text location assertion, e.g. `[yon,der]` – kept for round-tripping only. */
	textAssertion?: string;
}

export type Cfi =
	| { range: false; path: CfiPath }
	| { range: true; parent: CfiStep[]; start: CfiPath; end: CfiPath };

const SPECIAL = /[\^\[\](),;=]/g;
export const escapeCfi = (s: string) => s.replace(SPECIAL, (c) => `^${c}`);

export class CfiParseError extends Error {}

/** Parse `epubcfi(...)` (the wrapper is optional). */
export function parseCfi(input: string): Cfi {
	let s = input.trim();
	const m = /^epubcfi\(([\s\S]*)\)$/.exec(s);
	if (m) s = m[1];
	const parts = splitTopLevel(s);
	if (parts.length === 1) return { range: false, path: parsePath(parts[0]) };
	if (parts.length === 3) {
		const parent = parsePath(parts[0]);
		if (parent.offset !== undefined) throw new CfiParseError('range parent must not have an offset');
		return { range: true, parent: parent.steps, start: parsePath(parts[1]), end: parsePath(parts[2]) };
	}
	throw new CfiParseError(`invalid CFI: ${input}`);
}

export function tryParseCfi(input: string): Cfi | null {
	try {
		return parseCfi(input);
	} catch {
		return null;
	}
}

/** Split on commas that are not escaped and not inside `[...]`. */
function splitTopLevel(s: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let cur = '';
	for (let i = 0; i < s.length; i++) {
		const c = s[i];
		if (c === '^') {
			cur += c + (s[++i] ?? '');
			continue;
		}
		if (c === '[') depth++;
		else if (c === ']') depth--;
		if (c === ',' && depth === 0) {
			out.push(cur);
			cur = '';
		} else cur += c;
	}
	out.push(cur);
	return out;
}

function parsePath(s: string): CfiPath {
	const path: CfiPath = { steps: [] };
	let i = 0;
	let indirect = false;
	const readInt = () => {
		const start = i;
		while (i < s.length && /[0-9]/.test(s[i])) i++;
		if (start === i) throw new CfiParseError(`expected integer at ${start} in "${s}"`);
		return parseInt(s.slice(start, i), 10);
	};
	const readFloat = () => {
		const start = i;
		while (i < s.length && /[0-9.]/.test(s[i])) i++;
		return parseFloat(s.slice(start, i));
	};
	const readAssertion = (): string | undefined => {
		if (s[i] !== '[') return undefined;
		i++;
		let out = '';
		while (i < s.length && s[i] !== ']') {
			if (s[i] === '^') i++;
			out += s[i++] ?? '';
		}
		if (s[i] !== ']') throw new CfiParseError('unterminated assertion');
		i++;
		return out;
	};
	while (i < s.length) {
		const c = s[i];
		if (c === '!') {
			indirect = true;
			i++;
		} else if (c === '/') {
			i++;
			const step: CfiStep = { index: readInt() };
			const a = readAssertion();
			if (a !== undefined) {
				const id = a.split(';')[0];
				if (id) step.id = id;
			}
			if (indirect) step.indirect = true;
			indirect = false;
			path.steps.push(step);
		} else if (c === ':') {
			i++;
			path.offset = readInt();
			const a = readAssertion();
			if (a !== undefined) path.textAssertion = a;
		} else if (c === '~') {
			i++;
			readFloat();
		} else if (c === '@') {
			i++;
			readFloat();
			if (s[i] === ':') {
				i++;
				readFloat();
			}
		} else if (c === '[') {
			readAssertion();
		} else if (/\s/.test(c)) {
			i++;
		} else throw new CfiParseError(`unexpected "${c}" at ${i} in "${s}"`);
	}
	if (path.steps.length === 0 && path.offset === undefined) throw new CfiParseError('empty path');
	return path;
}

function serializeSteps(steps: CfiStep[], assertions: boolean): string {
	return steps
		.map((st) => `${st.indirect ? '!' : ''}/${st.index}${assertions && st.id ? `[${escapeCfi(st.id)}]` : ''}`)
		.join('');
}

function serializePath(p: CfiPath, assertions: boolean): string {
	return serializeSteps(p.steps, assertions) + (p.offset !== undefined ? `:${p.offset}` : '');
}

export interface SerializeOptions {
	/** Include `[id]` assertions. They make CFIs more robust but contain `[` `]`, which break wikilinks. Default true. */
	assertions?: boolean;
	/** Wrap in `epubcfi(...)`. Default true. */
	wrap?: boolean;
}

export function serializeCfi(cfi: Cfi, opts: SerializeOptions = {}): string {
	const a = opts.assertions ?? true;
	const body = cfi.range
		? `${serializeSteps(cfi.parent, a)},${serializePath(cfi.start, a)},${serializePath(cfi.end, a)}`
		: serializePath(cfi.path, a);
	return opts.wrap === false ? body : `epubcfi(${body})`;
}

/** Absolute start / end paths of a CFI (identical for points). */
export function cfiStart(cfi: Cfi): CfiPath {
	return cfi.range ? { ...cfi.start, steps: joinSteps(cfi.parent, cfi.start.steps) } : cfi.path;
}
export function cfiEnd(cfi: Cfi): CfiPath {
	return cfi.range ? { ...cfi.end, steps: joinSteps(cfi.parent, cfi.end.steps) } : cfi.path;
}

function joinSteps(a: CfiStep[], b: CfiStep[]): CfiStep[] {
	return [...a, ...b];
}

/** Build a CFI from two absolute paths, factoring out the common parent. */
export function makeRangeCfi(start: CfiPath, end: CfiPath): Cfi {
	const max = Math.min(start.steps.length, end.steps.length) - 1;
	let n = 0;
	while (
		n < max &&
		start.steps[n].index === end.steps[n].index &&
		!!start.steps[n].indirect === !!end.steps[n].indirect
	)
		n++;
	if (comparePaths(start, end) === 0) return { range: false, path: start };
	return {
		range: true,
		parent: start.steps.slice(0, n),
		start: { steps: start.steps.slice(n), offset: start.offset },
		end: { steps: end.steps.slice(n), offset: end.offset },
	};
}

export function comparePaths(a: CfiPath, b: CfiPath): number {
	const n = Math.min(a.steps.length, b.steps.length);
	for (let i = 0; i < n; i++) {
		const d = a.steps[i].index - b.steps[i].index;
		if (d !== 0) return d < 0 ? -1 : 1;
	}
	if (a.steps.length !== b.steps.length) return a.steps.length < b.steps.length ? -1 : 1;
	const d = (a.offset ?? 0) - (b.offset ?? 0);
	return d === 0 ? 0 : d < 0 ? -1 : 1;
}

/** Order CFIs by start, then by end. Accepts strings or parsed CFIs. */
export function compareCfi(a: Cfi | string, b: Cfi | string): number {
	const pa = typeof a === 'string' ? parseCfi(a) : a;
	const pb = typeof b === 'string' ? parseCfi(b) : b;
	return comparePaths(cfiStart(pa), cfiStart(pb)) || comparePaths(cfiEnd(pa), cfiEnd(pb));
}

/** Split absolute steps at the first indirection: package-document steps and content-document steps. */
export function splitIndirection(steps: CfiStep[]): { outer: CfiStep[]; inner: CfiStep[] } {
	const i = steps.findIndex((s) => s.indirect);
	if (i === -1) return { outer: steps, inner: [] };
	return { outer: steps.slice(0, i), inner: steps.slice(i).map((s, j) => (j === 0 ? { ...s, indirect: false } : s)) };
}

// ---------------------------------------------------------------------------
// DOM mapping
// ---------------------------------------------------------------------------

const isText = (n: Node): n is CharacterData => n.nodeType === 3 || n.nodeType === 4; // TEXT / CDATA
const isElement = (n: Node): n is Element => n.nodeType === 1;

/** Steps from `root` (exclusive) down to element `el` (inclusive). */
export function elementSteps(root: Node, el: Element): CfiStep[] {
	const steps: CfiStep[] = [];
	let cur: Element | null = el;
	while (cur && cur !== root) {
		const parent: Node | null = cur.parentNode;
		if (!parent) throw new Error('element is not inside root');
		let idx = 0;
		for (let c = parent.firstChild; c; c = c.nextSibling) {
			if (isElement(c)) idx++;
			if (c === cur) break;
		}
		const step: CfiStep = { index: idx * 2 };
		if (cur.id) step.id = cur.id;
		steps.unshift(step);
		cur = parent as Element;
	}
	if (cur !== root) throw new Error('element is not inside root');
	return steps;
}

/** Convert a DOM boundary point to a CFI path relative to `root`. Always ends on a text-chunk (odd) step. */
export function pointToPath(root: Node, container: Node, offset: number): CfiPath {
	let parent: Node;
	let elCount = 0;
	let textOff = 0;
	if (isText(container)) {
		parent = container.parentNode!;
		for (let n = parent.firstChild; n && n !== container; n = n.nextSibling) {
			if (isElement(n)) {
				elCount++;
				textOff = 0;
			} else if (isText(n)) textOff += n.length;
		}
		textOff += offset;
	} else {
		parent = container;
		let i = 0;
		for (let n = parent.firstChild; n && i < offset; n = n.nextSibling, i++) {
			if (isElement(n)) {
				elCount++;
				textOff = 0;
			} else if (isText(n)) textOff += n.length;
		}
	}
	const steps = parent === root ? [] : elementSteps(root, parent as Element);
	steps.push({ index: elCount * 2 + 1 });
	return { steps, offset: textOff };
}

export interface ResolvedPoint {
	container: Node;
	offset: number;
	/** Set when the path ended on an element step (no text offset). */
	element?: Element;
}

function findById(root: Node, id: string): Element | null {
	const el = (root as Element).querySelector?.(`[id="${id.replace(/["\\]/g, '\\$&')}"]`);
	return el ?? null;
}

/** Resolve CFI steps (relative to `root`) to a DOM boundary point. */
export function resolvePath(root: Node, steps: CfiStep[], offset?: number): ResolvedPoint | null {
	let node: Node = root;
	for (let i = 0; i < steps.length; i++) {
		const step = steps[i];
		if (step.index % 2 === 0) {
			let target: Element | null = null;
			let n = 0;
			for (let c = node.firstChild; c; c = c.nextSibling) {
				if (isElement(c) && ++n === step.index / 2) {
					target = c;
					break;
				}
			}
			if (step.id && target?.id !== step.id) target = findById(root, step.id) ?? target;
			if (!target) return null;
			node = target;
		} else {
			return resolveTextChunk(node, (step.index - 1) / 2, offset ?? 0);
		}
	}
	if (node === root) return { container: root, offset: 0 };
	const parent = node.parentNode!;
	return { container: parent, offset: Array.prototype.indexOf.call(parent.childNodes, node), element: node as Element };
}

function resolveTextChunk(parent: Node, chunk: number, offset: number): ResolvedPoint {
	let elSeen = 0;
	let childIdx = 0;
	let lastText: CharacterData | null = null;
	let chunkStart = -1;
	let c = parent.firstChild;
	for (; c; c = c.nextSibling, childIdx++) {
		if (isElement(c)) {
			if (elSeen === chunk) break;
			elSeen++;
			continue;
		}
		if (elSeen !== chunk) continue;
		if (chunkStart === -1) chunkStart = childIdx;
		if (isText(c)) {
			if (offset <= c.length) return { container: c, offset };
			offset -= c.length;
			lastText = c;
		}
	}
	if (lastText) return { container: lastText, offset: lastText.length };
	return { container: parent, offset: chunkStart === -1 ? childIdx : chunkStart };
}
