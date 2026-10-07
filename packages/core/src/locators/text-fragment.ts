import { foldString, type TextIndex } from '../search/text-index';

/**
 * Text Fragments (https://wicg.github.io/scroll-to-text-fragment/): `:~:text=[prefix-,]start[,end][,-suffix]`.
 * Matching is case-, diacritic- and quote-style-insensitive and spans element boundaries.
 */
export interface TextFragment {
	prefix?: string;
	start: string;
	end?: string;
	suffix?: string;
}

const enc = (s: string) => encodeURIComponent(s).replace(/-/g, '%2D');
const dec = (s: string) => {
	try {
		return decodeURIComponent(s);
	} catch {
		return s;
	}
};

export function serializeTextFragment(tf: TextFragment): string {
	const parts: string[] = [];
	if (tf.prefix) parts.push(`${enc(tf.prefix)}-`);
	parts.push(enc(tf.start));
	if (tf.end) parts.push(enc(tf.end));
	if (tf.suffix) parts.push(`-${enc(tf.suffix)}`);
	return `:~:text=${parts.join(',')}`;
}

/** Parse `:~:text=...` (also accepts a bare `text=...`). Returns null when not a text directive. */
export function parseTextFragment(input: string): TextFragment | null {
	const m = /(?:^|:~:|&)text=([^&]*)/.exec(input);
	if (!m) return null;
	const parts = m[1].split(',');
	const tf: Partial<TextFragment> = {};
	if (parts[0]?.endsWith('-')) tf.prefix = dec(parts.shift()!.slice(0, -1));
	if (parts.length && parts[parts.length - 1].startsWith('-')) tf.suffix = dec(parts.pop()!.slice(1));
	if (!parts.length || !parts[0]) return null;
	tf.start = dec(parts[0]);
	if (parts[1]) tf.end = dec(parts[1]);
	return tf as TextFragment;
}

/** Find the text-coordinate range matched by a fragment. */
export function findTextFragment(index: TextIndex, tf: TextFragment): [number, number] | null {
	const F = index.folded;
	const start = foldString(tf.start);
	const end = tf.end ? foldString(tf.end) : '';
	const prefix = tf.prefix ? foldString(tf.prefix) : '';
	const suffix = tf.suffix ? foldString(tf.suffix) : '';
	if (!start) return null;
	let from = 0;
	while (true) {
		const pos = F.indexOf(start, from);
		if (pos === -1) return null;
		from = pos + 1;
		if (prefix) {
			let p = pos;
			while (p > 0 && F[p - 1] === ' ') p--;
			if (F.slice(p - prefix.length, p) !== prefix) continue;
		}
		let rangeEnd = pos + start.length;
		if (end) {
			const e = F.indexOf(end, rangeEnd);
			if (e === -1) return null;
			rangeEnd = e + end.length;
		}
		if (suffix) {
			let s = rangeEnd;
			while (s < F.length && F[s] === ' ') s++;
			if (F.slice(s, s + suffix.length) !== suffix) continue;
		}
		return index.foldedToText(pos, rangeEnd);
	}
}

const words = (s: string) => s.split(' ').filter(Boolean);

/** Generate a fragment that resolves (as the first match) to the given text-coordinate range. */
export function createTextFragment(index: TextIndex, start: number, end: number): TextFragment | null {
	const T = index.text;
	while (start < end && T[start] === ' ') start++;
	while (end > start && T[end - 1] === ' ') end--;
	if (end <= start) return null;
	const exact = T.slice(start, end);
	const ws = words(exact);
	const tf: TextFragment =
		exact.length <= 120 || ws.length <= 8
			? { start: exact }
			: { start: ws.slice(0, 4).join(' '), end: ws.slice(-4).join(' ') };

	const before = words(T.slice(Math.max(0, start - 300), start));
	const after = words(T.slice(end, end + 300));
	const ok = () => {
		const r = findTextFragment(index, tf);
		return !!r && r[0] === start && r[1] === end;
	};
	for (let n = 0; !ok() && n <= 8; n++) {
		// grow context alternately; for long ranges also lengthen start/end words
		if (n % 2 === 0 && before.length) tf.prefix = before.slice(-Math.min(before.length, n / 2 + 1)).join(' ');
		else if (after.length) tf.suffix = after.slice(0, Math.min(after.length, (n + 1) / 2)).join(' ');
		if (tf.end && n >= 4) {
			const k = 4 + (n - 3);
			tf.start = ws.slice(0, k).join(' ');
			tf.end = ws.slice(-k).join(' ');
		}
	}
	return tf;
}
