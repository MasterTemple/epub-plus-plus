import { EpubBook, EpubReader } from '../packages/core/src';

const out: Record<string, unknown> = {};
const params = new URLSearchParams(location.search);
const files: string[] = params.get('book') ? [params.get('book')!] : await (await fetch('/fixtures')).json();
const host = document.getElementById('reader')!;

function rnd(seed: number) {
	return () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
}

for (const name of files) {
	const r: Record<string, unknown> = {};
	out[name] = r;
	try {
		const book = await EpubBook.open(await (await fetch(`/fixtures/${name}`)).arrayBuffer());
		const reader = new EpubReader(host, book, { cfiAssertions: false });
		let t = performance.now();
		await reader.render();
		r.renderMs = Math.round(performance.now() - t);
		r.spine = book.spine.length;
		r.toc = book.flatToc.length;
		r.title = book.metadata.title;
		r.tocUnresolved = book.flatToc.filter((i) => i.href && !reader.goTo(i)).map((i) => i.href);

		// CFI + text fragment round trips over random ranges
		const idx = reader.textIndex;
		r.textLength = idx.text.length;
		const rand = rnd(42);
		let cfiFail: unknown[] = [];
		let tfFail: unknown[] = [];
		t = performance.now();
		for (let i = 0; i < 200; i++) {
			const s = Math.floor(rand() * (idx.text.length - 200));
			const e = s + 1 + Math.floor(rand() * 150);
			const range = idx.toRange(s, e);
			const cfi = reader.cfiFromRange(range)!;
			const back = reader.resolveCfi(cfi);
			if (!back || back.compareBoundaryPoints(Range.START_TO_START, range) !== 0 || back.compareBoundaryPoints(Range.END_TO_END, range) !== 0)
				cfiFail.push({ cfi, text: range.toString().slice(0, 40), back: back?.toString().slice(0, 40) });
			const tf = reader.textFragmentFromRange(range);
			if (!tf) continue;
			const tfr = reader.resolve(tf);
			const want = idx.text.slice(s, e).trim();
			const got = tfr ? idx.text.slice(...idx.rangeToOffsets(tfr)).trim() : null;
			if (got !== want) tfFail.push({ tf, want: want.slice(0, 60), got: got?.slice(0, 60) });
		}
		r.roundTripMs = Math.round(performance.now() - t);
		r.cfiFail = cfiFail.slice(0, 5);
		r.cfiFailCount = cfiFail.length;
		r.tfFail = tfFail.slice(0, 5);
		r.tfFailCount = tfFail.length;

		// Search
		t = performance.now();
		const res = reader.search('the');
		r.searchThe = res.length;
		r.searchMs = Math.round(performance.now() - t);

		// goTo / location consistency: jump to a random cfi and check that location is near
		const s = Math.floor(idx.text.length * 0.6);
		const range = idx.toRange(s, s + 10);
		reader.goTo(reader.cfiFromRange(range)!);
		await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(res, 50))));
		const rect = range.getBoundingClientRect();
		const box = reader.scroller.getBoundingClientRect();
		r.gotoVisible = rect.top >= box.top && rect.bottom <= box.bottom;
		r.location = reader.getLocation()?.tocItem?.label;

		// Font scaling: proportions between h1 and p kept when font size changes
		const p = reader.content.querySelector('.epp-body p');
		const h = reader.content.querySelector('.epp-body h1, .epp-body h2');
		const ratio = () => (h && p ? parseFloat(getComputedStyle(h).fontSize) / parseFloat(getComputedStyle(p).fontSize) : 0);
		const r1 = ratio();
		const p1 = p ? parseFloat(getComputedStyle(p).fontSize) : 0;
		reader.updateSettings({ fontSize: 24 });
		r.fontScale = { ratioAt18: +r1.toFixed(3), ratioAt24: +ratio().toFixed(3), pAt18: p1, pAt24: p ? parseFloat(getComputedStyle(p).fontSize) : 0 };
		r.pFont = p ? getComputedStyle(p).fontFamily : null;
		reader.destroy();
		book.destroy();
	} catch (e) {
		r.error = String((e as Error)?.stack ?? e);
	}
}
document.getElementById('results')!.textContent = JSON.stringify(out, null, 1);
document.title = 'done';
