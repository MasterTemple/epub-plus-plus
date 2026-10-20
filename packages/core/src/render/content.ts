import type { EpubBook, SpineItem } from '../book/epub';
import { children } from '../book/xml';
import type { CssProcessor } from '../css/rewrite';
import { elementSteps, type CfiStep } from '../locators/cfi';
import { PREFIX } from 'file-plus-plus/core';
import { isExternal, resolvePath } from '../util/path';

export interface SheetRef {
	key: string;
	path: string;
	text: string;
}

export interface PreparedSection {
	item: SpineItem;
	doc: Document;
	/** CFI step of `<body>` inside `<html>` in the original document (usually `/4`). */
	bodyStep: CfiStep;
	sheets: SheetRef[];
}

/** Parse a spine item and collect its stylesheets (first pass; no DOM output yet). */
export function prepareSection(book: EpubBook, item: SpineItem, text?: string): PreparedSection {
	const doc = book.loadDocument(item, text);
	const html = doc.documentElement;
	const body = children(html, 'body')[0] ?? html;
	const bodyStep = body === html ? { index: 4 } : elementSteps(html, body)[0];
	const sheets: SheetRef[] = [];
	const head = children(html, 'head')[0];
	for (const el of head ? Array.from(head.children) : []) {
		if (el.localName === 'link' && /\bstylesheet\b/i.test(el.getAttribute('rel') ?? '') && !/\balternate\b/i.test(el.getAttribute('rel') ?? '')) {
			const href = el.getAttribute('href');
			if (!href || isExternal(href)) continue;
			const path = resolvePath(item.href, href).split('#')[0];
			if (book.has(path)) sheets.push({ key: `file:${path}`, path, text: book.text(path) });
		} else if (el.localName === 'style') {
			const text = el.textContent ?? '';
			sheets.push({ key: `inline:${text}`, path: item.href, text });
		}
	}
	return { item, doc, bodyStep, sheets };
}

const URL_ATTRS: Record<string, string[]> = {
	img: ['src'],
	image: ['href', 'xlink:href'],
	source: ['src'],
	audio: ['src'],
	video: ['src', 'poster'],
	track: ['src'],
	object: ['data'],
	embed: ['src'],
	input: ['src'],
	use: ['href', 'xlink:href'],
};

const XLINK = 'http://www.w3.org/1999/xlink';
const OPS = 'http://www.idpf.org/2007/ops';
const JS_URL = /^\s*javascript:/i;

/**
 * Import a prepared section into the target document. The body's child nodes are imported unchanged
 * (structurally), so CFIs computed against the rendered DOM match the original document.
 */
export function buildSection(
	target: Document,
	book: EpubBook,
	sec: PreparedSection,
	css: CssProcessor,
	sheetIds: string[],
): { wrapper: HTMLElement; body: HTMLElement } {
	const { doc, item } = sec;
	const html = doc.documentElement;
	const body = children(html, 'body')[0] ?? html;

	const wrapper = target.createElement('div');
	wrapper.className = 'epp-html';
	copyAttributes(html, wrapper, css, item.href);
	wrapper.classList.add('epp-html');
	wrapper.setAttribute('data-epp-spine', String(item.index));
	wrapper.setAttribute('data-epp-href', item.href);
	if (sheetIds.length) wrapper.setAttribute('data-epp-css', sheetIds.join(' '));

	const bodyEl = target.createElement('div');
	copyAttributes(body, bodyEl, css, item.href);
	bodyEl.classList.add('epp-body');
	wrapper.appendChild(bodyEl);

	// Neutralize scripts before import so they can never run.
	for (const s of Array.from(body.getElementsByTagNameNS('*', 'script'))) s.setAttribute('type', 'text/x-epp-disabled');

	// Adopted, not cloned: the parsed document is thrown away.
	for (const n of Array.from(body.childNodes)) bodyEl.appendChild(target.adoptNode(n));

	const walker = target.createTreeWalker(bodyEl, NodeFilter.SHOW_ELEMENT);
	for (let n = walker.nextNode() as Element | null; n; n = walker.nextNode() as Element | null) {
		processElement(n, book, item.href, css, item.index);
	}
	const textLength = bodyEl.textContent?.length ?? 0;
	// Rough height estimate (in lines of ~70 chars) so content-visibility placeholders keep the scrollbar sane.
	const lines = Math.max(4, Math.ceil(textLength / 70));
	wrapper.style.setProperty('contain-intrinsic-size', `auto ${Math.round(lines * 1.5)}em`);
	return { wrapper, body: bodyEl };
}

function copyAttributes(from: Element, to: HTMLElement, css: CssProcessor, base: string): void {
	for (const a of Array.from(from.attributes)) {
		const name = a.localName;
		if (a.name.startsWith('xmlns')) continue;
		if (/^on/i.test(name)) continue;
		if (name === 'style') to.setAttribute('style', css.rewriteStyleAttribute(a.value, base));
		else if (name === 'lang' || a.name === 'xml:lang') to.setAttribute('lang', a.value);
		else if (name === 'class') to.className = a.value;
		else if (!a.namespaceURI) to.setAttribute(name, a.value);
		else if (name === 'type') to.setAttribute('data-epub-type', a.value);
	}
}

function processElement(el: Element, book: EpubBook, base: string, css: CssProcessor, spineIndex: number): void {
	const name = el.localName;
	if (!el.hasAttributes()) {
		if (name === 'style') el.textContent = css.rewriteInlineSheet(el.textContent ?? '', base, `[data-epp-spine="${spineIndex}"]`);
		return;
	}
	const attrs = el.attributes;
	for (let i = attrs.length - 1; i >= 0; i--) {
		const a = attrs[i];
		const local = a.localName;
		if ((local.charCodeAt(0) | 32) === 111 && (local.charCodeAt(1) | 32) === 110) el.removeAttributeNode(a); // on…
		else if (a.value.indexOf(':') !== -1 && JS_URL.test(a.value)) el.removeAttributeNode(a);
		// Before the namespace test: the HTML parser (malformed or text/html chapters) gives xml:lang none.
		else if (a.name === 'xml:lang') el.setAttribute('lang', a.value);
		else if (a.namespaceURI === null) continue;
		else if (local === 'type' && a.namespaceURI === OPS) el.setAttribute('data-epub-type', a.value);
	}
	const style = el.getAttribute('style');
	if (style) el.setAttribute('style', css.rewriteStyleAttribute(style, base));

	const urlAttrs = URL_ATTRS[name];
	if (urlAttrs) {
		for (const attr of urlAttrs) {
			const isX = attr.startsWith('xlink:');
			const v = isX ? el.getAttributeNS(XLINK, 'href') : el.getAttribute(attr);
			if (!v || isExternal(v) || v.startsWith('#')) continue;
			const path = resolvePath(base, v).split('#')[0];
			const set = (url: string) => {
				if (isX) el.setAttributeNS(XLINK, 'xlink:href', url);
				else el.setAttribute(attr, url);
				// A <source> added late is only noticed when its audio or video loads again.
				if (name === 'source') (el.parentElement as HTMLMediaElement | null)?.load?.();
			};
			const made = book.cachedBlobUrl(path);
			if (made) set(made);
			else {
				// Images are most of a book's bytes: inflated off the main thread, set when ready (never fetched from the app's origin).
				if (isX) el.removeAttributeNS(XLINK, 'href');
				else el.removeAttribute(attr);
				void book.blobUrlAsync(path).then((url) => url && set(url));
			}
		}
		if (name === 'img') el.removeAttribute('srcset');
	}

	if (name === 'a' || (name === 'area' && el.hasAttribute('href'))) {
		const href = el.getAttribute('href') ?? el.getAttributeNS(XLINK, 'href');
		if (href) {
			// The reader handles clicks on these (internal links jump, external ones are reported).
			if (isExternal(href)) el.setAttribute(`data-${PREFIX}-external`, href);
			else {
				el.setAttribute(`data-${PREFIX}-href`, resolvePath(base, href));
				el.setAttribute('href', '#');
			}
		}
	} else if (name === 'style') {
		el.textContent = css.rewriteInlineSheet(el.textContent ?? '', base, `[data-epp-spine="${spineIndex}"]`);
	} else if (name === 'iframe' || name === 'frame') {
		el.removeAttribute('src');
		el.removeAttribute('srcdoc');
	} else if (name === 'link') {
		el.removeAttribute('href');
	}
}
