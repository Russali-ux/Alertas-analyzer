/* ════════════════════════════════════════════════════════════════════════════
   ft68_export.js — Exporta el FT-68 "Registro de Monitoreo de Información de
   Países de Alta Vigilancia Sanitaria" (PAVS · internacional, formato Conkomerco).

   - Abre la plantilla oficial (plantillas/FT-68_Registro_de_Monitoreo_de_PAVS.docx)
     y conserva logo, encabezado (código FT-68 / versión / fechas) y pie.
   - Página 1: lista de agencias de vigilancia sanitaria (sin cambios).
   - Desde la página 2: encabezado con TITULAR / PERIODO / trazabilidad y la tabla
     Fecha de emisión · Fecha de revisión · País · Agencia · Tipo de alerta ·
     Título de alerta · IFA · Reacción adversa (una fila por alerta).
   Solo recibe alertas PAVS internacionales (las de DIGEMID van al FT-69).
   Requiere JSZip en el navegador.
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

  /* ───────── utilidades DOM ───────── */
  const hijos = (el, local) => Array.from(el.childNodes)
    .filter(n => n.nodeType === 1 && n.namespaceURI === W && n.localName === local);
  const desc = (el, ns, local) => Array.from(el.getElementsByTagNameNS(ns, local));
  const quitar = n => n && n.parentNode && n.parentNode.removeChild(n);
  function wEl(doc, tag, attrs) {
    const e = doc.createElementNS(W, 'w:' + tag);
    if (attrs) for (const k in attrs) e.setAttributeNS(W, 'w:' + k, attrs[k]);
    return e;
  }
  function insertarOrdenado(padre, nuevo, antesDe) {
    const ref = Array.from(padre.childNodes).find(n => n.nodeType === 1 && antesDe.includes(n.localName));
    padre.insertBefore(nuevo, ref || null);
  }
  function limpiarIds(el) {
    [el, ...Array.from(el.getElementsByTagName('*'))].forEach(n => {
      if (n.hasAttributeNS && n.hasAttributeNS(W14, 'paraId')) n.removeAttributeNS(W14, 'paraId');
      if (n.hasAttributeNS && n.hasAttributeNS(W14, 'textId')) n.removeAttributeNS(W14, 'textId');
    });
  }
  const esTabla = n => n.nodeType === 1 && n.namespaceURI === W && n.localName === 'tbl';

  /* ───────── texto ───────── */
  const txt = v => {
    const s = v == null ? '' : String(v).split(/\s+/).join(' ').trim();
    return ['NAN', 'NONE', 'NAT', 'NULL'].includes(s.toUpperCase()) ? '' : s;
  };
  const pad = n => String(n).padStart(2, '0');
  const fmtDMY = iso => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || ''); return m ? `${m[3]}/${m[2]}/${m[1]}` : (txt(iso) || '—'); };
  const ahora = () => { const d = new Date(); return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const hoyISO = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

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
  function centrar(doc, p) {
    let pPr = hijos(p, 'pPr')[0];
    if (!pPr) { pPr = wEl(doc, 'pPr'); p.insertBefore(pPr, p.firstChild); }
    hijos(pPr, 'jc').forEach(quitar);
    insertarOrdenado(pPr, wEl(doc, 'jc', { val: 'center' }),
      ['textDirection', 'textAlignment', 'textboxTightWrap', 'outlineLvl', 'divId', 'cnfStyle', 'rPr', 'sectPr', 'pPrChange']);
  }
  /* lineas: [{t, bold, url}] o strings */
  function llenarCelda(doc, rels, tc, lineas, o) {
    o = o || {};
    const base = vaciarCelda(tc);
    lineas.forEach((l, i) => {
      const L = typeof l === 'string' ? { t: l } : l;
      const p = i === 0 ? base : nuevoParrafo(tc, base);
      if (o.center) centrar(doc, p);
      const texto = txt(L.t) || '—';
      if (L.url) {
        const h = wEl(doc, 'hyperlink');
        h.setAttributeNS(R, 'r:id', crearRelacion(rels, L.url));
        h.appendChild(run(doc, texto, { size: o.size, bold: L.bold, color: '0563C1', underline: true }));
        p.appendChild(h);
      } else p.appendChild(run(doc, texto, { size: o.size, bold: L.bold }));
    });
  }
  function crearRelacion(rels, url) {
    const raiz = rels.documentElement;
    const usados = new Set(Array.from(raiz.getElementsByTagNameNS(PR, 'Relationship')).map(r => r.getAttribute('Id')));
    let n = 1, id;
    do { id = 'rIdFt68_' + (n++); } while (usados.has(id));
    const rel = rels.createElementNS(PR, 'Relationship');
    rel.setAttribute('Id', id); rel.setAttribute('Type', HYPERLINK);
    rel.setAttribute('Target', url); rel.setAttribute('TargetMode', 'External');
    raiz.appendChild(rel);
    return id;
  }
  function asegurarTrPr(doc, tr) {
    let trPr = hijos(tr, 'trPr')[0];
    if (!trPr) { trPr = wEl(doc, 'trPr'); insertarOrdenado(tr, trPr, ['tc', 'customXml', 'sdt']); }
    return trPr;
  }

  /* Los párrafos vacíos entre la lista de agencias y la sección de registro se
     reemplazan por un salto de página: el registro siempre arranca en página nueva. */
  function forzarSaltoPagina(doc, body, tablaAgencias, tablaEncabezado2) {
    let n = tablaAgencias.nextSibling;
    while (n && n !== tablaEncabezado2) { const sig = n.nextSibling; if (n.nodeType === 1 && n.localName === 'p') quitar(n); n = sig; }
    const p = wEl(doc, 'p'), r = wEl(doc, 'r');
    r.appendChild(wEl(doc, 'br', { type: 'page' }));
    p.appendChild(r);
    body.insertBefore(p, tablaEncabezado2);
  }

  /* ───────── tabla de registro ───────── */
  function llenarRegistro(doc, rels, tabla, alertas, titular) {
    const filas = hijos(tabla, 'tr');
    const trPr0 = asegurarTrPr(doc, filas[0]);
    if (!hijos(trPr0, 'tblHeader').length)
      insertarOrdenado(trPr0, wEl(doc, 'tblHeader'), ['tblCellSpacing', 'jc', 'hidden', 'ins', 'del', 'trPrChange']);
    const tpl = filas[1].cloneNode(true);
    filas.slice(1).forEach(quitar);
    const SZ = 8;

    if (!alertas.length) {
      const tr = tpl.cloneNode(true); limpiarIds(tr); tabla.appendChild(tr);
      const tc = hijos(tr, 'tc');
      llenarCelda(doc, rels, tc[5], [`Sin alertas internacionales (PAVS) que impacten a ${titular} en el periodo monitoreado.`], { size: SZ });
      return;
    }
    for (const a of alertas) {
      const tr = tpl.cloneNode(true);
      const trPr = asegurarTrPr(doc, tr);
      if (!hijos(trPr, 'cantSplit').length) trPr.insertBefore(wEl(doc, 'cantSplit'), trPr.firstChild);
      limpiarIds(tr);
      tabla.appendChild(tr);
      const tc = hijos(tr, 'tc');
      llenarCelda(doc, rels, tc[0], [fmtDMY(a.fechaEmision)], { size: SZ, center: true });
      llenarCelda(doc, rels, tc[1], [fmtDMY(a.fechaRevision)], { size: SZ, center: true });
      llenarCelda(doc, rels, tc[2], [txt(a.pais)], { size: SZ, center: true });
      llenarCelda(doc, rels, tc[3], [txt(a.agencia)], { size: SZ, center: true });
      llenarCelda(doc, rels, tc[4], [txt(a.tipo)], { size: SZ, center: true });
      const url = /^https?:\/\//i.test(txt(a.url)) ? txt(a.url) : '';
      llenarCelda(doc, rels, tc[5], [{ t: a.titulo, url }], { size: SZ });
      const ifa = [{ t: txt(a.ifa) || txt(a.principio), bold: true }];
      if (txt(a.producto)) ifa.push('Producto impactado: ' + txt(a.producto));
      if (txt(a.regSanitario)) ifa.push('Nº Reg. Sanitario: ' + txt(a.regSanitario));
      llenarCelda(doc, rels, tc[6], ifa, { size: SZ });
      llenarCelda(doc, rels, tc[7], [txt(a.reaccion)], { size: SZ });
    }
  }

  /* ───────── API pública ───────── */
  async function generarFT68(plantilla, p) {
    const zip = await global.JSZip.loadAsync(plantilla);
    const parser = new global.DOMParser(), ser = new global.XMLSerializer();
    const doc = parser.parseFromString(await zip.file('word/document.xml').async('string'), 'application/xml');
    const relsPath = 'word/_rels/document.xml.rels';
    const rels = parser.parseFromString(await zip.file(relsPath).async('string'), 'application/xml');

    const body = desc(doc, W, 'body')[0];
    const tablas = Array.from(body.childNodes).filter(esTabla);
    if (tablas.length < 4) throw new Error('La plantilla FT-68 no tiene la estructura esperada (4 tablas).');
    const [, tAgencias, tEnc2, tReg] = tablas;

    const { anio, mes } = p;
    const finMes = `${anio}-${pad(mes)}-${pad(new Date(anio, mes, 0).getDate())}`;
    const cobFin = hoyISO() < finMes ? hoyISO() : finMes;
    const alertas = (p.alertas || []).slice().sort((x, y) => String(x.fechaEmision || '').localeCompare(String(y.fechaEmision || '')));

    forzarSaltoPagina(doc, body, tAgencias, tEnc2);

    const enc = [
      { t: `TITULAR: ${p.titular}`, bold: true },
      `PERIODO: ${MESES[mes]} ${anio}   |   Fuente: PAVS – Países de Alta Vigilancia Sanitaria (alertas internacionales vinculadas al portafolio)`,
      `Alertas internacionales que impactan al titular: ${alertas.length}   |   Días cubiertos: 01/${pad(mes)}/${anio} al ${fmtDMY(cobFin)}`,
      `Generado por ConkoSafe IA el ${ahora()}${p.generadoPor ? ' · ' + p.generadoPor : ''}`,
    ];
    llenarCelda(doc, rels, hijos(hijos(tEnc2, 'tr')[0], 'tc')[0], enc, { size: 9, center: true });
    llenarRegistro(doc, rels, tReg, alertas, p.titular);

    zip.file('word/document.xml', XML_DECL + ser.serializeToString(doc).replace(/^<\?xml[^>]*\?>\s*/, ''));
    zip.file(relsPath, XML_DECL + ser.serializeToString(rels).replace(/^<\?xml[^>]*\?>\s*/, ''));
    return zip.generateAsync({
      type: p.salida || 'blob', compression: 'DEFLATE',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
  }

  const slug = s => txt(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'SIN_TITULAR';

  /** o: { plantillaUrl, grupos:[{titular, alertas}], periodo:'YYYY-MM'|'todos', generadoPor, onProgreso } */
  async function exportarFT68PorTitular(o) {
    const resp = await fetch(o.plantillaUrl, { cache: 'no-cache' });
    if (!resp.ok) throw new Error(`No se pudo cargar la plantilla FT-68 (${resp.status}).`);
    const plantilla = await resp.arrayBuffer();
    const trabajos = [];
    for (const g of o.grupos) {
      const meses = o.periodo === 'todos'
        ? [...new Set(g.alertas.map(a => String(a.fechaEmision || '').slice(0, 7)).filter(m => /^\d{4}-\d{2}$/.test(m)))].sort()
        : [o.periodo];
      for (const ym of meses) trabajos.push({ titular: g.titular, ym, alertas: g.alertas.filter(a => String(a.fechaEmision || '').startsWith(ym)) });
    }
    if (!trabajos.length) throw new Error('No hay alertas PAVS con fecha para exportar con los filtros actuales.');

    const archivos = []; let n = 0;
    for (const t of trabajos) {
      o.onProgreso && o.onProgreso(++n, trabajos.length, t.titular);
      const [anio, mes] = t.ym.split('-').map(Number);
      const blob = await generarFT68(plantilla, { titular: t.titular, anio, mes, alertas: t.alertas, generadoPor: o.generadoPor });
      archivos.push({ nombre: `FT-68_${slug(t.titular)}_${t.ym}.docx`, blob });
    }
    if (archivos.length === 1) descargar(archivos[0].blob, archivos[0].nombre);
    else {
      const zip = new global.JSZip();
      archivos.forEach(a => zip.file(a.nombre, a.blob));
      const et = o.periodo === 'todos' ? 'todos_los_meses' : o.periodo;
      descargar(await zip.generateAsync({ type: 'blob' }), o.grupos.length === 1
        ? `FT-68_${slug(o.grupos[0].titular)}_${et}.zip` : `FT-68_PAVS_por_Titular_${et}.zip`);
    }
    return { archivos: archivos.length, alertas: trabajos.reduce((s, t) => s + t.alertas.length, 0) };
  }
  function descargar(blob, nombre) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = nombre; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1500);
  }

  global.FT68 = { generarFT68, exportarFT68PorTitular };
})(typeof window !== 'undefined' ? window : globalThis);
