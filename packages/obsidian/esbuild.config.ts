import { buildPlugin } from 'file-plus-plus/build';

await buildPlugin({ root: import.meta.dir, prefix: 'epp', production: process.argv[2] === 'production' });
