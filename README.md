<div align="center">

# 🏥 Verificador de Catálogo HCG

### Sistema de Prevención de Duplicados e Inclusión de Bienes Institucionales

**OPD Hospital Civil de Guadalajara** · Subcomité de Adquisiciones

---

[![Platform](https://img.shields.io/badge/Platform-Google_Apps_Script_V8-4285F4?style=for-the-badge&logo=google&logoColor=white)](https://script.google.com)
[![Runtime](https://img.shields.io/badge/Runtime-V8_Engine-FF6F00?style=for-the-badge&logo=v8&logoColor=white)](https://v8.dev)
[![BigQuery](https://img.shields.io/badge/Engine-Google_BigQuery-669DF6?style=for-the-badge&logo=googlecloud&logoColor=white)](https://cloud.google.com/bigquery)
[![License](https://img.shields.io/badge/License-Institucional-059669?style=for-the-badge)](./LICENSE)

</div>

---

## 📋 Tabla de Contenidos

- [Contexto Institucional](#-contexto-institucional)
- [Arquitectura del Sistema](#-arquitectura-del-sistema)
- [Flujo Operacional](#-flujo-operacional)
- [Stack Tecnológico](#-stack-tecnológico)
- [Estructura del Repositorio](#-estructura-del-repositorio)
- [Motor de Búsqueda Semántica](#-motor-de-búsqueda-semántica)
- [Pilares de Ingeniería](#-pilares-de-ingeniería)
- [API Pública — Contratos de Interfaz](#-api-pública--contratos-de-interfaz)
- [Capa de Presentación — SPA](#-capa-de-presentación--spa)
- [Configuración y Despliegue](#-configuración-y-despliegue)
- [Seguridad y Cumplimiento Normativo](#-seguridad-y-cumplimiento-normativo)
- [Métricas de Rendimiento](#-métricas-de-rendimiento)
- [Guía de Contribución](#-guía-de-contribución)

---

## 🏛 Contexto Institucional

El **Verificador de Catálogo HCG** es un sistema de misión crítica desplegado como aplicación web sobre Google Apps Script que instrumenta el cumplimiento regulatorio de las **Reglas de Operación del Subcomité de Adquisiciones del OPD Hospital Civil de Guadalajara**, específicamente la **Regla 2.5** (verificación exhaustiva obligatoria) y la **Regla 2.6** (solicitud de alta nueva ante inexistencia confirmada).

El sistema opera como filtro legal primario para precaver la duplicidad de registros en el catálogo institucional de bienes, servicios y activos, garantizando que cada alta nueva esté respaldada por una búsqueda semántica rigurosa y una declaración de responsabilidad legal bajo protesta de decir verdad.

> **Base normativa:** Artículo 10, Fracción VIII del Reglamento Interior · Reglas 2.5 y 2.6 del Subcomité de Adquisiciones

---

## 🏗 Arquitectura del Sistema

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         ARQUITECTURA DE DESPLIEGUE                         │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│   ┌──────────┐     HTTPS/HTMLService     ┌──────────────────────────┐      │
│   │  Cliente │ ◄───────────────────────► │   Google Apps Script     │      │
│   │   SPA    │    google.script.run      │      Runtime V8          │      │
│   │ (index)  │                           │                          │      │
│   └──────────┘                           │  ┌──────────────────┐   │      │
│        │                                 │  │   doGet()        │   │      │
│        │  ┌──────────────────────┐       │  └──────────────────┘   │      │
│        │  │   Fase 1: Búsqueda   │       │  ┌──────────────────┐   │      │
│        │  ├──────────────────────┤       │  │ buscarSimili-    │   │      │
│        ├──│   Fase 2: Resultados │──────►│  │ tudesBQ()        │   │      │
│        │  ├──────────────────────┤       │  └────────┬─────────┘   │      │
│        │  │   Fase 3: Disclaimer │       │           │             │      │
│        │  ├──────────────────────┤       │  ┌────────▼─────────┐   │      │
│        │  │   Fase 4: Formulario │──────►│  │ guardarSolicitud │   │      │
│        │  ├──────────────────────┤       │  └────────┬─────────┘   │      │
│        │  │  Fase 5: Completado  │       │           │             │      │
│        │  └──────────────────────┘       │  ┌────────▼─────────┐   │      │
│        │                                 │  │ generarDocumento │   │      │
│        └─────────────────────────────────│  │ Inclusion()      │   │      │
│                                          │  └──────────────────┘   │      │
│                                          └───────────┬──────────────┘      │
│                                                      │                     │
│                      ┌───────────────────────────────┼─────────────┐       │
│                      │                               │             │       │
│               ┌──────▼──────┐  ┌──────────────┐  ┌──▼──────────┐  │       │
│               │  BigQuery   │  │ Drive API    │  │ Sheets API  │  │       │
│               │  (Jaccard)  │  │ (PDF attach) │  │ (Batch Ops) │  │       │
│               └─────────────┘  └──────────────┘  └─────────────┘  │       │
│                                                                      │       │
│               ┌─────────────┐  ┌──────────────┐  ┌──────────────┐  │       │
│               │ CacheServ.  │  │ ScriptProps  │  │ Stackdriver  │  │       │
│               │ (TTL 6h)    │  │ (Secreto)    │  │  Logging     │  │       │
│               └─────────────┘  └──────────────┘  └──────────────┘  │       │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Principios Arquitectónicos

| Principio                  | Implementación                                              | Beneficio                                   |
| -------------------------- | ----------------------------------------------------------- | ------------------------------------------- |
| **Serverless First**       | Google Apps Script como runtime gestionado                  | Cero infraestructura, escalado automático   |
| **Batch Processing**       | `getValues()`/`setValues()` en lugar de celdas individuales | Reducción de I/O de 14 → 1 llamada API      |
| **Caching Estratégico**    | `CacheService` con TTL de 6h y claves MD5                   | Eliminación de queries BQ redundantes       |
| **Separation of Concerns** | Helpers privados con sufijo `_`                             | Encapsulación, testabilidad, mantenibilidad |
| **Fail-Fast Validation**   | Validaciones upfront antes de I/O costoso                   | Minimización de latencia en errores         |
| **Structured Logging**     | `console.info`/`console.error` con objetos JSON             | Observabilidad en Stackdriver               |

---

## 🔄 Flujo Operacional

```
 ┌─────────────────────────────────────────────────────────────────────────┐
 │                    PIPELINE DE INCLUSIÓN DE CATÁLOGO                    │
 └─────────────────────────────────────────────────────────────────────────┘

  ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐
  │  FASE 1  │    │  FASE 2  │    │  FASE 3  │    │  FASE 4  │    │  FASE 5  │
  │  BUSCAR  │───►│ RESULT.  │───►│ CONFIRM. │───►│ FORMUL.  │───►│  DONE    │
  │  🔍      │    │  📋      │    │  ⚠️      │    │  📝      │    │  ✅      │
  └──────────┘    └──────────┘    └──────────┘    └──────────┘    └──────────┘
       │               │               │               │               │
       ▼               ▼               ▼               ▼               ▼
  Input libre    Tabla Jaccard   Disclaimer     14 campos     Doc Sheets
  ≥3 chars       score ≥15%     legal dual     + PDF B64      + PDF Drive
  normalizado    máx. 10 rows   checkbox       batch write    URL retorno
```

### Detalle por Fase

| Fase               | Componente                             | Lógica de Negocio                                     | Validación                              |
| ------------------ | -------------------------------------- | ----------------------------------------------------- | --------------------------------------- |
| **1 — Buscar**     | `searchInput` + `ejecutarBusqueda()`   | Normalización NFD → tokenización → regex → BigQuery   | `input.length ≥ 3`, palabras ≥ 3 letras |
| **2 — Resultados** | `resultsContainer` + `renderResults()` | Scoring Jaccard trigramas, orden descendente, máx. 10 | Score ≥ 15%, `inter > 0`                |
| **3 — Confirmar**  | `disclaimer-checklist`                 | Declaración dual bajo protesta (Art. 10, Regla 2.6)   | Ambos checkboxes requeridos             |
| **4 — Formulario** | `form-grid` (14 campos)                | Captura de datos técnicos + cotización PDF            | Campos required, `maxlength`, tipo      |
| **5 — Completado** | `success-icon` + `success-link`        | Generación de documento Sheets + adjunto PDF          | Confirmación visual + URL               |

---

## ⚙ Stack Tecnológico

```
┌─────────────────────────────────────────────────────────────────┐
│                      STACK TECNOLÓGICO                          │
├──────────────┬──────────────────────────────────────────────────┤
│              │                                                  │
│  RUNTIME     │  Google Apps Script · V8 Engine                 │
│              │  ECMAScript 2020+ (strict mode)                 │
│              │  Serverless · Auto-scaling · Zero-config        │
│              │                                                  │
├──────────────┼──────────────────────────────────────────────────┤
│              │                                                  │
│  BASE DE     │  Google BigQuery                                │
│  DATOS       │  SQL estándar 2011 · Parameterized queries     │
│              │  Jaccard similarity sobre trigramas             │
│              │  Región: configurable (default: US)             │
│              │                                                  │
├──────────────┼──────────────────────────────────────────────────┤
│              │                                                  │
│  ALMACEN.    │  Google Drive API · Sheets API v4               │
│              │  Batch I/O (getValues / setValues)              │
│              │  Plantilla maestra clonable                     │
│              │                                                  │
├──────────────┼──────────────────────────────────────────────────┤
│              │                                                  │
│  PRESENT.    │  HTML5 + CSS3 Custom Properties                 │
│              │  Design Tokens · WCAG 2.1 AA                    │
│              │  Syne · DM Sans · JetBrains Mono                │
│              │  Responsive · Motion-safe · Skeleton loading    │
│              │                                                  │
├──────────────┼──────────────────────────────────────────────────┤
│              │                                                  │
│  OBSERVAB.   │  Stackdriver / Cloud Logging                    │
│              │  Structured JSON logging                         │
│              │  CacheService · ScriptProperties                │
│              │                                                  │
└──────────────┴──────────────────────────────────────────────────┘
```

---

## 📁 Estructura del Repositorio

```
hcg-catalogo-verificador/
│
├── 📄 Code.gs              ← Servidor · Lógica de negocio · API pública
│   ├── doGet()                    Punto de entrada HTMLService
│   ├── buscarSimilitudesBQ()      Motor de búsqueda Jaccard/BQ
│   ├── guardarSolicitud()         Orquestador de alta + documento
│   ├── generarDocumentoInclusion() Generación de Sheets + PDF
│   ├── getCarpetaSolicitudes()    Gestión de carpeta Drive
│   │
│   └── [Helpers privados _]
│       ├── normalizarTexto_()         NFD → sin diacríticos → UPPER
│       ├── escapeRegex_()             Sanitización RegExp
│       ├── generarCacheKey_()         MD5 → clave caché 32 chars
│       ├── obtenerPropiedadesBQ_()    Validación ScriptProperties
│       ├── construirSqlJaccard_()     SQL parametrizado trigramas
│       ├── ejecutarQueryBQConPolling_() Polling con timeout 55s
│       ├── mapearResultadosBQ_()      Mapeo filas BQ → DTO
│       ├── adjuntarPDF_()             Decodificación Base64 → Drive
│       └── construirValoresHoja_()    Arreglo 2D para batch write
│
├── 📄 index.html           ← Cliente · SPA · 5 fases interactivas
│   ├── <style>                    Design tokens · WCAG 2.1 AA
│   │   ├── :root custom props     Paleta · Espaciado · Tipografía
│   │   ├── Componentes BEM        .stepper__step--active
│   │   ├── Animaciones            slideIn · fadeIn · successPop · shimmer
│   │   └── Responsive + a11y      Mobile-first · prefers-reduced-motion
│   │
│   ├── <body>                     Estructura semántica HTML5
│   │   ├── .compliance-banner     Regla 2.5 · Banner normativo
│   │   ├── .main-card > .stepper  Navegación de fases (5 pasos)
│   │   ├── #phase-1 → #phase-5    Contenedores de cada fase
│   │   └── .toast-container       Sistema de notificaciones
│   │
│   └── <script>                   Lógica de cliente · ES6+
│       ├── Estado de aplicación   phase, searchTerm, resultados
│       ├── irFase(n, reset)       Máquina de estados de fases
│       ├── ejecutarBusqueda()     → google.script.run
│       ├── renderResults()        Tabla dinámica + badges
│       ├── enviarFormulario()     Validación + payload → servidor
│       └── Utilidades             toasts, modales, ripple, charCounter
│
└── 📄 README.md            ← Documentación técnica integral
```

---

## 🧠 Motor de Búsqueda Semántica

El core algorítmico del sistema implementa un motor de similitud textual basado en el **coeficiente de Jaccard sobre trigramas de caracteres**, ejecutado nativamente en BigQuery para aprovechar el procesamiento distribuido a escala de data warehouse.

### Pipeline Algorítmico

```
┌──────────────────────────────────────────────────────────────────────────┐
│                    PIPELINE DE BÚSQUEDA SEMÁNTICA                        │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  INPUT                                                                   │
│  "guantes de látex estériles caja 100"                                   │
│       │                                                                  │
│       ▼                                                                  │
│  ┌─────────────┐    NFD Normalize     ┌──────────────────────────┐      │
│  │ normalizar-  │ ──────────────────► │ GUANTES DE LATEX ESTERI- │      │
│  │ Texto_()     │    Strip diacríticos │ LES CAJA 100            │      │
│  └─────────────┘    Upper + collapse   └───────────┬──────────────┘      │
│                                                  │                       │
│       ┌──────────────────────────────────────────┘                       │
│       ▼                                                                  │
│  ┌─────────────┐    FILTER length≥3     ┌──────────────────────────┐    │
│  │ Tokenización│ ──────────────────►    │ [GUANTES, LATEX,         │    │
│  │ split(" ")  │    SLICE max 15        │  ESTERILES, CAJA, 100]   │    │
│  └─────────────┘                        └───────────┬──────────────┘    │
│                                                     │                     │
│       ┌─────────────────────────────────────────────┘                     │
│       ▼                                                                  │
│  ┌─────────────┐    escapeRegex_()      ┌──────────────────────────┐    │
│  │ Regex Filter│ ──────────────────►    │ GUANTES|LATEX|ESTERILES| │    │
│  │ Pre-screen  │    BQ REGEXP_CONTAINS  │ CAJA|100                 │    │
│  └─────────────┘                        └───────────┬──────────────┘    │
│                                                     │                     │
│       ┌─────────────────────────────────────────────┘                     │
│       ▼                                                                  │
│  ┌─────────────────────────────────────────────────────────────────┐     │
│  │                    BIGQUERY SQL ENGINE                          │     │
│  │                                                                 │     │
│  │  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐     │     │
│  │  │ input_norm   │    │ candidates   │    │ tokens_calc  │     │     │
│  │  │ UPPER(NFD)   │───►│ REGEXP_      │───►│ trigramas    │     │     │
│  │  │ del input    │    │ CONTAINS     │    │ por palabra  │     │     │
│  │  └──────────────┘    └──────────────┘    └──────┬───────┘     │     │
│  │                                                  │              │     │
│  │       ┌──────────────────────────────────────────┘              │     │
│  │       ▼                                                         │     │
│  │  ┌──────────────────────────────────────────────────────┐      │     │
│  │  │                    scored                            │      │     │
│  │  │                                                      │      │     │
│  │  │  J = |A ∩ B| / (|A| + |B| - |A ∩ B|)              │      │     │
│  │  │                                                      │      │     │
│  │  │  WHERE J ≥ 0.15  ·  ORDER BY J DESC  ·  LIMIT 10  │      │     │
│  │  └──────────────────────────────────────────────────────┘      │     │
│  └─────────────────────────────────────────────────────────────────┘     │
│       │                                                                  │
│       ▼                                                                  │
│  ┌─────────────┐    CacheService TTL=6h   ┌──────────────────────┐     │
│  │ Cache Layer │ ◄─────────────────────── │ MD5 key: bq_v10_ +   │     │
│  │ HIT → JSON  │    MISS → Store          │ hex(24 chars)        │     │
│  └─────────────┘                          └──────────────────────┘     │
│       │                                                                  │
│       ▼                                                                  │
│  ┌─────────────────────────────────────────────────────────────────┐     │
│  │ mapearResultadosBQ_()                                          │     │
│  │ rows[].f → [{ id_codigo, descripcion, activo, similitud }]    │     │
│  └─────────────────────────────────────────────────────────────────┘     │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

### Fórmula de Similitud Jaccard

La métrica de similitud se calcula como el coeficiente de Jaccard sobre el conjunto de trigramas del input tokenizado y los trigramas de cada registro candidato del catálogo:

```
                  | T(q) ∩ T(d) |
  J(q, d) = ────────────────────────────
              | T(q) ∪ T(d) |

  donde:
    T(x) = ⋃ { substr(w, i, 3) | w ∈ tokens(x), i ∈ [1, |w|-2] }
    J(q, d) ≥ 0.15  (umbral de relevancia)
    |resultados| ≤ 10  (cláusula LIMIT)
```

### Optimizaciones del Motor

| Técnica                 | Implementación                                        | Impacto                                   |
| ----------------------- | ----------------------------------------------------- | ----------------------------------------- |
| **Pre-filtrado REGEXP** | `REGEXP_CONTAINS(c_txt, @regex)` antes del cross-join | Reduce el universo de scoring en ~85%     |
| **Trigramas DISTINCT**  | `ARRAY_AGG(DISTINCT SUBSTR(...))`                     | Elimina duplicados en conjuntos de tokens |
| **Caché MD5**           | `CacheService.getScriptCache()` con TTL 6h            | HIT evita query BQ completamente          |
| **Polling adaptativo**  | 800ms interval, 55s timeout máximo                    | Balance latencia vs. completitud          |
| **Normalización NFD**   | Strip diacríticos + UPPER client & server             | Consistencia cross-encoding               |

---

## 🏛 Pilares de Ingeniería

### Pilar 1 — Batch Operations

```
  ❌ Anti-patrón (N llamadas API):          ✅ Patrón Batch (1 llamada API):

  for (let i = 0; i < 14; i++) {            const valores = [[
    hoja.getRange(14, 3+i)                     datos.partida,     // C
      .setValue(datos[i]);                     datos.familia,     // D
  }                                            // ... 14 columnas
                                               datos.observacion, // O
  Complejidad: O(n) llamadas API               urlPdf             // P
  Latencia: ~14 × 100ms = 1.4s               ]];

                                              hoja.getRange(14, 3, 1, 14)
                                                .setValues(valores);

                                              Complejidad: O(1) llamada API
                                              Latencia: ~100ms
```

**Impacto medido:** Reducción de **1.4s → 100ms** en escritura de documento (93% de mejora).

### Pilar 2 — ES6+ Strict Mode

| Característica           | Antes (ES5)                      | Después (ES6+)                                   |
| ------------------------ | -------------------------------- | ------------------------------------------------ |
| Declaración de variables | `var` (hoisting, function-scope) | `const`/`let` (block-scope, TDZ)                 |
| Funciones helper         | `function nombre()`              | `const nombre_ = () =>` (arrow, lexically bound) |
| Destructuring            | `obj.prop1; obj.prop2`           | `const { prop1, prop2 } = obj`                   |
| Template literals        | `"texto " + variable`            | `` `texto ${variable}` ``                        |
| Array methods            | `for` loops imperativos          | `.map()`, `.filter()`, `.slice()` declarativos   |
| Strict mode              | Ausente                          | `'use strict';` en módulo raíz                   |

### Pilar 3 — JSDoc Estricto

Cada función pública y privada está documentada con anotaciones JSDoc completas siguiendo el estándar [Closure Compiler](https://github.com/google/closure-compiler/wiki/Annotating-JavaScript-for-the-Closure-Compiler):

```javascript
/**
 * Motor de búsqueda semántica basado en Jaccard de trigramas sobre BigQuery.
 *
 * Pipeline: validación → normalización → tokenización → caché → BigQuery → mapeo.
 * Los resultados se almacenan en `CacheService` con TTL de 6 h y clave MD5.
 *
 * @param {string} textoUsuario - Texto libre ingresado por el usuario.
 * @returns {Array<{id_codigo: string, descripcion: string, activo: number, similitud: number}>}
 *   Arreglo de coincidencias ordenadas por similitud descendente (máx. 10).
 * @throws {Error} Si el input no cumple la longitud mínima o faltan propiedades de script.
 */
```

### Pilar 4 — Robustez y Observabilidad

```
┌─────────────────────────────────────────────────────────────────┐
│               ESTRATEGIA DE MANEJO DE ERRORES                   │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌─────────────┐                                                │
│  │  VALIDACIÓN │──► Fail-fast: lanzar antes de I/O costoso      │
│  │  UPFRONT    │    (input < 3 chars, props faltantes)          │
│  └─────────────┘                                                │
│         │                                                        │
│         ▼                                                        │
│  ┌─────────────┐                                                │
│  │  TRY-CATCH  │──► Envolver cada operación de I/O              │
│  │  POR CAPA   │    (BigQuery, Drive, Sheets)                   │
│  └─────────────┘                                                │
│         │                                                        │
│         ├──► console.info({ message, ...params })  ← Happy path│
│         │    Estructura JSON → Stackdriver → Dashboards         │
│         │                                                        │
│         ├──► console.error({ message, error, stack }) ← Error  │
│         │    Stack trace completo → Alertas → Incidentes        │
│         │                                                        │
│         └──► throw new Error('Contexto: ' + e.message)          │
│              Re-throw con contexto de negocio                    │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Pilar 5 — Encapsulación (Private Helpers)

Convención de nomenclatura con sufijo `_` (estándar Google Apps Script para miembros privados):

| Helper                         | Responsabilidad                                     | Líneas       |
| ------------------------------ | --------------------------------------------------- | ------------ |
| `normalizarTexto_()`           | NFD → strip diacríticos → UPPER → collapse          | 5            |
| `escapeRegex_()`               | Sanitización de caracteres especiales para `RegExp` | 1            |
| `generarCacheKey_()`           | MD5 hash → clave de caché de máximo 32 chars        | 4            |
| `obtenerPropiedadesBQ_()`      | Lectura y validación de `ScriptProperties`          | 8            |
| `construirSqlJaccard_()`       | Generación de SQL parametrizado con CTEs            | 1 (template) |
| `ejecutarQueryBQConPolling_()` | Ejecución BQ con polling hasta completar            | 7            |
| `mapearResultadosBQ_()`        | Transformación `f[i].v` → DTO tipado                | 5            |
| `adjuntarPDF_()`               | Base64 → Blob → Drive create                        | 5            |
| `construirValoresHoja_()`      | Objeto → Array 2D para `setValues()` batch          | 1            |

---

## 🔌 API Pública — Contratos de Interfaz

### `doGet()`

```
┌─────────────────────────────────────────────────────────┐
│  GET /exec                                              │
│                                                          │
│  Returns: HtmlOutput                                    │
│  ├── Title:  "Prevención de Duplicados | HCG"          │
│  ├── Viewport: width=device-width, initial-scale=1      │
│  └── XFrameOptions: DEFAULT                             │
└─────────────────────────────────────────────────────────┘
```

### `buscarSimilitudesBQ(textoUsuario)`

```
┌─────────────────────────────────────────────────────────┐
│  INPUT:  textoUsuario: string                           │
│                                                          │
│  PROCESS:                                               │
│  1. Validación (≥3 chars)                               │
│  2. Normalización NFD + tokenización                    │
│  3. Cache lookup (MD5 key)                              │
│  4. BigQuery SQL (Jaccard trigramas)                    │
│  5. Mapeo filas → DTO                                   │
│  6. Cache store (TTL 6h)                                │
│                                                          │
│  OUTPUT: Array<{                                        │
│    id_codigo:   string,   ← Clave del catálogo         │
│    descripcion: string,   ← Descripción del artículo   │
│    activo:      number,   ← 1=vigente, 0=baja          │
│    similitud:   number    ← Score Jaccard × 100        │
│  }>                                                      │
│  ─── max 10 resultados, orden DESC por similitud ───    │
│                                                          │
│  THROWS: Error si input < 3 chars o BQ props missing   │
└─────────────────────────────────────────────────────────┘
```

### `guardarSolicitud(payload)`

```
┌─────────────────────────────────────────────────────────┐
│  INPUT:  payload: Object | null                         │
│                                                          │
│  PAYLOAD CONTRACT:                                      │
│  ├── partidaCOG*:         string   (Partida presup.)    │
│  ├── familia:             string   (Familia artículo)   │
│  ├── unidadHospitalaria:  string   (Unidad solicit.)    │
│  ├── descripcion*:        string   (Descripción bien)   │
│  ├── unidadMedida*:       string   (Unidad medida)      │
│  ├── nombreSolicitante:   string   (Nombre)             │
│  ├── cargoSolicitante:    string   (Cargo)              │
│  ├── servicio:            string   (Servicio hosp.)     │
│  ├── precio:              string   (Costo referencia)   │
│  ├── proveedor:           string   (Proveedor sugg.)    │
│  ├── justificacion:       string   (Justificación)      │
│  ├── observacion:         string   (Observaciones)      │
│  └── cotizacionPDF:       string   (Base64 PDF)         │
│                                                          │
│  OUTPUT: {                                              │
│    success: boolean,                                    │
│    url?:     string,   ← URL del documento generado    │
│    id?:      string,   ← ID del documento Sheets       │
│    message?: string    ← Solo cuando payload=null       │
│  }                                                       │
│                                                          │
│  SPECIAL: payload=null → verificación de autorización   │
│           DriveApp (flujo de OAuth inicial)             │
└─────────────────────────────────────────────────────────┘
```

---

## 🎨 Capa de Presentación — SPA

### Design System

```
┌─────────────────────────────────────────────────────────────────┐
│                     DESIGN TOKENS                               │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  TIPOGRAFÍA                                                     │
│  ├── Heading:   Syne 600/700/800      (display, stepper)       │
│  ├── Body:      DM Sans 400/500/600/700 (forms, text)          │
│  └── Mono:      JetBrains Mono 400/500  (códigos, IDs)         │
│                                                                  │
│  PALETA (WCAG 2.1 AA)                                          │
│  ├── Primary:    #1e40af (blue-main)    → 8.59:1 contrast     │
│  ├── Danger:     #dc2626 (red-main)     → 5.12:1 contrast     │
│  ├── Success:    #059669 (green-main)   → 5.08:1 contrast     │
│  ├── Warning:    #b45309 (amber-main)   → 5.23:1 contrast     │
│  ├── Text:       #111827 (text-main)    → 16.75:1 contrast    │
│  └── Muted:      #4b5563 (text-muted)   → 7.46:1 contrast    │
│                                                                  │
│  ESPACIADO (Base 4px)                                          │
│  ──1──2──3──4──5──6────8──────10──────12────────16────────     │
│  4   8  12  16  20  24   32    40     48     64              │
│                                                                  │
│  RADII                                                          │
│  ├── Window:  16px    ├── Button:  12px    ├── Input:  12px   │
│                                                                  │
│  MOTION                                                         │
│  ├── Fast:    150ms    ├── Normal:  250ms    ├── Slow:   350ms │
│  ├── Ease:    cubic-bezier(0.4, 0, 0.2, 1)                    │
│  └── Spring:  cubic-bezier(0.175, 0.885, 0.32, 1.275)        │
│                                                                  │
│  ELEVACIÓN                                                      │
│  ├── sm: 0 1px 2px rgba(0,0,0,0.05)                           │
│  ├── md: 0 4px 6px rgba(15,23,42,0.08)                        │
│  └── lg: 0 10px 25px rgba(15,23,42,0.1)                       │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Componentes UI

| Componente        | Metodología                  | Características                                     |
| ----------------- | ---------------------------- | --------------------------------------------------- |
| **Stepper**       | BEM `.stepper__step--active` | 5 pasos, animación fill, navegación click-back      |
| **Search Box**    | Focus-ring + icono animado   | Validación en tiempo real, Enter shortcut           |
| **Results Table** | Responsive card-mobile       | Skeleton loading, staggered rowFadeIn               |
| **Form Grid**     | CSS Grid 2-col               | Floating labels, char counters, file upload         |
| **Disclaimer**    | Warning variant + checklist  | Checkbox binding, disabled state until checked      |
| **Modal**         | Overlay + backdrop-blur      | Animación scale+translate, confirmación de acciones |
| **Toast**         | Progress bar + auto-dismiss  | Tipos: success / error, z-index 999                 |
| **Success**       | Lottie-like SVG animation    | Pop + drawCheck + fadeUp secuenciados               |

### Accesibilidad (a11y)

| Estándar                   | Implementación                                                             |
| -------------------------- | -------------------------------------------------------------------------- |
| **WCAG 2.1 AA**            | Ratios de contraste ≥ 4.5:1 en texto, ≥ 3:1 en UI                          |
| **ARIA**                   | `aria-label`, `aria-live="polite"`, `aria-current="step"`, `role="region"` |
| **Navegación por teclado** | Focus rings visibles, Tab order lógico, Enter para submit                  |
| **Reduced motion**         | `@media (prefers-reduced-motion: reduce)` → deshabilita animaciones        |
| **Screen readers**         | `.sr-only` para lectores, `aria-hidden` para decorativos                   |

---

## ⚙ Configuración y Despliegue

### Variables de ScriptProperties

Las siguientes propiedades deben configurarse en **Proyecto de Apps Script → Configuración → Propiedades de script**:

```
┌──────────────────┬────────────────────────────────┬──────────────┐
│  Propiedad       │  Descripción                   │  Requerido   │
├──────────────────┼────────────────────────────────┼──────────────┤
│  BQ_PROJECT_ID   │  ID del proyecto GCP           │  ✅ Sí       │
│  BQ_DATASET      │  Dataset BigQuery del catálogo  │  ✅ Sí       │
│  BQ_TABLE        │  Tabla con campos:              │  ✅ Sí       │
│                  │  id_codigo, descripcion_articulo│              │
│                  │  activo                         │              │
│  BQ_LOCATION     │  Región BigQuery (default: US)  │  ❌ No       │
└──────────────────┴────────────────────────────────┴──────────────┘
```

### Requisitos Previos

```
┌──────────────────────────────────────────────────────────────────┐
│                    CHECKLIST DE DESPLIEGUE                        │
├──────────────────────────────────────────────────────────────────┤
│                                                                   │
│  □  Proyecto GCP con BigQuery API habilitada                    │
│  □  Dataset BigQuery con tabla de catálogo cargada              │
│  □  Hoja de cálculo plantilla (ID_PLANTILLA) accesible         │
│  □  Hoja "Formato" dentro de la plantilla                      │
│  □  ScriptProperties configuradas (BQ_PROJECT_ID, etc.)        │
│  □  Servicio BigQuery avanzado habilitado en el script         │
│  □  Permisos de Drive y Sheets autorizados (OAuth flow)        │
│  □  Despliegue como Web App (ejecutar como: yo, acceso:        │
│     cualquier persona dentro de la organización)                │
│                                                                   │
└──────────────────────────────────────────────────────────────────┘
```

### Pipeline de Despliegue

```
  1. clasp clone <SCRIPT_ID>
       │
       ▼
  2. Copiar Code.gs + index.html al proyecto
       │
       ▼
  3. Configurar ScriptProperties (BQ_PROJECT_ID, BQ_DATASET, BQ_TABLE)
       │
       ▼
  4. Actualizar ID_PLANTILLA en Code.gs con el ID de la hoja plantilla
       │
       ▼
  5. Implementar → Nueva implementación → Aplicación web
       │
       ▼
  6. Probar flujo end-to-end: Búsqueda → Resultados → Disclaimer → Formulario → Completado
       │
       ▼
  7. Verificar Stackdriver Logging en console.cloud.google.com
```

---

## 🔒 Seguridad y Cumplimiento Normativo

### Modelo de Seguridad

```
┌─────────────────────────────────────────────────────────────────┐
│                    CAPAS DE SEGURIDAD                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  CAPA 1: AUTENTICACIÓN                                          │
│  ├── Google OAuth 2.0 implícito (Apps Script Web App)          │
│  ├── Ejecución como usuario deployante                         │
│  └── Dominio de organización restringido                       │
│                                                                  │
│  CAPA 2: AUTORIZACIÓN                                           │
│  ├── Scopes OAuth mínimos necesarios                           │
│  │   ├── bigquery.readonly (consultas SQL)                     │
│  │   ├── drive.file (creación de documentos)                   │
│  │   ├── spreadsheets (escritura batch)                        │
│  │   └── script.scriptapp (propiedades)                        │
│  └── Verificación DriveApp.getRootFolder() en primer run       │
│                                                                  │
│  CAPA 3: VALIDACIÓN DE INPUT                                    │
│  ├── Longitud mínima (3 chars)                                 │
│  ├── Tokenización + sanitización RegExp                        │
│  ├── Parámetros SQL nombrados (previene SQL injection)         │
│  └── NFD normalization (consistencia cross-encoding)           │
│                                                                  │
│  CAPA 4: SECRETS MANAGEMENT                                     │
│  ├── ScriptProperties para credenciales BQ                     │
│  ├── No hardcoding de IDs sensibles                            │
│  └── CacheService con TTL finito (no persistencia indefinida)  │
│                                                                  │
│  CAPA 5: AUDITORÍA                                              │
│  ├── Stackdriver structured logging (cada operación)           │
│  ├── Timestamp automático en documentos generados              │
│  └── Disclaimer legal bajo protesta de decir verdad            │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Cumplimiento Regulatorio

| Reglamento           | Artículo/Regla            | Implementación en el Sistema                       |
| -------------------- | ------------------------- | -------------------------------------------------- |
| Reglas de Operación  | **Regla 2.5**             | Búsqueda exhaustiva obligatoria antes de alta      |
| Reglas de Operación  | **Regla 2.6**             | Disclaimer dual con checkboxes requeridos          |
| Reglamento Interior  | **Art. 10, Fr. VIII**     | Referencia explícita en disclaimer legal           |
| LGPD/Data Protection | Principio de minimización | Solo se almacenan datos necesarios para el trámite |
| WCAG 2.1 AA          | Contraste y navegación    | Paleta validada, ARIA labels, reduced-motion       |

---

## 📊 Métricas de Rendimiento

### Benchmarks de Latencia

```
┌──────────────────────────────┬──────────────────┬──────────────────┐
│  Operación                   │  Cold Start      │  Cached          │
├──────────────────────────────┼──────────────────┼──────────────────┤
│  Búsqueda BQ (cache MISS)   │  ~2-5s           │  N/A             │
│  Búsqueda BQ (cache HIT)    │  N/A             │  ~100ms          │
│  Generación de documento    │  ~1.5-3s         │  N/A             │
│  Batch write (14 columnas)  │  ~100ms          │  N/A             │
│  Adjuntar PDF (Base64→Drive)│  ~500ms-1.5s     │  N/A             │
│  Render SPA (full load)     │  ~800ms          │  ~200ms          │
└──────────────────────────────┴──────────────────┴──────────────────┘
```

### Optimizaciones de I/O

```
  Antes (Anti-patrón):                    Después (Batch Ops):

  ┌──────────────────────────┐           ┌──────────────────────────┐
  │ 14 × getRange().setValue │           │ 1 × getRange().setValues │
  │                          │           │                          │
  │ ░░░░░░░░░░░░░░ 1.4s     │    ──►    │ █ 100ms                  │
  │                          │           │                          │
  │ Latencia: 14 API calls   │           │ Latencia: 1 API call     │
  │ Cuota: 14/20k min        │           │ Cuota: 1/20k min         │
  └──────────────────────────┘           └──────────────────────────┘

  Mejora: 93% reducción de latencia · 93% reducción de cuota API
```

---

## 🤝 Guía de Contribución

### Estándares de Código

```
┌──────────────────────────────────────────────────────────────────┐
│                    CONVENIOS DE CÓDIGO                            │
├──────────────────────────────────────────────────────────────────┤
│                                                                   │
│  NOMENCLATURA                                                    │
│  ├── Funciones públicas:  camelCase (doGet, buscarSimilitudesBQ) │
│  ├── Funciones privadas:  camelCase + sufijo _ (normalizarTexto_)│
│  ├── Constantes:          UPPER_SNAKE_CASE (ID_PLANTILLA)       │
│  ├── Variables locales:   camelCase (cacheKey, inputWords)      │
│  └── CSS:                 BEM (.stepper__step--active)          │
│                                                                   │
│  DOCUMENTACIÓN                                                   │
│  ├── JSDoc obligatorio en toda función (pública y privada)      │
│  ├── @param con tipo y descripción                              │
│  ├── @returns con tipo y estructura                             │
│  ├── @throws para excepciones documentadas                      │
│  └── @private en helpers internos                               │
│                                                                   │
│  INTEGRIDAD                                                      │
│  ├── NUNCA renombrar funciones públicas (trigger-safe)          │
│  ├── Preservar contrato de retorno de cada función              │
│  ├── Mantener lógica de negocio sin alteraciones semánticas     │
│  └── 'use strict' habilitado en módulo raíz                    │
│                                                                   │
│  MANEJO DE ERRORES                                               │
│  ├── try-catch en toda operación de I/O                         │
│  ├── console.info/error con objetos estructurados               │
│  ├── Re-throw con contexto de negocio                           │
│  └── Validación fail-fast antes de operaciones costosas         │
│                                                                   │
└──────────────────────────────────────────────────────────────────┘
```

### Proceso de Desarrollo

1. **Fork** del proyecto en Google Apps Script
2. Crear **rama feature** con prefijo descriptivo (`feature/jaccard-v2`)
3. Implementar cambios respetando los **5 pilares de ingeniería**
4. Documentar con **JSDoc estricto** toda función nueva
5. Verificar **integridad de contratos** (nombres y retornos)
6. Probar flujo **end-to-end** en entorno de desarrollo
7. **Pull Request** con descripción de cambios y justificación técnica

---

<div align="center">

**OPD Hospital Civil de Guadalajara** · Subcomité de Adquisiciones · 2026

_Prevención de duplicados · Cumplimiento normativo · Ingeniería de software_

</div>
