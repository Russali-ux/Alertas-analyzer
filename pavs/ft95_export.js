/* ════════════════════════════════════════════════════════════════════════════
   ft95_export.js — Exporta el FT-95 "Monitoreo de Alertas de Países de Alta
   Vigilancia Sanitaria y LATAM" (Excel, formato Conkomerco · DS043).

   - Abre la plantilla oficial (plantillas/FT-95_Monitoreo_de_Alertas_de_PAVS.xlsx)
     y conserva intacta la hoja DS043 (logo, código FT-95, versión, vigencia y
     lista de agencias).
   - Completa la hoja PAVS_BD con las alertas recibidas (las que están filtradas
     en el Monitor PAVS): Año · Mes · Fecha Emisión · Fecha Revisión · País ·
     Agencia · Tipo de Alerta · Título · Tipo de Producto · IFA · Reacción
     Adversa · Enlace (con hipervínculo), usando los estilos de la plantilla.
   - Edita el XML directamente con JSZip para no perder formato, validaciones
     de datos, filtros ni imágenes (SheetJS community los descarta).
   Requiere JSZip en el navegador.
   ════════════════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  const HYPERLINK = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink';
  const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';
  const SHEET = 'xl/worksheets/sheet2.xml';          // PAVS_BD
  const SHEET_RELS = 'xl/worksheets/_rels/sheet2.xml.rels';

  // Estilos (índices de cellXfs) tomados de la fila modelo de PAVS_BD en la plantilla
  const S = { anio: 35, mes: 36, fecha: 37, texto: 38, textoU: 39, enlace: 40 };
  const COLS = 'ABCDEFGHIJKL'.split('');

  /* ───────── utilidades ───────── */
  const limpio = v => {
    if (v == null) return '';
    const s = String(v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '').trim();
    return ['NAN', 'NONE', 'NAT', 'NULL'].includes(s.toUpperCase()) ? '' : s;
  };
  const xesc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const pad = n => String(n).padStart(2, '0');
  const hoyISO = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

  /* 'YYYY-MM-DD' → número de serie de Excel (sistema 1900) */
  function serialExcel(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(limpio(iso));
    if (!m) return null;
    const t = Date.UTC(+m[1], +m[2] - 1, +m[3]);
    return Math.round((t - Date.UTC(1899, 11, 30)) / 86400000);
  }

  function celdaTexto(ref, s, v) {
    const t = limpio(v);
    if (!t) return `<c r="${ref}" s="${s}"/>`;
    return `<c r="${ref}" s="${s}" t="inlineStr"><is><t xml:space="preserve">${xesc(t)}</t></is></c>`;
  }
  function celdaNum(ref, s, n) {
    return (n == null || n === '' || isNaN(n)) ? `<c r="${ref}" s="${s}"/>` : `<c r="${ref}" s="${s}"><v>${n}</v></c>`;
  }

  /* Registro de pavs_alertas → fila PAVS_BD */
  function filaXml(a, r) {
    const fe = limpio(a.fecha_emision);
    const anio = a.anio != null && a.anio !== '' ? Number(a.anio) : (fe ? Number(fe.slice(0, 4)) : null);
    const mes = a.mes != null && a.mes !== '' ? Number(a.mes) : (fe ? Number(fe.slice(5, 7)) : null);
    const c = COLS.map(x => x + r);
    return `<row r="${r}" spans="1:12" ht="14.25" customHeight="1">` +
      celdaNum(c[0], S.anio, anio) +
      celdaNum(c[1], S.mes, mes) +
      celdaNum(c[2], S.fecha, serialExcel(a.fecha_emision)) +
      celdaNum(c[3], S.fecha, serialExcel(a.fecha_revision)) +
      celdaTexto(c[4], S.texto, a.pais) +
      celdaTexto(c[5], S.texto, a.agencia) +
      celdaTexto(c[6], S.texto, a.tipo_alerta) +
      celdaTexto(c[7], S.texto, a.titulo_alerta) +
      celdaTexto(c[8], S.texto, a.tipo_producto) +
      celdaTexto(c[9], S.textoU, a.ifa) +
      celdaTexto(c[10], S.textoU, a.reaccion_adversa) +
      celdaTexto(c[11], S.enlace, a.enlace) +
      '</row>';
  }

  async function descargar(blob, nombre) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = nombre;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  /**
   * exportarFT95({ alertas, plantillaUrl, nombreArchivo, generadoPor })
   *  alertas: filas de pavs_alertas YA filtradas (en el orden deseado)
   */
  async function exportarFT95(o) {
    if (typeof JSZip === 'undefined') throw new Error('No se cargó JSZip.');
    const alertas = o.alertas || [];

    const resp = await fetch(o.plantillaUrl, { cache: 'no-cache' });
    if (!resp.ok) throw new Error(`No se pudo descargar la plantilla FT-95 (${resp.status}).`);
    const zip = await JSZip.loadAsync(await resp.arrayBuffer());

    let xml = await zip.file(SHEET).async('string');
    const ultima = alertas.length + 1;

    // 1) filas de datos (la fila 1 es el encabezado de la plantilla)
    const filas = alertas.map((a, i) => filaXml(a, i + 2)).join('');
    xml = xml.replace(/(<row r="1"[\s\S]*?<\/row>)[\s\S]*?<\/sheetData>/, `$1${filas}</sheetData>`);

    // 2) dimensión y autofiltro
    xml = xml.replace(/<dimension ref="[^"]*"\/>/, `<dimension ref="A1:L${ultima}"/>`)
             .replace(/<autoFilter ref="[^"]*"/, `<autoFilter ref="A1:L${ultima}"`);

    // 3) hipervínculos de la columna Enlace
    const rels = [], links = [];
    alertas.forEach((a, i) => {
      const url = limpio(a.enlace);
      if (!/^https?:\/\//i.test(url) || url.length > 2000) return;
      const id = 'rId' + (rels.length + 1);
      rels.push(`<Relationship Id="${id}" Type="${HYPERLINK}" Target="${xesc(url)}" TargetMode="External"/>`);
      links.push(`<hyperlink ref="L${i + 2}" r:id="${id}"/>`);
    });
    xml = xml.replace(/<hyperlinks>[\s\S]*?<\/hyperlinks>/, '');
    if (links.length) {
      xml = xml.replace(/<printOptions|<pageMargins/, m => `<hyperlinks>${links.join('')}</hyperlinks>${m}`);
      zip.file(SHEET_RELS, XML_DECL +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join('')}</Relationships>`);
    } else if (zip.file(SHEET_RELS)) {
      zip.remove(SHEET_RELS);
    }
    zip.file(SHEET, xml);

    // 4) filtro guardado del libro
    let wb = await zip.file('xl/workbook.xml').async('string');
    wb = wb.replace(/PAVS_BD!\$A\$1:\$L\$\d+/, `PAVS_BD!$A$1:$L$${ultima}`);
    zip.file('xl/workbook.xml', wb);

    // 5) propiedades del documento (trazabilidad)
    const core = zip.file('docProps/core.xml');
    if (core) {
      let c = await core.async('string');
      const ahora = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
      c = c.replace(/<dcterms:modified[^>]*>[^<]*<\/dcterms:modified>/,
        `<dcterms:modified xsi:type="dcterms:W3CDTF">${ahora}</dcterms:modified>`);
      if (o.generadoPor) {
        c = /<cp:lastModifiedBy>/.test(c)
          ? c.replace(/<cp:lastModifiedBy>[^<]*<\/cp:lastModifiedBy>/, `<cp:lastModifiedBy>${xesc(o.generadoPor)}</cp:lastModifiedBy>`)
          : c.replace('</cp:coreProperties>', `<cp:lastModifiedBy>${xesc(o.generadoPor)}</cp:lastModifiedBy></cp:coreProperties>`);
      }
      zip.file('docProps/core.xml', c);
    }

    const blob = await zip.generateAsync({
      type: 'blob', compression: 'DEFLATE',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    });
    await descargar(blob, o.nombreArchivo || `FT-95_Monitoreo_de_Alertas_de_PAVS_${hoyISO()}.xlsx`);
    return { alertas: alertas.length, hipervinculos: links.length };
  }

  global.FT95 = { exportarFT95 };
})(window);
