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
 * 🔍 MOTOR DE AUDITORÍA Y PREVENCIÓN DE DUPLICADOS (VERSIÓN LÉXICA OPTIMIZADA)
 * @param {string} textoUsuario - Descripción enviada por el solicitante en la SPA.
 * @returns {Array<{id_codigo: string, descripcion: string, activo: number, similitud: number}>}
 */
function buscarSimilitudesBQ(textoUsuario) {
  const input = String(textoUsuario || "").trim();
  if (input.length < 3) {
    throw new Error("La verificación requiere una descripción mínima de 3 caracteres.");
  }

  // ─── NORMALIZACIÓN MÉDICA SIMÉTRICA EN MEMORIA (DICCIONARIO JS) ───
  let txt = input.toUpperCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  txt = txt.replace(/C\//g, " CON ").replace(/S\//g, " SIN ");
  
  // Separar números de letras
  txt = txt.replace(/([0-9]+)([A-Z])/g, "$1 $2").replace(/([A-Z]+)([0-9])/g, "$1 $2");

  // Diccionario Clínico Local
  const DICT_MEDICO = {
    "MG": "MILIGRAMOS", "ML": "MILILITROS", "TAB": "TABLETA", 
    "CAP": "CAPSULA", "AMP": "AMPOLLA", "JGA": "JERINGA"
  };
  for (const [abrev, compl] of Object.entries(DICT_MEDICO)) {
    txt = txt.replace(new RegExp("\\b" + abrev + "\\b", "gi"), compl);
  }

  const cleanInput = txt.replace(/[^A-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

  // ─── GENERACIÓN DE TRIGRAMAS DEL LADO DEL SERVIDOR (V8) ───
  const paddedInput = " " + cleanInput + " ";
  const trigrams = new Set();
  for (let i = 0; i < paddedInput.length - 2; i++) {
    const tri = paddedInput.substring(i, i + 3);
    if (tri.trim().length === 3) trigrams.add(tri); // Validamos que sean exactamente 3 caracteres
  }
  const trigramasArray = Array.from(trigrams);

  if (trigramasArray.length === 0) {
    throw new Error("Entrada sin suficiente claridad léxica alfanumérica.");
  }

  const props = PropertiesService.getScriptProperties();
  const bqLocation = props.getProperty("BQ_LOCATION") || "US";
  const cacheKeyRaw = `hcg_idx_v6_${cleanInput}`;
  const cacheKey = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, cacheKeyRaw)
    .map(b => ("0" + (b < 0 ? b + 256 : b).toString(16)).slice(-2)).join("").substring(0, 24);

  const cache = CacheService.getScriptCache();
  const cached = cache.get(cacheKey);
  if (cached) return JSON.parse(cached);

  // ─── CONSULTA SQL (INYECCIÓN PARAMETRIZADA A LA TABLA CORRECTA) ───
  const sqlQuery = `
    WITH candidatos_indexados AS (
      SELECT 
        id_codigo,
        descripcion_articulo,
        activo,
        ARRAY_LENGTH(trigramas) AS len_cat,
        (SELECT COUNT(DISTINCT elemento) FROM UNNEST(trigramas) elemento WHERE elemento IN UNNEST(@user_trigrams)) AS inter
      -- Apuntamos a la ruta exacta de la tabla que creaste
      FROM \`certain-perigee-495302-h7.catalogo.catalogo_maestro_clean\`
      WHERE SEARCH(norm_desc, @search_text) 
    )
    SELECT 
      id_codigo,
      descripcion_articulo,
      activo,
      ROUND(SAFE_DIVIDE(inter, len_cat + @len_in_tri - inter) * 100, 1) AS score
    FROM candidatos_indexados
    WHERE inter > 0 
      AND SAFE_DIVIDE(inter, len_cat + @len_in_tri - inter) >= 0.20 -- Umbral del 20%
    ORDER BY score DESC
    LIMIT 10;
  `;

  // El Project ID se lo pasamos directo para la facturación de la consulta
  const billingProjectId = props.getProperty("BQ_PROJECT_ID") || "certain-perigee-495302-h7";

  const request = {
    query: sqlQuery,
    useLegacySql: false,
    parameterMode: "NAMED",
    location: bqLocation,
    queryParameters: [
      {
        name: "search_text",
        parameterType: { type: "STRING" },
        parameterValue: { value: cleanInput }
      },
      {
        name: "user_trigrams",
        parameterType: { type: "ARRAY", arrayType: { type: "STRING" } },
        parameterValue: { arrayValues: trigramasArray.map(t => ({ value: t })) }
      },
      {
        name: "len_in_tri",
        parameterType: { type: "INT64" },
        parameterValue: { value: String(trigramasArray.length) }
      }
    ]
  };

  try {
    const res = BigQuery.Jobs.query(request, billingProjectId);
    const results = res.rows ? res.rows.map(({ f }) => ({
      id_codigo: f[0].v,
      descripcion: f[1].v,
      activo: Number(f[2].v) || 0,
      similitud: Number(f[3].v) || 0
    })) : [];

    cache.put(cacheKey, JSON.stringify(results), 21600);
    return results;
  } catch (e) {
    console.error({ message: "Fallo en motor de auditoría léxica HCG", error: e.message });
    throw new Error(`Error analítico de catálogo: ${e.message}`);
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
