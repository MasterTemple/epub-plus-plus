import { describe, expect, test } from 'bun:test';
import { parseEpubLocator } from '@epub-pp/core';
import { findPlacement, headingLabel, insertAnnotation, insertAt, linksIn, type Ordering } from 'file-plus-plus/notes';
import { epubFormat } from '../src/format';

// Annotation files order blocks by their first link's CFI (text fragments resolve through `resolve`).
const ordering = (resolve: (tf: string) => unknown = () => null): Ordering<unknown> => ({
	compare: epubFormat.position.compare,
	keyOf: (md) => {
		for (const link of linksIn(md)) {
			const loc = parseEpubLocator(link.slice(link.indexOf('#') + 1));
			if (loc.cfi) return epubFormat.position.key(loc.cfi);
			if (loc.textFragment) return resolve(loc.textFragment);
		}
		return null;
	},
});
const cfiKey = (cfi: string) => epubFormat.position.key(cfi);

const file = `---
epub: "[[Moby Dick.epub]]"
---

# [[Moby Dick.epub#epubcfi(/6/14!/4/1:0)|Chapter 1. Loomings.]]

> [!quote|yellow] [[Moby Dick.epub#epubcfi(/6/14!/4/2/4/2,/1:0,/1:16)&color=yellow|Moby-Dick]]
> Call me Ishmael.

> [!quote|red] [[Moby Dick.epub#epubcfi(/6/14!/4/2/6/2,/1:0,/1:48)&color=red|Moby-Dick]]
> There now is your insular city

# [[Moby Dick.epub#epubcfi(/6/16!/4/1:0)|Chapter 2. The Carpet-Bag.]]

# [[Moby Dick.epub#epubcfi(/6/18!/4/1:0)|Chapter 3. The Spouter-Inn.]]

Some loose note without a link.
`;

const noTf = ordering();
const key = (cfi: string) => cfiKey(cfi)!;

describe('annotation placement', () => {
	test('between existing annotations in the right chapter', () => {
		const sel = key('epubcfi(/6/14!/4/2/4/8,/1:0,/1:20)');
		const { data, placement } = insertAnnotation(file, sel, '> NEW', noTf);
		expect(placement.heading).toBe('Chapter 1. Loomings.');
		const lines = data.split('\n');
		const i = lines.indexOf('> NEW');
		expect(lines[i - 2]).toBe('> Call me Ishmael.');
		expect(lines[i + 2]).toStartWith('> [!quote|red]');
	});

	test('before the first annotation', () => {
		const sel = key('epubcfi(/6/14!/4/2/2/1:0)');
		const { data } = insertAnnotation(file, sel, '> FIRST', noTf);
		const lines = data.split('\n');
		const i = lines.indexOf('> FIRST');
		expect(lines[i - 2]).toStartWith('# [[Moby Dick.epub#epubcfi(/6/14!');
		expect(lines[i + 2]).toStartWith('> [!quote|yellow]');
	});

	test('empty chapter section', () => {
		const sel = key('epubcfi(/6/16!/4/2/10,/1:0,/1:5)');
		const { data, placement } = insertAnnotation(file, sel, '> CH2', noTf);
		expect(placement.heading).toBe('Chapter 2. The Carpet-Bag.');
		expect(data).toContain('# [[Moby Dick.epub#epubcfi(/6/16!/4/1:0)|Chapter 2. The Carpet-Bag.]]\n\n> CH2\n\n# [[Moby Dick.epub#epubcfi(/6/18!');
	});

	test('unclear blocks append to the end of the section', () => {
		const sel = key('epubcfi(/6/18!/4/2/2/1:0)');
		const { data, placement } = insertAnnotation(file, sel, '> CH3', noTf);
		expect(placement.appended).toBe(true);
		expect(data.trimEnd().endsWith('Some loose note without a link.\n\n> CH3')).toBe(true);
	});

	test('text fragments are resolved through the callback', () => {
		const withTf = file.replace(
			'[[Moby Dick.epub#epubcfi(/6/14!/4/2/6/2,/1:0,/1:48)&color=red|Moby-Dick]]',
			'[[Moby Dick.epub#:~:text=There%20now%20is&color=red|Moby-Dick]]',
		);
		const sel = key('epubcfi(/6/14!/4/2/4/8,/1:0,/1:20)');
		const resolve = ordering((tf: string) => (tf.includes('There') ? key('epubcfi(/6/14!/4/2/6/2/1:0)') : null));
		const { placement, data } = insertAnnotation(withTf, sel, '> NEW', resolve);
		expect(placement.appended).toBe(false);
		const lines = data.split('\n');
		expect(lines[lines.indexOf('> NEW') + 2]).toStartWith('> [!quote|red]');
		// Without resolving, the position is unclear: append to the end of the section.
		const appended = insertAnnotation(withTf, sel, '> NEW', noTf);
		expect(appended.placement.appended).toBe(true);
	});

	test('before the first chapter and in files without headings', () => {
		const sel = key('epubcfi(/6/4!/4/2/1:0)');
		const p = findPlacement(file.split('\n'), sel, noTf);
		expect(p.heading).toBeNull();
		expect(p.line).toBe(3);
		const plain = insertAnnotation('just text\n', sel, '> X', noTf).data;
		expect(plain).toBe('just text\n\n> X\n');
	});

	test('markdown-style links and labels', () => {
		expect(headingLabel('[Chapter 1](Moby%20Dick.epub#epubcfi%28/6/14!/4/1%3A0%29)')).toBe('Chapter 1');
		const md = '# [Ch 1](Moby%20Dick.epub#epubcfi%28/6/14!/4/1%3A0%29)\n\n[a](Moby%20Dick.epub#epubcfi%28/6/14!/4/2/9/1%3A0%29)\n';
		const { data } = insertAnnotation(md, key('epubcfi(/6/14!/4/2/4/1:0)'), 'NEW', noTf);
		expect(data).toBe('# [Ch 1](Moby%20Dick.epub#epubcfi%28/6/14!/4/1%3A0%29)\n\nNEW\n\n[a](Moby%20Dick.epub#epubcfi%28/6/14!/4/2/9/1%3A0%29)\n');
	});

	test('insertAt spacing', () => {
		expect(insertAt(['a', '', '', 'b'], 3, 'X')).toEqual(['a', '', 'X', '', 'b']);
		expect(insertAt(['a'], 1, 'X')).toEqual(['a', '', 'X', '']);
	});
});
