import esbuild from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const prod = process.argv[2] === 'production';
const here = import.meta.dir;
const outdir = join(here, 'dist');
mkdirSync(outdir, { recursive: true });

const copyStatic = {
	name: 'copy-static',
	setup(build: esbuild.PluginBuild) {
		build.onEnd(() => {
			for (const f of ['manifest.json', 'styles.css']) copyFileSync(join(here, f), join(outdir, f));
		});
	},
};

const ctx = await esbuild.context({
	entryPoints: [join(here, 'src/main.ts')],
	bundle: true,
	external: ['obsidian', 'electron', '@codemirror/*', '@lezer/*'],
	format: 'cjs',
	target: 'es2022',
	platform: 'browser',
	mainFields: ['browser', 'module', 'main'],
	sourcemap: prod ? false : 'inline',
	minify: prod,
	treeShaking: true,
	logLevel: 'info',
	outfile: join(outdir, 'main.js'),
	plugins: [copyStatic],
});

if (prod) {
	await ctx.rebuild();
	await ctx.dispose();
} else {
	await ctx.watch();
}
