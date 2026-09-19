# Corrección de importación PDF en Safari/WebKit

18 septiembre 2026. El reporte del usuario fue `undefined is not a function (near...)`, incluso con 87 páginas. No se recibió el archivo original ni el texto completo de la función señalada.

Se reprodujo un defecto compatible con ese síntoma contra la versión pública anterior: un PDF sintético de 87 páginas / 205.203 bytes falla antes de la primera página con `this._rangeReaders.keys(...).find is not a function` cuando falta Iterator.prototype.find. Las pruebas previas en Chrome moderno no cubrían esa condición. El límite de páginas no era la causa de este defecto reproducido; no se modificaron los límites de memoria para ocultarlo.

## Corrección

- PDF.js usa su distribución legacy tanto en la aplicación como en el worker, de la misma versión instalada. Esta incluye los polyfills de iteradores. `target: safari14` por sí solo transpila sintaxis, no aporta APIs ausentes.
- Polyfill pequeño de Promise.withResolvers antes de evaluar PDF.js, en ambos contextos. Incluso la distribución legacy presupone esta API. El worker ahora pasa por el compilador de Vite y conserva su ejecución dedicada y precarga offline.
- La extracción sigue usando getReader() y no requiere ReadableStream[Symbol.asyncIterator], otra incompatibilidad de algunas versiones de Safari.
- WebKit de prueba además rechazó persistir Blob/File en IndexedDB (`UnknownError: Error preparing Blob/File data to be stored in object store`). Fallback a bloques binarios de 256 KiB, sin convertir todo el PDF a ArrayBuffer/base64. Lectura por rangos al reanudar. IndexedDB v3 añade dos stores y conserva libros y esquema anterior; marca fuente lista solo tras guardar todos los bloques. Limpieza incluye esas partes.
- El JS principal aumenta unos 20 KB gzip. Presupuesto explícito ajustado de 360.000 a 375.000 bytes para este costo de compatibilidad; consumo real ~363.805 bytes. El worker compilado/minificado baja de 2,23 a 1,25 MB sin comprimir; sigue cacheándose para offline.

## Evidencia

- `scripts/verify-pdf-compat.cjs`, mismo PDF de 87 páginas: antes falla en la versión pública; después termina con 870 fragmentos y cero errores, en Chrome y WebKit.
- En la prueba posterior se eliminan Iterator.find, Promise.withResolvers y ReadableStream asyncIterator antes de cargar la app; se eliminan también dentro del worker para comprobar ambos contextos.
- 132 tests pasan, incluidos almacenamiento por bloques cuando se rechaza Blob, rangos que cruzan bloques, fallo de cuota sin fuente falsamente completa y reintento posterior.
- Build web, guardas, build:ios/sync y xcodebuild de simulador aprobados. Lint conserva los cuatro avisos React anteriores, sin nuevos errores.
- El estrés de 2.100 páginas / 142,59 MB sigue pasando con el motor compatible: flujo verificado 12,628 s, máximo intervalo UI 25,3 ms. La recuperación offline en Chrome sigue pasando.
- Se usó WebKit de escritorio automatizado; no equivale a ejecutar en el iPhone del usuario. Tampoco se afirma haber comprobado su PDF exacto.

Referencia primaria del fabricante: https://github.com/mozilla/pdf.js (distribución legacy); https://github.com/mozilla/pdf.js/issues/21557 y https://github.com/mozilla/pdf.js/issues/20973 (ReadableStream en Safari). Implementación contrastada con el paquete local 6.3.289.

Los archivos `pdf-evidence/pdf-compat-*.json` conservan los resultados antes y después. Para repetir: `PLAYWRIGHT_PATH=... EVO_URL=... node scripts/verify-pdf-compat.cjs`; `EVO_WEBKIT=1` selecciona WebKit, `EVO_WEBKIT_EXECUTABLE` permite usar el ejecutable disponible en el entorno.

## Límite de la verificación WebKit

La matriz offline completa no pasó en el WebKit automatizado instalado: selección de un archivo grande con red desactivada produjo `The I/O read operation failed` antes de crear el libro; al guardar primero con red y después desconectar, la recarga produjo `WebKit encountered an internal error`. No se contabiliza esa prueba como aprobada ni se extrapola el resultado offline de Chrome a Safari/iPhone. La compatibilidad de importación de 87 páginas sí se verificó directamente en WebKit. El harness permite `EVO_KEEP_ONLINE=1` para aislar recuperación de fuentes persistidas de la navegación offline.

Recuperación WebKit con red disponible: aprobada con 2.101 páginas, recarga durante importación, cancelación persistente tras segunda recarga y reintento hasta 21.010 fragmentos consecutivos. Esta prueba ejercita la fuente binaria alternativa realmente persistida en IndexedDB. Evidencia: `pdf-evidence/pdf-recovery-webkit.json` (`offline: false`).
