/**
 * @fileoverview Verificador de Catálogo HCG — Servidor (Google Apps Script V8)
 * Refactorizado para optimización mediante Batch Operations, ES6+,
 * JSDoc estricto, robustez con Cloud Logging y encapsulamiento.
 *
 * @version 2.0.0
 * @author Jules (Lead Developer)
 */

"use strict";

// ─── CONSTANTES DE CONFIGURACIÓN ─────────────────────────────────────────────

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

/** @const {Object<string, string>} Diccionario clínico para normalización */
const DICT_MEDICO = {
  "MG": "MILIGRAMOS",
  "ML": "MILILITROS",
  "TAB": "TABLETA",
  "CAP": "CAPSULA",
  "AMP": "AMPOLLA",
  "JGA": "JERINGA"
};

// ─── FUNCIONES PÚBLICAS (TRIGGER-SAFE) ───────────────────────────────────────

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
 * Motor de auditoría y prevención de duplicados utilizando BigQuery y similitud de Jaccard.
 *
 * @param {string} textoUsuario - Descripción enviada por el solicitante en la SPA.
 * @returns {Array<{id_codigo: string, descripcion: string, activo: number, similitud: number}>}
 *   Lista de coincidencias encontradas.
 * @throws {Error} Si la entrada es inválida o falla la consulta a BigQuery.
 */
function buscarSimilitudesBQ(textoUsuario) {
  try {
    const input = String(textoUsuario || "").trim();
    if (input.length < 3) {
      throw new Error("La verificación requiere una descripción mínima de 3 caracteres.");
    }

    const cleanInput = normalizarTexto_(input);
    const trigramasArray = generarTrigramas_(cleanInput);

    if (trigramasArray.length === 0) {
      throw new Error("Entrada sin suficiente claridad léxica alfanumérica.");
    }

    const cacheKey = generarCacheKey_(cleanInput);
    const cache = CacheService.getScriptCache();
    const cached = cache.get(cacheKey);
    if (cached) return JSON.parse(cached);

    const props = PropertiesService.getScriptProperties();
    const bqLocation = props.getProperty("BQ_LOCATION") || "northamerica-south1";
    const billingProjectId = props.getProperty("BQ_PROJECT_ID") || "certain-perigee-495302-h7";

    const sqlQuery = `
      WITH candidatos_evaluados AS (
        SELECT
          id_codigo,
          descripcion_articulo,
          activo,
          ARRAY_LENGTH(trigramas) AS len_cat,
          (
            SELECT COUNT(DISTINCT elemento)
            FROM UNNEST(trigramas) elemento
            WHERE elemento IN UNNEST(@user_trigrams)
          ) AS inter
        FROM \`certain-perigee-495302-h7.catalogo.catalogo_maestro_clean\`
      )
      SELECT 
        id_codigo,
        descripcion_articulo,
        activo,
        ROUND(SAFE_DIVIDE(inter, len_cat + @len_in_tri - inter) * 100, 1) AS score
      FROM candidatos_evaluados
      WHERE inter > 0
        AND SAFE_DIVIDE(inter, len_cat + @len_in_tri - inter) >= 0.15
      ORDER BY score DESC
      LIMIT 10;
    `;

    const request = {
      query: sqlQuery,
      useLegacySql: false,
      parameterMode: "NAMED",
      location: bqLocation,
      queryParameters: [
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

    const res = BigQuery.Jobs.query(request, billingProjectId);
    const results = res.rows ?
      res.rows.map(({ f }) => ({
        id_codigo: f[0].v,
        descripcion: f[1].v,
        activo: Number(f[2].v) || 0,
        similitud: Number(f[3].v) || 0
      })) : [];

    cache.put(cacheKey, JSON.stringify(results), CACHE_TTL_SEG);
    return results;

  } catch (e) {
    console.error({
      message: "Fallo en motor de auditoría léxica HCG",
      error: e.message,
      stack: e.stack
    });
    throw new Error(`Error analítico de catálogo: ${e.message}`);
  }
}

/**
 * Orquestador de alta de solicitud y generación de documento de inclusión.
 *
 * @param {Object|null} payload - Datos del formulario enviados desde el cliente.
 * @returns {{ success: boolean, url?: string, id?: string, message?: string }}
 *   Resultado de la operación.
 * @throws {Error} Si la validación o generación del documento falla.
 */
function guardarSolicitud(payload) {
  if (!payload) {
    console.info({ message: "Verificando acceso a DriveApp..." });
    DriveApp.getRootFolder();
    return { success: true, message: "Autorización exitosa" };
  }

  const { valido, mensaje } = validarPayloadEntrada_(payload);
  if (!valido) {
    console.warn({ message: "Validación de payload fallida", error: mensaje });
    throw new Error(`Validación: ${mensaje}`);
  }

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

    console.info({
      message: "Solicitud procesada con éxito",
      descripcion,
      idDocumento: resultadoDoc.id
    });

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
 * escribiendo los datos del formulario en batch.
 *
 * @param {Object} datos - Objeto con la información mapeada del formulario.
 * @param {string} [pdfBase64] - Datos del archivo PDF de cotización en Base64.
 * @returns {{ url: string, id: string }} URL e ID del documento generado.
 */
function generarDocumentoInclusion(datos, pdfBase64) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(15000); // Espera hasta 15 segundos si otra instancia escribe
    
    if (!datos || !datos.descripcion) {
      throw new Error("Datos insuficientes: descripción es obligatoria.");
    }

    const plantilla = DriveApp.getFileById(ID_PLANTILLA);
    const fechaStr = formatearTimestamp_();
    const nombreNuevoArchivo = `Solicitud Inclusión - ${datos.descripcion.substring(0, 30)} - ${fechaStr}`;

    const carpetaDestino = getCarpetaSolicitudes_();
    const copia = plantilla.makeCopy(nombreNuevoArchivo, carpetaDestino);

    const ssCopia = SpreadsheetApp.open(copia);
    const hoja = ssCopia.getSheetByName(NOMBRE_HOJA);

    if (!hoja) {
      throw new Error(`No se encontró la hoja "${NOMBRE_HOJA}" en la plantilla.`);
    }

    const urlPdf = adjuntarPDF_(carpetaDestino, pdfBase64, datos.descripcion);
    const valores = construirValoresHoja_(datos, urlPdf);

    // Batch write: Escritura de una sola vez para optimizar rendimiento
    hoja.getRange(FILA_INICIO_DATOS, COL_INICIO_DATOS, 1, valores[0].length).setValues(valores);
    SpreadsheetApp.flush();

    return { url: ssCopia.getUrl(), id: ssCopia.getId() };

  } catch (e) {
    console.error({
      message: "Error al generar documento",
      error: e.message,
      stack: e.stack,
    });
    throw new Error(`Error al generar documento: ${e.message}`);
  } finally {
    lock.releaseLock(); // Libera el bloqueo para la siguiente solicitud
  }
}

// ─── FUNCIONES PRIVADAS (SUFFIX: _) ──────────────────────────────────────────

/**
 * Obtiene o crea la carpeta dedicada para las solicitudes de inclusión en Drive.
 *
 * @returns {GoogleAppsScript.Drive.Folder} Carpeta destino para las solicitudes.
 * @private
 */
const getCarpetaSolicitudes_ = () => {
  const folders = DriveApp.getFoldersByName(NOMBRE_CARPETA);
  if (folders.hasNext()) return folders.next();
  console.info({ message: "Carpeta creada", nombre: NOMBRE_CARPETA });
  return DriveApp.createFolder(NOMBRE_CARPETA);
};

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
  const faltantes = camposObligatorios.filter(c => !payload[c] || String(payload[c]).trim() === "");

  if (faltantes.length) {
    return { valido: false, mensaje: `Campos obligatorios faltantes: ${faltantes.join(", ")}.` };
  }
  return { valido: true };
};

/**
 * Genera un timestamp formateado para nomenclatura de archivos.
 *
 * @param {Date} [fecha=new Date()] - Fecha base.
 * @returns {string} Cadena formateada (yyyyMMdd-HHmm).
 * @private
 */
const formatearTimestamp_ = (fecha = new Date()) =>
  Utilities.formatDate(fecha, Session.getScriptTimeZone(), "yyyyMMdd-HHmm");

/**
 * Normaliza un texto para búsqueda léxica avanzada.
 *
 * @param {string} texto - Texto crudo del usuario.
 * @returns {string} Texto normalizado y expandido según diccionario.
 * @private
 */
const normalizarTexto_ = (texto) => {
  let txt = texto.toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/C\//g, " CON ")
    .replace(/S\//g, " SIN ");

  // Separar números de letras
  txt = txt.replace(/([0-9]+)([A-Z])/g, "$1 $2").replace(/([A-Z]+)([0-9])/g, "$1 $2");

  // Expansión de abreviaturas médicas
  for (const [abrev, compl] of Object.entries(DICT_MEDICO)) {
    txt = txt.replace(new RegExp("\\b" + abrev + "\\b", "gi"), compl);
  }

  return txt.replace(/[^A-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
};

/**
 * Genera un array de trigramas únicos a partir de un texto.
 *
 * @param {string} texto - Texto normalizado.
 * @returns {string[]} Arreglo de trigramas.
 * @private
 */
const generarTrigramas_ = (texto) => {
  const padded = ` ${texto} `;
  const trigrams = new Set();
  for (let i = 0; i < padded.length - 2; i++) {
    const tri = padded.substring(i, i + 3);
    if (tri.trim().length === 3) trigrams.add(tri);
  }
  return Array.from(trigrams);
};

/**
 * Genera una clave MD5 corta para el servicio de caché.
 *
 * @param {string} input - Texto base para la clave.
 * @returns {string} Hash MD5 de 24 caracteres.
 * @private
 */
const generarCacheKey_ = (input) => {
  const rawKey = `hcg_v2_${input}`;
  return Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, rawKey)
    .map(b => ("0" + (b < 0 ? b + 256 : b).toString(16)).slice(-2))
    .join("")
    .substring(0, 24);
};

/**
 * Adjunta un archivo PDF de cotización a la carpeta de solicitudes.
 *
 * @param {GoogleAppsScript.Drive.Folder} carpeta - Carpeta destino.
 * @param {string|undefined} pdfBase64 - Contenido PDF codificado en Base64.
 * @param {string} descripcion - Descripción para el nombre del archivo.
 * @returns {string} URL del archivo PDF en Drive.
 * @private
 */
const adjuntarPDF_ = (carpeta, pdfBase64, descripcion) => {
  if (!pdfBase64 || typeof pdfBase64 !== "string") return "";

  try {
    const nombreArchivo = `Cotizacion_${descripcion.substring(0, 20)}.pdf`;
    const bytes = Utilities.base64Decode(pdfBase64);
    const blob = Utilities.newBlob(bytes, "application/pdf", nombreArchivo);
    const archivo = carpeta.createFile(blob);

    console.info({ message: "PDF adjuntado", nombre: nombreArchivo });
    return archivo.getUrl();
  } catch (e) {
    console.error({ message: "Fallo al adjuntar PDF", error: e.message });
    throw new Error(`Error en adjunto PDF: ${e.message}`);
  }
};

/**
 * Construye el arreglo 2D de valores para escritura batch.
 *
 * @param {Object} datos - Datos del formulario.
 * @param {string} urlPdf - URL del PDF adjunto.
 * @returns {Array<Array<*>>} Arreglo 2D de una fila.
 * @private
 */
const construirValoresHoja_ = (datos, urlPdf) => [[
  datos.partida,           // Col C
  datos.familia,           // Col D
  datos.unidad,            // Col E
  datos.descripcion,       // Col F
  datos.unidadMedida,      // Col G
  datos.nombreSolicitante, // Col H
  datos.cargoSolicitante,  // Col I
  datos.servicio,          // Col J
  datos.costoReferencia,   // Col K
  datos.proveedor,         // Col L
  new Date(),              // Col M
  datos.justificacion,     // Col N
  datos.observacion,       // Col O
  urlPdf                   // Col P
]];
