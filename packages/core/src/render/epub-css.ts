import { PREFIX } from 'file-plus-plus/core';

/** Styles for EPUB content inside the reader's shadow root, after file-plus-plus's base styles. */
export const EPUB_CSS = /* css */ `
@layer ${PREFIX}-user {
	/* Footnote references: small and raised. A publisher's <sup> around or inside the link isn't shrunk twice. */
	.epp-html :is(a[data-epub-type~="noteref"], a[role="doc-noteref"]):not(sup a),
	.epp-html sup:has(a[data-epub-type~="noteref"], a[role="doc-noteref"]) {
		font-size: 0.7em;
		vertical-align: super;
		line-height: 0;
	}
	.epp-html :is(a[data-epub-type~="noteref"], a[role="doc-noteref"]) sup,
	.epp-html sup :is(a[data-epub-type~="noteref"], a[role="doc-noteref"]) {
		font-size: inherit;
		vertical-align: baseline;
	}
}
`;
