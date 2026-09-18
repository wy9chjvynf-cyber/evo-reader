# Fase 2 — Biblioteca local, primer bloque

18 septiembre 2026. Continúa sobre la rama release/evoreader-3-design.

## Cambios visibles

Importar añade un libro; ya no elimina ninguno de los anteriores. La estantería muestra los libros guardados, sus portadas y progreso, favoritos, una colección opcional por libro, búsqueda, filtros por formato/colección/estado y orden por título o última apertura. Tu lectura muestra el número real de libros.

Al abrir otro libro se pausa la voz, se recuperan posición, velocidad y voz de ese libro y se guarda la selección activa. Las lecturas asíncronas del libro anterior no pueden contaminar el texto o caché del nuevo. Si falla una importación, los libros anteriores siguen disponibles y el nuevo queda identificado como incompleto.

## Compatibilidad y datos

Se conservan nombre y versión 2 de IndexedDB. Los nuevos campos favorite/collection son opcionales; libros anteriores funcionan sin reimportación. activeBookId vive en meta. Referencias inválidas vuelven al libro más reciente. Una importación interrumpida tiene prioridad al arrancar para reanudar el flujo existente.

React, IndexedDB, importadores y SpeechController son compartidos por web/PWA y Capacitor. No se añadieron dependencias, servicios externos ni costo operativo. Portadas revocan sus URLs al desmontar. Se sigue usando el caché offline previamente configurado.

## Validación

- 120 tests en 14 archivos, todos aprobados: preservación al importar, preservación tras fallo, selección activa/fallback y descarte de texto anterior añadido a las pruebas del motor.
- TypeScript y build GitHub Pages aprobados; JS gzip 341,649 bytes de 360,000 permitidos y CSS 4,956 de 6,000.
- Prueba Playwright con libros sintéticos: dos importaciones, progreso independiente y recarga, favoritos y colección, fallo de tercera importación conservando anteriores, lectura offline. Sin errores JavaScript. 320/390/820/1440 px sin desbordamiento.
- build:ios y cap sync ios aprobados. xcodebuild para simulador iOS: BUILD SUCCEEDED. La referencia SPM relativa portátil se conservó tras sincronizar.
- Lint: los mismos cuatro avisos React heredados; sin errores nuevos.
- No se ha instalado en un iPhone físico; audio nativo real, segundo plano y controles externos siguen requiriendo prueba en dispositivo. Publicar la web no actualiza el paquete instalado por Xcode.

## Archivos

App.tsx, Library.tsx, index.css: catálogo y selección. db.ts: referencia activa y metadata opcional. bookImport.ts: importación no destructiva y fallo explícito si no se crea el registro. speechController.ts: aislamiento de respuestas por libro. Tres suites existentes ampliadas y scripts/verify-library.cjs añadido. verify-ui.cjs actualizado al contrato no destructivo.

## Límites deliberados

Solo una importación a la vez; cambiar libro espera a que termine, para no cruzar callbacks de importación. Una colección por libro en este bloque. No hay sincronización entre dispositivos: cada instalación mantiene sus datos locales. No se modificó el motor de voz nativo.

Pendientes siguientes: importación cancelable y reintento de libros incompletos; detección de duplicados; limpieza transaccional de importaciones parciales y medición con bibliotecas grandes. La base conserva los fallos para diagnóstico, no los elimina automáticamente. Los errores de almacenamiento durante escritura de fragmentos todavía heredan la política tolerante de la base existente; hace falta endurecerla antes de afirmar atomicidad integral.

## Deploy seguro

La versión anterior de gh-pages es 9b7251b9801bfaf66394981222c6fb3bb57a19de. Mantener respaldo remoto antes de publicar y conservar assets anteriores. Push normal, sin force. Revertir el commit de deploy mediante un commit nuevo si hiciera falta. Verificar el sitio público después de terminar GitHub Pages.
