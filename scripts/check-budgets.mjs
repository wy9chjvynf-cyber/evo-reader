import { readdir, readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
const files = await readdir('dist/assets');
const js = files.filter(f => f.endsWith('.js'));
const css = files.filter(f => f.endsWith('.css'));
const size = async files => (await Promise.all(files.map(async f => gzipSync(await readFile(`dist/assets/${f}`)).length))).reduce((a,b)=>a+b,0);
const values = { javascriptGzip: await size(js), cssGzip: await size(css) };
// Legacy importers remain in the main bundle; lower this baseline in Import Engine phase.
const limits = { javascriptGzip: 360000, cssGzip: 6000 };
for (const key of Object.keys(limits)) if (values[key] > limits[key]) throw new Error(`${key}: ${values[key]} > ${limits[key]}`);
const styles=await readFile('src/index.css','utf8');
if (/https?:\/\//.test(styles)) throw new Error('Remote asset in design system');
console.log(JSON.stringify({values,limits,passed:true},null,2));
