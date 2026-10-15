import { describe, expect, test } from 'bun:test';
import { booksInScope, snippet, utf16Ranges, type BookInfo } from '../src/search/types';

describe('book search', () => {
	test('byte ranges from fff-epub become UTF-16 ranges', () => {
		const line = 'The “God’s grace” 𝔊 grace';
		const bytes = (s: string) => new TextEncoder().encode(s).length;
		const at = (i: number) => bytes(line.slice(0, i));
		const first = line.indexOf('God’s');
		const last = line.lastIndexOf('grace');
		const ranges = utf16Ranges(line, [
			{ start: at(first), end: at(first + 5) },
			{ start: at(last), end: at(last + 5) },
		]);
		expect(ranges).toEqual([
			[first, first + 5],
			[last, last + 5],
		]);
		expect(line.slice(...ranges[1]!)).toBe('grace');
	});

	test('scopes pick books by path, folder, and title words, in code-point order', () => {
		const files = ['Lib/b.epub', 'Lib/Z.epub', 'Other/a.epub'].map((path) => ({ path, basename: path.split('/')[1]!.replace('.epub', '') }));
		const known = new Map<string, BookInfo>([['Lib/b.epub', { id: 'Lib/b.epub', title: 'Institutes', creators: ['John Calvin'] }]]);
		expect(booksInScope(files, {}, known)).toEqual(['Lib/Z.epub', 'Lib/b.epub', 'Other/a.epub']);
		expect(booksInScope(files, { folders: ['Lib/'] }, known)).toEqual(['Lib/Z.epub', 'Lib/b.epub']);
		expect(booksInScope(files, { booksQuery: 'calvin inst' }, known)).toEqual(['Lib/b.epub']);
		expect(booksInScope(files, { books: ['Other/a.epub'] }, known)).toEqual(['Other/a.epub']);
	});

	test('snippets keep the match and cut at spaces', () => {
		const text = `${'word '.repeat(60)}grace here${' more'.repeat(60)}`;
		const start = text.indexOf('grace');
		const [shown, ranges] = snippet(text, [[start, start + 5]], 30);
		expect(shown.startsWith('… ')).toBe(true);
		expect(shown.endsWith(' …')).toBe(true);
		expect(shown.slice(...ranges[0]!)).toBe('grace');
		expect(snippet('short grace', [[6, 11]], 30)).toEqual(['short grace', [[6, 11]]]);
	});
});
