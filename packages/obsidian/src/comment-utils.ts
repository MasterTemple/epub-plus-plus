/**
 * Comments on highlights, stored in the note next to the highlight's link (pure text logic).
 *
 * The layout is the one the "Callout with comment" format produces:
 *
 *   > [!quote|yellow] [[Book.epub#epubcfi(...)|Book]]   ← header (contains the link)
 *   > > the highlighted text, double-embedded             ← quote
 *   >                                                     ← separator
 *   > the comment                                         ← comment
 *
 * A callout without the separator (`> [!quote] link` + `> text`) has no comment yet; adding one
 * double-embeds its existing lines (as they are, so the user's formatting survives) and appends it.
 */

const QUOTE = /^(\s*)>/;
const NESTED = /^\s*>\s?>/;
const BLANK_QUOTE = /^\s*>\s*$/;

export interface CommentLayout {
	/** The link is in a blockquote/callout (false: a plain paragraph). */
	quoted: boolean;
	/** Line range of the blockquote or paragraph (inclusive). */
	start: number;
	end: number;
	/** Line range of the double-embedded quote, or null. */
	nested: [number, number] | null;
	/** Line of the separator before the comment, or null when there is no comment. */
	separator: number | null;
}

export function commentLayout(lines: string[], linkLine: number): CommentLayout {
	if (!QUOTE.test(lines[linkLine] ?? '')) {
		let start = linkLine;
		let end = linkLine;
		while (start > 0 && lines[start - 1].trim()) start--;
		while (end + 1 < lines.length && lines[end + 1].trim()) end++;
		return { quoted: false, start, end, nested: null, separator: null };
	}
	let start = linkLine;
	let end = linkLine;
	while (start > 0 && QUOTE.test(lines[start - 1])) start--;
	while (end + 1 < lines.length && QUOTE.test(lines[end + 1])) end++;
	let i = start + 1;
	let nested: [number, number] | null = null;
	while (i <= end && NESTED.test(lines[i])) i++;
	if (i > start + 1) nested = [start + 1, i - 1];
	const separator = i <= end && BLANK_QUOTE.test(lines[i]) && i < end ? i : null;
	return { quoted: true, start, end, nested, separator };
}

/** The comment of the highlight whose link is on `linkLine`, or null. */
export function getComment(lines: string[], linkLine: number): string | null {
	const l = commentLayout(lines, linkLine);
	if (!l.quoted || l.separator === null) return null;
	const text = lines
		.slice(l.separator + 1, l.end + 1)
		.map((line) => line.replace(/^\s*> ?/, ''))
		.join('\n')
		.trim();
	return text || null;
}

const asQuote = (comment: string) =>
	comment
		.trim()
		.split('\n')
		.map((l) => (l.trim() ? `> ${l}` : '>'));

/**
 * Set (or with an empty string, remove) the comment of the highlight on `linkLine`.
 * `color` is used when a plain paragraph has to become a callout.
 */
export function setComment(lines: string[], linkLine: number, comment: string, color: string | null): string[] {
	const l = commentLayout(lines, linkLine);
	const out = lines.slice();
	const text = comment.trim();
	if (!l.quoted) {
		if (!text) return out;
		const para = lines.slice(l.start, l.end + 1);
		const callout = [`> [!quote${color ? `|${color}` : ''}] ${para[0]}`, ...para.slice(1).map((p) => `> ${p}`), '>', ...asQuote(text)];
		out.splice(l.start, para.length, ...callout);
		return out;
	}
	if (l.separator !== null) {
		// Replace the existing comment (or remove it together with its separator).
		out.splice(l.separator, l.end - l.separator + 1, ...(text ? ['>', ...asQuote(text)] : []));
		return out;
	}
	if (!text) return out;
	if (l.nested) {
		out.splice(l.nested[1] + 1, 0, '>', ...asQuote(text));
		return out;
	}
	// Double-embed the existing quote lines in place, then add the comment.
	const body = lines.slice(l.start + 1, l.end + 1).map((line) => (BLANK_QUOTE.test(line) ? line.replace(/>\s*$/, '> >') : line.replace(/^(\s*)> ?/, '$1> > ')));
	out.splice(l.start + 1, body.length, ...body, '>', ...asQuote(text));
	return out;
}
