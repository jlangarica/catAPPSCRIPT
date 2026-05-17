<div align="center">

# 🏥 Verificador de Catálogo HCG

### Sistema de Prevención de Duplicados e Inclusión de Bienes Institucionales

**OPD Hospital Civil de Guadalajara** · División de Servicios Administrativos

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

El **Verificador de Catálogo HCG** es un sistema de misión crítica desplegado como aplicación web sobre Google Apps Script que instrumenta el cumplimiento regulatorio del **OPD Hospital Civil de Guadalajara**, específicamente para la prevención de duplicidad en el catálogo institucional de bienes, servicios y activos.

El sistema opera bajo las normativas del Subcomité de Adquisiciones, garantizando que cada alta nueva esté respaldada por una búsqueda semántica rigurosa y una declaración de responsabilidad legal.

> **Base normativa:** Reglamento Interior (Art. 10, Fr. VIII) · Reglas 2.5, 2.6 y 2.7 del Subcomité de Adquisiciones.

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
│               ┌───────▼────────┐  ┌──────────────┐  ┌───▼──────────┐  │       │
│               │    BigQuery    │  │  Drive API   │  │  Sheets API  │  │       │
│               │(Jaccard Hybrid)│  │ (PDF attach) │  │ (Batch Ops)  │  │       │
│               └────────────────┘  └──────────────┘  └──────────────┘  │       │
│                                                                            │
│               ┌─────────────┐  ┌──────────────┐  ┌──────────────┐  │       │
│               │ CacheServ.  │  │ ScriptProps  │  │ Stackdriver  │  │       │
│               │ (TTL 6h)    │  │ (BQ Config)  │  │  Logging     │  │       │
│               └─────────────┘  └──────────────┘  └──────────────┘  │       │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Principios Arquitectónicos

| Principio                  | Implementación                                              | Beneficio                                   |
| -------------------------- | ----------------------------------------------------------- | ------------------------------------------- |
| **Serverless First**       | Google Apps Script como runtime gestionado                  | Cero infraestructura, escalado automático   |
| **Batch Processing**       | `setValues()` en bloque (14 columnas)                       | Reducción drástica de latencia I/O          |
| **Caching Estratégico**    | `CacheService` con TTL de 6h y claves MD5                   | Eliminación de queries BQ redundantes       |
| **Separation of Concerns** | Helpers privados con sufijo `_`                             | Encapsulación y mantenimiento limpio        |
| **Lock Management**        | `LockService` para concurrencia de escritura                | Previene colisiones en la plantilla Sheets  |
| **Structured Logging**     | `console.info`/`console.error` con metadatos JSON           | Observabilidad avanzada en GCP              |

---

## 🔄 Flujo Operacional

1.  **🔍 Búsqueda (Fase 1):** Entrada de texto libre (min. 3 caracteres). Normalización clínica y expansión de abreviaturas.
2.  **📋 Resultados (Fase 2):** Visualización de coincidencias por scoring de similitud (Jaccard) extraídas de BigQuery.
3.  **⚠️ Confirmación (Fase 3):** Declaración legal de inexistencia bajo protesta de decir verdad (Art. 10).
4.  **📝 Formulario (Fase 4):** Captura de datos técnicos, COG y adjunto de cotización PDF (Base64).
5.  **✅ Completado (Fase 5):** Generación de expediente en Sheets + Drive y entrega de URL de acceso.

---

## ⚙ Stack Tecnológico

-   **Runtime:** Google Apps Script · V8 Engine (ECMAScript 2020+).
-   **Engine Analítico:** Google BigQuery (SQL estándar) · Procesamiento híbrido de trigramas.
-   **Almacenamiento:** Google Drive API v3 · Google Sheets API v4.
-   **Frontend:** HTML5 · CSS3 (Inter font) · Vanilla JS (ES6+).
-   **Observabilidad:** Google Cloud Logging (Stackdriver).

---

## 📁 Estructura del Repositorio

```
hcg-catalogo-verificador/
│
├── 📄 Code.gs              ← Backend · Lógica de negocio · Integraciones
│   ├── buscarSimilitudesBQ()      Motor analítico Jaccard/BigQuery
│   ├── guardarSolicitud()         Orquestador de alta + documentos
│   ├── generarDocumentoInclusion() Gestión de plantillas y escritura batch
│   └── [Helpers _]                Normalización, Trigramas, MD5, PDF, etc.
│
├── 📄 index.html           ← Frontend · SPA React-like con Vanilla JS
│   ├── <style>                    CSS Variables, Animaciones, Responsive
│   ├── <body>                     Estructura semántica (Fases 1-5)
│   └── <script>                   Estado de la App y comunicación asíncrona
│
├── 📄 appsscript.json      ← Manifiesto · Scopes y Servicios Avanzados
└── 📄 .clasp.json          ← Configuración de sincronización local
```

---

## 🧠 Motor de Búsqueda Semántica

El sistema implementa una búsqueda de similitud léxica avanzada para detectar duplicados incluso con variaciones ortográficas o de sintaxis.

### Pipeline Algorítmico

1.  **Normalización:** `normalizarTexto_()` convierte a UPPER, elimina diacríticos y expande abreviaturas médicas (MG → MILIGRAMOS, etc.).
2.  **Tokenización de Trigramas:** `generarTrigramas_()` descompone el texto en conjuntos de 3 caracteres para resiliencia ante errores tipográficos.
3.  **Cross-Reference (BigQuery):** Se ejecuta una intersección de conjuntos (Jaccard) entre los trigramas del usuario y los trigramas pre-calculados en el catálogo maestro.
4.  **Caché:** Los resultados se indexan por MD5 del input para respuestas instantáneas (<100ms) en consultas repetitivas.

```sql
-- Core de Similitud Jaccard en BigQuery
SELECT
  id_codigo,
  descripcion_articulo,
  ROUND(SAFE_DIVIDE(inter, len_cat + @len_in_tri - inter) * 100, 1) AS score
FROM candidatos
WHERE inter > 0 AND score >= 15
```

---

## 🔌 API Pública — Contratos de Interfaz

### `buscarSimilitudesBQ(textoUsuario)`
- **Input:** `string`
- **Output:** `Array<Object>` (id_codigo, descripcion, activo, similitud)
- **Cache:** TTL 6 horas.

### `guardarSolicitud(payload)`
- **Input:** Object (campos técnicos + cotizacionPDF en Base64)
- **Output:** Object (success, url, id)

---

## 🎨 Capa de Presentación — SPA

### Design System
- **Tipografía:** [Inter](https://fonts.google.com/specimen/Inter) (Variable weight 400-700).
- **Colores:** Primary Blue `#2563eb`, Success Green `#10b981`, Error Red `#ef4444`.
- **UX:** Sistema de etiquetas flotantes, validación real-time, y skeletons de carga.
- **A11y:** Soporte para lectores de pantalla, ARIA labels y contraste validado WCAG 2.1.

---

## ⚙ Configuración y Despliegue

### Requisitos de Infraestructura
- **BigQuery:** Dataset con tabla `catalogo_maestro_clean`.
- **Drive:** Carpeta destino "Solicitudes de Inclusión HCG".
- **Sheets:** Plantilla maestra (ID: `1ZVwPuloDIcDfQJFuZs_AeEb8SH5TD0iRbEx3kER_GC8`).

### Propiedades del Script (Required)
| Propiedad | Descripción |
| :--- | :--- |
| `BQ_PROJECT_ID` | ID del proyecto en Google Cloud Console. |
| `BQ_LOCATION` | Región del dataset (Ej: `northamerica-south1`). |

---

## 🔒 Seguridad y Cumplimiento

1.  **Validación de Entrada:** Sanitización de HTML y escape de caracteres especiales para evitar inyecciones.
2.  **Autorización:** Ejecución bajo el contexto del usuario desplegante con acceso restringido al dominio institucional.
3.  **Logs:** Registro de cada solicitud exitosa o fallida para auditoría técnica.

---

<div align="center">

**OPD Hospital Civil de Guadalajara** · Unidad Digital · 2026

</div>
