import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {IDBObjectStore} from 'fake-indexeddb';
import {clearAllBooks,putBook,savePdfSource,getPdfSource,deleteFileBlob,cleanupImportOrphans,type BookRecord} from '../db';
const book = {id:'source',format:'pdf',importStatus:'importing',importedUntil:0,totalChunks:0} as BookRecord;
beforeEach(async()=>{await clearAllBooks();await putBook(book);});
afterEach(()=>vi.restoreAllMocks());
function rejectBlobs(failPart=false) {
 const original=IDBObjectStore.prototype.put;
 vi.spyOn(IDBObjectStore.prototype,'put').mockImplementation(function(this:IDBObjectStore,value,key){
   if(this.name==='files') throw new DOMException('Cannot store Blob','UnknownError');
   if(failPart && this.name==='pdfSourceParts' && value.index===1) throw new DOMException('Disk full','QuotaExceededError');
   return original.call(this,value,key);
 });
}
it('persists and reads exact cross-boundary ranges when WebKit rejects Blobs',async()=>{
 rejectBlobs();
 const bytes=Uint8Array.from({length:700000},(_,i)=>i%251);
 const blob=new Blob([bytes]);
 blob.arrayBuffer=()=>{throw new Error('Whole file read forbidden');};
 await savePdfSource('source',blob);
 const stored=(await getPdfSource('source'))!;
 expect(stored.size).toBe(bytes.length);
 expect(new Uint8Array(await stored.slice(260000,530000).arrayBuffer())).toEqual(bytes.slice(260000,530000));
 await cleanupImportOrphans();
 expect(await getPdfSource('source')).toBeDefined();
 await deleteFileBlob('source');
 expect(await getPdfSource('source')).toBeUndefined();
});
it('does not expose a partially written source after quota failure and can retry',async()=>{
 rejectBlobs(true);
 const blob=new Blob([new Uint8Array(600000)]);
 await expect(savePdfSource('source',blob)).rejects.toThrow('Disk full');
 expect(await getPdfSource('source')).toBeUndefined();
 vi.restoreAllMocks();rejectBlobs();
 await savePdfSource('source',blob);
 expect((await getPdfSource('source'))?.size).toBe(600000);
});
