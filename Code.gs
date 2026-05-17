/**
 * @fileoverview Verificador de Catálogo HCG — Servidor Optimizado V3
 * Integra: lazy-config, caché multinivel, regex precompiladas, sanitización
 * server-side, logging estructurado, límite de trigramas, MD5 completo y
 * corrección del algoritmo de tokenización para alineación con BigQuery.
 *
 * @version 3.0.0
 */

"use strict";

// ─── LAZY-CONFIG: Evalúa PropertiesService solo en la primera llamada ───────

/** @type {Object|null} Caché en memoria de la ejecución actual */
let __configCache = null;

/**
 * Retorna configuración unificada desde PropertiesService con caché en memoria.
 * Impacto: -1 llamada a PropertiesService por ejecución (cuota: 50,000/día).
 * @private
 * @returns {Object}
 */
const getConfig_ = () => {
  if (__configCache) return __configCache;
  const props = PropertiesService.getScriptProperties();
  __configCache = {
    BQ_PROJECT: props.getProperty("BQ_PROJECT_ID") || "certain-perigee-495302-h7",
    BQ_LOCATION: props.getProperty("BQ_LOCATION") || "northamerica-south1",
    BQ_DATASET: props.getProperty("BQ_DATASET") || "catalogo",
    BQ_TABLE: props.getProperty("BQ_TABLE") || "catalogo_maestro_clean",
    TEMPLATE_ID: props.getProperty("TEMPLATE_SHEET_ID") || "1ZVwPuloDIcDfQJFuZs_AeEb8SH5TD0iRbEx3kER_GC8",
    GEMINI_KEY: props.getProperty("GEMINI_API_KEY") || "",
    GEMINI_MODEL: props.getProperty("GEMINI_MODEL") || "gemini-2.5-flash-lite",
    CONAC_ID: props.getProperty("CONAC_JSON_ID") || "",
  };
  return __configCache;
};

// ─── CONSTANTES OPERATIVAS ───────────────────────────────────────────────────

const NOMBRE_HOJA = "Formato";
const NOMBRE_CARPETA = "Solicitudes de Inclusión HCG";
const CACHE_TTL_SEG = 21600; // 6 horas
const FILA_INICIO_DATOS = 14;
const COL_INICIO_DATOS = 3;
const MAX_TRIGRAMAS = 200;        // Protección anti-abuso de cuota BQ
const MAX_INPUT_LENGTH = 500;     // Protección anti-exceso de tokens IA

/** @const {Object<string, string>} Diccionario clínico */
const DICT_MEDICO = {
  MG: "MILIGRAMOS",
  ML: "MILILITROS",
  TAB: "TABLETA",
  CAP: "CAPSULA",
  AMP: "AMPOLLA",
  JGA: "JERINGA",
};

/** @type {Map|null} Caché de regex precompiladas (memoization) */
let __regexCache = null;

/**
 * Retorna Map de regex precompiladas para expansión médica.
 * Impacto: Elimina 6 compilaciones de RegExp por cada llamada a normalizarTexto_.
 * @private
 * @returns {Map<string, RegExp>}
 */
const getRegexCacheMedico_ = () => {
  if (__regexCache) return __regexCache;
  __regexCache = new Map();
  for (const [abrev, compl] of Object.entries(DICT_MEDICO)) {
    __regexCache.set(abrev, new RegExp("\\b" + abrev + "\\b", "gi"));
  }
  return __regexCache;
};

// ─── LOGGING ESTRUCTURADO (Cloud Logging / Stackdriver) ─────────────────────

/**
 * Logger unificado con metadatos JSON. Ingesta automática en GCP.
 * @private
 * @param {number} level 0=info, 1=warn, 2=error
 * @param {string} message
 * @param {Object} [meta={}]
 */
const logEvent = (level, message, meta = {}) => {
  const payload = {
    ts: new Date().toISOString(),
    level: level === 0 ? "INFO" : level === 1 ? "WARN" : "ERROR",
    service: "HCG_CATALOGO",
    message,
    ...meta,
  };
  const fn = level === 0 ? console.info : level === 1 ? console.warn : console.error;
  fn(JSON.stringify(payload));
};

// ─── FUNCIONES PÚBLICAS ────────────────────────────────────────────────────────

/**
 * Punto de entrada HTML Service.
 * @returns {GoogleAppsScript.HTML.HtmlOutput}
 */
function doGet() {
  return HtmlService.createHtmlOutputFromFile("index")
    .setTitle("Prevención de Duplicados | HCG")
    .addMetaTag("viewport", "width=device-width, initial-scale=1")
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * Endpoint de heartbeat para validación de sesión institucional.
 * @returns {{email: string, authorized: boolean}}
 */
function getActiveUserEmail() {
  try {
    const email = Session.getActiveUser().getEmail();
    return { email, authorized: email.endsWith("@hcg.gob.mx") };
  } catch (e) {
    return { email: "", authorized: false };
  }
}

/**
 * Motor de auditoría léxica con Jaccard/BigQuery.
 * CORRECCIÓN CRÍTICA V3: Trigramas alineados por palabra (sin padding de espacios)
 * para coincidir con la tokenización de BigQuery.
 *
 * @param {string} textoUsuario
 * @returns {Array<Object>}
 */
function buscarSimilitudesBQ(textoUsuario) {
  const startTime = Date.now();
  try {
    let input = String(textoUsuario || "").trim();
    if (input.length > MAX_INPUT_LENGTH) input = input.substring(0, MAX_INPUT_LENGTH);
    if (input.length < 3) {
      throw new Error("La verificación requiere una descripción mínima de 3 caracteres.");
    }

    const cleanInput = normalizarTexto_(input);
    let trigramasArray = generarTrigramas_(cleanInput);

    if (trigramasArray.length === 0) {
      throw new Error("Entrada sin suficiente claridad léxica alfanumérica.");
    }

    // Protección contra payloads excesivos (anti-abuso de cuota BQ)
    const originalTriCount = trigramasArray.length;
    if (trigramasArray.length > MAX_TRIGRAMAS) {
      trigramasArray = trigramasArray.slice(0, MAX_TRIGRAMAS);
      logEvent(1, "Trigramas truncados por límite de seguridad", {
        original: originalTriCount, limit: MAX_TRIGRAMAS, input: cleanInput.substring(0, 50)
      });
    }

    // Cache key MD5 completo (32 chars) — elimina colisiones de versión anterior (24 chars)
    const cacheKey = generarCacheKey_(cleanInput);
    const cache = CacheService.getScriptCache();
    const cached = cache.get(cacheKey);
    if (cached) {
      logEvent(0, "Cache hit BQ", { cacheKey, trigramas: trigramasArray.length });
      return JSON.parse(cached);
    }

    const cfg = getConfig_();
    const sqlQuery = `
      WITH base_trigramas AS (
        SELECT 
          id_codigo,
          descripcion_articulo,
          activo,
          (
            SELECT COALESCE(ARRAY_AGG(DISTINCT SUBSTR(wf.w, i, 3)), [])
            FROM (
              SELECT w 
              FROM UNNEST(SPLIT(UPPER(REGEXP_REPLACE(NORMALIZE(descripcion_articulo, NFD), r'\\\\p{M}', '')), ' ')) AS w
              WHERE LENGTH(w) >= 3
            ) AS wf,
                 UNNEST(GENERATE_ARRAY(1, LENGTH(wf.w) - 2)) AS i
          ) AS trigramas
        FROM \`${cfg.BQ_PROJECT}.${cfg.BQ_DATASET}.${cfg.BQ_TABLE}\`
      ),
      candidatos_evaluados AS (
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
        FROM base_trigramas
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
      location: cfg.BQ_LOCATION,
      queryParameters: [
        {
          name: "user_trigrams",
          parameterType: { type: "ARRAY", arrayType: { type: "STRING" } },
          parameterValue: {
            arrayValues: trigramasArray.map((t) => ({ value: t })),
          },
        },
        {
          name: "len_in_tri",
          parameterType: { type: "INT64" },
          parameterValue: { value: String(trigramasArray.length) },
        },
      ],
    };

    const bqStart = Date.now();
    const res = BigQuery.Jobs.query(request, cfg.BQ_PROJECT);
    const bqDuration = Date.now() - bqStart;

    const results = res.rows ? res.rows.map(({ f }) => ({
      id_codigo: f[0].v, descripcion: f[1].v, activo: Number(f[2].v) || 0, similitud: Number(f[3].v) || 0
    })) : [];

    try { cache.put(cacheKey, JSON.stringify(results), CACHE_TTL_SEG); }
    catch (err) { logEvent(1, "Error al escribir en caché", { error: err.message, cacheKey }); }

    logEvent(0, "BQ query completada", {
      durationMs: bqDuration, trigramasEnviados: trigramasArray.length,
      resultados: results.length, input: cleanInput.substring(0, 50)
    });
    return results;

  } catch (e) {
    logEvent(2, "Fallo motor de auditoría", { error: e.message, stack: e.stack, durationMs: Date.now() - startTime });
    throw new Error(`Error analítico de catálogo: ${e.message}`);
  }
}

/**
 * Orquestador de alta de solicitud.
 * @param {Object|null} payload
 * @returns {{ success: boolean, url?: string, id?: string, message?: string }}
 */
function guardarSolicitud(payload) {
  if (!payload) {
    logEvent(0, "Heartbeat de autorización", { user: Session.getActiveUser().getEmail() });
    DriveApp.getRootFolder();
    return { success: true, message: "Autorización exitosa" };
  }

  const { valido, mensaje } = validarPayloadEntrada_(payload);
  if (!valido) {
    logEvent(1, "Validación de payload fallida", { error: mensaje });
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

    logEvent(0, "Solicitud procesada con éxito", {
      descripcion,
      idDocumento: resultadoDoc.id,
    });

    return { success: true, url: resultadoDoc.url, id: resultadoDoc.id };
  } catch (e) {
    logEvent(2, "Error en guardarSolicitud", {
      error: e.message,
      stack: e.stack,
    });
    throw new Error(`No se pudo procesar la solicitud: ${e.message}`);
  }
}

/**
 * Genera documento de inclusión. PDF se adjunta ANTES del lock para no bloquear
 * concurrencia durante la subida a Drive (~2-4s).
 * @param {Object} datos
 * @param {string} [pdfBase64]
 * @returns {{ url: string, id: string }}
 */
function generarDocumentoInclusion(datos, pdfBase64) {
  if (!datos || !datos.descripcion) {
    throw new Error("Datos insuficientes: descripción es obligatoria.");
  }

  const cfg = getConfig_();
  const carpetaDestino = getCarpetaSolicitudes_();

  // PDF fuera del lock: operación independiente de Drive, no necesita exclusión mutua
  let urlPdf = "";
  try {
    urlPdf = adjuntarPDF_(carpetaDestino, pdfBase64, datos.descripcion);
  } catch (e) {
    logEvent(1, "PDF adjunto falló, continuando sin adjunto", { error: e.message });
    // Graceful degradation: la solicitud continúa sin PDF
  }

  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(15000); // Solo la zona crítica: clone + batch write

    const plantilla = DriveApp.getFileById(cfg.TEMPLATE_ID);
    const fechaStr = formatearTimestamp_();
    const nombreNuevoArchivo = `Solicitud Inclusión - ${datos.descripcion.substring(0, 30)} - ${fechaStr}`;

    const copia = plantilla.makeCopy(nombreNuevoArchivo, carpetaDestino);
    const ssCopia = SpreadsheetApp.open(copia);
    const hoja = ssCopia.getSheetByName(NOMBRE_HOJA);
    if (!hoja) throw new Error(`Hoja "${NOMBRE_HOJA}" no encontrada.`);

    const valores = construirValoresHoja_(datos, urlPdf);
    hoja.getRange(FILA_INICIO_DATOS, COL_INICIO_DATOS, 1, valores[0].length).setValues(valores);
    SpreadsheetApp.flush();

    return { url: ssCopia.getUrl(), id: ssCopia.getId() };

  } catch (e) {
    logEvent(2, "Error generando documento", { error: e.message, stack: e.stack });
    throw new Error(`Error al generar documento: ${e.message}`);
  } finally {
    lock.releaseLock();
  }
}

/**
 * Endpoint analítico automático. Clasifica el término de búsqueda usando Gemini.
 * @param {string} descripcionCruda - El término de búsqueda original del usuario.
 * @returns {Object} Objeto estructurado con las clasificaciones predeterminadas.
 */
function sugerirCamposConIA(descripcionCruda) {
  const startTime = Date.now();
  try {
    let input = String(descripcionCruda || "").trim();
    if (input.length > MAX_INPUT_LENGTH) input = input.substring(0, MAX_INPUT_LENGTH);
    if (input.length < 3) throw new Error("Input muy corto para clasificación.");

    const cfg = getConfig_();
    if (!cfg.GEMINI_KEY) throw new Error("GEMINI_API_KEY no configurada.");

    // Cache IA: evita llamadas duplicadas para el mismo término (TTL 1h vs 6h de BQ)
    const cache = CacheService.getScriptCache();
    const iaCacheKey = `ia_${Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, input)
      .map((b) => ("0" + (b < 0 ? b + 256 : b).toString(16)).slice(-2))
      .join("")}`;
    const iaCached = cache.get(iaCacheKey);
    if (iaCached) {
      logEvent(0, "Cache hit IA", { input: input.substring(0, 50) });
      return JSON.parse(iaCached);
    }

    const conacContexto = obtenerClasificadorContexto_();
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${cfg.GEMINI_MODEL}:generateContent?key=${cfg.GEMINI_KEY}`;

    const systemInstruction = `Eres el sistema automatizado de catalogación oficial. Tu función es clasificar el insumo ingresado por el usuario utilizando exclusivamente el catálogo CONAC suministrado.

CATÁLOGO CONAC DE REFERENCIA:
${conacContexto}

REGLAS DE PROCESAMIENTO Y GENERACIÓN:
1. descripcionSugerida: Re-escribe y normaliza la descripción del insumo en MAYÚSCULAS. La redacción debe ser técnica, genérica y alineada estrictamente con normas y estándares internacionales de catalogación de bienes (anteponiendo el nombre base, características esenciales, dimensiones o empaque, omitiendo marcas comerciales o términos informales).
2. partidaCOG: Determina el código de 4 dígitos exacto comparando el insumo con las descripciones e inclusiones del catálogo CONAC de arriba.
3. unidadMedida: Mapea a una de las siguientes opciones del sistema: "PIEZA", "CAJA C/100", "CAJA C/50", "FRASCO", "AMPULA", "ENVASE", "EQUIPO". Si el estándar internacional del insumo exige otra, escribe su abreviatura corta en mayúsculas.
4. familia: Deduce la macrocategoría correspondiente a la partida (Ej: "MATERIAL DE CURACIÓN", "MEDICAMENTOS", "EQUIPO MÉDICO", "PAPELERÍA").

Responde única y obligatoriamente con la estructura JSON definida en el responseSchema.`;

    const payload = {
      contents: [{ parts: [{ text: `Clasifica de forma automática el término: "${input}"` }] }],
      systemInstruction: { parts: [{ text: systemInstruction }] },
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: {
          type: "OBJECT",
          properties: {
            descripcionSugerida: { type: "STRING" },
            partidaCOG: { type: "STRING" },
            unidadMedida: { type: "STRING" },
            familia: { type: "STRING" }
          },
          required: ["descripcionSugerida", "partidaCOG", "unidadMedida", "familia"]
        }
      }
    };

    const response = UrlFetchApp.fetch(endpoint, {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });

    if (response.getResponseCode() !== 200) throw new Error(response.getContentText());

    const resJson = JSON.parse(response.getContentText());
    const aiResult = JSON.parse(resJson.candidates[0].content.parts[0].text);

    // Validación estructural de respuesta
    const requiredKeys = ["descripcionSugerida", "partidaCOG", "unidadMedida", "familia"];
    const missing = requiredKeys.filter(k => !aiResult[k]);
    if (missing.length) throw new Error(`Respuesta IA incompleta. Faltan: ${missing.join(", ")}`);

    cache.put(iaCacheKey, JSON.stringify(aiResult), 3600); // 1 hora

    logEvent(0, "IA invocación exitosa", { durationMs: Date.now() - startTime, input: input.substring(0, 50) });
    return aiResult;

  } catch (e) {
    logEvent(2, "Error IA", { error: e.message, durationMs: Date.now() - startTime });
    throw new Error(`Asistente IA: ${e.message}`);
  }
}

// ─── FUNCIONES PRIVADAS (SUFFIX: _) ──────────────────────────────────────────

/**
 * Recupera el catálogo de partidas.
 * @private
 * @returns {string} Estructura comprimida de partidas en formato JSON string.
 */
const obtenerClasificadorContexto_ = () => {
  const cache = CacheService.getScriptCache();
  const cacheKey = "hcg_conac_comprimido_cache";
  const cached = cache.get(cacheKey);

  if (cached) return cached;

  try {
    const cfg = getConfig_();
    if (!cfg.CONAC_ID) {
      throw new Error("La propiedad de entorno 'CONAC_JSON_ID' no se encuentra configurada.");
    }

    const file = DriveApp.getFileById(cfg.CONAC_ID);
    const jsonString = file.getBlob().getDataAsString();
    const partidasRaw = JSON.parse(jsonString);

    const catalogoOptimizado = partidasRaw.map(p => ({
      partida: String(p.id || ""),
      nombre: String(p.nombre || ""),
      descripcion: String(p.descripcion || "").substring(0, 220),
      inclusiones: Array.isArray(p.inclusiones_ejemplos) ? p.inclusiones_ejemplos.slice(0, 8) : []
    }));

    const resultadoTexto = JSON.stringify(catalogoOptimizado);
    try {
      cache.put(cacheKey, resultadoTexto, CACHE_TTL_SEG);
    } catch (cacheError) {
      logEvent(1, "No se pudo cachear el catálogo (excede límite de Apps Script)", { error: cacheError.message });
    }
    return resultadoTexto;

  } catch (e) {
    logEvent(2, "Fallo crítico al resolver fuente de datos CONAC", { error: e.message });
    throw new Error(`Infraestructura de Datos: ${e.message}`);
  }
};

/**
 * Obtiene o crea la carpeta dedicada para las solicitudes de inclusión en Drive.
 * @private
 */
const getCarpetaSolicitudes_ = () => {
  const folders = DriveApp.getFoldersByName(NOMBRE_CARPETA);
  if (folders.hasNext()) return folders.next();
  logEvent(0, "Carpeta creada", { nombre: NOMBRE_CARPETA });
  return DriveApp.createFolder(NOMBRE_CARPETA);
};

/**
 * Valida que el payload contenga los campos críticos.
 * @private
 */
const validarPayloadEntrada_ = (payload) => {
  if (!payload || typeof payload !== "object") {
    return { valido: false, mensaje: "Payload nulo o malformado." };
  }
  const camposObligatorios = ["descripcion", "unidadMedida", "partidaCOG"];
  const faltantes = camposObligatorios.filter(
    (c) => !payload[c] || String(payload[c]).trim() === "",
  );

  if (faltantes.length) {
    return {
      valido: false,
      mensaje: `Campos obligatorios faltantes: ${faltantes.join(", ")}.`,
    };
  }
  return { valido: true };
};

/**
 * Genera un timestamp formateado.
 * @private
 */
const formatearTimestamp_ = (fecha = new Date()) =>
  Utilities.formatDate(fecha, Session.getScriptTimeZone(), "yyyyMMdd-HHmm");

/**
 * Normaliza texto para búsqueda léxica.
 * V3: Usa regex precompiladas del cache para expansión médica.
 * @private
 */
const normalizarTexto_ = (texto) => {
  let txt = texto
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/C\//g, " CON ")
    .replace(/S\//g, " SIN ");

  txt = txt
    .replace(/([0-9]+)([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([0-9])/g, "$1 $2");

  // Expansión médica con regex cacheadas (evita 6 new RegExp() por llamada)
  const regexCache = getRegexCacheMedico_();
  for (const [abrev, regex] of regexCache) {
    txt = txt.replace(regex, DICT_MEDICO[abrev]);
  }

  return txt
    .replace(/[^A-Z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
};

/**
 * Genera un array de trigramas únicos a partir de un texto.
 * V3 FIX: Tokens alineados por palabra (sin padding de espacios) para coincidir
 * exactamente con la tokenización intra-palabra de BigQuery.
 *
 * @param {string} texto - Texto ya normalizado (mayúsculas, sin acentos).
 * @returns {string[]} Arreglo de trigramas únicos.
 * @private
 */
const generarTrigramas_ = (texto) => {
  const words = texto.split(/\s+/).filter(w => w.length >= 3);
  const trigrams = new Set();
  for (const w of words) {
    for (let i = 0; i <= w.length - 3; i++) {
      trigrams.add(w.substring(i, i + 3));
    }
  }
  return Array.from(trigrams);
};

/**
 * Genera clave de caché con MD5 completo (32 chars hex).
 * V3: Elimina truncamiento a 24 chars para evitar colisiones estadísticas.
 * @private
 * @param {string} input
 * @returns {string}
 */
const generarCacheKey_ = (input) => {
  const rawKey = `hcg_v3_${input}`;
  return Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, rawKey)
    .map((b) => ("0" + (b < 0 ? b + 256 : b).toString(16)).slice(-2))
    .join(""); // 32 caracteres completos
};

/**
 * Adjunta un archivo PDF a Drive.
 * @private
 */
const adjuntarPDF_ = (carpeta, pdfBase64, descripcion) => {
  if (!pdfBase64 || typeof pdfBase64 !== "string") return "";

  try {
    const cleanDesc = descripcion.replace(/[^A-Za-z0-9]/g, "_");
    const nombreArchivo = `Cotizacion_${cleanDesc.substring(0, 20)}.pdf`;
    const bytes = Utilities.base64Decode(pdfBase64);
    const blob = Utilities.newBlob(bytes, "application/pdf", nombreArchivo);
    const archivo = carpeta.createFile(blob);

    logEvent(0, "PDF adjuntado", { nombre: nombreArchivo });
    return archivo.getUrl();
  } catch (e) {
    logEvent(2, "Fallo al adjuntar PDF", { error: e.message });
    throw new Error(`Error en adjunto PDF: ${e.message}`);
  }
};

/**
 * Construye el arreglo 2D de valores para escritura batch.
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
    new Date(), // Col M
    datos.justificacion, // Col N
    datos.observacion, // Col O
    urlPdf, // Col P
  ],
];
