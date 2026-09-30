/* ════════════════════════════════════════════════════════════════════════════
   ft69_export.js — Exporta el FT-69 "Registro de Monitoreo de Alertas Nacionales"
   (formato Conkomerco, Word) desde la vista "Producto & Titular".

   Port a JavaScript de scripts/generar_ft69.py (repo digemid-monitor):
   - Abre la plantilla oficial (plantillas/FT-69_...docx) → conserva logo,
     encabezado (código FT-69 / versión / fechas) y pie de página.
   - Encabezado: TITULAR + PERIODO + trazabilidad (generado por / fecha).
   - Calendario del mes: "Si hay alerta" en días con alertas que impactan al
     titular; "No hay alerta" en el resto de días ya transcurridos.
   - Tabla inferior: una fila por alerta (Autoridad y código · Tipo · IFA ·
     Comentarios con producto impactado, titulares, urgencia, resumen IA…).

   Requiere JSZip (cdnjs) en el navegador. Sin dependencias de Supabase:
   index.html le entrega las alertas ya normalizadas.
   ════════════════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  const W   = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const W14 = 'http://schemas.microsoft.com/office/word/2010/wordml';
  const R   = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const PR  = 'http://schemas.openxmlformats.org/package/2006/relationships';
  const HYPERLINK = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink';
  const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';

  const MESES = ['', 'ENERO', 'FEBRERO', 'MARZO', 'ABRIL', 'MAYO', 'JUNIO', 'JULIO',
    'AGOSTO', 'SETIEMBRE', 'OCTUBRE', 'NOVIEMBRE', 'DICIEMBRE'];
  // Orden de las casillas en la celda "Tipo de alerta" de la plantilla
  const TIPO_IDX = [['calidad', 0], ['falsific', 1], ['segurid', 2], ['modific', 3]];

  /* ───────────────────────────── utilidades DOM ───────────────────────────── */
  const hijos = (el, local) => Array.from(el.childNodes)
    .filter(n => n.nodeType === 1 && n.namespaceURI === W && n.localName === local);
  const desc = (el, ns, local) => Array.from(el.getElementsByTagNameNS(ns, local));
  const quitar = n => n && n.parentNode && n.parentNode.removeChild(n);

  function wEl(doc, tag, attrs) {
    const e = doc.createElementNS(W, 'w:' + tag);
    if (attrs) for (const k in attrs) e.setAttributeNS(W, 'w:' + k, attrs[k]);
    return e;
  }

  /* Inserta `nuevo` dentro de `padre` antes del primer hijo cuyo nombre esté en `antesDe`
     (respeta el orden que exige el esquema OOXML). */
  function insertarOrdenado(padre, nuevo, antesDe) {
    const ref = Array.from(padre.childNodes)
      .find(n => n.nodeType === 1 && antesDe.includes(n.localName));
    padre.insertBefore(nuevo, ref || null);
  }

  /* Evita IDs duplicados al clonar filas/celdas (Word los tolera, pero así queda limpio). */
  let _sdtSeq = 0;
  function limpiarIds(el) {
    const todos = [el, ...Array.from(el.getElementsByTagName('*'))];
    for (const n of todos) {
      if (n.hasAttributeNS && n.hasAttributeNS(W14, 'paraId')) n.removeAttributeNS(W14, 'paraId');
      if (n.hasAttributeNS && n.hasAttributeNS(W14, 'textId')) n.removeAttributeNS(W14, 'textId');
    }
    for (const sdtPr of desc(el, W, 'sdtPr')) {
      const id = hijos(sdtPr, 'id')[0];
      if (id) id.setAttributeNS(W, 'w:val', String(700000000 + (++_sdtSeq)));
    }
  }

  /* ───────────────────────────── casillas ───────────────────────────── */
  const casillas = tc => desc(tc, W, 'sdt').filter(s => desc(s, W14, 'checkbox').length);
  function marcar(sdt, valor) {
    const chk = desc(sdt, W14, 'checked')[0];
    if (chk) chk.setAttributeNS(W14, 'w14:val', valor ? '1' : '0');
    desc(sdt, W, 't').forEach(t => { t.textContent = valor ? '☒' : '☐'; });
  }

  /* ───────────────────────────── texto en celdas ───────────────────────────── */
  function run(doc, texto, o) {
    o = o || {};
    const r = wEl(doc, 'r'), rPr = wEl(doc, 'rPr');
    rPr.appendChild(wEl(doc, 'rFonts', { ascii: 'Arial', hAnsi: 'Arial', cs: 'Arial' }));
    if (o.bold) rPr.appendChild(wEl(doc, 'b'));
    if (o.color) rPr.appendChild(wEl(doc, 'color', { val: o.color }));
    if (o.size) {
      rPr.appendChild(wEl(doc, 'sz', { val: String(o.size * 2) }));
      rPr.appendChild(wEl(doc, 'szCs', { val: String(o.size * 2) }));
    }
    if (o.underline) rPr.appendChild(wEl(doc, 'u', { val: 'single' }));
    r.appendChild(rPr);
    const t = wEl(doc, 't');
    t.setAttributeNS('http://www.w3.org/XML/1998/namespace', 'xml:space', 'preserve');
    t.textContent = texto;
    r.appendChild(t);
    return r;
  }

  function ajustarPPr(doc, p, o) {
    let pPr = hijos(p, 'pPr')[0];
    if (!pPr) { pPr = wEl(doc, 'pPr'); p.insertBefore(pPr, p.firstChild); }
    const antes = ['rPr', 'sectPr', 'pPrChange'];
    if (o.spacingAfter != null) {
      hijos(pPr, 'spacing').forEach(quitar);
      insertarOrdenado(pPr, wEl(doc, 'spacing', { after: String(o.spacingAfter), before: '0' }),
        ['ind', 'contextualSpacing', 'mirrorIndents', 'suppressOverlap', 'jc', 'textDirection',
          'textAlignment', 'textboxTightWrap', 'outlineLvl', 'divId', 'cnfStyle', ...antes]);
    }
    if (o.center) {
      hijos(pPr, 'jc').forEach(quitar);
      insertarOrdenado(pPr, wEl(doc, 'jc', { val: 'center' }),
        ['textDirection', 'textAlignment', 'textboxTightWrap', 'outlineLvl', 'divId', 'cnfStyle', ...antes]);
    }
  }

  /* Deja la celda con un único párrafo vacío (conserva su pPr) y lo devuelve. */
  function vaciarCelda(tc) {
    const ps = hijos(tc, 'p');
    ps.slice(1).forEach(quitar);
    const base = ps[0];
    Array.from(base.childNodes).forEach(n => { if (n.nodeType !== 1 || n.localName !== 'pPr') quitar(n); });
    return base;
  }

  function nuevoParrafo(tc, base) {
    const p = base.cloneNode(false);
    p.removeAttributeNS(W14, 'paraId'); p.removeAttributeNS(W14, 'textId');
    const pPr = hijos(base, 'pPr')[0];
    if (pPr) p.appendChild(pPr.cloneNode(true));
    tc.appendChild(p);
    return p;
  }

  function llenarCeldaTexto(doc, tc, lineas, o) {
    o = o || {};
    const base = vaciarCelda(tc);
    lineas.forEach((linea, i) => {
      const p = i === 0 ? base : nuevoParrafo(tc, base);
      if (o.center) ajustarPPr(doc, p, { center: true });
      p.appendChild(run(doc, linea, { size: o.size, bold: o.boldPrimera && i === 0 }));
    });
  }

  /* ───────────────────────────── hipervínculos ───────────────────────────── */
  function crearRelacion(rels, url) {
    const raiz = rels.documentElement;
    const usados = new Set(Array.from(raiz.getElementsByTagNameNS(PR, 'Relationship')).map(r => r.getAttribute('Id')));
    let n = 1, id;
    do { id = 'rIdFt69_' + (n++); } while (usados.has(id));
    const rel = rels.createElementNS(PR, 'Relationship');
    rel.setAttribute('Id', id);
    rel.setAttribute('Type', HYPERLINK);
    rel.setAttribute('Target', url);
    rel.setAttribute('TargetMode', 'External');
    raiz.appendChild(rel);
    return id;
  }

  function hipervinculo(doc, rels, p, url, size) {
    const h = wEl(doc, 'hyperlink');
    h.setAttributeNS(R, 'r:id', crearRelacion(rels, url));
    h.appendChild(run(doc, url, { size, color: '0563C1', underline: true }));
    p.appendChild(h);
  }

  function llenarComentarios(doc, rels, tc, pares, size) {
    const base = vaciarCelda(tc);
    pares.forEach(([etq, val], i) => {
      const p = i === 0 ? base : nuevoParrafo(tc, base);
      ajustarPPr(doc, p, { spacingAfter: 40 });
      p.appendChild(run(doc, etq + ': ', { bold: true, size }));
      const v = val == null ? '' : String(val);
      if (/^https?:\/\//i.test(v)) hipervinculo(doc, rels, p, v, size);
      else p.appendChild(run(doc, v || '—', { size }));
    });
  }

  /* ───────────────────────────── texto / resumen ───────────────────────────── */
  const txt = v => {
    const s = v == null ? '' : String(v).split(/\s+/).join(' ').trim();
    return ['NAN', 'NONE', 'NAT', 'NULL'].includes(s.toUpperCase()) ? '' : s;
  };
  function oracion(t) {
    t = txt(t).replace(/^[\s;,\-]+|[\s;,\-]+$/g, '');
    if (!t) return '';
    t = t[0].toUpperCase() + t.slice(1);
    return /[.!?]$/.test(t) ? t : t + '.';
  }
  const CONTEXTO = [
    ['falsific', 'DIGEMID alerta sobre la comercialización ilegal (producto falsificado o sin registro sanitario) de {p}.'],
    ['calidad', 'DIGEMID comunica resultados no conformes en el control de calidad de {p}.'],
    ['segurid', 'Se comunica nueva información de seguridad relacionada con {p}.'],
    ['modific', 'DIGEMID comunica la modificación del registro sanitario de {p}.'],
  ];
  const MEDIDA = [
    ['falsific', 'Se recomienda no adquirir, distribuir ni utilizar el producto y abastecerse únicamente en establecimientos farmacéuticos autorizados.'],
    ['calidad', 'Se debe verificar existencias en almacén y puntos de dispensación, inmovilizar los lotes involucrados y proceder conforme a lo dispuesto por DIGEMID.'],
    ['segurid', 'Se recomienda vigilar la aparición de los eventos descritos y notificar toda sospecha de reacción adversa al Sistema Peruano de Farmacovigilancia.'],
  ];
  /* Si la alerta ya trae resumen (Claude/heurístico) se respeta; si no, se redacta uno estructurado. */
  function redactarResumen(a) {
    if (txt(a.resumen)) return oracion(a.resumen);
    const tipo = txt(a.tipo).toLowerCase();
    const p = txt(a.producto) || txt(a.principio) || 'el producto señalado';
    const ctx = (CONTEXTO.find(([k]) => tipo.includes(k)) || [0, 'Se emite una alerta sanitaria sobre {p}.'])[1].replace('{p}', p);
    const med = (MEDIDA.find(([k]) => tipo.includes(k)) ||
      [0, 'Se recomienda revisar el comunicado oficial y evaluar el impacto en el portafolio y la cadena de suministro.'])[1];
    return ctx + ' ' + med;
  }

  const pad = n => String(n).padStart(2, '0');
  const fmtDMY = iso => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || ''); return m ? `${m[3]}/${m[2]}/${m[1]}` : (iso || '—'); };
  const ahora = () => { const d = new Date(); return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const hoyISO = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

  /* ───────────────────────────── calendario ───────────────────────────── */
  function llenarCalendario(tabla, anio, mes, diasConAlerta, coberturaFin) {
    const filas = hijos(tabla, 'tr');
    const celdaDia = filas[1] && hijos(filas[1], 'tc')[5];
    const celdaVacia = hijos(filas[1], 'tc')[0];
    const tplDia = celdaDia.cloneNode(true), tplVacia = celdaVacia.cloneNode(true);
    const tplFila = filas[1].cloneNode(true);
    filas.slice(1).forEach(quitar);

    const ultimo = new Date(anio, mes, 0).getDate();
    const semanas = []; let sem = new Array(new Date(anio, mes - 1, 1).getDay()).fill(0); // domingo primero
    for (let d = 1; d <= ultimo; d++) { sem.push(d); if (sem.length === 7) { semanas.push(sem); sem = []; } }
    if (sem.length) { while (sem.length < 7) sem.push(0); semanas.push(sem); }

    for (const semana of semanas) {
      const tr = tplFila.cloneNode(true);
      const tcs = hijos(tr, 'tc');
      semana.forEach((dia, col) => {
        const nuevo = (dia ? tplDia : tplVacia).cloneNode(true);
        if (dia) {
          const t = desc(hijos(nuevo, 'p')[0], W, 't');
          if (t.length) { t[0].textContent = String(dia); t.slice(1).forEach(x => { x.textContent = ''; }); }
          const iso = `${anio}-${pad(mes)}-${pad(dia)}`;
          const cbs = casillas(nuevo); // [No hay alerta, Si hay alerta]
          if (diasConAlerta.has(iso)) marcar(cbs[1], true);
          else if (iso <= coberturaFin) marcar(cbs[0], true);
        }
        // conservar el ancho de la columna original
        const wOrig = desc(tcs[col], W, 'tcW')[0], wNuevo = desc(nuevo, W, 'tcW')[0];
        if (wOrig && wNuevo) wNuevo.setAttributeNS(W, 'w:w', wOrig.getAttributeNS(W, 'w'));
        tr.replaceChild(nuevo, tcs[col]);
      });
      limpiarIds(tr);
      tabla.appendChild(tr);
    }
  }

  /* ───────────────────────────── tabla de alertas ───────────────────────────── */
  function asegurarTrPr(doc, tr) {
    let trPr = hijos(tr, 'trPr')[0];
    if (!trPr) { trPr = wEl(doc, 'trPr'); insertarOrdenado(tr, trPr, ['tc', 'customXml', 'sdt']); }
    return trPr;
  }

  function llenarAlertas(doc, rels, tabla, alertas, titular) {
    const filas = hijos(tabla, 'tr');
    // repetir encabezado en cada página
    const trPr0 = asegurarTrPr(doc, filas[0]);
    if (!hijos(trPr0, 'tblHeader').length)
      insertarOrdenado(trPr0, wEl(doc, 'tblHeader'), ['tblCellSpacing', 'jc', 'hidden', 'ins', 'del', 'trPrChange']);
    const tplFila = filas[1].cloneNode(true);
    filas.slice(1).forEach(quitar);

    const SZ = 8;
    if (!alertas.length) {
      const tr = tplFila.cloneNode(true); limpiarIds(tr); tabla.appendChild(tr);
      llenarCeldaTexto(doc, hijos(tr, 'tc')[3], [`Sin alertas que impacten a ${titular} en el periodo monitoreado.`], { size: SZ });
      return;
    }
    for (const a of alertas) {
      const tr = tplFila.cloneNode(true);
      const trPr = asegurarTrPr(doc, tr); // la fila no se parte entre páginas
      if (!hijos(trPr, 'cantSplit').length) trPr.insertBefore(wEl(doc, 'cantSplit'), trPr.firstChild);
      limpiarIds(tr);
      tabla.appendChild(tr);
      const tc = hijos(tr, 'tc');

      const codigo = txt(a.codigo).replace(/ALERTA\s+DIGEMID/i, 'Alerta').trim() || '—';
      llenarCeldaTexto(doc, tc[0], [txt(a.autoridad) || 'DIGEMID', codigo, fmtDMY(a.fecha)], { boldPrimera: true, size: SZ });

      const tipo = txt(a.tipo).toLowerCase(), cbs = casillas(tc[1]);
      const hit = TIPO_IDX.find(([k]) => tipo.includes(k));
      if (hit && cbs[hit[1]]) marcar(cbs[hit[1]], true);

      llenarCeldaTexto(doc, tc[2], [txt(a.principio) || txt(a.producto) || '—'], { size: SZ });

      const pares = [
        ['Fecha', fmtDMY(a.fecha)],
        ['Producto impactado', txt(a.producto)],
        ['Principio activo', txt(a.principio)],
        ['Titular(es)', txt(a.titulares) || 'No asignado en el portafolio'],
        ['Tipo de alerta', txt(a.tipo)],
        ['Urgencia', txt(a.urgencia)],
      ];
      if (txt(a.accion)) pares.push(['Acción principal', txt(a.accion)]);
      pares.push(['Resumen IA', redactarResumen(a)]);
      if (txt(a.estado)) pares.push(['Estado del caso', txt(a.estado) + (txt(a.expediente) ? ` · Expediente ${txt(a.expediente)}` : '')]);
      if (txt(a.urlAlerta)) pares.push(['URL Alerta', txt(a.urlAlerta)]);
      if (txt(a.urlPdf) && txt(a.urlPdf) !== txt(a.urlAlerta)) pares.push(['URL PDF', txt(a.urlPdf)]);
      llenarComentarios(doc, rels, tc[3], pares, SZ);
    }
  }

  /* ───────────────────────────── API pública ───────────────────────────── */
  /**
   * Genera un FT-69 (ArrayBuffer/Uint8Array de la plantilla → Blob|Uint8Array).
   * @param {ArrayBuffer} plantilla  bytes de la plantilla .docx
   * @param {object} p  { titular, anio, mes, alertas:[…normalizadas], generadoPor, fuente, salida:'blob'|'uint8array' }
   */
  async function generarFT69(plantilla, p) {
    const JSZipLib = global.JSZip;
    const zip = await JSZipLib.loadAsync(plantilla);
    const parser = new global.DOMParser(), ser = new global.XMLSerializer();
    const doc = parser.parseFromString(await zip.file('word/document.xml').async('string'), 'application/xml');
    const relsPath = 'word/_rels/document.xml.rels';
    const rels = parser.parseFromString(await zip.file(relsPath).async('string'), 'application/xml');

    const body = desc(doc, W, 'body')[0];
    const [tEnc, tCal, tAle] = hijos(body, 'tbl');
    const { anio, mes } = p;
    const ultimo = new Date(anio, mes, 0).getDate();
    const finMes = `${anio}-${pad(mes)}-${pad(ultimo)}`;
    const cobFin = hoyISO() < finMes ? hoyISO() : finMes;
    const alertas = (p.alertas || []).slice().sort((x, y) => String(x.fecha || '').localeCompare(String(y.fecha || '')));

    const enc = [
      `TITULAR: ${p.titular}`,
      `PERIODO: ${MESES[mes]} ${anio}   |   Fuente: ${p.fuente || 'DIGEMID – Alertas sanitarias vinculadas al portafolio'}`,
      `Alertas que impactan al titular: ${alertas.length}   |   Días cubiertos: 01/${pad(mes)}/${anio} al ${fmtDMY(cobFin)}`,
      `Generado por ConkoSafe IA el ${ahora()}${p.generadoPor ? ' · ' + p.generadoPor : ''}`,
    ];
    llenarCeldaTexto(doc, hijos(hijos(tEnc, 'tr')[0], 'tc')[0], enc, { boldPrimera: true, size: 9, center: true });

    llenarCalendario(tCal, anio, mes, new Set(alertas.map(a => String(a.fecha || '').slice(0, 10))), cobFin);
    llenarAlertas(doc, rels, tAle, alertas, p.titular);

    zip.file('word/document.xml', XML_DECL + ser.serializeToString(doc).replace(/^<\?xml[^>]*\?>\s*/, ''));
    zip.file(relsPath, XML_DECL + ser.serializeToString(rels).replace(/^<\?xml[^>]*\?>\s*/, ''));
    return zip.generateAsync({
      type: p.salida || 'blob', compression: 'DEFLATE',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
  }

  const slug = s => txt(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'SIN_TITULAR';

  /**
   * Genera los FT-69 por titular y los descarga (un .docx si es uno solo; .zip si son varios).
   * @param {object} o { plantillaUrl, grupos:[{titular, alertas}], periodo:'YYYY-MM'|'todos', generadoPor, onProgreso }
   * @returns {Promise<{archivos:number, alertas:number}>}
   */
  async function exportarFT69PorTitular(o) {
    const resp = await fetch(o.plantillaUrl, { cache: 'no-cache' });
    if (!resp.ok) throw new Error(`No se pudo cargar la plantilla FT-69 (${resp.status}).`);
    const plantilla = await resp.arrayBuffer();

    const trabajos = [];
    for (const g of o.grupos) {
      let meses;
      if (o.periodo === 'todos') {
        meses = [...new Set(g.alertas.map(a => String(a.fecha || '').slice(0, 7)).filter(m => /^\d{4}-\d{2}$/.test(m)))].sort();
      } else meses = [o.periodo];
      for (const ym of meses) {
        const alertasMes = g.alertas.filter(a => String(a.fecha || '').startsWith(ym));
        trabajos.push({ titular: g.titular, ym, alertas: alertasMes });
      }
    }
    if (!trabajos.length) throw new Error('No hay alertas con fecha para exportar con los filtros actuales.');

    const archivos = []; let n = 0;
    for (const t of trabajos) {
      o.onProgreso && o.onProgreso(++n, trabajos.length, t.titular);
      const [anio, mes] = t.ym.split('-').map(Number);
      const blob = await generarFT69(plantilla, { titular: t.titular, anio, mes, alertas: t.alertas, generadoPor: o.generadoPor });
      archivos.push({ nombre: `FT-69_${slug(t.titular)}_${t.ym}.docx`, blob });
    }

    if (archivos.length === 1) descargar(archivos[0].blob, archivos[0].nombre);
    else {
      const zip = new global.JSZip();
      archivos.forEach(a => zip.file(a.nombre, a.blob));
      const etiqueta = o.periodo === 'todos' ? 'todos_los_meses' : o.periodo;
      const nombreZip = o.grupos.length === 1
        ? `FT-69_${slug(o.grupos[0].titular)}_${etiqueta}.zip`
        : `FT-69_Alertas_por_Titular_${etiqueta}.zip`;
      descargar(await zip.generateAsync({ type: 'blob' }), nombreZip);
    }
    return { archivos: archivos.length, alertas: trabajos.reduce((s, t) => s + t.alertas.length, 0) };
  }

  function descargar(blob, nombre) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = nombre; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1500);
  }

  global.FT69 = { generarFT69, exportarFT69PorTitular, redactarResumen };
})(typeof window !== 'undefined' ? window : globalThis);
