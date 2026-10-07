/** Pure helpers for building and editing EPUB links in markdown (no Obsidian imports, unit-testable). */

/**
 * Percent-encode for a markdown link destination. Obsidian runs `decodeURI` on the destination, and
 * ignores markdown links whose destination contains a raw `:` (it treats them as URLs), so colons are
 * encoded as `%3A` (which `decodeURI` leaves alone; `parseLocator` accepts it).
 */
export function mdEncode(s: string): string {
	return encodeURI(s).replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/:/g, '%3A');
}

export function sanitizeAlias(s: string, style: 'wiki' | 'markdown'): string {
	const oneLine = s.replace(/\s+/g, ' ').trim();
	return style === 'wiki' ? oneLine.replace(/[|\[\]#^]/g, ' ').replace(/\s+/g, ' ').trim() : oneLine.replace(/([\[\]])/g, '\\$1');
}

export function formatLink(linktext: string, subpath: string, alias: string, style: 'wiki' | 'markdown'): string {
	const a = sanitizeAlias(alias, style);
	if (style === 'wiki') return `[[${linktext}${subpath ? `#${subpath}` : ''}${a ? `|${a}` : ''}]]`;
	return `[${a || linktext}](${mdEncode(linktext)}${subpath ? `#${mdEncode(subpath)}` : ''})`;
}

/**
 * Fill a `{{var}}` template. Multi-line values continue the line's quote/callout prefix (`> `),
 * so `> {{text}}` stays inside the callout for multi-paragraph selections.
 */
export function renderTemplate(template: string, vars: Record<string, string>): string {
	return template
		.split('\n')
		.map((line) => {
			const prefix = /^(\s*>\s?)*/.exec(line)?.[0] ?? '';
			return line.replace(/\{\{(\w+)\}\}/g, (_, k: string) => {
				const v = vars[k] ?? '';
				return prefix ? v.split('\n').join(`\n${prefix.trimEnd() + ' '}`).replace(/> \n/g, '>\n') : v;
			});
		})
		.join('\n');
}

/** Index just past the locator (CFI or text directive) inside a link's source text, or -1. */
function locatorEnd(src: string): number {
	let i = src.indexOf('epubcfi(');
	if (i !== -1) return matchParen(src, i + 'epubcfi'.length, '(', ')');
	i = src.indexOf('epubcfi%28');
	if (i !== -1) return matchParen(src, i + 'epubcfi'.length, '%28', '%29');
	i = src.search(/(:|%3A)~(:|%3A)text=/i);
	if (i !== -1) {
		const m = /[&|\])\s]/.exec(src.slice(i));
		return m ? i + m.index : src.length;
	}
	return -1;
}

function matchParen(s: string, start: number, open: string, close: string): number {
	let depth = 0;
	for (let i = start; i < s.length; ) {
		if (s[i] === '^' && open === '(') {
			i += 2;
			continue;
		}
		if (s.startsWith(open, i)) {
			depth++;
			i += open.length;
		} else if (s.startsWith(close, i)) {
			i += close.length;
			if (--depth === 0) return i;
		} else i++;
	}
	return -1;
}

/** Set (or remove, when `color` is null) the `&color=` parameter of an EPUB link's source text. */
export function setLinkColor(src: string, color: string | null): string {
	const end = locatorEnd(src);
	if (end === -1) return src;
	const tail = src.slice(end);
	const m = /^((?:&[\w-]+=[^&|\])\s]*)*)/.exec(tail)!;
	let params = m[1].replace(/&color=[^&|\])\s]*/g, '');
	if (color) params = `&color=${encodeURIComponent(color)}${params}`;
	return src.slice(0, end) + params + tail.slice(m[1].length);
}

/**
 * Update the color of a callout header (`> [!quote|yellow]`) that contains the line `lineNo`, if any.
 * Returns the edited lines (or the input when there is no callout).
 */
export function setCalloutColor(lines: string[], lineNo: number, color: string | null): string[] {
	if (!/^\s*>/.test(lines[lineNo] ?? '')) return lines;
	for (let i = lineNo; i >= 0 && /^\s*>/.test(lines[i]); i--) {
		const m = /^(\s*>\s*\[!)([^\]|]+)(\|[^\]]*)?(\][+-]?)/.exec(lines[i]);
		if (m) {
			const out = lines.slice();
			out[i] = lines[i].replace(m[0], `${m[1]}${m[2]}${color ? `|${color}` : ''}${m[4]}`);
			return out;
		}
	}
	return lines;
}

/**
 * The link (wiki or markdown) covering column `ch` of a line, as linktext (`path#subpath`), or null.
 * Markdown destinations are decoded the way Obsidian does (decodeURI); balanced parentheses allowed.
 */
export function linkAt(line: string, ch: number): string | null {
	for (const m of line.matchAll(/!?\[\[([^\]]+)\]\]/g)) {
		if (ch >= m.index! && ch <= m.index! + m[0].length) return m[1].split('|')[0];
	}
	for (let i = line.indexOf(']('); i !== -1; i = line.indexOf('](', i + 2)) {
		const open = line.lastIndexOf('[', i);
		let depth = 0;
		let end = -1;
		for (let j = i + 1; j < line.length; j++) {
			if (line[j] === '(') depth++;
			else if (line[j] === ')' && --depth === 0) {
				end = j;
				break;
			}
		}
		if (open === -1 || end === -1) continue;
		if (ch >= open && ch <= end) {
			let dest = line.slice(i + 2, end).trim().replace(/^<|>$/g, '');
			try {
				dest = decodeURI(dest);
			} catch {
				/* keep */
			}
			return dest;
		}
	}
	return null;
}
