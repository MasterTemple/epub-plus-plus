import { EpubBook, EpubReader, type HighlightSpec, type SearchResult, type TocItem } from '../packages/core/src';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
let reader: EpubReader | null = null;
let book: EpubBook | null = null;
const highlights: HighlightSpec[] = [];

async function load(name: string) {
	reader?.destroy();
	book?.destroy();
	const buf = await (await fetch(`/fixtures/${name}`)).arrayBuffer();
	book = await EpubBook.open(buf);
	reader = new EpubReader($('reader'), book, { settings: readSettings() });
	(window as any).reader = reader;
	const t0 = performance.now();
	await reader.render();
	console.log(`rendered ${book.spine.length} items in ${(performance.now() - t0).toFixed(0)}ms`);
	renderToc(book.toc);
	reader.on('relocated', (loc) => ($('info').textContent = `${loc.tocItem?.label ?? ''} ${(loc.progress * 100).toFixed(1)}% ${loc.cfi}`));
	reader.on('highlight-click', (_e, hs) => alert(`clicked highlight ${hs.map((h) => h.locator).join('\n')}`));
	reader.on('contextmenu', (e, { selection, highlights: hs }) => {
		e.preventDefault();
		console.log('contextmenu', selection?.cfi, selection?.textFragment(), selection?.text, hs);
		$('info').textContent = selection ? `${selection.cfi} | ${selection.textFragment()}` : hs.map((h) => h.locator).join(' ');
	});
	reader.on('external-link', (_e, url) => window.open(url));
	const saved = localStorage.getItem(`pos:${name}`);
	if (saved) reader.goTo(saved);
	reader.on('relocated', (loc) => localStorage.setItem(`pos:${name}`, loc.cfi));
	reader.setHighlights(highlights);
}

function readSettings() {
	const lh = parseFloat(($('lh') as HTMLInputElement).value);
	return {
		theme: ($('theme') as HTMLSelectElement).value as any,
		fontSize: Number(($('size') as HTMLInputElement).value),
		lineHeight: Number.isFinite(lh) ? lh : null,
		width: Number(($('width') as HTMLInputElement).value),
		widthUnit: ($('unit') as HTMLSelectElement).value as any,
		fontFamily: ($('font') as HTMLInputElement).value,
	};
}

function renderToc(items: TocItem[]) {
	const side = $('side');
	side.replaceChildren();
	const add = (list: TocItem[]) => {
		for (const it of list) {
			const a = document.createElement('a');
			a.textContent = it.label;
			a.style.paddingLeft = `${it.depth}em`;
			a.onclick = () => reader?.goTo(it);
			side.appendChild(a);
			add(it.children);
		}
	};
	add(items);
}

for (const id of ['theme', 'size', 'lh', 'width', 'unit', 'font']) $(id).addEventListener('change', () => reader?.updateSettings(readSettings()));
$('hl').onclick = () => {
	const sel = reader?.getSelection();
	if (!sel) return;
	highlights.push({ id: String(highlights.length), locator: sel.cfi, color: ['yellow', 'red', 'green', 'blue'][highlights.length % 4] });
	reader!.setHighlights(highlights);
	reader!.clearSelection();
};
let results: SearchResult[] = [];
let cur = 0;
$('q').addEventListener('keydown', (e) => {
	if (e.key !== 'Enter' || !reader) return;
	const q = ($('q') as HTMLInputElement).value;
	if ((e.target as any).dataset.last !== q) {
		results = reader.search(q);
		cur = 0;
		(e.target as any).dataset.last = q;
		const side = $('side');
		side.replaceChildren();
		results.slice(0, 300).forEach((r, i) => {
			const d = document.createElement('div');
			d.className = 'res';
			d.innerHTML = `${esc(r.excerpt.before)}<b>${esc(r.excerpt.match)}</b>${esc(r.excerpt.after)}`;
			d.onclick = () => reader!.showSearchResults(results, (cur = i));
			side.appendChild(d);
		});
	} else cur = (cur + (e.shiftKey ? -1 : 1) + results.length) % results.length;
	reader.showSearchResults(results, cur);
});
const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);

const files: string[] = await (await fetch('/fixtures')).json();
const sel = $('file') as HTMLSelectElement;
for (const f of files) sel.add(new Option(f, f));
const initial = new URLSearchParams(location.search).get('book') ?? files[0];
sel.value = initial;
sel.onchange = () => load(sel.value);
load(initial);
