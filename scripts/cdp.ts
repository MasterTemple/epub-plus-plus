// See file-plus-plus/scripts/cdp.ts.
process.env.FPP_CDP_PORT ??= process.env.EPP_CDP_PORT;
await import('../node_modules/file-plus-plus/scripts/cdp.ts');
