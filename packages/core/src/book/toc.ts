import type { TocItem } from 'file-plus-plus/core';
import { resolvePath } from '../util/path';
import { attrLocal, child, children, descendants, textOf } from './xml';

/** EPUB TOC items' `href`s are zip-relative paths with an optional `#fragment` (empty for unlinked headings). */
export { flattenToc, type TocItem } from 'file-plus-plus/core';

let counter = 0;
const nextId = () => `toc-${++counter}`;

/** EPUB 3 navigation document: `<nav epub:type="toc"><ol><li><a href>…` */
export function parseNav(doc: Document, navPath: string): TocItem[] {
	const navs = descendants(doc, 'nav');
	const nav = navs.find((n) => (attrLocal(n, 'type') ?? '').split(/\s+/).includes('toc')) ?? navs[0];
	if (!nav) return [];
	const ol = descendants(nav, 'ol')[0];
	return ol ? parseOl(ol, navPath, 0) : [];
}

function parseOl(ol: Element, base: string, depth: number): TocItem[] {
	const items: TocItem[] = [];
	for (const li of children(ol, 'li')) {
		const a = child(li, 'a') ?? child(li, 'span');
		const sub = child(li, 'ol');
		const href = a?.localName === 'a' ? a.getAttribute('href') : null;
		items.push({
			id: nextId(),
			label: textOf(a) || attrLocal(a ?? li, 'title') || '',
			href: href ? resolvePath(base, href) : '',
			children: sub ? parseOl(sub, base, depth + 1) : [],
			depth,
		});
	}
	return items;
}

/** EPUB 2 NCX: `<navMap><navPoint><navLabel><text/>…<content src/>` */
export function parseNcx(doc: Document, ncxPath: string): TocItem[] {
	const navMap = descendants(doc, 'navMap')[0];
	return navMap ? parseNavPoints(navMap, ncxPath, 0) : [];
}

function parseNavPoints(parent: Element, base: string, depth: number): TocItem[] {
	return children(parent, 'navPoint').map((np) => {
		const label = textOf(descendants(child(np, 'navLabel') ?? np, 'text')[0]);
		const src = child(np, 'content')?.getAttribute('src');
		return {
			id: nextId(),
			label,
			href: src ? resolvePath(base, src) : '',
			children: parseNavPoints(np, base, depth + 1),
			depth,
		};
	});
}
