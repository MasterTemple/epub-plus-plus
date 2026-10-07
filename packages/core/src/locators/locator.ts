/**
 * Parsing of link subpaths / locators, e.g.
 *
 *   `#epubcfi(/6/4!/4/2,/1:0,/1:12)&color=yellow`
 *   `:~:text=call%20me-,Ishmael&color=red`
 *   `chapter_001.xhtml#c001p0003`
 *
 * Parameters after the locator are `&key=value` pairs (PDF++ style). The input may have been
 * percent-decoded once already (Obsidian decodes markdown link targets), or not at all.
 */
export interface ParsedLocator {
	cfi?: string;
	/** The full directive, `:~:text=...` */
	textFragment?: string;
	href?: string;
	params: Record<string, string>;
}

function safeDecode(s: string): string {
	try {
		return decodeURIComponent(s);
	} catch {
		return s;
	}
}

export function parseLocator(input: string): ParsedLocator {
	let s = input.trim().replace(/^#/, '');
	if (/^epubcfi%28/i.test(s)) s = safeDecode(s);
	// Markdown links reach us after Obsidian's decodeURI, which leaves %3A / %2C encoded.
	s = s.replace(/^%3A~%3A/i, ':~:');
	const params: Record<string, string> = {};
	const out: ParsedLocator = { params };

	if (s.startsWith('epubcfi(')) {
		// Find the matching close paren, honoring ^-escapes.
		let depth = 0;
		let end = -1;
		for (let i = 0; i < s.length; i++) {
			const c = s[i];
			if (c === '^') {
				i++;
				continue;
			}
			if (c === '(') depth++;
			else if (c === ')' && --depth === 0) {
				end = i;
				break;
			}
		}
		if (end === -1) end = s.length - 1;
		out.cfi = s.slice(0, end + 1);
		if (out.cfi.includes('%')) out.cfi = safeDecode(out.cfi);
		s = s.slice(end + 1);
	} else {
		const m = /^(?::~:)?(text=[^&]*)/.exec(s);
		if (m) {
			out.textFragment = `:~:${m[1]}`;
			s = s.slice(m[0].length);
		} else if (s && !/^[\w-]+=/.test(s)) {
			// href (may itself contain a '#fragment'); params follow '&'
			const amp = s.search(/&[\w-]+=/);
			out.href = amp === -1 ? s : s.slice(0, amp);
			s = amp === -1 ? '' : s.slice(amp);
		}
	}

	for (const part of s.split('&')) {
		if (!part) continue;
		const eq = part.indexOf('=');
		if (eq === -1) continue;
		params[safeDecode(part.slice(0, eq))] = safeDecode(part.slice(eq + 1));
	}
	return out;
}

/** Build a subpath (without `#`) from a locator and params. */
export function formatLocator(locator: string, params: Record<string, string | undefined> = {}): string {
	let s = locator.replace(/^#/, '');
	for (const [k, v] of Object.entries(params)) if (v) s += `&${k}=${encodeURIComponent(v)}`;
	return s;
}

/** True when a subpath looks like an EPUB locator we handle (CFI or text fragment). */
export function isEpubLocator(subpath: string): boolean {
	const l = parseLocator(subpath);
	return !!(l.cfi || l.textFragment);
}
