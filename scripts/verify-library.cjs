const {chromium}=require(process.env.PLAYWRIGHT_PATH || 'playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
(async()=>{
const browser=await chromium.launch({headless:true,channel:'chrome'});
try {
const page=await browser.newPage({viewport:{width:1440,height:1000}});
const errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.goto(process.env.EVO_URL || 'http://127.0.0.1:4175');
await page.getByRole('button',{name:'Importar libro',exact:true}).waitFor();
const upload=async(name,content)=>{await page.locator('input[type=file]').first().setInputFiles({name,mimeType:'text/plain',buffer:Buffer.from(content)});};
const waitDB=async(predicate)=>page.waitForFunction(async predicate=>{const db=await new Promise(r=>{const q=indexedDB.open('evoreader');q.onsuccess=()=>r(q.result)});const books=await new Promise(r=>{const q=db.transaction('books').objectStore('books').getAll();q.onsuccess=()=>r(q.result)});db.close();return new Function('books',predicate)(books);},predicate);
await upload('Primero.txt',('Una historia primera. Caminamos por el bosque. ').repeat(100));
await waitDB('return books.length===1 && books[0].importStatus==="done"');
await page.getByRole('button',{name:'Siguiente →',exact:true}).click();
await waitDB('return books[0].currentChunk===1');
await page.getByRole('button',{name:'Biblioteca',exact:true}).click();
await upload('Segundo.txt',('La segunda historia mira al mar. ').repeat(100));
await waitDB('return books.length===2 && books.every(b=>b.importStatus==="done")');
await page.getByRole('button',{name:'Biblioteca',exact:true}).click();
assert.equal(await page.locator('.library-card').count(),2);
await page.getByRole('button',{name:'Abrir Primero',exact:true}).click();
await page.waitForFunction(()=>document.querySelector('.reader-pagination')?.textContent.includes('2 /'));
await page.reload();await page.waitForFunction(()=>document.querySelector('.reader-pagination')?.textContent.includes('2 /'));
await page.getByRole('button',{name:'Biblioteca',exact:true}).click();
await page.getByRole('button',{name:'Favorito: Primero',exact:true}).click();
const first=page.locator('.library-card').filter({has:page.getByRole('button',{name:'Abrir Primero',exact:true})});
await first.getByRole('textbox',{name:'Colección'}).fill('Novelas');await first.getByRole('textbox',{name:'Colección'}).press('Enter');
await waitDB('return books.some(b=>b.title==="Primero" && b.favorite && b.collection==="Novelas")');
await page.getByRole('button',{name:'Favoritos',exact:true}).click();assert.equal(await page.locator('.library-card').count(),1);
await page.getByRole('button',{name:'Todos',exact:true}).click();
await page.screenshot({path:'artifacts/library-multi-desktop.png',fullPage:true});
for(const width of [820,390,320]){await page.setViewportSize({width,height:844});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`overflow ${width}`);await page.screenshot({path:`artifacts/library-multi-${width}.png`,fullPage:true});}
await upload('Vacio.txt','');await page.getByRole('alert').waitFor();
await page.getByRole('button',{name:'Biblioteca',exact:true}).click();
assert.equal(await page.locator('.library-card').count(),3);
await page.getByRole('button',{name:'Abrir Primero',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.reader-pagination')?.textContent.includes('2 /'));
await page.evaluate(()=>navigator.serviceWorker.ready);await page.reload();await page.waitForFunction(()=>!!navigator.serviceWorker.controller);
await page.context().setOffline(true);await page.reload();await page.waitForFunction(()=>document.querySelector('.reader-pagination')?.textContent.includes('2 /'));
assert.deepEqual(errors,[]);
fs.writeFileSync('artifacts/library-verification.json',JSON.stringify({passed:true,checks:['two imports retain both books','independent position and active-book reload','favorites and collections persist','320/390/820/1440 no overflow','failed third import preserves previous books','offline restoration'],errors},null,2));
} finally {await browser.close();}
})().catch(e=>{console.error(e);process.exit(1)});
