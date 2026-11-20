// Bundle the app into web/dist (what GitHub Pages serves).
//   node web/build.js           one-off production build
//   node web/build.js --watch   rebuild on change and serve on http://localhost:5173
import * as esbuild from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'dist');
const watch = process.argv.includes('--watch');
mkdirSync(out, { recursive: true });

const copyStatic = () => {
  for (const f of ['index.html', 'styles.css', '404.html']) {
    try {
      copyFileSync(join(here, f), join(out, f));
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }
};

const options = {
  entryPoints: [join(here, 'src/main.js')],
  outfile: join(out, 'app.js'),
  bundle: true,
  format: 'esm',
  splitting: false,
  minify: !watch,
  sourcemap: true,
  target: ['es2020'],
  logLevel: 'info',
  plugins: [{ name: 'static', setup: (b) => b.onEnd(copyStatic) }],
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  const { port } = await ctx.serve({ servedir: out, port: 5173 });
  console.log(`Serving http://localhost:${port}/`);
} else {
  await esbuild.build(options);
}
