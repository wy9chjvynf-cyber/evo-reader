import {beforeEach, expect, it, vi} from 'vitest';
import {IDBObjectStore} from 'fake-indexeddb';
import {clearAllBooks, commitPdfPage, getBook, getChunkRange, putBook, putFileBlob, getFileBlob, cleanupImportOrphans, type BookRecord} from '../db';
const book = {id:'atomic',format:'pdf',importStatus:'importing',importedUntil:0,totalChunks:0} as BookRecord;
beforeEach(async()=>{await clearAllBooks();await putBook(book);});
it('rolls back chunks and checkpoint together on a write failure',async()=>{
  const original=IDBObjectStore.prototype.put;
  const spy=vi.spyOn(IDBObjectStore.prototype,'put').mockImplementation(function(this:IDBObjectStore,value,key){
    if(this.name==='books') throw new DOMException('Disk full','QuotaExceededError');
    return original.call(this,value,key);
  });
  await expect(commitPdfPage('atomic',[{bookId:'atomic',index:0,sectionIndex:0,sourcePage:1,text:'Hello'}],[],{importedUntil:1,totalChunks:1})).rejects.toThrow('Disk full');
  spy.mockRestore();
  expect((await getBook('atomic'))?.importedUntil).toBe(0);
  expect(await getChunkRange('atomic',0,10)).toEqual([]);
});
it('cleans completed and orphan sources while preserving resumable sources',async()=>{
  await putFileBlob('atomic',new Blob(['in progress']));
  await putFileBlob('orphan',new Blob(['orphan']));
  await putBook({...book,id:'done',importStatus:'done'});
  await putFileBlob('done',new Blob(['finished']));
  await cleanupImportOrphans();
  expect(await getFileBlob('atomic')).toBeDefined();
  expect(await getFileBlob('orphan')).toBeUndefined();
  expect(await getFileBlob('done')).toBeUndefined();
});
