# EvoReader 3.0 — Fases 0 + 1

Implementado y verificado el 17 de septiembre de 2026 sobre la versión local `f149ecb`.

## Entrega y ubicación

Esta tarea contiene una copia independiente en `evo-reader/`. El repositorio de origen `/Users/robertopinalopez/DEV/active/evo-reader` permanece intacto y limpio. No se publicó ni instaló una nueva versión en el iPhone. `artifacts/evoreader-3.patch` contiene únicamente cambios de código/configuración/documentación y se puede revisar/aplicar sobre esa base. La copia incluye dependencias locales para poder ejecutar la vista previa; no se añadieron dependencias al producto.

## Inspección de arquitectura

React 19 + Vite 8, Capacitor 8 para iOS, IndexedDB v2 mediante `idb`. App.tsx coordina estado, importación y navegación. Los importadores PDF/EPUB/DOCX/TXT/Markdown viven en `src/lib`; SpeechController abstrae reproducción y posición, con motores Web Speech y NativeIosSpeechEngine. EvoSpeechPlugin.swift está registrado por el controlador nativo existente. La base guarda libros, secciones, fragmentos, archivos temporales, portadas y metadatos.

El contrato actual es **un libro activo**: `runImport` llama a `clearAllBooks`. Se conservó ese comportamiento y se añadió confirmación explícita antes de reemplazar el libro y su progreso. No se modificaron importadores, esquema de base de datos, SpeechController ni Swift. La interfaz no simula una biblioteca múltiple ni inventa estadísticas.

## Implementación

- Diseño editorial verde/marfil con fuentes del sistema, iconos SVG y portadas tipográficas locales. Sin peticiones a fuentes, imágenes o servicios externos.
- App Shell con Biblioteca, Lector, Tu lectura y Ajustes. Sidebar en escritorio/iPad y navegación inferior en móvil con safe areas.
- Biblioteca con Continuar, búsqueda, filtros funcionales, portada, progreso y tiempo aproximado de escucha. Estantería adaptada al libro activo real.
- Reader sin tarjeta interior ni scroll anidado: tipografía ajustable, blanco/marfil/oscuro/OLED, controles de fragmentos y capítulos. Enfoque oculta navegación y player, dejando una salida visible.
- EvoPlayer compacto persistente al cambiar de pantalla y completo en panel modal: play/pausa, posición, velocidad, voz, capítulos y temporizador básico.
- Tu lectura muestra libro, avance y secciones reales. No presenta horas inventadas.
- Componentes reutilizables AppShell, Library, BookCover, Glyph, Progress, Sheet y EvoPlayer. Dialog nativo aporta aislamiento del fondo, foco, Escape y devolución de foco.
- Preferencias versionadas, validadas y limitadas a rangos seguros; checkpoint localStorage pequeño y respaldo IndexedDB. Reanudación de importación protegida contra doble ejecución de StrictMode.
- Errores de importación atrapados en la UI y fin del bloqueo de importación tras error. Pausa antes de reemplazar libro. Respuestas de secciones obsoletas descartadas; URLs de portada revocadas al cambiar/desmontar.
- PWA incluye ahora el worker PDF `.mjs` en precarga y limpia cachés antiguas administradas por Workbox. Orientación libre para iPad/Mac.

## Archivos modificados respecto a origen

| Archivo | Motivo |
| --- | --- |
| src/App.tsx | Integración del shell, pantallas, preferencias, player y recuperación de UI |
| src/index.css | Design System, responsive, lector, player y paneles |
| vite.config.ts | Identidad PWA, orientación, worker PDF offline y cachés |
| package.json | Comando check:budgets |

Archivos nuevos:

- src/components/AppShell.tsx
- src/components/DesignSystem.tsx
- src/components/Library.tsx
- src/components/EvoPlayer.tsx
- src/lib/uiPreferences.ts
- src/lib/__tests__/uiPreferences.test.ts
- scripts/check-budgets.mjs
- scripts/verify-ui.cjs
- docs/FASES-0-1.md

Capturas y reporte automático en `artifacts/`. No se modificaron archivos sincronizados de `sources/`.

## Guardas y resultados

| Guarda | Resultado y alcance |
| --- | --- |
| Funcionalidad | 117/117 pruebas, 14 archivos; incluye importadores, DB y motores existentes. Importación real de Markdown desde input en Chrome, navegación y cancelación de reemplazo verificadas |
| Diseño | Capturas inspeccionadas de biblioteca, lector OLED y player; estados vacío/con libro |
| Responsive | 1440, 820, 390 y 320 px sin desbordamiento horizontal. Emulación de tamaño en Chrome; no equivale a dispositivos físicos |
| Rendimiento | JS gzip 340,912 bytes / presupuesto 360,000; CSS gzip 4,839 / presupuesto 6,000. Worker PDF separado de 2.23 MB sin comprimir |
| Fluidez | Movimiento de 160 ms mediante transform/opacity; sin librería de animación, blur de fondo ni fuentes remotas; reduced-motion desactiva transiciones. Sin afirmación de FPS medidos en iPhone |
| Persistencia | Progreso confirmado en IndexedDB antes de recarga; preferencias conservadas incluso en recarga rápida. Valores inválidos recuperan defaults. No se garantiza escritura ante cierre antes de confirmar transacción |
| Costo $0 | Sin backend, servicios, cuentas, modelos ni dependencias de pago añadidas |
| Lifecycle | Limpieza Workbox de sus cachés antiguas, worker PDF cacheado, revocación de object URLs, timers/listeners desmontables. Sin cookies o sesiones de autenticación nuevas. No se borra almacenamiento ajeno |
| Offline | Compilación de producción: service worker activo, recarga offline y lectura del libro guardado pasan. Worker PDF presente en precache; importación PDF offline no se ejecutó en esta prueba |
| Builds | TypeScript + build web + bundle CAP_BUILD=1 para iOS correctos. No se ejecutó xcodebuild, firma ni instalación física |
| Lint | Sin errores; 4 avisos React preexistentes, contrastados contra origen: refs, dos set-state-in-effect y dependencia de book |

La prueba de navegador no pudo usar agent-browser: CLI ausente y descarga sin resolución de red. Se utilizó Playwright ya instalado y Chrome en un perfil de prueba aislado, sin tocar biblioteca ni navegación personal.

## Presupuestos y reproducción

`npm test`, `npm run lint`, `npm run build`, `npm run check:budgets`.

`CAP_BUILD=1 npx vite build` genera assets iOS sin alterar el proyecto nativo. El build completo existente `npm run build:ios` también sincroniza Capacitor y queda para el flujo de instalación.

`scripts/verify-ui.cjs` usa Playwright provisto por el entorno (o `PLAYWRIGHT_PATH`) y Chrome. `EVO_URL` permite indicar la vista previa; `EVO_OFFLINE=1` activa la prueba de producción offline. Genera únicamente datos sintéticos en un perfil temporal.

Objetivos perceptuales para próximas fases: primera biblioteca visible en ≤1.5 s en equipo de referencia, respuesta a interacción ≤100 ms y sin tareas UI >50 ms atribuibles al shell. Son objetivos pendientes de medir en hardware real, no resultados prometidos. El bundle grande de importadores es deuda heredada; aquí se limita su crecimiento sin cambiar su estrategia de carga.

## Límites y siguiente fase

**Fase 2 recomendada: biblioteca múltiple con importación no destructiva.** Antes de retirar el aviso de reemplazo: seleccionar libro activo explícito, conservar metadatos/portadas/progreso por libro, hacer importación transaccional y añadir favoritos/colecciones con migración probada.

Los saltos actuales son por fragmento, no 15 segundos: el motor no ofrece una línea temporal de audio exacta. No se falsean etiquetas. El temporizador añadido funciona mientras la app puede ejecutar JavaScript y se verifica al volver a foreground; no garantiza pausa durante suspensión nativa ni persiste tras recargar. Background audio, temporizador nativo y controles externos corresponden a Fase 8.

El lector sigue mostrando el fragmento actual del motor; reflow continuo, vista PDF original y virtualización corresponden a Fase 5. Tu lectura no contabiliza horas aún. La limpieza profunda de huérfanos y recuperación transaccional de importaciones siguen en Fases 3/4/23; la base existente se preservó.

Antes de distribuir: comprobar en iPhone físico voces del sistema, selección de archivos, safe areas con teclado, suspensión/retorno y reproducción nativa. La validación visual web no demuestra el funcionamiento de AVSpeechSynthesizer en el dispositivo.
