// Prepend to page scripts run with `bun scripts/cdp.ts --file …` (wrap everything in one async IIFE):
//   { echo "(async()=>{"; cat scripts/obsidian-helpers.js; echo "…your code…; return …})()"; } > /tmp/x.js
// Top-level `const` in Runtime.evaluate persists across calls, so keep helpers inside the IIFE.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const plugin = () => app.plugins.plugins['epub-plus-plus'];
/** The EPUB view for a vault path (opened from Notes/Moby notes.md if needed), loaded and rendered. */
async function getView(path = 'Books/Moby Dick.epub') {
	// Leaves can be stale ("plugin no longer active") or deferred (background tabs) — handle both.
	app.workspace.getLeavesOfType('epub-plus-plus').filter((l) => !l.view.openSearch && !l.isDeferred).forEach((l) => l.detach());
	let leaf = app.workspace.getLeavesOfType('epub-plus-plus').find((l) => (l.view.file?.path ?? l.getViewState().state?.file) === path);
	if (!leaf) {
		await app.workspace.openLinkText(path.split('/').pop(), 'Notes/Moby notes.md');
		leaf = app.workspace.getLeavesOfType('epub-plus-plus').find((l) => (l.view.file?.path ?? l.getViewState().state?.file) === path);
	}
	await app.workspace.revealLeaf(leaf);
	await leaf.loadIfDeferred?.();
	for (let i = 0; i < 100 && !leaf.view.reader?.isRendered; i++) await sleep(100);
	return leaf.view;
}
/** Reload the plugin after `bun run build` (EPUB tabs are closed first). */
async function reloadPlugin() {
	app.workspace.getLeavesOfType('epub-plus-plus').forEach((l) => l.detach());
	await app.plugins.disablePlugin('epub-plus-plus');
	await app.plugins.enablePlugin('epub-plus-plus');
	await sleep(500);
}
