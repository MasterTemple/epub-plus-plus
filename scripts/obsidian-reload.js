(async () => {
	app.workspace.iterateAllLeaves((l) => { if (l.view.getViewType() === 'epub-plus-plus') l.detach(); });
	await app.plugins.disablePlugin('epub-plus-plus');
	await app.plugins.enablePlugin('epub-plus-plus');
	await new Promise((r) => setTimeout(r, 500));
	return Object.keys(app.plugins.plugins);
})()
