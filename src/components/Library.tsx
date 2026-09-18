import { useEffect, useState } from 'react';
import { getCover, type BookRecord } from '../lib/db';
import { estimateRemainingLabel } from '../lib/timeEstimate';
import { BookCover, Glyph, Progress } from './DesignSystem';
export function Library({ books, onSelect, onEdit, book, index, coverUrl, chapter, onRead, onListen, onImport, busy }: {
    books: BookRecord[];
    onSelect: (id: string) => void;
    onEdit: (id: string, patch: Partial<BookRecord>) => void;
    book: BookRecord | null;
    index: number;
    coverUrl: string | null;
    chapter?: string | null;
    onRead: () => void;
    onListen: () => void;
    onImport: () => void;
    busy: boolean;
}) {
    const [filter, setFilter] = useState('Todos');
    const [search, setSearch] = useState('');
    const progress = book && book.totalChunks > 1 ? Math.round(index / (book.totalChunks - 1) * 100) : 0;
    const [collection, setCollection] = useState('');
    const [format, setFormat] = useState('');
    const [sort, setSort] = useState('recent');
    const collections = [...new Set(books.map(b => b.collection).filter(Boolean))];
    const matches = books.map(b => b.id === book?.id ? {...b, currentChunk:index} : b).filter(b => `${b.title} ${b.author ?? ''}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()) && (filter !== 'Favoritos' || b.favorite) && (filter !== 'En lectura' || b.currentChunk < b.totalChunks - 1) && (filter !== 'Terminados' || (b.totalChunks > 1 && b.currentChunk >= b.totalChunks - 1)) && (!collection || b.collection === collection) && (!format || b.format === format)).sort((a,b) => sort === 'title' ? a.title.localeCompare(b.title) : b.lastOpenedAt - a.lastOpenedAt);
    return <><header className="page-heading"><div><p className="eyebrow">UN BUEN MOMENTO PARA TI</p><h1>Tu biblioteca.</h1><p>Historias que te acompañan. A tu ritmo.</p></div><button className="primary-button" aria-label={busy ? "Preparando libro" : "Importar libro"} onClick={onImport} disabled={busy}><Glyph name="plus"/>{busy ? 'Preparando…' : 'Importar libro'}</button></header><section className={`continue-card ${!book ? 'empty-hero' : ''}`} aria-label="Continuar leyendo"><div className="hero-copy"><p className="eyebrow">{book ? 'CONTINUAR LEYENDO' : 'EL SIGUIENTE CAPÍTULO EMPIEZA AQUÍ'}</p><h2>{book?.title || <>Menos ruido.<br />Más historias.</>}</h2><p className="hero-author">{book ? (book.author || 'De tu biblioteca personal') : 'Abre un libro. Encuentra tu pausa. Lee o deja que una voz te acompañe.'}</p>{book ? <><p className="hero-chapter">{chapter || 'Tu lectura actual'}</p><div className="hero-progress"><Progress value={progress} label="Progreso del libro"/><span>{progress}% leído · {estimateRemainingLabel(book.wordCount, book.totalChunks, index, book.rate) || 'Tiempo por calcular'}</span></div><div className="hero-actions"><button className="primary-button" onClick={onRead}>Continuar leyendo <Glyph name="arrow"/></button><button className="subtle-button" onClick={onListen}><Glyph name="headphones"/>Escuchar</button></div></> : <button className="primary-button" onClick={onImport} disabled={busy}>Abrir mi primer libro <Glyph name="arrow"/></button>}</div><div className="hero-art"><BookCover large title={book?.title || 'El placer de perderse entre páginas'} author={book?.author || 'TU PRÓXIMA LECTURA'} url={coverUrl}/></div></section><section className="library-section"><div className="section-heading"><h2>En tu estantería <span>{books.length}</span></h2><label className="search-field"><span className="sr-only">Buscar en biblioteca</span><input type="search" placeholder="Buscar un libro…" value={search} onChange={e => setSearch(e.target.value)}/></label></div><div className="filter-row" aria-label="Filtrar libros">{['Todos', 'En lectura', 'Favoritos', 'Terminados'].map(f => <button key={f} aria-pressed={filter === f} onClick={() => setFilter(f)}>{f}</button>)}</div><div className="library-options"><label>Colección<select value={collection} onChange={e => setCollection(e.target.value)}><option value="">Todas</option>{collections.map(c => <option key={c} value={c}>{c}</option>)}</select></label><label>Formato<select value={format} onChange={e => setFormat(e.target.value)}><option value="">Todos</option>{['pdf','epub','docx','txt','md'].map(f => <option key={f} value={f}>{f.toUpperCase()}</option>)}</select></label><label>Orden<select value={sort} onChange={e => setSort(e.target.value)}><option value="recent">Recientes</option><option value="title">Título</option></select></label></div><div className="book-grid">{matches.length ? matches.map(item => <LibraryCard key={item.id} book={item.id === book?.id ? {...item, currentChunk:index} : item} onSelect={() => onSelect(item.id)} onEdit={patch => onEdit(item.id,patch)} disabled={busy} />) : <div className="shelf-empty"><Glyph name="book"/><h3>{books.length ? 'No hay libros en esta selección' : 'Haz espacio para una buena historia.'}</h3><p>Importa un libro o prueba otra búsqueda.</p></div>}<button className="import-card" onClick={onImport} disabled={busy}><span><Glyph name="plus"/></span><strong>Añadir otro libro</strong><small>Tus libros anteriores se conservan</small></button></div></section><footer className="library-footer"><span>Hecho para leer sin distracciones.</span><span>Local por naturaleza.</span></footer></>;
}

function LibraryCard({book, onSelect, onEdit, disabled}: {book: BookRecord; onSelect: () => void; onEdit: (patch: Partial<BookRecord>) => void; disabled: boolean}) {
  const [url,setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!book.hasCover) return;
    let cancelled = false; let objectUrl: string | null = null;
    void getCover(book.id).then(record => { if (!cancelled && record) {objectUrl=URL.createObjectURL(record.blob);setUrl(objectUrl);} });
    return () => {cancelled=true;if(objectUrl)URL.revokeObjectURL(objectUrl);};
  },[book.id,book.hasCover]);
  const progress=book.totalChunks>1 ? Math.round(book.currentChunk/(book.totalChunks-1)*100):0;
  return <article className="library-card"><button className="book-card" onClick={onSelect} disabled={disabled} aria-label={`Abrir ${book.title}`}><BookCover title={book.title} author={book.author} url={url}/><strong>{book.title}</strong><span>{book.author || book.format.toUpperCase()}</span><Progress value={progress} label="Progreso"/><span>{progress}% · {book.importStatus === 'done' ? 'Listo para leer' : book.importStatus === 'error' ? 'Importación incompleta' : 'Preparando libro'}</span></button><button className="favorite-button" aria-label={`Favorito: ${book.title}`} aria-pressed={!!book.favorite} onClick={() => onEdit({favorite: !book.favorite})}>{book.favorite ? '★ Favorito' : '☆ Favorito'}</button><label className="collection-field">Colección<input key={book.collection ?? ''} defaultValue={book.collection ?? ''} maxLength={48} placeholder="Sin colección" onBlur={e => {const value=e.target.value.trim();if(value !== (book.collection ?? ''))onEdit({collection:value});}} onKeyDown={e => {if(e.key === 'Enter')e.currentTarget.blur();}} /></label></article>;
}
