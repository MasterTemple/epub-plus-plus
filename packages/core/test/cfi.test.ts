import { describe, expect, test } from 'bun:test';
import { compareCfi, makeRangeCfi, parseCfi, pointToPath, resolvePath, serializeCfi, cfiStart } from '../src/locators/cfi';

describe('CFI parse/serialize', () => {
	const cases = [
		'epubcfi(/6/4[chap01ref]!/4[body01]/10[para05]/3:10)',
		'epubcfi(/6/4[chap01ref]!/4[body01]/10[para05],/2/1:1,/3:4)',
		'epubcfi(/6/14[xchapter_001]!/4/2,/1:0,/1:16)',
		'epubcfi(/6/4!/4/2/1:3[yon,der])',
		'epubcfi(/6/4[a^[b^]]!/4)',
	];
	for (const c of cases) test(c, () => expect(serializeCfi(parseCfi(c))).toBe(c.replace(':3[yon,der]', ':3')));

	test('without assertions', () => {
		expect(serializeCfi(parseCfi(cases[0]), { assertions: false })).toBe('epubcfi(/6/4!/4/10/3:10)');
	});
	test('escaped assertion', () => {
		const p = parseCfi('epubcfi(/6/4[a^[b^]]!/4)');
		expect(p.range === false && p.path.steps[1].id).toBe('a[b]');
	});
	test('compare', () => {
		expect(compareCfi('epubcfi(/6/4!/4/2/1:5)', 'epubcfi(/6/4!/4/2/1:10)')).toBe(-1);
		expect(compareCfi('epubcfi(/6/6!/4/2/1:5)', 'epubcfi(/6/4!/4/10/1:10)')).toBe(1);
		expect(compareCfi('epubcfi(/6/4!/4/2,/1:0,/1:5)', 'epubcfi(/6/4!/4/2/1:0)')).toBe(1);
	});
	test('range factoring', () => {
		const a = parseCfi('epubcfi(/6/4!/4/2/1:3)');
		const b = parseCfi('epubcfi(/6/4!/4/2/1:9)');
		expect(serializeCfi(makeRangeCfi(cfiStart(a), cfiStart(b)))).toBe('epubcfi(/6/4!/4/2,/1:3,/1:9)');
	});
});

describe('CFI <-> DOM', () => {
	const html = `<div id="root"><p id="p1">Hello <em>big</em> world</p>\n<p>Second <b>bold <i>it</i></b> tail</p></div>`;
	document.body.innerHTML = html;
	const root = document.getElementById('root')!;
	const p2 = root.children[1];
	test('round trip every text position', () => {
		const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
		for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
			for (let o = 0; o <= n.length; o++) {
				const path = pointToPath(root, n, o);
				const r = resolvePath(root, path.steps, path.offset)!;
				// positions at the end of a text node may resolve to the same chunk position in a later node; compare by range
				const a = document.createRange(); a.setStart(n, o);
				const b = document.createRange(); b.setStart(r.container, r.offset);
				expect(a.compareBoundaryPoints(Range.START_TO_START, b)).toBe(0);
			}
		}
	});
	test('steps', () => {
		const t = p2.childNodes[2] as Text; // " tail"
		expect(pointToPath(root, t, 2)).toEqual({ steps: [{ index: 4 }, { index: 3 }], offset: 2 });
		const em = root.querySelector('em')!.firstChild!;
		expect(pointToPath(root, em, 1)).toEqual({ steps: [{ index: 2, id: 'p1' }, { index: 2 }, { index: 1 }], offset: 1 });
		// element boundary point
		expect(pointToPath(root, p2, 1)).toEqual({ steps: [{ index: 4 }, { index: 1 }], offset: 7 });
	});
	test('id assertion fallback', () => {
		const r = resolvePath(root, [{ index: 8, id: 'p1' }, { index: 1 }], 2)!;
		expect((r.container as Text).data).toBe('Hello ');
	});
});
