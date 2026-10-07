/** Path helpers for resolving references inside the EPUB zip container. All paths are zip-relative, no leading slash. */

export function dirname(path: string): string {
	const i = path.lastIndexOf('/');
	return i === -1 ? '' : path.slice(0, i);
}

/** Split `a/b.xhtml#frag` into path and fragment (fragment without `#`). */
export function splitFragment(href: string): { path: string; fragment: string | null } {
	const i = href.indexOf('#');
	if (i === -1) return { path: href, fragment: null };
	return { path: href.slice(0, i), fragment: href.slice(i + 1) };
}

/** True for absolute URLs (http:, mailto:, data:, blob: ...). */
export function isExternal(href: string): boolean {
	return /^[a-z][a-z0-9+.-]*:/i.test(href);
}

/** Resolve `href` relative to the directory containing `base` (a file path). Fragment is preserved. */
export function resolvePath(base: string, href: string): string {
	if (isExternal(href)) return href;
	const { path, fragment } = splitFragment(href);
	if (path === '') return fragment === null ? base : `${base}#${fragment}`;
	let decoded = path;
	try {
		decoded = decodeURIComponent(path);
	} catch {
		/* keep raw */
	}
	const parts = decoded.startsWith('/') ? [] : dirname(base).split('/').filter(Boolean);
	for (const seg of decoded.split('/')) {
		if (seg === '' || seg === '.') continue;
		if (seg === '..') parts.pop();
		else parts.push(seg);
	}
	const resolved = parts.join('/');
	return fragment === null ? resolved : `${resolved}#${fragment}`;
}
