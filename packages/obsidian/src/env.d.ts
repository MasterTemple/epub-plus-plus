/** fff-epub's WebAssembly, embedded by esbuild's binary loader (esbuild.config.ts) */
declare module 'fff-epub-wasm' {
	const bytes: Uint8Array;
	export default bytes;
}

/** The book search's worker, bundled and embedded as text (esbuild.config.ts) */
declare module 'epp-search-worker' {
	const source: string;
	export default source;
}
