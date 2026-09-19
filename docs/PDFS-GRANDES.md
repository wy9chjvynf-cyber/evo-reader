# PDFs grandes — entrega y límites

18 septiembre 2026. Base publicada: b9879bf; rama release/evoreader-3-design.

## Resultado verificado

Importación PDF local, sin servicios ni costo operativo añadido. Chrome de escritorio en macOS, build de producción, perfil aislado. No certifica rendimiento en un iPhone físico ni todos los PDFs posibles.

| PDF sintético real | Tamaño | Flujo completo¹ | Mayor intervalo UI (timer 16 ms) | Tareas largas (>50 ms) | Incremento RSS total Chrome² | Crecimiento RSS segunda mitad |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 500 páginas | 1.18 MB | 2.101 s | 19.0 ms | 0 | 124.4 MiB | 33.1 MiB |
| 1.000 páginas | 2.36 MB | 3.731 s | 22.2 ms | 0 | 160.8 MiB | 38.3 MiB |
| 2.100 páginas | 142.59 MB | 12.347 s | 23.2 ms | 0 | 237.1 MiB | 16.3 MiB |

¹ Incluye carga mediante input, importación, verificación, captura y detección de duplicado. No es tiempo puro del parser. ² Suma RSS de procesos devueltos por CDP SystemInfo; incluye navegador/renderers, no solo heap del importador. Base ~1.0 GiB, pico 1.26 GiB. No debe interpretarse como RAM requerida por la app. Muestras cada 250 ms; los picos intermedios pueden pasar inadvertidos. Las guardas del harness son delta <400 MiB, crecimiento en segunda mitad <64 MiB e intervalo UI <1 s; los valores observados son bastante menores.

Los fixtures contienen 30 líneas de texto por página (10 fragmentos/página). El archivo pesado añade 64 KiB de comentarios sin comprimir por página, con árbol de páginas jerárquico. Comprueba tamaño/IO, no representa imágenes complejas ni bombas de descompresión. Datos íntegros en `pdf-evidence/`.

## Auditoría y cambios

Antes: `file.arrayBuffer()` cargaba todos los bytes; cada página se extraía entera; escritura de fragmentos, sección y checkpoint separadas, con excepciones silenciadas; cleanup sin terminar worker; sin cancelación ni deduplicación.

Ahora:

- Fuente Blob persistida en IndexedDB. Lecturas bajo demanda con PDFDataRangeTransport; prefetch y streaming de archivo desactivados. No se llama a arrayBuffer sobre el PDF completo.
- Una importación por ventana; Web Locks impide competencia entre pestañas cuando el navegador lo soporta. Una lectura de rango activa; una página y una escritura activa. No se acumula el texto del libro.
- Parser en worker dedicado; se rechaza fallback al hilo principal. `streamTextContent` alimenta una página acotada. Escritura y progreso se esperan antes de continuar (backpressure).
- Se renueva el documento y termina el worker cada 32 páginas para liberar rangos y objetos retenidos por PDF.js. Cierre forzado del worker tras 1 s si la terminación cooperativa no responde.
- Fragmentos, secciones, contadores y página confirmada se guardan en una transacción estricta. Un fallo de cuota revierte la página completa y llega a la UI.
- Cancelación conserva el archivo y el checkpoint. El botón Reintentar retoma desde la siguiente página. Una cancelación permanece pausada tras recarga. Un cierre con estado `importing` se reanuda automáticamente al arrancar.
- Timeout de 30 s por operación del parser, con un reintento automático por ejecución y worker nuevo. Después se conserva el estado para reintento manual; no hay bucle de recuperación infinito.
- Identidad SHA-256 encadenada sobre bloques fijos de 256 KiB para duplicados PDF incluso renombrados; nunca se conserva el archivo completo en un buffer para hashing. Duplicados anteriores sin fingerprint no pueden detectarse hasta reimportarse.
- Páginas sin texto contadas y visibles; PDF completamente vacío/escaneado termina con explicación de OCR. Errores FormatError explícitos permiten conservar las páginas legibles con aviso de páginas dañadas. Algunos daños son recuperados internamente por PDF.js como página vacía: se reportan como “sin texto”, no se puede distinguir con certeza escaneo, blanco y corrupción recuperada.
- Limpieza al arrancar de archivos de libros terminados y filas huérfanas usando cursores; se preservan fuentes de trabajos incompletos. No se borran libros del usuario ni cachés ajenas. Workbox conserva el manejo offline previo.
- Se conservan TXT, DOCX, EPUB, Markdown, biblioteca, lectura y voz. No hay migración destructiva ni nuevas dependencias. Portadas existentes intactas; PDFs nuevos usan la portada tipográfica del rediseño para evitar rasterizar una primera página potencialmente enorme.

## Límites explícitos

- Máximo 256 MiB por PDF; no es promesa de que cualquier archivo debajo de ese tamaño sea procesable.
- Rangos nominales de 64 KiB; PDF.js puede agruparlos. Máximo 8 MiB por solicitud y 32 MiB leídos por época de 32 páginas, incluyendo apertura. Si el índice fuerza lecturas excesivas se pide dividir el archivo.
- Un fixture de 139 MB con índice plano y páginas dispersas excedió el presupuesto durante apertura: rechazo seguro comprobado, **no soportado** bajo este presupuesto. El fixture jerárquico pesado sí pasó. Cambiar límites exige repetir estrés.
- PDF.js reserva internamente un espacio de bytes relacionado con la longitud del documento aunque solo solicite rangos. Por eso no se afirma memoria total O(1), ni ausencia de reservas del tamaño del archivo. Sí se elimina la lectura completa inicial, se acotan las lecturas y el texto retenido, y se recicla el parser.
- Máximo 256 Ki caracteres de texto por página. El acumulado de texto/chunks es de una página acotada, no del libro entero. Una página extrema conserva el checkpoint anterior y da error.
- Sin OCR ni contraseñas interactivas. PDFs cifrados no compatibles se rechazan. Corrupción de estructura global puede impedir abrir el documento; corrupción parcial solo se salva cuando PDF.js permite acceder a las páginas restantes.
- No hay garantía absoluta frente a PDFs maliciosos con descompresión extrema dentro del parser; el watchdog no equivale a límite de memoria del proceso del sistema operativo.
- Fuentes incompletas permanecen hasta completar/eliminar el libro. IndexedDB está sujeto a cuota/evicción del navegador; el usuario debe conservar su original. Sin Web Locks la exclusión solo cubre la misma ventana.
- El endurecimiento incremental es PDF; los otros formatos mantienen sus importadores previos. No se afirma que DOCX/EPUB grandes tengan estas mismas garantías.

## Validación reproducible

- 130 tests / 15 archivos: compatibilidad de formatos y motor; cancelación y reanudación; conteo de palabras; duplicados; concurrencia; texto patológico; timeout y recuperación; corrupción explícita; atomicidad ante cuota; huérfanos.
- `npm test`, `npm run lint`, `npm run build`, `npm run check:budgets`. Lint sin errores, mismos cuatro avisos React heredados. JS gzip 343.7 KB de 360 KB; CSS 4.96 KB de 6 KB.
- `npm run build:ios`: build y sync aprobados. `xcodebuild ... -sdk iphonesimulator ... CODE_SIGNING_ALLOWED=NO`: BUILD SUCCEEDED. No instalación ni prueba en iPhone físico.
- `scripts/stress-pdf.cjs`: crea PDFs reales en /tmp y usa input de la UI, parser real y almacenamiento. Requiere Playwright disponible; `PLAYWRIGHT_PATH` puede apuntar al runtime del entorno. `EVO_URL` selecciona sitio local/público.
- `scripts/verify-pdf-recovery.cjs`: sin red, 2.101 páginas; recarga tras página 80; cancelación tras 114; nueva recarga mantiene pausa; reintento completa 21.010 fragmentos consecutivos y todas las páginas. Worker precacheado y lectura offline comprobados. Es simulación de cierre por recarga, no una prueba de terminación por el SO/iOS.
- `scripts/verify-library.cjs`: biblioteca múltiple, posiciones, favoritos, colecciones, fallo no destructivo, offline y 320/390/820/1440 px, sin errores JavaScript.

Referencia de API: https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib.html (range, disableAutoFetch y disableStream); implementación contrastada además contra los tipos y código de pdfjs-dist 6.3.289 instalado.

## Publicación confirmada

Código: `6757a51` en `release/evoreader-3-design`, subido a origin. Deploy GitHub Pages: `0569babd1cf95d8636cb7827a7dbe39399c4a049`. Respaldo remoto: `backup/pre-large-pdf-20260918` (versión previa `137e809`). Se conservaron los assets antiguos para pestañas abiertas.

Sitio: https://wy9chjvynf-cyber.github.io/evo-reader/. Se confirmó en la respuesta pública el asset nuevo `index-Do7asI5H.js`. Prueba del sitio público en perfil limpio: se precacheó el worker, se desactivó la red, se importaron 2.101 páginas, se recargó tras página 80, se canceló tras página 83 y se retomó hasta completar 21.010 fragmentos únicos. Lectura offline final aprobada, cero errores JavaScript. Evidencia: `pdf-evidence/pdf-recovery-public.json`. Presupuestos del build publicado: JS gzip 343.728 bytes y CSS gzip 4.956 bytes.
