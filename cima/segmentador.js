/*
 * segmentador.js — Separa una Ficha Técnica (FT) o un Prospecto (P) en los
 * campos de la estructura "CONTENIDO DE LA FICHA TÉCNICA" (a … e.6).
 *
 * Dos entradas, mismas reglas de salida:
 *   1. CIMA (AEMPS): la API docSegmentado ya entrega el documento dividido en
 *      secciones numeradas (FT: 1…12, P: 0…6); aquí solo se asignan a campos.
 *   2. Documento subido (PDF / Word / HTML): se extraen bloques de texto y se
 *      detectan los títulos por reglas (numeración + palabras clave). Sin IA.
 *
 * El Prospecto se fuerza al mismo esquema de la FT: sus subtítulos ("No tome…",
 * "Embarazo y lactancia", "Si toma más … del que debe", "Composición de …")
 * se asignan al campo equivalente; lo que no tiene equivalente queda vacío.
 *
 * Todo corre en el navegador: la API REST de CIMA permite CORS (*).
 */
(function (global) {
  'use strict';

  const CIMA_REST = 'https://cima.aemps.es/cima/rest';

  // ── Esquema de campos (orden = orden de presentación) ────────────────────
  const CAMPOS = [
    { codigo: 'a',   titulo: 'Nombre del medicamento, cantidad de IFA(s) y forma farmacéutica' },
    { codigo: 'b',   titulo: 'Composición cualitativa-cuantitativa' },
    { codigo: 'c.1', titulo: 'Indicaciones terapéuticas' },
    { codigo: 'c.2', titulo: 'Dosis y vía de administración' },
    { codigo: 'c.3', titulo: 'Contraindicaciones' },
    { codigo: 'c.4', titulo: 'Advertencias y precauciones' },
    { codigo: 'c.5', titulo: 'Interacciones con otros medicamentos y otras formas de interacción' },
    { codigo: 'c.6', titulo: 'Administración durante el embarazo y lactancia' },
    { codigo: 'c.7', titulo: 'Efectos sobre la capacidad de conducir y usar maquinaria' },
    { codigo: 'c.8', titulo: 'Reacciones adversas' },
    { codigo: 'c.9', titulo: 'Sobredosis y tratamiento' },
    { codigo: 'd.1', titulo: 'Propiedades farmacodinámicas' },
    { codigo: 'd.2', titulo: 'Propiedades farmacocinéticas' },
    { codigo: 'd.3', titulo: 'Datos preclínicos de seguridad' },
    { codigo: 'e.1', titulo: 'Lista de excipientes' },
    { codigo: 'e.2', titulo: 'Incompatibilidades' },
    { codigo: 'e.3', titulo: 'Tiempo de vida útil' },
    { codigo: 'e.4', titulo: 'Precauciones especiales de conservación' },
    { codigo: 'e.5', titulo: 'Naturaleza y contenido del envase' },
    { codigo: 'e.6', titulo: 'Precauciones especiales para eliminar el medicamento no utilizado' },
    { codigo: 'f',   titulo: 'Fecha de revisión del texto' },
    { codigo: 'g.1', titulo: 'Radiofármacos: dosimetría interna de la radiación' },
    { codigo: 'g.2', titulo: 'Radiofármacos: instrucciones de preparación extemporánea' },
  ];
  // Fuera del esquema DIGEMID, pero presentes en FT/Prospecto europeos: se
  // guardan aparte para no perder información (no cuentan como campos vacíos).
  const CAMPOS_EXTRA = [
    { codigo: 'x.titular',            titulo: 'Titular / fabricante (fuera del esquema)' },
    { codigo: 'x.autorizacion',       titulo: 'Número de autorización (fuera del esquema)' },
    { codigo: 'x.fecha_autorizacion', titulo: 'Fecha de primera autorización / renovación (fuera del esquema)' },
    { codigo: 'x.otros',              titulo: 'Otro contenido no asignado' },
  ];
  const TITULO = Object.fromEntries([...CAMPOS, ...CAMPOS_EXTRA].map(c => [c.codigo, c.titulo]));
  const ORDEN  = Object.fromEntries([...CAMPOS, ...CAMPOS_EXTRA].map((c, i) => [c.codigo, i]));
  // Orden en que aparecen dentro de una FT (secciones 7–9 van antes de la 10 = f).
  const ORDEN_DOC = Object.fromEntries(
    ['a', 'b', 'c.1', 'c.2', 'c.3', 'c.4', 'c.5', 'c.6', 'c.7', 'c.8', 'c.9', 'd.1', 'd.2', 'd.3',
     'e.1', 'e.2', 'e.3', 'e.4', 'e.5', 'e.6', 'x.titular', 'x.autorizacion', 'x.fecha_autorizacion',
     'f', 'g.1', 'g.2'].map((c, i) => [c, i]).concat([['x.otros', -1]]));

  // Radiofármacos: g.1/g.2 solo aplican a ellos, así que no se reportan como faltantes.
  const OPCIONALES = new Set(['g.1', 'g.2']);

  // ── FT: sección numerada CIMA/UE → campo ─────────────────────────────────
  function campoDesdeSeccionFT(sec) {
    sec = String(sec).replace(/\.$/, '');
    if (sec === '1' || sec === '3') return 'a';
    if (sec === '2') return 'b';
    if (sec === '4' || sec === '5' || sec === '6') return null;      // encabezados contenedores
    const m = sec.match(/^([456])\.(\d{1,2})$/);
    if (m) {
      const cod = `${{ 4: 'c', 5: 'd', 6: 'e' }[m[1]]}.${+m[2]}`;
      return TITULO[cod] ? cod : 'x.otros';
    }
    return { 7: 'x.titular', 8: 'x.autorizacion', 9: 'x.fecha_autorizacion',
             10: 'f', 11: 'g.1', 12: 'g.2' }[sec] || 'x.otros';
  }

  // ── FT subida: título de sección → campo (el orden importa) ──────────────
  // Destino '=' : subtítulo reconocido que NO cambia de campo (queda en el actual).
  const TITULOS_FT = [
    [/^(datos cl[ií]nicos|informaci[oó]n cl[ií]nica|propiedades farmacol[oó]gicas|datos farmac[eé]uticos)$/i, null],
    [/^excipientes? con (efecto|acci[oó]n) conocid/i, '='],        // subtítulo de la sección 2, no la 6.1
    [/^(nombre del (medicamento|producto)|denominaci[oó]n)/i, 'a'],
    [/^forma(s)? farmac[eé]utica/i, 'a'],
    [/^composici[oó]n/i, 'b'],
    [/^indicaci[oó]n(es)?( terap[eé]uticas?)?\b/i, 'c.1'],
    [/^(posolog[ií]a|dosis y v[ií]a|dosificaci[oó]n|v[ií]a de administraci[oó]n|forma de administraci[oó]n)/i, 'c.2'],
    [/^contraindicaci[oó]n/i, 'c.3'],
    [/^precauciones especiales (de|para) (la )?conservaci[oó]n/i, 'e.4'],
    [/^precauciones especiales (de|para) (eliminar|la eliminaci[oó]n|eliminaci[oó]n)/i, 'e.6'],
    [/^(advertencias|precauciones)/i, 'c.4'],
    [/^interacci[oó]n/i, 'c.5'],
    [/^(fertilidad|embarazo|lactancia|administraci[oó]n durante el embarazo)/i, 'c.6'],
    [/^(efectos sobre la )?capacidad (para|de) conducir|^conducci[oó]n/i, 'c.7'],
    [/^(reacciones adversas|efectos (adversos|indeseables|secundarios))/i, 'c.8'],
    [/^sobredosi/i, 'c.9'],
    [/^(propiedades )?farmacodin[aá]mic/i, 'd.1'],
    [/^(propiedades )?farmacocin[eé]tic/i, 'd.2'],
    [/^(datos )?precl[ií]nicos|^toxicolog/i, 'd.3'],
    [/^(lista de )?excipientes/i, 'e.1'],
    [/^incompatibilidad/i, 'e.2'],
    [/^(per[ií]odo|tiempo) de (validez|vida [uú]til)|^vida [uú]til/i, 'e.3'],
    [/^(conservaci[oó]n|almacenamiento|condiciones de (conservaci|almacenamiento))/i, 'e.4'],
    [/^(naturaleza y contenido|contenido del envase|presentaci[oó]n|envase)/i, 'e.5'],
    [/^(eliminaci[oó]n|instrucciones de uso y manipulaci|manipulaci[oó]n)/i, 'e.6'],
    [/^fecha de (la )?(revisi[oó]n|[uú]ltima revisi[oó]n)/i, 'f'],
    [/^dosimetr/i, 'g.1'],
    [/^(instrucciones para la preparaci[oó]n de radiof|preparaci[oó]n extempor)/i, 'g.2'],
    [/^(titular (de la autorizaci|del registro)|fabricante|laboratorio (titular|fabricante))/i, 'x.titular'],
    [/^(n[uú]mero(\(s\)|s)? de (la )?(autorizaci|registro)|registro sanitario)/i, 'x.autorizacion'],
    [/^fecha de (la )?(primera autorizaci|renovaci)/i, 'x.fecha_autorizacion'],
  ];

  // ── Prospecto: campo por defecto de cada sección y reglas de subtítulo ───
  // `reglas`   se evalúan sobre subtítulos (bloques cortos en negrita / títulos).
  // `parrafos` se evalúan sobre cualquier bloque; `cambia:true` mueve el campo
  //            actual, `false` solo reasigna ese bloque.
  const REGLAS_P = {
    '0': { def: 'x.otros', reglas: [] },
    '1': { def: 'c.1', reglas: [] },
    '2': {
      def: 'c.4',
      reglas: [
        [/^no (use|tome|utilice|debe (usar|tomar|utilizar|recibir|administrarse)|se (le )?(debe )?(administr|aplic|inyect)|le (deben )?administr|aplique|reciba|inyecte)/i, 'c.3'],
        [/^(fertilidad|embarazo|lactancia)/i, 'c.6'],
        [/^conducci[oó]n|conducir|m[aá]quinas:?$/i, 'c.7'],
        [/^(otros medicamentos|interacci)|con otros medicamentos|con (los )?alimentos|con bebidas|con alcohol/i, 'c.5'],
        [/^.{1,90}\bcontiene\b/i, 'c.4'],
        [/^(advertencias|precauciones|tenga especial cuidado|consulte (a su|con su) (m[eé]dico|farmac)|ni[ñn]os|adolescentes|uso en |pacientes de edad|personas de edad|ancianos|poblaci[oó]n pedi|deportistas|dependencia|s[ií]ndrome de abstinencia|s[ií]ntomas de abstinencia|uso a largo plazo|pruebas|an[aá]lisis|durante el tratamiento|antes de (iniciar|empezar))/i, 'c.4'],
      ],
    },
    '3': {
      def: 'c.2',
      reglas: [
        [/^si (usa|toma|utiliza|recibe|se (le )?(ha )?administra|se inyecta|aplica|ingiere).{0,90}\bm[aá]s\b/i, 'c.9'],
        [/sobredosis/i, 'c.9'],
        [/^(si olvid|si interrumpe|si deja de|uso en |posolog|dosis|dosificaci|v[ií]a |forma de administ|instrucciones|c[oó]mo )/i, 'c.2'],
      ],
    },
    '4': { def: 'c.8', reglas: [] },
    '5': {
      def: 'e.4',
      reglas: [
        [/elimin|desech|tirar/i, 'e.6'],
        [/caducidad|cu[aá]nto tiempo/i, 'e.3'],
        [/conserv|guard|temperatura/i, 'e.4'],
      ],
      parrafos: [
        [/desag[uü]es|punto sigre|deshacerse de los envases|c[oó]mo deshacerse/i, 'e.6', false],
        [/fecha de caducidad|despu[eé]s de la fecha|\bCAD\b/i, 'e.3', false],
      ],
    },
    '6': {
      def: 'b',
      reglas: [
        [/^composici[oó]n/i, 'b'],
        [/^(aspecto|presentaci)|contenido del envase/i, 'e.5'],
        [/^fecha de (la )?[uú]ltima revisi/i, 'f'],
        [/^(titular|responsable de la fabricaci|fabricante|representante local|estado miembro|nombre del estado|este medicamento est[aá] autorizado|puede (solicitar|obtener|consultar) m[aá]s informaci|la informaci[oó]n detallada)/i, 'x.titular'],
        [/profesionales (del sector sanitario|sanitarios)/i, 'x.otros'],
        [/^incompatib/i, 'e.2'],
        [/^(precauciones especiales de )?conservaci/i, 'e.4'],
        [/eliminaci|manipulaci/i, 'e.6'],
      ],
      parrafos: [
        [/^(los dem[aá]s componentes|los otros componentes|los excipientes|(el|los) (otro|dem[aá]s) (componente|ingrediente)s?)/i, 'e.1', true],
        [/^fecha de (la )?[uú]ltima revisi/i, 'f', false],
      ],
    },
  };

  // Secciones de nivel superior de un prospecto subido (formato UE).
  const P_TOP = [
    [/^1\.?\s*qu[eé] es\b/i, '1'],
    [/^2\.?\s*qu[eé] (necesita|debe) saber/i, '2'],
    [/^3\.?\s*c[oó]mo\b/i, '3'],
    [/^4\.?\s*posibles efectos adversos/i, '4'],
    [/^5\.?\s*(conservaci|c[oó]mo conservar)/i, '5'],
    [/^6\.?\s*(contenido del envase|informaci[oó]n adicional)/i, '6'],
  ];

  // ══════════════════════════════════════════════════════════════════════════
  // Utilidades de texto / HTML
  // ══════════════════════════════════════════════════════════════════════════
  const norm = s => (s || '').replace(/[   ]/g, ' ').replace(/\s+/g, ' ').trim();
  const escHTML = s => (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const quitarNumeracion = t => t.replace(/^\s*(\d{1,2}(\.\d{1,2})*\.?|[a-g](\.\d{1,2})?[.)]|[IVX]{1,4}\.)\s*/i, '');
  const numeracion = t => { const m = t.match(/^\s*(\d{1,2}(?:\.\d{1,2})*)\.?\s/); return m ? m[1] : null; };

  const ES_NEGRITA = 'strong,b,[style*="font-weight:bold"],[style*="font-weight: bold"],[style*="font-weight:700"],[style*="font-weight: 700"]';

  function esTodoNegrita(el) {
    const total = norm(el.textContent);
    if (!total) return false;
    if (el.matches(ES_NEGRITA)) return true;
    let neg = '';
    el.querySelectorAll(ES_NEGRITA).forEach(b => {
      if (!b.parentElement.closest(ES_NEGRITA)) neg += ' ' + b.textContent;   // solo las negritas más externas
    });
    return norm(neg).length >= total.length * 0.95;
  }

  function textoDeTabla(tabla) {
    return [...tabla.rows].map(r => [...r.cells].map(c => norm(c.textContent)).join(' | ')).join('\n');
  }

  /** Recorre HTML y devuelve bloques planos: {tipo:'h'|'p'|'table', texto, html, negrita}. */
  function bloquesDesdeHTML(html) {
    const doc = new DOMParser().parseFromString(`<div id="__raiz">${html || ''}</div>`, 'text/html');
    const out = [];
    const HOJA = /^(P|H[1-6]|LI|PRE|BLOCKQUOTE|DT|DD)$/;
    const CONTIENE_BLOQUE = 'p,h1,h2,h3,h4,h5,h6,li,table,div,ul,ol';
    (function recorrer(el) {
      for (const n of el.children) {
        if (n.tagName === 'TABLE') {
          const texto = textoDeTabla(n);
          if (texto.trim()) out.push({ tipo: 'table', texto, html: n.outerHTML, negrita: false });
          continue;
        }
        if (/^(SCRIPT|STYLE)$/.test(n.tagName)) continue;
        if (HOJA.test(n.tagName) && !n.querySelector(CONTIENE_BLOQUE)) {
          const texto = norm(n.textContent);
          if (!texto) continue;
          const esH = /^H[1-6]$/.test(n.tagName);
          out.push({ tipo: esH ? 'h' : 'p', texto, html: n.outerHTML, negrita: esH || esTodoNegrita(n) });
          continue;
        }
        if (n.children.length) recorrer(n);
        else if (norm(n.textContent)) {
          const texto = norm(n.textContent);
          out.push({ tipo: 'p', texto, html: `<p>${escHTML(texto)}</p>`, negrita: esTodoNegrita(n) });
        }
      }
    })(doc.getElementById('__raiz'));
    return out;
  }

  /** ¿El bloque puede ser un subtítulo? En PDF (sin negrita) se exige línea corta sin punto final. */
  function esCandidatoTitulo(b, modo) {
    const t = b.texto;
    if (!t || t.length > 130 || b.tipo === 'table') return false;
    // PDF: una línea que empieza en minúscula es continuación de un párrafo, no un título.
    if (modo === 'lineas') return t.length <= 110 && !/[.;,]$/.test(t) && /^[\dA-ZÁÉÍÓÚÑ¿¡]/.test(t);
    return b.negrita || b.tipo === 'h';
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Acumulador de resultado
  // ══════════════════════════════════════════════════════════════════════════
  function nuevoResultado(tipo, origen, meta) {
    return { tipo, origen, meta: meta || {}, _campos: new Map(), avisos: [] };
  }

  function agregar(res, campo, bloque, seccionOrigen) {
    if (!campo) return;
    if (!res._campos.has(campo)) res._campos.set(campo, { codigo: campo, titulo: TITULO[campo] || campo, secciones: new Set(), partes: [] });
    const c = res._campos.get(campo);
    if (seccionOrigen) c.secciones.add(String(seccionOrigen));
    c.partes.push({ texto: bloque.texto, html: bloque.html });
  }

  /** Convierte el acumulador en la salida final ordenada por el esquema. */
  function cerrar(res) {
    const campos = [...res._campos.values()]
      .map(c => ({
        codigo: c.codigo,
        titulo: c.titulo,
        secciones_origen: [...c.secciones].join(', '),
        texto: c.partes.map(p => p.texto).join('\n').trim(),
        html: c.partes.map(p => p.html).join('\n'),
      }))
      .filter(c => c.texto)
      .sort((x, y) => (ORDEN[x.codigo] ?? 999) - (ORDEN[y.codigo] ?? 999));
    const presentes = new Set(campos.map(c => c.codigo));
    const vacios = CAMPOS.map(c => c.codigo).filter(c => !presentes.has(c) && !OPCIONALES.has(c));
    return { tipo: res.tipo, origen: res.origen, meta: res.meta, campos, campos_vacios: vacios, avisos: res.avisos };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Prospecto: asignación de bloques de una sección a campos
  // ══════════════════════════════════════════════════════════════════════════
  function segmentarSeccionP(res, sec, bloques, modo) {
    const regla = REGLAS_P[sec] || { def: 'x.otros', reglas: [] };
    let actual = regla.def;
    for (const b of bloques) {
      let destino = null;
      if (esCandidatoTitulo(b, modo)) {
        const t = quitarNumeracion(b.texto);
        for (const [re, campo] of regla.reglas) if (re.test(t)) { destino = campo; break; }
        if (destino) actual = destino;
      }
      let campoBloque = actual;
      if (!destino && regla.parrafos) {
        for (const [re, campo, cambia] of regla.parrafos) {
          if (re.test(b.texto)) { campoBloque = campo; if (cambia) actual = campo; break; }
        }
      }
      agregar(res, campoBloque, b, `P${sec}`);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // CIMA
  // ══════════════════════════════════════════════════════════════════════════
  async function getJSON(url) {
    const r = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error(`CIMA respondió HTTP ${r.status}`);
    return r.json();
  }

  /** Metadatos del medicamento (nombre, laboratorio, IFA, fecha de versión de cada documento). */
  async function metaCIMA(nregistro) {
    const m = await getJSON(`${CIMA_REST}/medicamento?nregistro=${encodeURIComponent(nregistro)}`);
    const doc = t => (m.docs || []).find(d => d.tipo === t) || null;
    return {
      nregistro: String(nregistro),
      nombre: m.nombre || '',
      laboratorio: m.labtitular || '',
      pactivos: m.pactivos || '',
      dosis: m.dosis || '',
      forma: (m.formaFarmaceutica && m.formaFarmaceutica.nombre) || '',
      docFT: doc(1),
      docP: doc(2),
    };
  }

  /**
   * Segmenta la FT (tipo 'FT') o el Prospecto (tipo 'P') de un medicamento CIMA.
   * Lanza Error con `.codigo = 'SIN_SEGMENTAR'` si CIMA no tiene la versión por secciones.
   */
  async function segmentarCIMA(nregistro, tipo, metaPrevia) {
    const meta = metaPrevia || await metaCIMA(nregistro);
    const doc = tipo === 'FT' ? meta.docFT : meta.docP;
    const tipodoc = tipo === 'FT' ? 1 : 2;
    const secciones = await getJSON(`${CIMA_REST}/docSegmentado/contenido/${tipodoc}?nregistro=${encodeURIComponent(nregistro)}`);
    if (!Array.isArray(secciones) || !secciones.length) {
      const e = new Error((secciones && secciones.error) || 'CIMA no tiene este documento dividido por secciones.');
      e.codigo = 'SIN_SEGMENTAR';
      e.url_pdf = doc && doc.url;
      throw e;
    }

    const res = nuevoResultado(tipo, 'cima', {
      nregistro: meta.nregistro,
      nombre: meta.nombre,
      laboratorio: meta.laboratorio,
      url: doc ? (doc.urlHtml || doc.url) : null,
      fecha_version: doc && doc.fecha ? new Date(doc.fecha).toISOString() : null,
    });

    if (tipo === 'FT') {
      for (const s of secciones) {
        const campo = campoDesdeSeccionFT(s.seccion);
        const bloques = bloquesDesdeHTML(s.contenido);
        if (!campo || !bloques.length) continue;
        const texto = bloques.map(b => b.texto).join('\n');
        agregar(res, campo, { texto, html: s.contenido }, s.seccion);
      }
    } else {
      // Prospecto: el nombre (campo a) sale de los metadatos, no del texto.
      const a = [meta.nombre, meta.pactivos && `IFA: ${meta.pactivos}${meta.dosis ? ' ' + meta.dosis : ''}`, meta.forma && `Forma farmacéutica: ${meta.forma}`]
        .filter(Boolean).join('\n');
      if (a) agregar(res, 'a', { texto: a, html: a.split('\n').map(l => `<p>${escHTML(l)}</p>`).join('') }, 'CIMA');
      for (const s of secciones) segmentarSeccionP(res, String(s.seccion), bloquesDesdeHTML(s.contenido), 'html');
      res.avisos.push('Prospecto asignado al esquema de FT por reglas de subtítulo; revise c.3–c.7 y e.1–e.6.');
    }
    return cerrar(res);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Documentos subidos
  // ══════════════════════════════════════════════════════════════════════════
  const cargados = {};
  function cargarScript(src) {
    if (!cargados[src]) cargados[src] = new Promise((ok, mal) => {
      const s = document.createElement('script');
      s.src = src; s.onload = ok; s.onerror = () => mal(new Error('No se pudo cargar ' + src));
      document.head.appendChild(s);
    });
    return cargados[src];
  }

  const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/';
  const MAMMOTH = 'https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.8.0/mammoth.browser.min.js';

  /** PDF → una línea por bloque (pdf.js no expone negrita de forma fiable). */
  async function bloquesDesdePDF(buffer) {
    await cargarScript(PDFJS + 'pdf.min.js');
    const pdfjsLib = global.pdfjsLib;
    pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS + 'pdf.worker.min.js';
    const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
    const out = [];
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const tc = await page.getTextContent();
      const lineas = [];
      for (const it of tc.items) {
        if (!it.str || !it.str.trim()) continue;
        const y = it.transform[5], x = it.transform[4];
        let l = lineas.find(l => Math.abs(l.y - y) < 2.5);
        if (!l) lineas.push(l = { y, partes: [] });
        l.partes.push({ x, w: it.width || 0, h: Math.abs(it.transform[0]) || 10, s: it.str });
      }
      lineas.sort((a, b) => b.y - a.y);
      for (const l of lineas) {
        // pdf.js parte palabras en varios fragmentos ("MEDICA" + "MENTO"): solo se
        // inserta espacio si hay hueco visible entre el fin de uno y el inicio del otro.
        let texto = '', fin = null;
        for (const q of l.partes.sort((a, b) => a.x - b.x)) {
          const hueco = fin === null ? 0 : q.x - fin;
          texto += (fin !== null && hueco > q.h * 0.15 && !/\s$/.test(texto) && !/^\s/.test(q.s) ? ' ' : '') + q.s;
          fin = q.x + q.w;
        }
        texto = norm(texto);
        if (!texto || /^\d{1,3}$/.test(texto) || /^p[aá]gina \d+( de \d+)?$/i.test(texto)) continue;   // números de página
        out.push({ tipo: 'p', texto, html: `<p>${escHTML(texto)}</p>`, negrita: false });
      }
    }
    return out;
  }

  /** Detecta si el texto parece FT o Prospecto (se puede forzar desde la UI). */
  function detectarTipo(bloques) {
    const t = bloques.slice(0, 400).map(b => b.texto).join('\n').toLowerCase();
    let ft = 0, p = 0;
    [/ficha t[eé]cnica/, /\b4\.8\b/, /propiedades farmacocin/, /datos precl[ií]nicos/, /\b5\.1\b/, /profesional/].forEach(r => { if (r.test(t)) ft++; });
    [/prospecto/, /informaci[oó]n para el (paciente|usuario)/, /qu[eé] necesita saber/, /posibles efectos adversos/, /consulte a su m[eé]dico/, /no tome|no use/].forEach(r => { if (r.test(t)) p++; });
    return p > ft ? 'P' : 'FT';
  }

  function segmentarBloquesFT(res, bloques, modo) {
    let actual = 'x.otros';
    let vistos = 0;
    for (const b of bloques) {
      if (esCandidatoTitulo(b, modo)) {
        const t = quitarNumeracion(b.texto);
        const num = numeracion(b.texto);
        let hit;
        for (const [re, campo] of TITULOS_FT) if (re.test(t)) { hit = { campo }; break; }
        // Numeración 4.x/5.x/6.x con título no estándar: se usa el número.
        if (!hit && num && /^[456]\.\d{1,2}$/.test(num)) hit = { campo: campoDesdeSeccionFT(num) };
        if (hit && hit.campo && hit.campo !== '=' && !num) {
          // Sin numeración, un título solo avanza en el orden de la FT: "Precauciones de
          // preparación" dentro de 6.6 o "Excipientes" dentro de 4.4 son subtítulos internos.
          // Excepción: "FORMA FARMACÉUTICA" (sección 3 → campo a) viene después de la composición (b).
          const retrocede = (ORDEN_DOC[hit.campo] ?? 999) < (ORDEN_DOC[actual] ?? -1) && !(hit.campo === 'a' && actual === 'b');
          const excipienteSuelto = hit.campo === 'e.1' && /^excipientes:?$/i.test(t) && t !== t.toUpperCase();
          if (retrocede || excipienteSuelto) hit = { campo: '=' };
        }
        if (hit) {
          if (!hit.campo) continue;                                   // "DATOS CLÍNICOS", etc.: solo agrupan
          if (hit.campo === '=') { agregar(res, actual, b, null); continue; }
          vistos++;
          actual = hit.campo;
          agregar(res, actual, b, numeracion(b.texto) || 'título');   // el título queda como primera línea del campo
          continue;
        }
      }
      agregar(res, actual, b, null);
    }
    if (vistos < 4) res.avisos.push(`Solo se reconocieron ${vistos} títulos de sección: revise que el documento sea una ficha técnica con títulos legibles.`);
  }

  function segmentarBloquesP(res, bloques, modo) {
    // Un prospecto UE suele abrir con un índice ("Contenido del prospecto: 1. Qué es…")
    // que repite los títulos: se toma la ÚLTIMA aparición de "1." y desde ahí en orden.
    const hits = bloques.map(b => { for (const [re, s] of P_TOP) if (re.test(b.texto) && b.texto.length < 160) return s; return null; });
    const inicio = hits.lastIndexOf('1');
    const cortes = [];
    if (inicio >= 0) {
      cortes.push([inicio, '1']);
      let esperado = 2;
      for (let i = inicio + 1; i < hits.length && esperado <= 6; i++) {
        if (hits[i] && +hits[i] >= esperado) { cortes.push([i, hits[i]]); esperado = +hits[i] + 1; }
      }
    }
    if (cortes.length < 3) {
      // No sigue el formato UE (frecuente en insertos peruanos): se tratan sus títulos como los de una FT.
      res.avisos.push('No se encontraron las 6 secciones del prospecto UE; se usaron los títulos tipo ficha técnica.');
      segmentarBloquesFT(res, bloques, modo);
      return;
    }
    segmentarSeccionP(res, '0', bloques.slice(0, cortes[0][0]), modo);
    cortes.forEach(([i, sec], k) => {
      const fin = k + 1 < cortes.length ? cortes[k + 1][0] : bloques.length;
      segmentarSeccionP(res, sec, bloques.slice(i + 1, fin), modo);
    });
    if (cortes.length < 6) res.avisos.push(`Se encontraron ${cortes.length} de las 6 secciones del prospecto.`);
  }

  /**
   * Segmenta un archivo subido (PDF, DOCX, HTML).
   * @param {File} archivo
   * @param {'FT'|'P'|'auto'} tipo
   */
  async function segmentarArchivo(archivo, tipo = 'auto') {
    const nombre = archivo.name || 'documento';
    const ext = (nombre.split('.').pop() || '').toLowerCase();
    let bloques, modo;
    if (ext === 'pdf') {
      bloques = await bloquesDesdePDF(await archivo.arrayBuffer());
      modo = 'lineas';
    } else if (ext === 'docx') {
      await cargarScript(MAMMOTH);
      const r = await global.mammoth.convertToHtml({ arrayBuffer: await archivo.arrayBuffer() });
      bloques = bloquesDesdeHTML(r.value);
      modo = 'html';
    } else if (ext === 'html' || ext === 'htm') {
      bloques = bloquesDesdeHTML(await archivo.text());
      modo = 'html';
    } else if (ext === 'doc') {
      throw new Error('El formato .doc (Word 97-2003) no se puede leer en el navegador. Guárdelo como .docx o PDF y vuelva a subirlo.');
    } else {
      throw new Error(`Formato no soportado: .${ext}. Use PDF, DOCX o HTML.`);
    }
    if (!bloques.length) throw new Error('No se encontró texto en el documento (¿PDF escaneado como imagen?).');

    const tipoFinal = tipo === 'auto' ? detectarTipo(bloques) : tipo;
    const res = nuevoResultado(tipoFinal, 'subida', { nombre: nombre.replace(/\.[^.]+$/, ''), archivo: nombre });
    if (tipo === 'auto') res.avisos.push(`Tipo detectado automáticamente: ${tipoFinal === 'FT' ? 'Ficha técnica' : 'Prospecto'}.`);
    if (modo === 'lineas') res.avisos.push('PDF: los títulos se detectan por texto (sin negritas); revise los límites entre campos.');
    if (tipoFinal === 'FT') segmentarBloquesFT(res, bloques, modo);
    else segmentarBloquesP(res, bloques, modo);
    return cerrar(res);
  }

  /** Fecha (ISO) de la versión vigente del documento en CIMA, para no re-segmentar lo ya guardado. */
  function fechaVersion(meta, tipo) {
    const doc = tipo === 'FT' ? meta.docFT : meta.docP;
    return doc && doc.fecha ? new Date(doc.fecha).toISOString() : null;
  }

  global.Segmentador = {
    CAMPOS, CAMPOS_EXTRA, TITULO, fechaVersion,
    segmentarCIMA, segmentarArchivo, metaCIMA,
    // expuestos para pruebas
    _bloquesDesdeHTML: bloquesDesdeHTML, _campoDesdeSeccionFT: campoDesdeSeccionFT,
  };
})(window);
