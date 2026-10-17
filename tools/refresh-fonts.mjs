// Self-host a compact, open Chinese UI font. Apple devices retain native PingFang.
// Only font assets are generated; CSS and source edits remain reviewable separately.
import { readFile, mkdir, writeFile } from 'node:fs/promises';

const site = new URL('../web',import.meta.url).pathname;
const sources = await Promise.all([
    ...['index.html', 'app.js', 'admin.js', 'background-image.js', 'about.html', 'promotion.js'].map(file => readFile(`${site}/${file}`, 'utf8')),
    readFile(new URL('../livo/api.py',import.meta.url), 'utf8'),
    readFile(new URL('../livo/core.py',import.meta.url), 'utf8')
]);
const characters = [...new Set([...sources.join('\n')])]
    .filter(char => char.codePointAt(0) > 31).sort().join('');
const request = new URL('https://fonts.googleapis.com/css2');
request.searchParams.set('family', 'Noto Sans SC:wght@400..600');
request.searchParams.set('text', characters);
const response = await fetch(request, {
    headers: {'User-Agent': 'Mozilla/5.0 AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36'},
    signal: AbortSignal.timeout(25000)
});
if (!response.ok) throw new Error(`Font stylesheet HTTP ${response.status}`);
const stylesheet = await response.text();
const rules = [...stylesheet.matchAll(/@font-face\s*\{([^}]+)\}/g)];
if (rules.length !== 1) throw new Error('Expected one variable subset');
const rule = rules[0][1];
const address = rule.match(/url\(([^)]+)\)/)?.[1].replaceAll('"', '').replaceAll("'", '');
if (!address || new URL(address).hostname !== 'fonts.gstatic.com' || !/font-weight:\s*400 600/.test(rule)) {
    throw new Error('Unexpected font source or weight range');
}
const font = await fetch(address, {signal: AbortSignal.timeout(25000)});
if (!font.ok) throw new Error(`Font download HTTP ${font.status}`);
const bytes = Buffer.from(await font.arrayBuffer());
if (bytes.subarray(0, 4).toString() !== 'wOF2' || bytes.length > 500000) {
    throw new Error('Unexpected WOFF2 subset');
}
// The same upstream font's license is already distributed with this project.
const license = await readFile(`${site}/fonts/OFL.txt`, 'utf8');
if (!license.includes('SIL OPEN FONT LICENSE')) throw new Error('Unexpected font license');
await mkdir(`${site}/fonts`, {recursive: true});
await writeFile(`${site}/fonts/livo-ui-sc-v6.woff2`, bytes);
await writeFile(`${site}/fonts/OFL.txt`, license);
console.log(JSON.stringify({characters: characters.length, bytes: bytes.length, family: 'Noto Sans SC', weight: '400–600'}));
