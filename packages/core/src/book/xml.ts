/** Namespace-agnostic XML helpers (EPUB files mix default namespaces, prefixes and plain XML). */

export function decodeText(bytes: Uint8Array): string {
	if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
	if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
	const head = new TextDecoder('ascii').decode(bytes.subarray(0, 200));
	const enc = /encoding=["']([\w-]+)["']/i.exec(head)?.[1];
	try {
		return new TextDecoder(enc && !/^utf-?8$/i.test(enc) ? enc : 'utf-8').decode(bytes);
	} catch {
		return new TextDecoder('utf-8').decode(bytes);
	}
}

function hasParserError(doc: Document): boolean {
	return doc.getElementsByTagName('parsererror').length > 0;
}

export function parseXml(text: string): Document {
	return new DOMParser().parseFromString(text, 'application/xml');
}

/** Parse an (X)HTML content document. Falls back to the HTML parser for malformed XHTML. */
export function parseContentDocument(text: string, mediaType: string): Document {
	if (mediaType !== 'text/html') {
		const doc = new DOMParser().parseFromString(text, 'application/xhtml+xml');
		if (!hasParserError(doc)) return doc;
		console.warn('[epub-pp] malformed XHTML, falling back to HTML parser');
	}
	return new DOMParser().parseFromString(text, 'text/html');
}

export function children(el: Element | Document, localName?: string): Element[] {
	const out: Element[] = [];
	for (const c of Array.from(el.children)) if (!localName || c.localName === localName) out.push(c);
	return out;
}

export function child(el: Element | Document, localName: string): Element | null {
	for (const c of Array.from(el.children)) if (c.localName === localName) return c;
	return null;
}

export function descendants(el: Element | Document, localName: string): Element[] {
	const found = Array.from(el.getElementsByTagNameNS('*', localName));
	if (found.length) return found;
	// DOMs without wildcard namespace support (happy-dom, used by the tests).
	return Array.from(el.getElementsByTagName('*')).filter((e) => e.localName === localName);
}

export function textOf(el: Element | null | undefined): string {
	return (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/** Get an attribute irrespective of namespace prefix, e.g. `epub:type`. */
export function attrLocal(el: Element, localName: string): string | null {
	for (const a of Array.from(el.attributes)) if (a.localName === localName) return a.value;
	return null;
}
