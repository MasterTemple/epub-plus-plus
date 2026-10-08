import * as csstree from 'css-tree';
import { PREFIX } from 'file-plus-plus/core';
import { isExternal, resolvePath } from '../util/path';

/**
 * Rewrites publisher CSS so it can live inside the reader's shadow root:
 *
 * - `html` / `:root` / `body` selectors target the wrapper elements standing in for them.
 * - Every rule is prefixed with `.epp-html` (optionally restricted to the chapters that link the sheet).
 * - Absolute font sizes and `rem` become multiples of the reader's font size variable, so the user's font size scales
 *   the whole book while the publisher's relative proportions are preserved.
 * - `font-family`, `line-height`, `color`, `background-color` and `text-align` fall back through CSS
 *   variables, so reader settings can override them live without re-rendering.
 * - `@font-face` rules are extracted (they don't work inside shadow roots) and families renamed to avoid
 *   clashes with the host page.
 * - `url()` references are resolved to blob URLs.
 */

/** The reader's variables (set by file-plus-plus from the reading settings). */
export const CSS_VARS = {
	fontSize: `--${PREFIX}-font-size`,
	fontFamily: `--${PREFIX}-font-family`,
	lineHeight: `--${PREFIX}-line-height`,
	textColor: `--${PREFIX}-text-color`,
	linkColor: `--${PREFIX}-link-color`,
	bgOverride: `--${PREFIX}-bg-override`,
	textAlign: `--${PREFIX}-text-align`,
} as const;

const ABSOLUTE_UNITS: Record<string, number> = {
	px: 1,
	pt: 4 / 3,
	pc: 16,
	in: 96,
	cm: 96 / 2.54,
	mm: 96 / 25.4,
	q: 96 / 101.6,
};

const SIZE_KEYWORDS: Record<string, number> = {
	'xx-small': 9 / 16,
	'x-small': 10 / 16,
	small: 13 / 16,
	medium: 1,
	large: 18 / 16,
	'x-large': 24 / 16,
	'xx-large': 2,
	'xxx-large': 3,
};

const round = (n: number) => Math.round(n * 10000) / 10000;
const scaled = (factor: number) => `calc(${round(factor)} * var(${CSS_VARS.fontSize}))`;

export interface CssProcessorOptions {
	/** Map a zip path to a URL usable by the renderer (usually a blob URL). */
	resolveUrl: (path: string) => string | null;
	/** Load the text of another stylesheet (for `@import`). */
	loadText: (path: string) => string | null;
	/** Prefix used to rename `@font-face` families; should be unique per book. */
	fontPrefix: string;
}

interface Sheet {
	id: string;
	path: string;
	ast: csstree.CssNode;
}

const MONO = /mono|courier|consolas|menlo|code/i;

export class CssProcessor {
	private sheets: Sheet[] = [];
	private fontFamilies = new Map<string, string>();
	private fontFaces: string[] = [];
	/** Publisher root font-size relative to 16px (e.g. `html { font-size: 62.5% }` → 0.625). */
	private rootScale = 1;

	constructor(private readonly opts: CssProcessorOptions) {}

	/** Register a stylesheet. Must be called for all sheets before `build()`. */
	addSheet(id: string, text: string, path: string): void {
		const ast = this.parse(text, path, new Set([path]));
		this.collectFontFaces(ast, path);
		this.collectRootScale(ast);
		this.sheets.push({ id, path, ast });
	}

	private parse(text: string, path: string, seen: Set<string>): csstree.CssNode {
		const ast = csstree.parse(text, { parseValue: true, onParseError: () => {} });
		// Inline @import recursively so url() resolution and scoping apply uniformly.
		csstree.walk(ast, {
			visit: 'Atrule',
			enter: (node, item, list) => {
				if (node.name.toLowerCase() !== 'import' || !list || !node.prelude) return;
				let href: string | null = null;
				csstree.walk(node.prelude, (n) => {
					if (href) return;
					if (n.type === 'Url') href = n.value;
					else if (n.type === 'String') href = n.value;
				});
				if (!href || isExternal(href)) {
					list.remove(item);
					return;
				}
				const target = resolvePath(path, href);
				const imported = !seen.has(target) ? this.opts.loadText(target) : null;
				if (imported != null) {
					seen.add(target);
					const sub = this.parse(imported, target, seen) as csstree.StyleSheet;
					const media = csstree.generate(node.prelude).replace(/^\s*(url\([^)]*\)|"[^"]*"|'[^']*')\s*/, '').trim();
					if (media) {
						const wrapped = csstree.parse(`@media ${media}{}`) as csstree.StyleSheet;
						const at = wrapped.children.first as csstree.Atrule;
						(at.block as csstree.Block).children = sub.children;
						list.insert(list.createItem(at), item);
					} else {
						sub.children.forEach((n) => list.insert(list.createItem(n), item));
					}
				}
				list.remove(item);
			},
		});
		this.resolveUrls(ast, path);
		return ast;
	}

	private resolveUrls(ast: csstree.CssNode, path: string): void {
		csstree.walk(ast, {
			visit: 'Url',
			enter: (node) => {
				if (isExternal(node.value) || node.value.startsWith('#')) return;
				const resolved = resolvePath(path, node.value).split('#')[0];
				const url = this.opts.resolveUrl(resolved);
				if (url) node.value = url;
			},
		});
	}

	private collectFontFaces(ast: csstree.CssNode, _path: string): void {
		csstree.walk(ast, {
			visit: 'Atrule',
			enter: (node, item, list) => {
				if (node.name.toLowerCase() !== 'font-face' || !node.block) return;
				csstree.walk(node.block, {
					visit: 'Declaration',
					enter: (decl) => {
						if (decl.property.toLowerCase() !== 'font-family') return;
						const name = unquote(csstree.generate(decl.value));
						let renamed = this.fontFamilies.get(name.toLowerCase());
						if (!renamed) {
							renamed = `${this.opts.fontPrefix}-${name.replace(/[^\w-]/g, '_')}`;
							this.fontFamilies.set(name.toLowerCase(), renamed);
						}
						decl.value = { type: 'Raw', value: `"${renamed}"` };
					},
				});
				this.fontFaces.push(csstree.generate(node));
				list?.remove(item);
			},
		});
	}

	private collectRootScale(ast: csstree.CssNode): void {
		csstree.walk(ast, {
			visit: 'Rule',
			enter: (rule) => {
				const sel = csstree.generate(rule.prelude);
				if (!/^\s*(html|:root)\s*$/i.test(sel)) return;
				csstree.walk(rule.block, {
					visit: 'Declaration',
					enter: (decl) => {
						if (decl.property.toLowerCase() !== 'font-size') return;
						const v = decl.value.type === 'Value' ? decl.value.children.first : null;
						if (!v) return;
						if (v.type === 'Percentage') this.rootScale = parseFloat(v.value) / 100;
						else if (v.type === 'Dimension') {
							const u = v.unit.toLowerCase();
							if (u in ABSOLUTE_UNITS) this.rootScale = (parseFloat(v.value) * ABSOLUTE_UNITS[u]) / 16;
							else if (u === 'em' || u === 'rem') this.rootScale = parseFloat(v.value);
						} else if (v.type === 'Identifier' && v.name in SIZE_KEYWORDS) this.rootScale = SIZE_KEYWORDS[v.name];
					},
				});
			},
		});
	}

	/**
	 * Produce the final stylesheets. `usage` maps sheet id → number of spine items using it; sheets used by
	 * every spine item are not restricted to particular chapters.
	 */
	build(scoped: Set<string>): { css: string; fontFaces: string } {
		const out: string[] = [];
		for (const sheet of this.sheets) {
			const scope = scoped.has(sheet.id) ? `[data-epp-css~="${sheet.id}"]` : '';
			this.transformRules(sheet.ast, scope);
			out.push(`/* ${sheet.path} */\n${csstree.generate(sheet.ast)}`);
		}
		return { css: out.join('\n'), fontFaces: this.fontFaces.join('\n') };
	}

	/** Rewrite a `<style>` element body found inside content (scoped to the given attribute selector). */
	rewriteInlineSheet(text: string, path: string, scopeAttr: string): string {
		const ast = this.parse(text, path, new Set([path]));
		this.collectFontFaces(ast, path);
		this.transformRules(ast, scopeAttr);
		return csstree.generate(ast);
	}

	/** Rewrite a `style="..."` attribute. */
	rewriteStyleAttribute(text: string, path: string): string {
		try {
			const ast = csstree.parse(text, { context: 'declarationList', parseValue: true, onParseError: () => {} });
			this.resolveUrls(ast, path);
			csstree.walk(ast, { visit: 'Declaration', enter: (d) => this.transformDeclaration(d) });
			return csstree.generate(ast);
		} catch {
			return text;
		}
	}

	private transformRules(ast: csstree.CssNode, scope: string): void {
		csstree.walk(ast, {
			visit: 'Atrule',
			enter: (node, item, list) => {
				const name = node.name.toLowerCase();
				// Paged-media and namespace rules have no meaning in a scrolling shadow root.
				if ((name === 'page' || name === 'namespace' || name === 'charset') && list) list.remove(item);
			},
		});
		csstree.walk(ast, {
			visit: 'Rule',
			enter: (rule, _item, _list) => {
				if (isInKeyframes(ast, rule)) return;
				if (rule.prelude.type === 'SelectorList') {
					rule.prelude.children.forEach((sel) => {
						if (sel.type === 'Selector') this.transformSelector(sel, scope);
					});
				}
				csstree.walk(rule.block, { visit: 'Declaration', enter: (d) => this.transformDeclaration(d) });
			},
		});
	}

	private transformSelector(sel: csstree.Selector, scope: string): void {
		// Map html/:root/body anywhere (including inside :not(), :is() ...).
		csstree.walk(sel, {
			enter: (node: csstree.CssNode, item: csstree.ListItem<csstree.CssNode>, list: csstree.List<csstree.CssNode>) => {
				if (!list) return;
				if (node.type === 'TypeSelector') {
					const n = node.name.toLowerCase();
					if (n === 'html' || n === 'body')
						list.replace(item, list.createItem({ type: 'ClassSelector', name: `epp-${n}` }));
				} else if (node.type === 'PseudoClassSelector' && node.name.toLowerCase() === 'root') {
					list.replace(item, list.createItem({ type: 'ClassSelector', name: 'epp-html' }));
				}
			},
		});
		const first = sel.children.first;
		const startsWithHtml = first?.type === 'ClassSelector' && first.name === 'epp-html';
		if (startsWithHtml) {
			if (scope) sel.children.insert(sel.children.createItem({ type: 'Raw', value: scope }), (sel.children as any).head?.next ?? undefined);
		} else {
			sel.children.prepend(sel.children.createItem({ type: 'Combinator', name: ' ' }));
			sel.children.prepend(sel.children.createItem({ type: 'Raw', value: `.epp-html${scope}` }));
		}
	}

	private transformDeclaration(decl: csstree.Declaration): void {
		const prop = decl.property.toLowerCase();
		if (prop.startsWith('--')) return;
		const important = decl.important;

		if (prop === 'font-size' || prop === 'font') this.scaleFontSizes(decl.value, prop === 'font-size');
		this.convertRem(decl.value);
		if (prop === 'font-family' || prop === 'font') this.renameFamilies(decl.value);

		const value = () => csstree.generate(decl.value);
		const wrap = (v: string) => {
			decl.value = { type: 'Raw', value: `var(${v}, ${value()})` };
		};
		switch (prop) {
			case 'font-family':
				if (!MONO.test(value())) wrap(CSS_VARS.fontFamily);
				break;
			case 'line-height':
				wrap(CSS_VARS.lineHeight);
				break;
			case 'color':
				wrap(CSS_VARS.textColor);
				break;
			case 'background-color':
				wrap(CSS_VARS.bgOverride);
				break;
			case 'background':
				if (isSingleColor(decl.value)) wrap(CSS_VARS.bgOverride);
				break;
			case 'text-align':
				if (/^(left|justify|start)$/i.test(value().trim())) wrap(CSS_VARS.textAlign);
				break;
		}
		decl.important = important;
	}

	private scaleFontSizes(value: csstree.CssNode, keywords: boolean): void {
		csstree.walk(value, {
			enter: (node: csstree.CssNode, item: csstree.ListItem<csstree.CssNode>, list: csstree.List<csstree.CssNode>) => {
				if (!list) return;
				if (node.type === 'Dimension') {
					const factor = ABSOLUTE_UNITS[node.unit.toLowerCase()];
					if (factor) list.replace(item, list.createItem({ type: 'Raw', value: scaled((parseFloat(node.value) * factor) / 16) }));
				} else if (keywords && node.type === 'Identifier') {
					const f = SIZE_KEYWORDS[node.name.toLowerCase()];
					if (f) list.replace(item, list.createItem({ type: 'Raw', value: scaled(f) }));
				}
			},
		});
	}

	/** `rem` inside a shadow root refers to the host page's root; re-anchor it to the book's root size. */
	private convertRem(value: csstree.CssNode): void {
		csstree.walk(value, {
			visit: 'Dimension',
			enter: (node, item, list) => {
				if (list && node.unit.toLowerCase() === 'rem')
					list.replace(item, list.createItem({ type: 'Raw', value: scaled(parseFloat(node.value) * this.rootScale) }));
			},
		});
	}

	private renameFamilies(value: csstree.CssNode): void {
		if (!this.fontFamilies.size) return;
		csstree.walk(value, {
			enter: (node: csstree.CssNode, item: csstree.ListItem<csstree.CssNode>, list: csstree.List<csstree.CssNode>) => {
				if (!list) return;
				if (node.type === 'String' || node.type === 'Identifier') {
					const name = node.type === 'String' ? node.value : node.name;
					const renamed = this.fontFamilies.get(name.toLowerCase());
					if (renamed) list.replace(item, list.createItem({ type: 'String', value: renamed }));
				}
			},
		});
	}
}

const keyframeRules = new WeakSet<csstree.CssNode>();
function isInKeyframes(ast: csstree.CssNode, rule: csstree.Rule): boolean {
	if (!keyframeRules.has(ast)) {
		keyframeRules.add(ast);
		csstree.walk(ast, {
			visit: 'Atrule',
			enter: (at) => {
				if (/keyframes$/i.test(at.name) && at.block) csstree.walk(at.block, { visit: 'Rule', enter: (r) => void keyframeRules.add(r) });
			},
		});
	}
	return keyframeRules.has(rule);
}

function unquote(s: string): string {
	return s.trim().replace(/^["']|["']$/g, '');
}

function isSingleColor(value: csstree.CssNode): boolean {
	if (value.type !== 'Value' || value.children.size !== 1) return false;
	const n = value.children.first!;
	if (n.type === 'Hash') return true;
	if (n.type === 'Function') return /^(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)$/i.test(n.name);
	if (n.type === 'Identifier') return !/^(none|inherit|initial|unset|revert)$/i.test(n.name);
	return false;
}
