/** What the book search asks an engine, and what it gets back (no Obsidian imports: tested directly). */

export type GrepMode = 'plaintext' | 'regex' | 'fuzzy';
export type Casing = 'smart' | 'sensitive' | 'insensitive';

/** fff-epub's `GrepOptions`, as its JSON has them */
export interface GrepOptions {
	mode: GrepMode;
	casing: Casing;
	/** `'` `"` `-` match curly quotes and dashes (plain text) */
	fold_punctuation: boolean;
	whole_word: boolean;
	/** 0: no limit */
	max_matches_per_book: number;
	before_context: number;
	after_context: number;
}

export const DEFAULT_GREP: GrepOptions = {
	mode: 'plaintext',
	casing: 'smart',
	fold_punctuation: true,
	whole_word: false,
	max_matches_per_book: 0,
	before_context: 0,
	after_context: 0,
};

/** Which books a search covers: ids are vault paths */
export interface Scope {
	/** Only these books */
	books?: string[];
	/** Only books under these folders (`Library/`) */
	folders?: string[];
	/** Only books whose title, author, or path has each of these words */
	booksQuery?: string;
}

export interface GrepRequest {
	pattern: string;
	options: GrepOptions;
	scope: Scope;
	/** Where to resume: 0, then the last page's `next` */
	offset: number;
	/** About how many matches a page has (it ends with a whole book) */
	pageLimit: number;
}

/** A match, the same from either engine; offsets are UTF-16 (JavaScript's) */
export interface Hit {
	/** The book's vault path */
	book: string;
	title: string;
	cfi: string;
	chapter: string | null;
	/** 1-based line (paragraph) of the book's text, and UTF-16 column in it */
	line: number;
	column: number;
	/** The paragraph it is in */
	lineText: string;
	/** The matched parts of `lineText` */
	ranges: [number, number][];
	/** Fuzzy mode's score */
	score: number | null;
	before: string[];
	after: string[];
}

export interface GrepPage {
	hits: Hit[];
	booksSearched: number;
	booksWithMatches: number;
	totalBooks: number;
	/** The offset of the next page, or 0 when every book has been searched */
	next: number;
	/** A newer search stopped this one */
	aborted: boolean;
	errors: string[];
	ms: number;
}

export interface BookInfo {
	/** Its vault path */
	id: string;
	title: string;
	creators: string[];
}

export type EngineState =
	| { kind: 'starting' }
	| { kind: 'ready'; books: number; warming?: { done: number; total: number } }
	| { kind: 'failed'; message: string };

/** A way to search books: the native `fff-epub serve` process (desktop) or WebAssembly */
export interface SearchEngine {
	readonly name: 'native' | 'wasm';
	state(): EngineState;
	/** Called when `state()` changes */
	onState(listener: () => void): () => void;
	books(): Promise<BookInfo[]>;
	/** A page of matches; `onProgress` reports books searched so far, for engines that know */
	grep(request: GrepRequest, onProgress?: (searched: number, total: number, hits: Hit[]) => void): Promise<GrepPage>;
	/** Stops the search in flight (its promise resolves with `aborted`) */
	cancel(): void;
	/** Finds the books again (they were added, removed, or renamed) */
	rescan(): void;
	dispose(): void;
}

/** UTF-8 byte ranges in a line (from Rust) as UTF-16 ranges (JavaScript's string indices) */
export function utf16Ranges(text: string, ranges: { start: number; end: number }[]): [number, number][] {
	if (ranges.length === 0) return [];
	// Byte offset of each UTF-16 index, walked once
	const out: [number, number][] = [];
	const wanted = ranges.flatMap((r) => [r.start, r.end]);
	const found = new Map<number, number>();
	let byte = 0;
	for (let i = 0; i <= text.length; i++) {
		found.set(byte, i);
		if (i === text.length) break;
		const code = text.codePointAt(i)!;
		const units = code > 0xffff ? 2 : 1;
		byte += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
		if (units === 2) i++;
	}
	const at = (b: number) => found.get(b) ?? text.length;
	for (let i = 0; i < wanted.length; i += 2) out.push([at(wanted[i]!), at(wanted[i + 1]!)]);
	return out;
}

/** The words a book picker matches: title, creators, path */
export function bookLabel(book: BookInfo): string {
	return [book.title, book.creators.join(', '), book.id].filter(Boolean).join(' — ');
}

/** The books a scope covers, in path order (`known` gives titles and authors seen before) */
export function booksInScope(files: { path: string; basename: string }[], scope: Scope, known: Map<string, BookInfo>): string[] {
	const words = (scope.booksQuery ?? '').toLowerCase().split(/\s+/).filter(Boolean);
	return files
		.filter((f) => !scope.books || scope.books.includes(f.path))
		.filter((f) => !scope.folders?.length || scope.folders.some((folder) => f.path.startsWith(folder)))
		.filter((f) => {
			if (words.length === 0) return true;
			const info = known.get(f.path);
			const label = `${info?.title ?? f.basename} ${info?.creators.join(' ') ?? ''} ${f.path}`.toLowerCase();
			return words.every((w) => label.includes(w));
		})
		.map((f) => f.path)
		// Code-point order, as fff-epub sorts (so pages line up between engines)
		.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** The words around the matched ranges (about `around` characters each side), at word breaks */
export function snippet(text: string, ranges: [number, number][], around: number): [string, [number, number][]] {
	const first = ranges[0];
	const last = ranges[ranges.length - 1];
	if (!first || !last) return [text.length > around * 2 ? `${text.slice(0, around * 2)}…` : text, []];
	let start = Math.max(0, first[0] - around);
	let end = Math.min(text.length, last[1] + around);
	if (start > 0) {
		const space = text.indexOf(' ', start);
		if (space !== -1 && space < first[0]) start = space + 1;
	}
	if (end < text.length) {
		const space = text.lastIndexOf(' ', end);
		if (space > last[1]) end = space;
	}
	const prefix = start > 0 ? '… ' : '';
	const suffix = end < text.length ? ' …' : '';
	const shift = prefix.length - start;
	return [`${prefix}${text.slice(start, end)}${suffix}`, ranges.map(([a, b]) => [a + shift, b + shift] as [number, number])];
}
