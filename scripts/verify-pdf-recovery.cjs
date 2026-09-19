const {chromium,webkit}=require(process.env.PLAYWRIGHT_PATH || 'playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {fixture,state}=require('./stress-pdf.cjs');
(async()=>{
const browser=await (process.env.EVO_WEBKIT?webkit:chromium).launch({headless:true,...(process.env.EVO_WEBKIT?(process.env.EVO_WEBKIT_EXECUTABLE?{executablePath:process.env.EVO_WEBKIT_EXECUTABLE}:{}):{channel:'chrome'})});
try {
const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.goto(process.env.EVO_URL||'http://127.0.0.1:4177');
await page.getByRole('button',{name:'Importar libro',exact:true}).waitFor();
await page.evaluate(()=>navigator.serviceWorker.ready);await page.reload();await page.waitForFunction(()=>!!navigator.serviceWorker.controller);
if(!process.env.EVO_WEBKIT && !process.env.EVO_KEEP_ONLINE) await page.context().setOffline(true);
const file=fixture(2101,1024);
await page.waitForFunction(()=>document.querySelector('input[type=file]') && !document.querySelector('input[type=file]').disabled);
await page.locator('input[type=file]').first().setInputFiles(process.env.EVO_WEBKIT ? {name:require('node:path').basename(file),mimeType:'application/pdf',buffer:fs.readFileSync(file)} : file);
let b;const initial=Date.now();while(!(b=(await state(page))[0])||b.importedUntil<80) { assert(Date.now()-initial<30000,JSON.stringify({book:b,errors,ui:await page.locator("body").innerText()})); assert.notEqual(b?.importStatus,'error',JSON.stringify(b)); await page.waitForTimeout(20); }
assert.equal(b.importStatus,'importing');const before=b.importedUntil;
if(process.env.EVO_WEBKIT && !process.env.EVO_KEEP_ONLINE) await page.context().setOffline(true);
await page.reload();
await page.getByRole('button',{name:'Cancelar importación',exact:true}).waitFor();
await page.getByRole('button',{name:'Cancelar importación',exact:true}).click();
await page.getByRole('button',{name:'Reintentar importación',exact:true}).waitFor();
b=(await state(page))[0];assert.equal(b.importStatus,'error');assert(b.importedUntil>=before);
const paused=b.importedUntil; await page.reload();await page.getByRole('button',{name:'Reintentar importación',exact:true}).waitFor();
assert.equal((await state(page))[0].importedUntil,paused);
await page.getByRole('button',{name:'Reintentar importación',exact:true}).click();
const started=Date.now();while((b=(await state(page))[0]).importStatus!=='done' && Date.now()-started<60000) await page.waitForTimeout(100);
assert.equal(b.importStatus,'done');assert.equal(b.importedUntil,2101);
const content=await page.evaluate(async()=>{const db=await new Promise(r=>{const q=indexedDB.open('evoreader');q.onsuccess=()=>r(q.result)});const all=await new Promise(r=>{const q=db.transaction('chunks').objectStore('chunks').getAll();q.onsuccess=()=>r(q.result)});return {indices:all.map(c=>c.index),pages:[...new Set(all.map(c=>c.sourcePage))]};});
assert.equal(content.indices.length,b.totalChunks);assert.deepEqual(content.indices,Array.from({length:b.totalChunks},(_,i)=>i));assert.equal(content.pages.length,2101);
await page.reload();await page.getByRole('button',{name:'Siguiente →',exact:true}).waitFor();
await page.screenshot({path:'artifacts/pdf-offline-recovered.png',fullPage:true});
assert.deepEqual(errors,[]);
fs.writeFileSync(`artifacts/pdf-recovery${process.env.EVO_WEBKIT?'-webkit':''}.json`,JSON.stringify({passed:true,offline:!process.env.EVO_KEEP_ONLINE,pages:2101,reloadCheckpoint:before,cancelCheckpoint:paused,totalChunks:b.totalChunks,checks:[process.env.EVO_KEEP_ONLINE?'PDF import with saved binary source':'offline PDF with cached worker','automatic reload recovery','cancel preserves checkpoint','cancel stays paused across reload','manual retry','unique contiguous chunks','all pages persisted',process.env.EVO_KEEP_ONLINE?'reading':'offline reading'],errors},null,2));
console.log('PDF recovery passed; offline='+!process.env.EVO_KEEP_ONLINE);
} finally {await browser.close();}
})().catch(e=>{console.error(e);process.exit(1)});
