"use strict";

/* ===========================================================================
 * Verificador de Catálogo HCG — Servidor (Google Apps Script V8)
 * ---------------------------------------------------------------------------
 * Refactorización: Batch Ops · ES6+ · JSDoc estricto · try-catch + Stackdriver
 *                         Helpers privados con sufijo _
 * =========================================================================== */

// ─── Constantes de configuración ─────────────────────────────────────────────

/** @const {string} ID de la hoja de cálculo plantilla (HCG Formato Inclusión 2026) */
const ID_PLANTILLA = "1ZVwPuloDIcDfQJFuZs_AeEb8SH5TD0iRbEx3kER_GC8";

/** @const {string} Nombre de la hoja dentro de la plantilla */
const NOMBRE_HOJA = "Formato";

/** @const {string} Nombre de la carpeta destino en Drive */
const NOMBRE_CARPETA = "Solicitudes de Inclusión HCG";

/** @const {number} TTL de caché en segundos (6 horas) */
const CACHE_TTL_SEG = 21600;

/** @const {number} Tiempo máximo de polling a BigQuery (ms) */
const MAX_POLL_MS = 55000;

/** @const {number} Intervalo de polling a BigQuery (ms) */
const POLL_INTERVAL_MS = 800;

/** @const {number} Longitud mínima de input para búsqueda */
const MIN_INPUT_LEN = 3;

/** @const {number} Longitud mínima de palabra para tokenizar */
const MIN_WORD_LEN = 3;

/** @const {number} Máximo de palabras del input para generar regex */
const MAX_INPUT_WORDS = 15;

/** @const {number} Fila inicio para escritura batch en la plantilla */
const FILA_INICIO_DATOS = 14;

/** @const {number} Columna inicio (C = 3) para escritura batch */
const COL_INICIO_DATOS = 3;

// ─── Funciones Públicas (Trigger-safe) ───────────────────────────────────────

/**
 * Punto de entrada HTML Service — renderiza la SPA al cliente.
 *
 * @returns {GoogleAppsScript.HTML.HtmlOutput} Página web servida al navegador.
 */
function doGet() {
  return HtmlService.createHtmlOutputFromFile("index")
    .setTitle("Prevención de Duplicados | HCG")
    .addMetaTag("viewport", "width=device-width, initial-scale=1")
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

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
function buscarSimilitudesBQ(textoUsuario) {
  const input = String(textoUsuario || "").trim();
  if (input.length < MIN_INPUT_LEN) {
    throw new Error("Ingresa una descripción de al menos 3 caracteres.");
  }

  const { projectId, datasetId, tableId, location } = obtenerPropiedadesBQ_();

  const cleanInput = normalizarTexto_(input);
  const inputWords = cleanInput
    .split(" ")
    .filter((word) => word.length >= MIN_WORD_LEN)
    .slice(0, MAX_INPUT_WORDS);

  if (inputWords.length === 0) {
    throw new Error("Ingresa palabras más descriptivas (mínimo 3 letras).");
  }

  const regexFilter = inputWords.map((word) => escapeRegex_(word)).join("|");

  const cache = CacheService.getScriptCache();
  const cacheKey = generarCacheKey_(
    projectId,
    datasetId,
    tableId,
    location,
    cleanInput,
  );

  const cached = cache.get(cacheKey);
  if (cached) {
    console.info({ message: "Cache HIT", cacheKey });
    return JSON.parse(cached);
  }

  const sql = construirSqlJaccard_(projectId, datasetId, tableId);
  const request = {
    query: sql,
    useLegacySql: false,
    parameterMode: "NAMED",
    location,
    queryParameters: [
      {
        name: "q",
        parameterType: { type: "STRING" },
        parameterValue: { value: input },
      },
      {
        name: "regex",
        parameterType: { type: "STRING" },
        parameterValue: { value: regexFilter },
      },
    ],
  };

  try {
    console.info({
      message: "BigQuery query initiated",
      input,
      wordCount: inputWords.length,
    });
    const res = ejecutarQueryBQConPolling_(projectId, location, request);
    const results = mapearResultadosBQ_(res.rows);

    cache.put(cacheKey, JSON.stringify(results), CACHE_TTL_SEG);
    console.info({
      message: "BigQuery query completed",
      resultCount: results.length,
    });
    return results;
  } catch (e) {
    console.error({
      message: "BigQuery query failed",
      error: e.message,
      stack: e.stack,
    });
    throw new Error(`BigQuery: ${e.message}`);
  }
}

/**
 * Orquestador de alta de solicitud y generación de documento de inclusión.
 *
 * Flujo: mapeo de payload → generación de documento Sheets → retorno de URL/ID.
 * Si `payload` es `null` o `undefined`, ejecuta la verificación de autorización Drive.
 *
 * @param {Object|null} payload - Datos del formulario enviados desde el cliente.
 * @param {string} payload.partidaCOG       - Partida presupuestal COG.
 * @param {string} [payload.familia]         - Familia del artículo.
 * @param {string} [payload.unidadHospitalaria] - Unidad hospitalaria solicitante.
 * @param {string} payload.descripcion       - Descripción del bien o servicio.
 * @param {string} payload.unidadMedida      - Unidad de medida.
 * @param {string} [payload.nombreSolicitante] - Nombre del solicitante.
 * @param {string} [payload.cargoSolicitante]  - Cargo del solicitante.
 * @param {string} [payload.servicio]        - Servicio hospitalario.
 * @param {string} [payload.precio]          - Costo de referencia.
 * @param {string} [payload.proveedor]       - Proveedor sugerido.
 * @param {string} [payload.justificacion]   - Justificación de la solicitud.
 * @param {string} [payload.observacion]     - Observaciones adicionales.
 * @param {string} [payload.cotizacionPDF]   - PDF de cotización en Base64.
 * @returns {{ success: boolean, url?: string, id?: string, message?: string }}
 *   Resultado de la operación.
 * @throws {Error} Si la validación o generación del documento falla.
 */
function guardarSolicitud(payload) {
  if (!payload) {
    console.info({ message: "Verificando acceso a DriveApp..." });
    DriveApp.getRootFolder();
    console.info({ message: "Acceso a Drive confirmado." });
    return { success: true, message: "Autorización exitosa" };
  }

  const { valido, mensaje } = validarPayloadEntrada_(payload);
  if (!valido) {
    console.warn({ message: "Validación de payload fallida", error: mensaje });
    throw new Error(`Validación: ${mensaje}`);
  }

  console.info({
    message: "Nueva solicitud recibida",
    descripcion: payload.descripcion,
    partida: payload.partidaCOG,
  });

  try {
    const {
      partidaCOG: partida,
      familia = "",
      unidadHospitalaria: unidad = "",
      descripcion,
      unidadMedida,
      nombreSolicitante = "",
      cargoSolicitante = "",
      servicio = "",
      precio: costoReferencia = "",
      proveedor = "",
      justificacion = "",
      observacion = "",
      cotizacionPDF,
    } = payload;

    const datosDoc = {
      partida,
      familia,
      unidad,
      descripcion,
      unidadMedida,
      nombreSolicitante,
      cargoSolicitante,
      servicio,
      costoReferencia,
      proveedor,
      justificacion,
      observacion,
    };

    const resultadoDoc = generarDocumentoInclusion(datosDoc, cotizacionPDF);

    console.info({ message: "Documento generado", id: resultadoDoc.id });
    return { success: true, url: resultadoDoc.url, id: resultadoDoc.id };
  } catch (e) {
    console.error({
      message: "Error en guardarSolicitud",
      error: e.message,
      stack: e.stack,
    });
    throw new Error(`No se pudo procesar la solicitud: ${e.message}`);
  }
}

/**
 * Genera el documento de inclusión clonando la plantilla maestra y
 * escribiendo los datos del formulario en batch (14 columnas × 1 fila).
 *
 * @param {Object} datos         - Objeto con la información mapeada del formulario.
 * @param {string} datos.partida           - Partida presupuestal.
 * @param {string} datos.familia           - Familia del artículo.
 * @param {string} datos.unidad            - Unidad hospitalaria.
 * @param {string} datos.descripcion       - Descripción del bien/servicio.
 * @param {string} datos.unidadMedida      - Unidad de medida.
 * @param {string} datos.nombreSolicitante - Nombre del solicitante.
 * @param {string} datos.cargoSolicitante  - Cargo del solicitante.
 * @param {string} datos.servicio          - Servicio hospitalario.
 * @param {string} datos.costoReferencia   - Costo de referencia.
 * @param {string} datos.proveedor         - Proveedor sugerido.
 * @param {string} datos.justificacion     - Justificación.
 * @param {string} datos.observacion       - Observaciones.
 * @param {string} [pdfBase64]  - Datos del archivo PDF de cotización en Base64.
 * @returns {{ url: string, id: string }} URL e ID del documento generado.
 * @throws {Error} Si falla la clonación, la hoja no existe o la escritura batch falla.
 */
function generarDocumentoInclusion(datos, pdfBase64) {
  try {
    if (!datos || !datos.descripcion) {
      throw new Error("Datos insuficientes: descripción es obligatoria.");
    }

    const plantilla = DriveApp.getFileById(ID_PLANTILLA);
    const fechaStr = formatearTimestamp_();
    const nombreNuevoArchivo = `Solicitud Inclusión - ${datos.descripcion.substring(0, 30)} - ${fechaStr}`;

    const carpetaDestino = getCarpetaSolicitudes();
    const copia = plantilla.makeCopy(nombreNuevoArchivo, carpetaDestino);

    const ssCopia = SpreadsheetApp.open(copia);
    const hoja = ssCopia.getSheetByName(NOMBRE_HOJA);

    if (!hoja) {
      throw new Error(`No se encontró la hoja "${NOMBRE_HOJA}" en la plantilla.`);
    }

    const urlPdf = adjuntarPDF_(carpetaDestino, pdfBase64, datos.descripcion);
    const valores = construirValoresHoja_(datos, urlPdf);

    // Batch write: O(1) llamada API para 14 columnas
    hoja.getRange(FILA_INICIO_DATOS, COL_INICIO_DATOS, 1, valores[0].length).setValues(valores);
    SpreadsheetApp.flush();

    console.info({
      message: "Documento de inclusión generado",
      nombre: nombreNuevoArchivo,
      filas: valores.length,
      columnas: valores[0].length,
    });

    return { url: ssCopia.getUrl(), id: ssCopia.getId() };
  } catch (e) {
    console.error({
      message: "Error al generar documento",
      error: e.message,
      stack: e.stack,
    });
    throw new Error(`Error al generar documento: ${e.message}`);
  }
}

/**
 * Obtiene o crea la carpeta dedicada para las solicitudes de inclusión en Drive.
 *
 * Si la carpeta no existe, la crea en la raíz de Drive del usuario deployante.
 *
 * @returns {GoogleAppsScript.Drive.Folder} Carpeta destino para las solicitudes.
 */
function getCarpetaSolicitudes() {
  const folders = DriveApp.getFoldersByName(NOMBRE_CARPETA);
  if (folders.hasNext()) return folders.next();
  console.info({ message: "Carpeta creada", nombre: NOMBRE_CARPETA });
  return DriveApp.createFolder(NOMBRE_CARPETA);
}

// ─── Funciones Privadas (suffix: _) ──────────────────────────────────────────

/**
 * Valida que el payload de solicitud contenga los campos críticos.
 *
 * @param {Object} payload - Payload crudo del cliente.
 * @returns {{ valido: boolean, mensaje?: string }}
 * @private
 */
const validarPayloadEntrada_ = (payload) => {
  if (!payload || typeof payload !== "object") {
    return { valido: false, mensaje: "Payload nulo o malformado." };
  }
  const camposObligatorios = ["descripcion", "unidadMedida", "partidaCOG"];
  const faltantes = camposObligatorios.filter((c) => !payload[c] || String(payload[c]).trim() === "");
  if (faltantes.length) {
    return { valido: false, mensaje: `Campos obligatorios faltantes: ${faltantes.join(", ")}.` };
  }
  return { valido: true };
};

/**
 * Genera un timestamp formateado para nomenclatura de archivos institucionales.
 *
 * @param {Date} [fecha=new Date()] - Fecha base.
 * @param {string} [formato="yyyyMMdd-HHmm"] - Patrón de fecha.
 * @returns {string} Cadena formateada.
 * @private
 */
const formatearTimestamp_ = (fecha = new Date(), formato = "yyyyMMdd-HHmm") =>
  Utilities.formatDate(fecha, Session.getScriptTimeZone(), formato);

/**
 * Normaliza un texto para búsqueda: NFD → elimina diacríticos → mayúsculas →
 * remueve caracteres no alfanuméricos → colapsa espacios.
 *
 * @param {string} texto - Texto crudo del usuario.
 * @returns {string} Texto normalizado listo para tokenización y comparación.
 * @private
 */
const normalizarTexto_ = (texto) =>
  texto
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Escapa caracteres especiales para su uso dentro de una expresión regular.
 *
 * @param {string} str - Cadena a escapar.
 * @returns {string} Cadena escapada segura para `RegExp`.
 * @private
 */
const escapeRegex_ = (str) =>
  String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Genera una clave de caché MD5 a partir de los componentes de la consulta.
 *
 * Formato: `bq_v10_` + primeros 24 caracteres hex del digest MD5.
 *
 * @param {string} projectId - ID del proyecto GCP.
 * @param {string} datasetId - ID del dataset BigQuery.
 * @param {string} tableId   - ID de la tabla BigQuery.
 * @param {string} location  - Ubicación/región de BigQuery.
 * @param {string} cleanInput - Texto normalizado del usuario.
 * @returns {string} Clave de caché de máximo 32 caracteres.
 * @private
 */
const generarCacheKey_ = (
  projectId,
  datasetId,
  tableId,
  location,
  cleanInput,
) => {
  const rawKey = `${projectId}|${datasetId}|${tableId}|${location}|${cleanInput}`;
  const digestBytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.MD5,
    rawKey,
  );
  const hex = digestBytes
    .map((b) => ("0" + (b < 0 ? b + 256 : b).toString(16)).slice(-2))
    .join("");
  return `bq_v10_${hex.substring(0, 24)}`;
};

/**
 * Obtiene y valida las propiedades de script necesarias para BigQuery.
 *
 * @returns {{ projectId: string, datasetId: string, tableId: string, location: string }}
 *   Objeto con las propiedades de configuración de BigQuery.
 * @throws {Error} Si alguna propiedad requerida no está definida.
 * @private
 */
const obtenerPropiedadesBQ_ = () => {
  const props = PropertiesService.getScriptProperties();
  const projectId = props.getProperty("BQ_PROJECT_ID");
  const datasetId = props.getProperty("BQ_DATASET");
  const tableId = props.getProperty("BQ_TABLE");
  const location = props.getProperty("BQ_LOCATION") || "US";

  if (!projectId || !datasetId || !tableId) {
    const missing = [
      !projectId && "BQ_PROJECT_ID",
      !datasetId && "BQ_DATASET",
      !tableId && "BQ_TABLE",
    ]
      .filter(Boolean)
      .join(", ");
    throw new Error(`Faltan propiedades de script: ${missing}.`);
  }

  return { projectId, datasetId, tableId, location };
};

/**
 * Construye la consulta SQL parametrizada de Jaccard sobre trigramas.
 *
 * La query implementa el pipeline completo: normalización → tokenización →
 * pre-filtrado REGEXP → cross-join → scoring Jaccard → filtrado ≥ 15 %.
 *
 * @param {string} projectId - ID del proyecto GCP.
 * @param {string} datasetId - ID del dataset BigQuery.
 * @param {string} tableId   - ID de la tabla BigQuery.
 * @returns {string} Sentencia SQL estándar (no legacy) para BigQuery.
 * @private
 */
const construirSqlJaccard_ = (projectId, datasetId, tableId) => `
  DECLARE input_text STRING DEFAULT @q;
  DECLARE regex_param STRING DEFAULT @regex;

  WITH
  input_norm AS (
    SELECT UPPER(REGEXP_REPLACE(NORMALIZE(input_text, NFD), r'\\p{M}', '')) AS clean
  ),
  input_words_cte AS (
    SELECT DISTINCT w
    FROM input_norm, UNNEST(SPLIT(clean, ' ')) AS w
    WHERE LENGTH(w) >= 3
  ),
  input_tokens AS (
    SELECT COALESCE(ARRAY_AGG(DISTINCT SUBSTR(w, i, 3)), []) AS arr
    FROM input_words_cte, UNNEST(GENERATE_ARRAY(1, LENGTH(w) - 2)) AS i
  ),
  candidates AS (
    SELECT
      id_codigo,
      descripcion_articulo,
      activo,
      UPPER(REGEXP_REPLACE(NORMALIZE(descripcion_articulo, NFD), r'\\p{M}', '')) AS c_txt
    FROM \`${projectId}.${datasetId}.${tableId}\`
    WHERE REGEXP_CONTAINS(
      UPPER(REGEXP_REPLACE(NORMALIZE(descripcion_articulo, NFD), r'\\p{M}', '')),
      regex_param
    )
  ),
  tokens_calc AS (
    SELECT
      id_codigo,
      descripcion_articulo,
      activo,
      (
        SELECT COALESCE(ARRAY_AGG(DISTINCT SUBSTR(w, i, 3)), [])
        FROM UNNEST(SPLIT(c_txt, ' ')) AS w,
             UNNEST(GENERATE_ARRAY(1, LENGTH(w) - 2)) AS i
        WHERE LENGTH(w) >= 3
      ) AS cat_tokens,
      (SELECT arr FROM input_tokens) AS in_tokens
    FROM candidates
  ),
  scored AS (
    SELECT
      id_codigo,
      descripcion_articulo,
      activo,
      ARRAY_LENGTH(cat_tokens) AS len_cat,
      ARRAY_LENGTH(in_tokens) AS len_in,
      (
        SELECT COUNT(1)
        FROM UNNEST(cat_tokens) t1
        INNER JOIN UNNEST(in_tokens) t2
        ON t1 = t2
      ) AS inter
    FROM tokens_calc
  )
  SELECT
    id_codigo,
    descripcion_articulo,
    activo,
    ROUND(SAFE_DIVIDE(inter, len_cat + len_in - inter) * 100, 1) AS score
  FROM scored
  WHERE inter > 0
    AND SAFE_DIVIDE(inter, len_cat + len_in - inter) >= 0.15
  ORDER BY score DESC
  LIMIT 10
`;

/**
 * Ejecuta una consulta BigQuery con polling hasta completarse o superar
 * el timeout de seguridad.
 *
 * @param {string} projectId - ID del proyecto GCP.
 * @param {string} location  - Ubicación/región de BigQuery.
 * @param {Object} request   - Objeto de solicitud BigQuery.Jobs.query.
 * @returns {Object} Respuesta de BigQuery con `rows` y `jobComplete = true`.
 * @throws {Error} Si la consulta excede el tiempo límite.
 * @private
 */
const ejecutarQueryBQConPolling_ = (projectId, location, request) => {
  let res = BigQuery.Jobs.query(request, projectId);
  const { jobId } = res.jobReference;
  const startTime = Date.now();

  while (!res.jobComplete) {
    if (Date.now() - startTime > MAX_POLL_MS) {
      console.error({
        message: "BigQuery polling timeout",
        jobId,
        elapsed: Date.now() - startTime,
      });
      throw new Error(
        "La consulta excedió el tiempo límite. Intenta con un término más específico.",
      );
    }
    Utilities.sleep(POLL_INTERVAL_MS);
    res = BigQuery.Jobs.getQueryResults(projectId, jobId, { location });
  }

  return res;
};

/**
 * Mapea las filas crudas de BigQuery al contrato de retorno del DOM.
 *
 * Cada fila se transforma de `r.f[i].v` a un objeto tipado con
 * `id_codigo`, `descripcion`, `activo` y `similitud`.
 *
 * @param {Array<Object>|undefined} rows - Filas devueltas por BigQuery (`res.rows`).
 * @returns {Array<{id_codigo: string, descripcion: string, activo: number, similitud: number}>}
 *   Arreglo de resultados mapeados. Arreglo vacío si no hay filas.
 * @private
 */
const mapearResultadosBQ_ = (rows) => {
  if (!rows) return [];

  return rows.map(({ f }) => ({
    id_codigo: f[0].v,
    descripcion: f[1].v,
    activo: Number(f[2].v) || 0,
    similitud: Number(f[3].v) || 0,
  }));
};

/**
 * Adjunta un archivo PDF de cotización a la carpeta de solicitudes.
 *
 * @param {GoogleAppsScript.Drive.Folder} carpetaDestino - Carpeta destino.
 * @param {string|undefined} pdfBase64 - Contenido PDF codificado en Base64.
 * @param {string} descripcion - Descripción del artículo para nomenclatura.
 * @returns {string} URL del archivo PDF en Drive, o cadena vacía.
 * @throws {Error} Si el Base64 es inválido o la creación de archivo falla.
 * @private
 */
const adjuntarPDF_ = (carpetaDestino, pdfBase64, descripcion) => {
  if (!pdfBase64 || typeof pdfBase64 !== "string" || pdfBase64.trim() === "") {
    return "";
  }

  const nombreArchivo = `Cotizacion_${descripcion.substring(0, 20)}.pdf`;

  try {
    const bytes = Utilities.base64Decode(pdfBase64);
    const blob = Utilities.newBlob(bytes, "application/pdf", nombreArchivo);
    const archivoPdf = carpetaDestino.createFile(blob);

    console.info({
      message: "PDF adjuntado",
      nombre: nombreArchivo,
      tamanoBytes: bytes.length,
      mimeType: blob.getContentType(),
    });

    return archivoPdf.getUrl();
  } catch (e) {
    console.error({
      message: "Fallo al adjuntar PDF",
      nombre: nombreArchivo,
      error: e.message,
    });
    throw new Error(`Adjunto PDF inválido: ${e.message}`);
  }
};

/**
 * Construye el arreglo 2D de valores para escritura batch en la hoja Sheets.
 *
 * El orden de las 14 columnas corresponde a: C(partida) · D(familia) ·
 * E(unidad) · F(descripcion) · G(unidadMedida) · H(nombreSolicitante) ·
 * I(cargoSolicitante) · J(servicio) · K(costoReferencia) · L(proveedor) ·
 * M(fecha) · N(justificacion) · O(observacion) · P(urlPdf).
 *
 * @param {Object} datos  - Objeto con la información mapeada del formulario.
 * @param {string} urlPdf - URL del PDF de cotización (vacío si no aplica).
 * @returns {Array<Array<*>>} Arreglo 2D con una fila y 14 columnas.
 * @private
 */
const construirValoresHoja_ = (datos, urlPdf) => [
  [
    datos.partida, // Col C
    datos.familia, // Col D
    datos.unidad, // Col E
    datos.descripcion, // Col F
    datos.unidadMedida, // Col G
    datos.nombreSolicitante, // Col H
    datos.cargoSolicitante, // Col I
    datos.servicio, // Col J
    datos.costoReferencia, // Col K
    datos.proveedor, // Col L
    new Date(), // Col M — fecha de registro
    datos.justificacion, // Col N
    datos.observacion, // Col O
    urlPdf, // Col P — link cotización
  ],
];
