import { expect, test } from 'bun:test';
import { parseLocator } from '@epub-pp/core';
import { formatLink, renderTemplate, setCalloutColor, setLinkColor } from '../src/link-utils';

const cfi = 'epubcfi(/6/14!/4/2,/1:0,/1:16)';

test('wiki and markdown links', () => {
	expect(formatLink('Books/Moby Dick.epub', `${cfi}&color=red`, 'Moby | Ch. 1', 'wiki')).toBe(
		'[[Books/Moby Dick.epub#epubcfi(/6/14!/4/2,/1:0,/1:16)&color=red|Moby Ch. 1]]',
	);
	expect(formatLink('Books/Moby Dick.epub', `${cfi}&color=red`, 'Moby [1]', 'markdown')).toBe(
		'[Moby \\[1\\]](Books/Moby%20Dick.epub#epubcfi%28/6/14!/4/2,/1%3A0,/1%3A16%29&color=red)',
	);
});

test('markdown link subpath survives one decode', () => {
	const sub = ':~:text=call%20me-,Ishmael,-%2C%20some&color=red';
	const link = formatLink('a.epub', sub, 'x', 'markdown');
	const dest = /\((.*)\)$/.exec(link)![1];
	// Obsidian applies decodeURI, which keeps reserved chars like %3A encoded.
	const decoded = decodeURI(dest.split('#')[1]);
	expect(decoded).toBe(sub.replace(/:/g, '%3A'));
	expect(parseLocator(decoded)).toEqual({ textFragment: ':~:text=call%20me-,Ishmael,-%2C%20some', params: { color: 'red' } });
});

test('parseLocator', () => {
	expect(parseLocator('epubcfi(/6/14!/4/2/6/2,/1%3A0,/1%3A48)&color=green')).toEqual({ cfi: 'epubcfi(/6/14!/4/2/6/2,/1:0,/1:48)', params: { color: 'green' } });
	expect(parseLocator(`#${cfi}&color=yellow`)).toEqual({ cfi, params: { color: 'yellow' } });
	expect(parseLocator('epubcfi%28/6/4!/4/2/1:0%29&color=red')).toEqual({ cfi: 'epubcfi(/6/4!/4/2/1:0)', params: { color: 'red' } });
	expect(parseLocator('OPS/ch1.xhtml#p3')).toEqual({ href: 'OPS/ch1.xhtml#p3', params: {} });
	expect(parseLocator('epubcfi(/6/4[a^)b]!/4/2/1:0)').cfi).toBe('epubcfi(/6/4[a^)b]!/4/2/1:0)');
});

test('setLinkColor', () => {
	expect(setLinkColor(`[[a.epub#${cfi}|x]]`, 'red')).toBe(`[[a.epub#${cfi}&color=red|x]]`);
	expect(setLinkColor(`[[a.epub#${cfi}&color=yellow|x]]`, 'red')).toBe(`[[a.epub#${cfi}&color=red|x]]`);
	expect(setLinkColor(`[[a.epub#${cfi}&color=yellow]]`, null)).toBe(`[[a.epub#${cfi}]]`);
	expect(setLinkColor('[x](a.epub#epubcfi%28/6/4!/4/2/1:0%29&color=blue)', 'green')).toBe('[x](a.epub#epubcfi%28/6/4!/4/2/1:0%29&color=green)');
	expect(setLinkColor('[x](a.epub#:~:text=foo,bar)', 'green')).toBe('[x](a.epub#:~:text=foo,bar&color=green)');
	expect(setLinkColor('[x](a.epub#%3A~%3Atext=foo,bar&color=red)', 'green')).toBe('[x](a.epub#%3A~%3Atext=foo,bar&color=green)');
});

test('templates continue callout prefix', () => {
	const t = '> [!quote|{{color}}] {{link}}\n> {{text}}';
	expect(renderTemplate(t, { color: 'red', link: 'L', text: 'para one\n\npara two' })).toBe('> [!quote|red] L\n> para one\n>\n> para two');
	expect(renderTemplate('{{text}} ({{link}})', { text: 'a\nb', link: 'L' })).toBe('a\nb (L)');
});

test('setCalloutColor', () => {
	const lines = ['text', '> [!quote|yellow] [[a.epub#x]]', '> body'];
	expect(setCalloutColor(lines, 2, 'red')[1]).toBe('> [!quote|red] [[a.epub#x]]');
	expect(setCalloutColor(lines, 0, 'red')).toBe(lines);
	expect(setCalloutColor(['> [!note]- x'], 0, 'blue')[0]).toBe('> [!note|blue]- x');
});
