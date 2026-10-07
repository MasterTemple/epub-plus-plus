import { expect, test } from 'bun:test';
import { CssProcessor } from '../src/css/rewrite';

function run(css: string, scoped = false) {
	const p = new CssProcessor({ resolveUrl: (x) => `blob:${x}`, loadText: (x) => (x === 'OPS/css/b.css' ? 'h2{color:blue}' : null), fontPrefix: 'bk' });
	p.addSheet('s1', css, 'OPS/css/a.css');
	return p.build(scoped ? new Set(['s1']) : new Set());
}

test('selectors', () => {
	const { css } = run('html body.x > p:not(body), :root .a, h1 { margin: 0 }');
	expect(css).toContain('.epp-html .epp-body.x>p:not(.epp-body),.epp-html .a,.epp-html h1{margin:0}');
});
test('scoped selectors', () => {
	const { css } = run('html p, p{margin:0}', true);
	expect(css).toContain('.epp-html[data-epp-css~="s1"] p,.epp-html[data-epp-css~="s1"] p{');
});
test('font scaling keeps proportions', () => {
	const { css } = run('p{font-size:12px} h1{font-size:2em} h2{font-size:large} small{font:italic 9pt/1.2 serif} li{margin-left:2rem}');
	expect(css).toContain('font-size:calc(0.75 * var(--epp-font-size))');
	expect(css).toContain('font-size:2em');
	expect(css).toContain('font-size:calc(1.125 * var(--epp-font-size))');
	expect(css).toContain('calc(0.75 * var(--epp-font-size))/1.2');
	expect(css).toContain('margin-left:calc(2 * var(--epp-font-size))');
});
test('rem respects publisher root size', () => {
	const { css } = run('html{font-size:62.5%} p{font-size:1.6rem}');
	expect(css).toContain('font-size:calc(1 * var(--epp-font-size))');
});
test('overridable properties', () => {
	const { css } = run('p{color:#333;line-height:1.4;font-family:Georgia,serif;text-align:justify} pre{font-family:monospace} h1{text-align:center}');
	expect(css).toContain('color:var(--epp-text-color, #333)');
	expect(css).toContain('line-height:var(--epp-line-height, 1.4)');
	expect(css).toContain('font-family:var(--epp-font-family, Georgia,serif)');
	expect(css).toContain('pre{font-family:monospace}');
	expect(css).toContain('text-align:var(--epp-text-align, justify)');
	expect(css).toContain('text-align:center');
});
test('font-face extraction and renaming', () => {
	const r = run(`@font-face{font-family:'Stix';src:url(../fonts/S.otf)} body{font-family:'Stix',serif}`);
	expect(r.fontFaces).toContain('font-family:"bk-Stix"');
	expect(r.fontFaces).toContain('url(blob:OPS/fonts/S.otf)');
	expect(r.css).toContain('"bk-Stix"');
	expect(r.css).not.toContain('@font-face');
});
test('@import inlined', () => {
	const { css } = run('@import url(b.css); p{color:red}');
	expect(css).toContain('.epp-html h2{color:var(--epp-text-color, blue)}');
});
test('style attribute', () => {
	const p = new CssProcessor({ resolveUrl: () => null, loadText: () => null, fontPrefix: 'bk' });
	expect(p.rewriteStyleAttribute('font-size: 24px; color: red', 'a.xhtml')).toBe('font-size:calc(1.5 * var(--epp-font-size));color:var(--epp-text-color, red)');
});
