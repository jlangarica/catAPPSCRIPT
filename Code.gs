/**
 * 🌐 SERVIDOR: Carga de la Interfaz
 */
function doGet() {
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('Prevención de Duplicados | HCG')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

/**
 * 🔍 MOTOR DE BÚSQUEDA SEMÁNTICA
 * Devuelve un arreglo de coincidencias ordenadas por similitud.
 */
function buscarSimilitudesBQ(textoUsuario) {
  const input = String(textoUsuario || '').trim();
  if (input.length < 3) {
    throw new Error('Ingresa una descripción de al menos 3 caracteres.');
  }

  const props = PropertiesService.getScriptProperties();
  const projectId = props.getProperty('BQ_PROJECT_ID');
  const datasetId = props.getProperty('BQ_DATASET');
  const tableId = props.getProperty('BQ_TABLE');
  const location = props.getProperty('BQ_LOCATION') || 'US';

  if (!projectId || !datasetId || !tableId) {
    throw new Error('Faltan propiedades de script: BQ_PROJECT_ID, BQ_DATASET o BQ_TABLE.');
  }

  const cleanInput = input
    .toUpperCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // [10] Limitar a 15 palabras para evitar regex excesivamente complejos
  const inputWords = cleanInput
    .split(' ')
    .filter(word => word.length >= 3)
    .slice(0, 15);

  if (inputWords.length === 0) {
    throw new Error('Ingresa palabras más descriptivas (mínimo 3 letras).');
  }

  const escapeRegex = str => String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regexFilter = inputWords.map(escapeRegex).join('|');

  const cache = CacheService.getScriptCache();
  const cacheKeyRaw = `${projectId}|${datasetId}|${tableId}|${location}|${cleanInput}`;
  const cacheKey = 'bq_v10_' + Utilities.computeDigest(
    Utilities.DigestAlgorithm.MD5,
    cacheKeyRaw
  ).map(b => ('0' + (b < 0 ? b + 256 : b).toString(16)).slice(-2)).join('').substring(0, 24);

  const cached = cache.get(cacheKey);
  if (cached) return JSON.parse(cached);

  const sql = `
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

  try {
    const request = {
      query: sql,
      useLegacySql: false,
      parameterMode: 'NAMED',
      location: location,
      queryParameters: [
        { name: 'q', parameterType: { type: 'STRING' }, parameterValue: { value: input } },
        { name: 'regex', parameterType: { type: 'STRING' }, parameterValue: { value: regexFilter } }
      ]
    };

    let res = BigQuery.Jobs.query(request, projectId);
    const jobId = res.jobReference.jobId;

    // [9] Polling optimizado con frecuencia reducida y timeout de seguridad
    const MAX_POLL_MS = 55000;
    const startTime = Date.now();

    while (!res.jobComplete) {
      if (Date.now() - startTime > MAX_POLL_MS) {
        throw new Error('La consulta excedió el tiempo límite. Intenta con un término más específico.');
      }
      Utilities.sleep(800);
      res = BigQuery.Jobs.getQueryResults(projectId, jobId, { location: location });
    }

    const results = res.rows
      ? res.rows.map(r => ({
          id_codigo: r.f[0].v,
          descripcion: r.f[1].v,
          activo: Number(r.f[2].v) || 0,
          similitud: Number(r.f[3].v) || 0
        }))
      : [];

    cache.put(cacheKey, JSON.stringify(results), 21600);
    return results;
  } catch (e) {
    throw new Error(`BigQuery: ${e.message}`);
  }
}

/**
 * 💾 GUARDAR SOLICITUD DE ALTA
 * Registra la nueva solicitud y genera el formato de inclusión.
 * @param {Object} payload - Datos del formulario
 */
function guardarSolicitud(payload) {
  // Verificación para autorizar DriveApp manualmente desde el editor
  if (!payload) {
    console.log('Verificando acceso a Drive...');
    DriveApp.getRootFolder(); // Esto forzará el diálogo de autorización
    console.log('Acceso a Drive confirmado. Puedes cerrar esta prueba.');
    return { success: true, message: 'Autorización exitosa' };
  }
  
  console.log('Nueva solicitud recibida:', JSON.stringify(payload));
  
  try {
    // 1. Mapeo de datos para la plantilla
    const datosDoc = {
      partida: payload.partidaCOG,
      familia: payload.familia || '',
      unidad: payload.unidadHospitalaria || '',
      descripcion: payload.descripcion,
      unidadMedida: payload.unidadMedida,
      nombreSolicitante: payload.nombreSolicitante || '',
      cargoSolicitante: payload.cargoSolicitante || '',
      servicio: payload.servicio || '',
      costoReferencia: payload.precio || '',
      proveedor: payload.proveedor || '',
      justificacion: payload.justificacion || '',
      observacion: payload.observacion || ''
    };

    // 2. Generar el documento basado en la plantilla
    const resultadoDoc = generarDocumentoInclusion(datosDoc, payload.cotizacionPDF);

    // TODO: Aquí podrías agregar la lógica para guardar en BD_Registro (BigQuery o Sheets)
    // registrarEnBaseDeDatos(payload, resultadoDoc.url);

    return { 
      success: true, 
      url: resultadoDoc.url,
      id: resultadoDoc.id
    };
  } catch (e) {
    console.error('Error en guardarSolicitud:', e.toString());
    throw new Error('No se pudo procesar la solicitud: ' + e.message);
  }
}

/**
 * 📄 GENERAR DOCUMENTO DE INCLUSIÓN
 * Crea una copia de la plantilla y la llena con los datos.
 * @param {Object} datos - Objeto con la información mapeada
 * @param {string} pdfBase64 - Datos del archivo en base64 (opcional)
 */
function generarDocumentoInclusion(datos, pdfBase64) {
  // ID de la hoja de cálculo plantilla (HCG Formato Inclusión 2026)
  const ID_PLANTILLA = '1ZVwPuloDIcDfQJFuZs_AeEb8SH5TD0iRbEx3kER_GC8';
  const NOMBRE_HOJA = 'Formato'; 
  
  try {
    const plantilla = DriveApp.getFileById(ID_PLANTILLA);
    const fechaStr = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyyMMdd-HHmm");
    const nombreNuevoArchivo = `Solicitud Inclusión - ${datos.descripcion.substring(0,30)} - ${fechaStr}`;
    
    // Carpeta destino (puedes cambiar el ID si deseas una específica)
    // [8] Evitar contaminación de la raíz de Drive
  const carpetaDestino = getCarpetaSolicitudes(); 
    const copia = plantilla.makeCopy(nombreNuevoArchivo, carpetaDestino);
    
    const ssCopia = SpreadsheetApp.open(copia);
    const hoja = ssCopia.getSheetByName(NOMBRE_HOJA);
    
    if (!hoja) throw new Error(`No se encontró la hoja "${NOMBRE_HOJA}" en la plantilla.`);

    // 4. Manejo del PDF (si existe)
    let urlPdf = "";
    if (pdfBase64) {
      const blob = Utilities.newBlob(Utilities.base64Decode(pdfBase64), 'application/pdf', `Cotizacion_${datos.descripcion.substring(0,20)}.pdf`);
      const archivoPdf = carpetaDestino.createFile(blob);
      urlPdf = archivoPdf.getUrl();
    }

    // 5. Mapeo de datos a las celdas (Fila 14, Col C a Col P)
    const filaInicio = 14;
    const valores = [[
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
      urlPdf                   // Col P: Link Cotización
    ]];

    // Aplicar batching: una sola llamada para 14 columnas
    hoja.getRange(filaInicio, 3, 1, valores[0].length).setValues(valores);
    
    SpreadsheetApp.flush();
    
    return {
      url: ssCopia.getUrl(),
      id: ssCopia.getId()
    };
  } catch (e) {
    throw new Error('Error al generar documento: ' + e.message);
  }
}

/**
 * Obtiene o crea la carpeta dedicada para las solicitudes
 */
function getCarpetaSolicitudes() {
  const FOLDER_NAME = 'Solicitudes de Inclusión HCG';
  const folders = DriveApp.getFoldersByName(FOLDER_NAME);
  if (folders.hasNext()) return folders.next();
  return DriveApp.createFolder(FOLDER_NAME);
}
