import { describe, expect, test } from 'bun:test';
import { getComment, setComment } from '../src/comment-utils';

const L = (s: string) => s.split('\n');
const J = (a: string[]) => a.join('\n');

describe('comments', () => {
	const withComment = L(`intro

> [!quote|blue] [[B.epub#epubcfi(/6/4!/4/2,/1:0,/1:5)|B]]
> > the quote
> > *second* line
>
> my comment
> more

after`);

	test('read', () => {
		expect(getComment(withComment, 2)).toBe('my comment\nmore');
		expect(getComment(L('> [!quote] [[x]]\n> text\n>\n> para two'), 0)).toBeNull();
		expect(getComment(L('[[x]] plain'), 0)).toBeNull();
	});

	test('edit and remove', () => {
		expect(J(setComment(withComment, 2, 'new\n\nlines', null))).toBe(`intro

> [!quote|blue] [[B.epub#epubcfi(/6/4!/4/2,/1:0,/1:5)|B]]
> > the quote
> > *second* line
>
> new
>
> lines

after`);
		expect(J(setComment(withComment, 2, '', null))).toBe(`intro

> [!quote|blue] [[B.epub#epubcfi(/6/4!/4/2,/1:0,/1:5)|B]]
> > the quote
> > *second* line

after`);
	});

	test('add to a callout: double-embeds the existing text as-is', () => {
		const src = L(`> [!quote|red] [[B.epub#x|B]]
> the **edited** quote
>
> second paragraph`);
		const out = setComment(src, 0, 'thoughts', 'red');
		expect(J(out)).toBe(`> [!quote|red] [[B.epub#x|B]]
> > the **edited** quote
> >
> > second paragraph
>
> thoughts`);
		expect(getComment(out, 0)).toBe('thoughts');
	});

	test('add to an already nested quote without comment', () => {
		const out = setComment(L('> [!quote] [[x]]\n> > q'), 0, 'c', null);
		expect(J(out)).toBe('> [!quote] [[x]]\n> > q\n>\n> c');
	});

	test('add to a plain paragraph link', () => {
		const out = setComment(L('before\n\nSee [[B.epub#x|here]] now\n\nafter'), 2, 'why', 'green');
		expect(J(out)).toBe('before\n\n> [!quote|green] See [[B.epub#x|here]] now\n>\n> why\n\nafter');
		expect(getComment(out, 2)).toBe('why');
	});
});
