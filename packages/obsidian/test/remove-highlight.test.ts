import { describe, expect, test } from 'bun:test';
import { removeHighlight } from '../src/comment-utils';

const LINK = '[[B.epub#epubcfi(/6/4!/4/2,/1:0,/1:5)|B]]';
const remove = (data: string, occurrence = 0) => {
	let start = -1;
	for (let i = 0; i <= occurrence; i++) start = data.indexOf(LINK, start + 1);
	return removeHighlight(data, start, start + LINK.length);
};

describe('removeHighlight', () => {
	test('callout with comment: the whole block', () => {
		expect(remove(`intro\n\n> [!quote|blue] ${LINK}\n> > the quote\n>\n> my comment\n\nafter`)).toBe('intro\n\nafter');
	});
	test('plain callout at the end of the note', () => {
		expect(remove(`intro\n\n> [!quote] ${LINK}\n> text\n`)).toBe('intro\n');
	});
	test('link alone on a line', () => {
		expect(remove(`> some quote\n\n${LINK}\n\nnext`)).toBe('> some quote\n\nnext');
	});
	test('text with link', () => {
		expect(remove(`the text (${LINK}) and more`)).toBe('the text and more');
	});
	test('inline link', () => {
		expect(remove(`see ${LINK} here`)).toBe('see here');
		expect(remove(`see ${LINK}.`)).toBe('see.');
		expect(remove(`${LINK} starts it`)).toBe('starts it');
	});
	test('link inside a callout body, not the header: only the link', () => {
		expect(remove(`> [!note] Notes\n> see ${LINK} here`)).toBe('> [!note] Notes\n> see here');
	});
	test('second of two callouts', () => {
		expect(remove(`> [!quote] ${LINK}\n> a\n\n> [!quote] ${LINK}\n> b\n\nend`, 1)).toBe(`> [!quote] ${LINK}\n> a\n\nend`);
	});
});
