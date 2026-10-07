/**
 * Convert the content of a DOM range to Markdown: paragraphs, headings, lists, blockquotes, code,
 * line breaks, external links, and emphasis. Emphasis is detected from computed styles, so books
 * that italicize with classes (`<span class="i">`) convert as well as `<em>`.
 */

const BLOCK = new Set(['p', 'div', 'section', 'article', 'header', 'footer', 'aside', 'figure', 'figcaption', 'dd', 'dt', 'table', 'tr', 'nav', 'main', 'body', 'address', 'details', 'summary']);
const SKIP = new Set(['script', 'style', 'head', 'title', 'template', 'noscript', 'img', 'svg', 'video', 'audio', 'iframe', 'object']);

interface Ctx {
	italic: boolean;
	bold: boolean;
	pre: boolean;
	list: { ordered: boolean; n: number }[];
}

const escape = (s: string) => s.replace(/([\\`*_[\]])/g, '\\$1');

/** Wrap with an emphasis marker, keeping surrounding whitespace outside it. */
function wrap(s: string, mark: string): string {
	if (!s.trim()) return s;
	// Emphasis can't span paragraphs in Markdown: wrap each one.
	if (/\n\s*\n/.test(s.trim())) return s.split(/(\n\s*\n)/).map((part, i) => (i % 2 ? part : wrap(part, mark))).join('');
	const lead = /^\s*/.exec(s)![0];
	const trail = /\s*$/.exec(s)![0];
	return `${lead}${mark}${s.trim()}${mark}${trail}`;
}

export function rangeToMarkdown(range: Range): string {
	const root = range.commonAncestorContainer;
	const win = (root.ownerDocument ?? document).defaultView ?? window;
	const style = (el: Element) => win.getComputedStyle(el);
	// Start plain: a selection entirely inside italics should still come out as *…*.
	const start: Ctx = { italic: false, bold: false, pre: false, list: [] };

	const text = (node: Text, ctx: Ctx): string => {
		let s = node.data;
		if (node === range.endContainer) s = s.slice(0, range.endOffset);
		if (node === range.startContainer) s = s.slice(range.startOffset);
		if (!ctx.pre) s = s.replace(/\s+/g, ' ');
		return ctx.pre ? s : escape(s);
	};

	const convert = (node: Node, ctx: Ctx): string => {
		if (!range.intersectsNode(node)) return '';
		if (node.nodeType === 3 || node.nodeType === 4) return text(node as Text, ctx);
		if (node.nodeType !== 1) return '';
		const el = node as Element;
		const tag = el.localName;
		if (SKIP.has(tag)) return '';
		if (tag === 'br') return ctx.pre ? '\n' : '  \n';

		const cs = style(el);
		if (cs.display === 'none') return '';
		const italic = cs.fontStyle === 'italic' || cs.fontStyle === 'oblique';
		const heading = /^h[1-6]$/.test(tag);
		const bold = Number(cs.fontWeight) >= 600;
		const pre = tag === 'pre' || /^pre/.test(cs.whiteSpace);
		const inner: Ctx = { ...ctx, italic, bold: bold || heading, pre };
		if (tag === 'ul' || tag === 'ol') inner.list = [...ctx.list, { ordered: tag === 'ol', n: 0 }];

		const isList = tag === 'ul' || tag === 'ol';
		let s = '';
		for (let c = el.firstChild; c; c = c.nextSibling) {
			if (isList && c.nodeType !== 1) continue; // whitespace between items
			s += convert(c, inner);
		}

		if (tag === 'code' && !pre) return `\`${s.replace(/\\([\\`*_[\]])/g, '$1')}\``;
		if (pre && !ctx.pre) return `\n\n\`\`\`\n${s.replace(/\n+$/, '')}\n\`\`\`\n\n`;
		// Emphasis only where it starts (not on every nested element), never for heading weight.
		if (bold && !ctx.bold && !heading) s = wrap(s, '**');
		if (italic && !ctx.italic) s = wrap(s, '*');
		if (tag === 'a') {
			const href = el.getAttribute('data-epp-external') ?? el.getAttribute('href') ?? '';
			if (/^https?:/i.test(href) && s.trim()) s = `[${s.trim()}](${href})`;
		}
		if (heading) return `\n\n${'#'.repeat(Number(tag[1]))} ${s.trim()}\n\n`;
		if (tag === 'li') {
			const list = ctx.list[ctx.list.length - 1];
			const indent = '    '.repeat(Math.max(0, ctx.list.length - 1));
			const marker = list?.ordered ? `${++list.n}.` : '-';
			// Tight items: nested list lines keep their own indent, other continuation lines are indented.
			const lines = s
				.trim()
				.split('\n')
				.filter((l) => l.trim());
			const body = lines.map((l, i) => (i === 0 ? l.trim() : /^\s*(-|\d+\.)\s/.test(l) ? l : `${indent}    ${l.trim()}`)).join('\n');
			return `${indent}${marker} ${body}\n`;
		}
		if (isList) return ctx.list.length ? `\n${s.replace(/\n+$/, '')}\n` : `\n\n${s.replace(/\n+$/, '')}\n\n`;
		if (tag === 'blockquote') {
			const q = s.trim().replace(/\n{3,}/g, '\n\n').split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n');
			return `\n\n${q}\n\n`;
		}
		if (tag === 'td' || tag === 'th') return ` ${s.trim()} |`;
		if (BLOCK.has(tag) || cs.display === 'block' || cs.display === 'list-item') return `\n\n${s}\n\n`;
		return s;
	};

	let out: string;
	if (root.nodeType === 3 || root.nodeType === 4) {
		// Selection within one text node: its element decides emphasis.
		const parent = root.parentElement;
		const cs = parent ? style(parent) : null;
		start.pre = !!cs && /^pre/.test(cs.whiteSpace);
		out = text(root as Text, start);
		if (cs && Number(cs.fontWeight) >= 600 && !/^h[1-6]$/.test(parent!.localName)) out = wrap(out, '**');
		if (cs && (cs.fontStyle === 'italic' || cs.fontStyle === 'oblique')) out = wrap(out, '*');
	} else out = convert(root, start);
	return out
		.replace(/[ \t]+\n/g, (m) => (m.startsWith('  ') ? '  \n' : '\n'))
		.replace(/\n\n[ \t]+/g, '\n\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}
