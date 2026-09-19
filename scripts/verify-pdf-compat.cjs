const {chromium,webkit}=require(process.env.PLAYWRIGHT_PATH || 'playwright');
const {fixture,state}=require('./stress-pdf.cjs');
const fs=require('node:fs');
const assert=require('node:assert/strict');
(async()=>{
const type=process.env.EVO_WEBKIT?webkit:chromium;
const browser=await type.launch({headless:true,...(process.env.EVO_WEBKIT?(process.env.EVO_WEBKIT_EXECUTABLE?{executablePath:process.env.EVO_WEBKIT_EXECUTABLE}:{}):{channel:'chrome'})});
try {
 const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 // Reproduce Safari installations without iterator helpers. Deliberately leave
 // Promise.withResolvers intact in the baseline so failure reaches range loading.
 await page.addInitScript(({baseline})=>{
   const proto=Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]()));
   delete proto.find;
   if (!baseline) {
     delete Promise.withResolvers;
     delete ReadableStream.prototype[Symbol.asyncIterator];
   }
 }, {baseline:!!process.env.EXPECT_BROKEN});
 if(!process.env.EXPECT_BROKEN) await page.route('**/pdf.worker-*.mjs', async route=>{
   const response=await route.fetch();
   const prelude='delete Promise.withResolvers; delete Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]())).find; delete ReadableStream.prototype[Symbol.asyncIterator];\n';
   await route.fulfill({response,body:prelude+await response.text()});
 });
 await page.goto(process.env.EVO_URL || 'http://127.0.0.1:4181');
 await page.getByRole('button',{name:'Importar libro',exact:true}).waitFor();
 const file=fixture(87);
 await page.waitForFunction(()=>document.querySelector('input[type=file]') && !document.querySelector('input[type=file]').disabled);
await page.locator('input[type=file]').first().setInputFiles(file);
 let book;const started=Date.now();
 while(Date.now()-started<90000){book=(await state(page))[0];if(book?.importStatus==='done'||book?.importStatus==='error')break;await page.waitForTimeout(100);}
 const result={browser:process.env.EVO_WEBKIT?'WebKit':'Chrome with missing iterator.find',book,errors};
 console.log(JSON.stringify(result,null,2));
 fs.writeFileSync(`artifacts/pdf-compat-${process.env.EXPECT_BROKEN?'before':process.env.EVO_WEBKIT?'webkit':'after'}.json`,JSON.stringify(result,null,2));
 if(process.env.EXPECT_BROKEN){assert.equal(book?.importStatus,'error');assert.match(book.errorMessage,/find|function/);}
 else {assert.equal(book?.importStatus,'done');assert.equal(book.importedUntil,87);assert.equal(book.totalChunks,870);assert.deepEqual(errors,[]);}
} finally {await browser.close();}
})().catch(e=>{console.error(e);process.exit(1)});
