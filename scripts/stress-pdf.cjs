/* Real PDFs + production UI + IndexedDB checkpoints. No PDF parser mocks. */
const fs = require('node:fs');
const {execFileSync} = require('node:child_process');
const assert = require('node:assert/strict');
const {chromium} = require(process.env.PLAYWRIGHT_PATH || 'playwright');
function fixture(pages, padding = 0, mode = '') {
  const path = `/tmp/evo-stress-${pages}-${padding}${mode}.pdf`;
  const fd = fs.openSync(path, 'w'); let offset = 0; const offsets = [0];
  const write = text => { const bytes = Buffer.from(text); fs.writeSync(fd, bytes); offset += bytes.length; };
  const obj = (id, body) => { offsets[id] = offset; write(`${id} 0 obj\n${body}\nendobj\n`); };
  write('%PDF-1.7\n'); obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  const groups=Math.ceil(pages/32), groupStart=4+pages*2;
  obj(2, `<< /Type /Pages /Count ${pages} /Kids [${Array.from({length:groups},(_,i)=>`${groupStart+i} 0 R`).join(' ')}] >>`);
  obj(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  for(let i=0;i<pages;i++) {
    obj(4+i*2, `<< /Type /Page /Parent ${groupStart+Math.floor(i/32)} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5+i*2} 0 R >>`);
    const content = mode === 'blank' ? '' : `BT /F1 12 Tf 50 740 Td 14 TL (Page ${i+1}.) Tj T* ${'(A meaningful sentence for incremental reading and listening.) Tj T* '.repeat(30)} ET\n` + (padding ? `%${'x'.repeat(padding)}\n` : '');
    obj(5+i*2, `<< ${mode === 'corrupt' && i === 1 ? '/Filter /FlateDecode' : ''} /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`);
  }
  for(let g=0;g<groups;g++) obj(groupStart+g, `<< /Type /Pages /Parent 2 0 R /Count ${Math.min(32,pages-g*32)} /Kids [${Array.from({length:Math.min(32,pages-g*32)},(_,i)=>`${4+(g*32+i)*2} 0 R`).join(" ")}] >>`);
  const xref=offset; write(`xref\n0 ${offsets.length}\n0000000000 65535 f \n`);
  for(const n of offsets.slice(1)) write(`${String(n).padStart(10,'0')} 00000 n \n`);
  write(`trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`); fs.closeSync(fd); return path;
}
async function state(page) { return page.evaluate(async()=> { const db=await new Promise((resolve,reject)=>{const q=indexedDB.open('evoreader');q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error)}); const books=await new Promise(resolve=>{const q=db.transaction('books').objectStore('books').getAll();q.onsuccess=()=>resolve(q.result)});db.close();return books; }); }
if (require.main === module) (async()=>{
const results=[];
for(const [pages,padding] of (process.env.EVO_HEAVY ? [[2100,65536]] : process.env.EVO_QUICK ? [[500,0]] : [[500,0],[1000,0],[2100,65536]])) {
 const file=fixture(pages,padding); const browser=await chromium.launch({headless:true,channel:'chrome'});
 try {
  const page=await browser.newPage(); const errors=[]; page.on('pageerror',e=>errors.push(e.message));
  await page.goto(process.env.EVO_URL || 'http://127.0.0.1:4175');
  await page.getByRole('button',{name:'Importar libro',exact:true}).waitFor();
  await page.screenshot({path:'artifacts/pdf-initial.png'});
  await page.evaluate(()=>{window.stress={ticks:0,maxGap:0,longTasks:[],heap:[]};let last=performance.now();setInterval(()=>{const now=performance.now();window.stress.ticks++;window.stress.maxGap=Math.max(window.stress.maxGap,now-last);last=now;},16);new PerformanceObserver(list=>window.stress.longTasks.push(...list.getEntries().map(e=>e.duration))).observe({entryTypes:['longtask']});});
  const cdp=await browser.newBrowserCDPSession();const rss=[];
  const started=Date.now(); await page.locator('input[type=file]').first().setInputFiles(file);
  let book;
  while(Date.now()-started < 240000) {
    book=(await state(page))[0];
    const {processInfo}=await cdp.send('SystemInfo.getProcessInfo');
    const pids=processInfo.map(p=>p.id).join(',');
    const memory=execFileSync('ps',['-o','rss=','-p',pids],{encoding:'utf8'}).trim().split(/\s+/).reduce((a,b)=>a+Number(b),0)*1024;
    rss.push({page:book?.importedUntil||0,bytes:memory});
    if(book?.importStatus==='done'||book?.importStatus==='error') break;
    await page.waitForTimeout(250);
  }
  assert.equal(book?.importStatus,'done',JSON.stringify(book)); assert.equal(book.importedUntil,pages);
  const metrics=await page.evaluate(()=>window.stress);
  const late=rss.filter(s=>s.page>pages/2);
  assert(Math.max(...rss.map(s=>s.bytes))-rss[0].bytes<400*1048576,"RSS growth exceeded 400 MiB");
  assert(late.length<2 || late.at(-1).bytes-late[0].bytes<64*1048576,"Late RSS growth exceeded 64 MiB");
  assert(metrics.maxGap<1000,`UI blocked ${metrics.maxGap}ms`);
  await page.screenshot({path:`artifacts/pdf-${pages}.png`});
  const verify=await page.evaluate(async()=>{const db=await new Promise(r=>{const q=indexedDB.open('evoreader');q.onsuccess=()=>r(q.result)});const query=(store,op)=>new Promise(r=>{const q=db.transaction(store).objectStore(store)[op]();q.onsuccess=()=>r(q.result)});return {chunks:await query('chunks','count'),files:await query('files','count')};});
  assert.equal(verify.chunks,book.totalChunks); assert.equal(verify.files,0);
  // Exact duplicate reuses original book.
  await page.locator('input[type=file]').first().setInputFiles(file);
  await page.waitForTimeout(padding?2000:500); assert.equal((await state(page)).length,1);
  results.push({pages,fileBytes:fs.statSync(file).size,seconds:(Date.now()-started)/1000,book,metrics,rss,errors});
  assert.deepEqual(errors,[]);
  fs.writeFileSync('artifacts/pdf-stress.json',JSON.stringify(results,null,2));
  console.log(JSON.stringify({pages,seconds:results.at(-1).seconds,maxGap:metrics.maxGap,peakRssMB:Math.max(...rss.map(s=>s.bytes))/1048576}));
 } finally {await browser.close();}
}
})().catch(e=>{console.error(e);process.exit(1)});

module.exports={fixture,state};
