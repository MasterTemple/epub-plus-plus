import { describe, expect, test } from 'bun:test';
import { strToU8, zipSync } from 'fflate';
import { BookText } from '../src/book/extract';
import { EpubBook } from '../src/book/epub';
import { cfiEnd, cfiStart, parseCfi, resolvePath, splitIndirection } from '../src/locators/cfi';

const CHAPTER = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>John 1:1 in the title</title></head>
<body>
<h1 id="c1">Chapter</h1>
<p>See John</p>
<p>3 more, and Rom<!-- note -->ans 8:28 and café <em>John 3:16</em>.</p>
<p>Line<br/>break 😀 x</p>
</body></html>`;

function epub(): Uint8Array {
	return zipSync({
		mimetype: strToU8('application/epub+zip'),
		'META-INF/container.xml': strToU8(
			'<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
		),
		'OEBPS/content.opf': strToU8(`<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>T</dc:title><dc:identifier id="id">x</dc:identifier></metadata>
<manifest><item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/></manifest>
<spine><itemref idref="ch1"/></spine></package>`),
		'OEBPS/ch1.xhtml': strToU8(CHAPTER),
	});
}

/** The text a CFI covers, resolved against a freshly parsed copy of the chapter. */
function textOf(book: EpubBook, cfi: string): string {
	const c = parseCfi(cfi);
	const doc = book.loadDocument(book.spine[0]);
	const body = doc.getElementsByTagName('body')[0];
	const point = (p: ReturnType<typeof cfiStart>) => resolvePath(body, splitIndirection(p.steps).inner.slice(1), p.offset)!;
	const s = point(cfiStart(c));
	const e = point(cfiEnd(c));
	// The test ranges span at most two adjacent text nodes (happy-dom's Range.toString is unreliable on XML).
	const a = (s.container as Text).data;
	if (e.container === s.container) return a.slice(s.offset, e.offset);
	return a.slice(s.offset) + (e.container as Text).data.slice(0, e.offset);
}

describe('BookText', async () => {
	const book = await EpubBook.open(epub());
	const text = await BookText.extract(book);
	const t = text.sections[0].text;

	test('blocks are separated, head is skipped', () => {
		expect(t).toBe('Chapter\n\nSee John\n\n3 more, and Romans 8:28 and café John 3:16.\n\nLine\nbreak 😀 x');
	});

	test('custom separator', async () => {
		const spaced = await BookText.extract(book, { blockSeparator: ' ' });
		expect(spaced.sections[0].text.startsWith('Chapter See John 3 more')).toBe(true);
	});

	const cfiFor = (s: string, opts = {}) => {
		const i = t.indexOf(s);
		return text.cfi(0, i, i + s.length, opts)!;
	};

	test('range across a comment', () => {
		const cfi = cfiFor('Romans 8:28');
		expect(cfi).toBe('epubcfi(/6/2!/4/6,/1:12,/1:23)');
		expect(textOf(book, cfi)).toBe('Romans 8:28');
	});

	test('inside an inline element, after non-ASCII text', () => {
		const cfi = cfiFor('John 3:16');
		expect(cfi).toBe('epubcfi(/6/2!/4/6/2,/1:0,/1:9)');
		expect(textOf(book, cfi)).toBe('John 3:16');
	});

	test('after a line break and an astral character', () => {
		expect(textOf(book, cfiFor('x'))).toBe('x');
		expect(textOf(book, cfiFor('break 😀'))).toBe('break 😀');
	});

	test('assertions', () => {
		expect(cfiFor('Chapter', { assertions: true })).toBe('epubcfi(/6/2[ch1]!/4/2[c1],/1:0,/1:7)');
	});

	test('out of range', () => {
		expect(text.cfi(0, 5, 5)).toBeNull();
		expect(text.cfi(3, 0, 1)).toBeNull();
	});
});
