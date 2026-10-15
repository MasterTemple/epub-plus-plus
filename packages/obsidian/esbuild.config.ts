import esbuild from 'esbuild';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { buildPlugin } from 'file-plus-plus/build';

const production = process.argv[2] === 'production';

// fff-epub's WebAssembly package (book search): its core module, without automatic loading, and
// its .wasm embedded in main.js, so it works offline and on phones
const pkg = realpathSync(join(import.meta.dir, 'node_modules/fff-epub'));
const alias = {
	'fff-epub': join(pkg, 'fff_epub.js'),
	'fff-epub-wasm': join(pkg, 'fff_epub_bg.wasm'),
};

/** The book search's worker, bundled on each build and embedded as text (`epp-search-worker`) */
const searchWorker: esbuild.Plugin = {
	name: 'search-worker',
	setup(build) {
		build.onResolve({ filter: /^epp-search-worker$/ }, (args) => ({ path: args.path, namespace: 'search-worker' }));
		build.onLoad({ filter: /.*/, namespace: 'search-worker' }, async () => {
			const result = await esbuild.build({
				entryPoints: [join(import.meta.dir, 'src/search/worker.ts')],
				bundle: true,
				write: false,
				format: 'iife',
				target: 'es2022',
				minify: production,
				alias,
			});
			return { contents: result.outputFiles[0]!.text, loader: 'text', watchFiles: [join(import.meta.dir, 'src/search/worker.ts')] };
		});
	},
};

await buildPlugin({
	root: import.meta.dir,
	prefix: 'epp',
	production,
	esbuild: {
		alias,
		loader: { '.wasm': 'binary' },
		plugins: [searchWorker],
		// The book search runs fff-epub with Node's modules, which Electron provides on desktop
		external: ['obsidian', 'electron', '@codemirror/*', '@lezer/*', 'node:*'],
	},
});
