import index from './index.html';
import test from './test.html';

const root = new URL('..', import.meta.url).pathname;
const server = Bun.serve({
	port: Number(process.env.PORT ?? 3737),
	development: true,
	routes: {
		'/': index,
		'/test': test,
		'/fixtures/:name': (req) => new Response(Bun.file(`${root}fixtures/${req.params.name}`)),
		'/fixtures': async () => {
			const names = [...new Bun.Glob('*.epub').scanSync(`${root}fixtures`)].sort();
			return Response.json(names);
		},
	},
});
console.log(`demo at ${server.url}`);
