/*
 * generador.js — "Generar documento" del módulo CIMA (estilo Scribe).
 *
 * Pasos: 1) país  2) idioma  3) tipo (FT / inserto / etiqueta)  4) producto
 * (catálogo completo de CIMA o documento subido) → Generar. El contenido sale
 * del segmentador (cima/segmentador.js) y se ordena según cima/plantillas.js.
 * Cada sección es editable antes de exportar a Word o imprimir.
 *
 * Usa globals de cima/index.html: sb, escH, DOMPurify, cargarDeSupabase,
 * guardarEnSupabase, Segmentador, Plantillas.
 */
(function (global) {
  'use strict';

  const CIMA = 'https://cima.aemps.es/cima/rest';
  const DOCX_SRC = 'https://cdn.jsdelivr.net/npm/docx@8.5.0/build/index.umd.js';
  const P = () => global.Plantillas;

  const st = {
    pais: 'PE', idioma: 'es', tipo: 'FT', modo: 'cima',
    producto: null,        // { origen:'cima', nregistro, nombre, lab, detalle, docs } | { origen:'subida', nombre, archivo, res, docId }
    resultados: [], buscando: false, busquedaId: 0,
    doc: null,             // documento generado
  };
  const $g = id => document.getElementById(id);
  // escH es un const del script principal de index.html: se accede por nombre (no es propiedad de window).
  const esc = s => escH(s);

  // ════════════════════════════════════════════════════════════════════════
  // Configuración
  // ════════════════════════════════════════════════════════════════════════
  function renderConfig() {
    const { PAISES, IDIOMAS, TIPOS, PLANTILLAS } = P();
    const plantilla = (PLANTILLAS[st.pais] || {})[st.tipo];
    const tipoDef = TIPOS.find(t => t.codigo === st.tipo);
    const pr = st.producto;

    $g('genConfig').innerHTML = `
      <div class="gcard-h"><span class="gdot"></span>CONFIGURACIÓN DEL DOCUMENTO</div>
      <div class="gcard-b">
        <div class="ggrid">
          <div>
            <div class="glabel">1 · País de destino</div>
            ${PAISES.map(p => `
              <button type="button" class="gopt${st.pais === p.codigo ? ' sel' : ''}" data-pais="${p.codigo}" ${p.activo ? '' : 'disabled'}>
                <span class="gcode">${p.codigo}</span>
                <span><b>${esc(p.nombre)}</b><small>${esc(p.autoridad)}</small></span>
                ${p.activo ? '' : '<span class="gsoon">Próximamente</span>'}
              </button>`).join('')}
          </div>
          <div>
            <div class="glabel">2 · Idioma</div>
            ${IDIOMAS.map(i => `
              <button type="button" class="gopt${st.idioma === i.codigo ? ' sel' : ''}" data-idioma="${i.codigo}">
                ${st.idioma === i.codigo ? '▶ ' : ''}${esc(i.nombre)}
              </button>`).join('')}
            ${st.idioma === 'pt' ? `<p class="gnote">Títulos en portugués; el contenido queda en español (CIMA solo publica en español).</p>` : ''}

            <div class="glabel" style="margin-top:18px">3 · Tipo de documento</div>
            <div class="gtipos">
              ${TIPOS.map(t => {
                const pl = (PLANTILLAS[st.pais] || {})[t.codigo];
                return `<button type="button" class="gtipo${st.tipo === t.codigo ? ' sel' : ''}" data-tipo="${t.codigo}" ${pl ? '' : 'disabled'}>
                  ${t.icono} ${esc(t.nombre.es)}${pl && pl.borrador ? '<small>borrador</small>' : ''}</button>`;
              }).join('')}
            </div>
          </div>
        </div>

        <div class="ggrid" style="margin-top:22px">
          <div>
            <div class="glabel">4 · Producto</div>
            <div class="gmodo">
              <button type="button" class="${st.modo === 'cima' ? 'sel' : ''}" data-modo="cima">🔎 Buscar en CIMA</button>
              <button type="button" class="${st.modo === 'subida' ? 'sel' : ''}" data-modo="subida">⬆ Subir ficha técnica</button>
            </div>
            ${st.modo === 'cima' ? `
              <input type="search" id="genBuscar" class="ginput" placeholder="Nombre, principio activo o Nº de registro (mín. 3 caracteres)" autocomplete="off">
              <div id="genResultados" class="gresultados"></div>` : `
              <label class="gdrop" for="genArchivo">
                <b>Seleccionar archivo</b><span>PDF, Word (.docx) o HTML de una ficha técnica o prospecto</span>
              </label>
              <input type="file" id="genArchivo" accept=".pdf,.docx,.html,.htm" hidden>
              <div id="genSubidaEstado" class="gnote"></div>`}
          </div>
          <div>
            <div class="gresumen">
              <div class="glabel">Resumen</div>
              ${pr ? `
                <div class="gres-nombre">${esc(pr.nombre)}</div>
                ${pr.detalle ? `<div class="gres-det">${esc(pr.detalle)}</div>` : ''}
                <div class="gres-meta">${pr.origen === 'cima' ? `CIMA · Nº ${esc(pr.nregistro)}${pr.lab ? ' · ' + esc(pr.lab) : ''}` : `Documento subido · ${esc(pr.archivo.name)}`}</div>`
                : `<div class="gres-vacio">Seleccione un producto de CIMA o suba una ficha técnica.</div>`}
              <div class="gchips">
                <span class="gchip">${esc((P().PAISES.find(p => p.codigo === st.pais) || {}).nombre || st.pais)}</span>
                <span class="gchip">${st.idioma === 'es' ? 'Español' : 'Português'}</span>
                <span class="gchip">${esc(tipoDef.nombre.es)}</span>
                ${plantilla && plantilla.borrador ? '<span class="gchip warn">Estructura provisional</span>' : ''}
              </div>
            </div>
            <button type="button" id="genGenerar" class="ggenerar" ${pr && plantilla ? '' : 'disabled'}>▶ ${esc(tipoDef.accion.es.toUpperCase())}</button>
            <div id="genEstado" class="gnote"></div>
          </div>
        </div>
      </div>`;

    // Eventos
    $g('genConfig').querySelectorAll('[data-pais]').forEach(b => b.onclick = () => { st.pais = b.dataset.pais; renderConfig(); });
    $g('genConfig').querySelectorAll('[data-idioma]').forEach(b => b.onclick = () => {
      st.idioma = b.dataset.idioma; renderConfig();
      if (st.doc) { st.doc.idioma = st.idioma; renderDoc(); }      // solo cambian títulos: no hace falta regenerar
    });
    $g('genConfig').querySelectorAll('[data-tipo]').forEach(b => b.onclick = () => { st.tipo = b.dataset.tipo; renderConfig(); });
    $g('genConfig').querySelectorAll('[data-modo]').forEach(b => b.onclick = () => { st.modo = b.dataset.modo; renderConfig(); });
    $g('genGenerar').onclick = generar;

    if (st.modo === 'cima') {
      const inp = $g('genBuscar');
      let t = null;
      inp.oninput = () => { clearTimeout(t); t = setTimeout(() => buscar(inp.value.trim()), 400); };
      inp.onkeydown = e => { if (e.key === 'Enter') { clearTimeout(t); buscar(inp.value.trim()); } };
      renderResultados();
    } else {
      $g('genArchivo').onchange = () => { const f = $g('genArchivo').files[0]; if (f) subir(f); };
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  // Paso 4a: buscar en el catálogo completo de CIMA
  // ════════════════════════════════════════════════════════════════════════
  async function buscar(q) {
    const id = ++st.busquedaId;
    if (q.length < 3) { st.resultados = []; st.buscando = false; renderResultados(); return; }
    st.buscando = true; renderResultados();
    try {
      let lista;
      if (/^\d{4,}$/.test(q)) {
        const r = await fetch(`${CIMA}/medicamento?nregistro=${encodeURIComponent(q)}`);
        lista = r.ok ? [await r.json()].filter(m => m && m.nregistro) : [];
      } else {
        const r = await fetch(`${CIMA}/medicamentos?nombre=${encodeURIComponent(q)}&pagina=1`);
        if (!r.ok) throw new Error(`CIMA respondió HTTP ${r.status}`);
        lista = (await r.json()).resultados || [];
        // Si no hay coincidencias por nombre, se intenta por principio activo.
        if (!lista.length) {
          const r2 = await fetch(`${CIMA}/medicamentos?practiv1=${encodeURIComponent(q)}&pagina=1`);
          if (r2.ok) lista = (await r2.json()).resultados || [];
        }
      }
      if (id !== st.busquedaId) return;                       // llegó una búsqueda más nueva
      lista.sort((a, b) => (b.comerc === true) - (a.comerc === true) || a.nombre.localeCompare(b.nombre));
      st.resultados = lista.slice(0, 30);
      st.errorBusqueda = null;
    } catch (e) {
      if (id !== st.busquedaId) return;
      st.resultados = []; st.errorBusqueda = e.message;
    }
    st.buscando = false; renderResultados();
  }

  function renderResultados() {
    const box = $g('genResultados'); if (!box) return;
    if (st.buscando) { box.innerHTML = '<div class="gnote">⏳ Buscando en CIMA…</div>'; return; }
    if (st.errorBusqueda) { box.innerHTML = `<div class="gnote err">${esc(st.errorBusqueda)}</div>`; return; }
    if (!st.resultados.length) {
      box.innerHTML = $g('genBuscar') && $g('genBuscar').value.trim().length >= 3 ? '<div class="gnote">Sin resultados en CIMA.</div>' : '';
      return;
    }
    box.innerHTML = st.resultados.map((m, i) => {
      const docs = m.docs || [];
      const ft = docs.find(d => d.tipo === 1), p = docs.find(d => d.tipo === 2);
      const sel = st.producto && st.producto.origen === 'cima' && st.producto.nregistro === String(m.nregistro);
      return `<button type="button" class="gres${sel ? ' sel' : ''}" data-i="${i}">
        <b>${esc(m.nombre)}</b>
        <small>Nº ${esc(m.nregistro)} · ${esc(m.labtitular || '')}${m.comerc === false ? ' · no comercializado' : ''}</small>
        <span class="gdocs">${ft ? `<i class="${ft.secc ? 'ok' : ''}">FT</i>` : ''}${p ? `<i class="${p.secc ? 'ok' : ''}">Prosp</i>` : ''}</span>
      </button>`;
    }).join('');
    box.querySelectorAll('.gres').forEach(b => b.onclick = () => {
      const m = st.resultados[+b.dataset.i];
      const forma = m.formaFarmaceutica && m.formaFarmaceutica.nombre;
      st.producto = {
        origen: 'cima', nregistro: String(m.nregistro), nombre: m.nombre, lab: m.labtitular,
        detalle: [m.pactivos || m.dosis, forma].filter(Boolean).join(' · '), docs: m.docs || [],
      };
      renderConfig();
    });
  }

  // ════════════════════════════════════════════════════════════════════════
  // Paso 4b: subir un documento
  // ════════════════════════════════════════════════════════════════════════
  async function subir(archivo) {
    const est = $g('genSubidaEstado');
    est.textContent = '⏳ Leyendo y separando secciones…';
    try {
      const res = await global.Segmentador.segmentarArchivo(archivo, 'auto');
      st.producto = { origen: 'subida', nombre: res.meta.nombre, archivo, res,
                      detalle: `${res.tipo === 'FT' ? 'Ficha técnica' : 'Prospecto'} · ${res.campos.length} campos reconocidos` };
      renderConfig();
      $g('genSubidaEstado').textContent = `✓ ${archivo.name}: ${res.campos.length} campos reconocidos. Se guardará en Supabase al generar.`;
    } catch (e) {
      est.innerHTML = `<span class="err">${esc(e.message)}</span>`;
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  // Generar
  // ════════════════════════════════════════════════════════════════════════
  const estado = (msg, err) => { const e = $g('genEstado'); if (e) e.innerHTML = err ? `<span class="err">${msg}</span>` : msg; };

  /** Documento CIMA segmentado: usa el guardado en Supabase si ya existe esa versión; si no, segmenta y guarda. */
  async function segmentadoCIMA(meta, tipoDoc) {
    const version = global.Segmentador.fechaVersion(meta, tipoDoc);
    if (version) {
      try {
        const previo = await global.cargarDeSupabase({ origen: 'cima', tipo_documento: tipoDoc, nregistro: meta.nregistro, fecha_version_cima: version });
        if (previo) return previo.res;
      } catch (e) { console.warn('No se pudo leer Supabase:', e.message); }
    }
    const res = await global.Segmentador.segmentarCIMA(meta.nregistro, tipoDoc, meta);
    try { await global.guardarEnSupabase(res); } catch (e) { console.warn('No se guardó en Supabase:', e.message); }
    return res;
  }

  async function generar() {
    const plantilla = P().PLANTILLAS[st.pais][st.tipo];
    const pr = st.producto;
    const btn = $g('genGenerar');
    btn.disabled = true;
    try {
      let res;
      if (pr.origen === 'cima') {
        estado('⏳ Consultando CIMA…');
        const meta = await global.Segmentador.metaCIMA(pr.nregistro);
        const errores = [];
        for (const tipoDoc of plantilla.fuentePreferida) {
          if (!(tipoDoc === 'FT' ? meta.docFT : meta.docP)) continue;
          estado(`⏳ Separando ${tipoDoc === 'FT' ? 'la ficha técnica' : 'el prospecto'}…`);
          try { res = await segmentadoCIMA(meta, tipoDoc); break; }
          catch (e) { errores.push(e); if (e.codigo !== 'SIN_SEGMENTAR') throw e; }
        }
        if (!res) {
          const pdf = (meta.docFT || meta.docP || {}).url;
          throw new Error('CIMA no publica este medicamento dividido por secciones. '
            + (pdf ? `Descargue el <a href="${esc(pdf)}" target="_blank" rel="noopener">PDF</a> y use "Subir ficha técnica".` : 'Suba el documento con "Subir ficha técnica".'));
        }
      } else {
        res = pr.res;
        if (!pr.docId) {
          estado('⏳ Guardando en Supabase…');
          try { pr.docId = await global.guardarEnSupabase(res, pr.archivo); }
          catch (e) { console.warn('No se guardó en Supabase:', e.message); }
        }
      }
      st.doc = construir(plantilla, res, pr);
      estado('');
      renderDoc();
      $g('genDoc').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (e) {
      estado(e.message.includes('<a ') ? e.message : esc(e.message), true);
    } finally {
      btn.disabled = false;
    }
  }

  /** Arma las secciones de la plantilla con el contenido de los campos segmentados. */
  function construir(plantilla, res, pr) {
    const porCodigo = Object.fromEntries(res.campos.map(c => [c.codigo, c]));
    const secciones = [];
    plantilla.secciones.forEach(s => {
      let html = '';
      const origen = [];
      for (const fu of s.fuentes || []) {
        const c = porCodigo[fu.campo];
        if (!c || !c.texto) continue;
        origen.push(c.secciones_origen || fu.campo);
        const cuerpo = c.html || `<p>${esc(c.texto).replace(/\n/g, '<br>')}</p>`;
        html += (fu.rotulo ? `<p><strong>${esc(fu.rotulo.es)}</strong></p>` : '') + cuerpo;
      }
      if (s.opcional && !html) return;
      secciones.push({
        def: s, html: s.manual ? '' : html,
        estado: s.manual ? 'manual' : (html ? 'ok' : 'vacio'),
        origen: origen.join(', '), editado: false,
      });
    });
    secciones.forEach((s, i) => { s.num = plantilla.numerar === 'codigo' ? s.def.codigo : String(i + 1); });
    return {
      pais: st.pais, idioma: st.idioma, tipo: st.tipo, plantilla, secciones,
      producto: pr.nombre, detalle: pr.detalle || '',
      fuenteOrigen: res.origen, fuenteTipo: res.tipo, fuenteNreg: res.meta.nregistro,
      fuenteVersion: res.meta.fecha_version, fuenteArchivo: res.meta.archivo || '',
      generado: new Date(),
      get fuente() { return textoFuente(this, this.idioma); },
    };
  }
  function textoFuente(d, L) {
    const doc = d.fuenteTipo === 'FT' ? 'Ficha técnica' : (L === 'pt' ? 'Bula (prospecto)' : 'Prospecto');
    return d.fuenteOrigen === 'cima'
      ? `CIMA (AEMPS) · Nº ${d.fuenteNreg} · ${doc} ${L === 'pt' ? 'versão' : 'versión'} ${fmt(d.fuenteVersion)}`
      : `${L === 'pt' ? 'Documento enviado' : 'Documento subido'}: ${d.fuenteArchivo} (${doc.toLowerCase()})`;
  }
  const fmt = iso => iso ? new Date(iso).toLocaleDateString('es-PE', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '—';

  // ════════════════════════════════════════════════════════════════════════
  // Vista del documento generado
  // ════════════════════════════════════════════════════════════════════════
  function renderDoc() {
    const d = st.doc, box = $g('genDoc');
    if (!d) { box.hidden = true; return; }
    const T = P().TXT[d.idioma], L = d.idioma;
    const pais = P().PAISES.find(p => p.codigo === d.pais);
    const nCrit = d.secciones.filter(s => s.def.critica).length;
    const nPend = d.secciones.filter(s => s.estado !== 'ok' && !s.editado).length;
    const tipoDef = P().TIPOS.find(t => t.codigo === d.tipo);
    // En el Inserto hecho desde una FT (sin prospecto) el lenguaje es técnico: se avisa.
    const avisoFuente = d.tipo === 'INSERTO' && d.fuenteTipo === 'FT'
      ? '<div class="gaviso">El inserto se armó desde la ficha técnica (no hay prospecto disponible): revise el lenguaje para el paciente.</div>' : '';

    let grupoPrevio = null;
    box.hidden = false;
    box.innerHTML = `
      <div class="gdoc-h">
        <div>
          <div class="gdoc-norma"><span class="gcode">${pais.codigo}</span> ${esc(pais.nombre)} — ${esc(d.plantilla.norma[L])}</div>
          <div class="gdoc-titulo">${esc(d.producto)}</div>
          <div class="gdoc-sub">${esc(tipoDef.nombre[L])} · ${T.idioma} · ${d.secciones.length} ${T.secciones} · ${nCrit} ${T.criticas}${nPend ? ` · <b class="pend">${nPend} ${T.pendientes}</b>` : ''}</div>
          <div class="gdoc-fuente">${esc(T.fuente)}: ${esc(d.fuente)}</div>
        </div>
        <div class="gdoc-acc">
          <button type="button" class="gbtn prim" id="genWord">⬇ ${T.exportar}</button>
          <button type="button" class="gbtn" id="genPrint">🖨 ${T.imprimir}</button>
        </div>
      </div>
      ${d.plantilla.borrador ? `<div class="gaviso">⚠ ${esc(T.borrador)}</div>` : ''}
      ${L === 'pt' ? `<div class="gaviso info">${esc(T.aviso_pt)}</div>` : ''}
      ${avisoFuente}
      <div class="gdoc-tools">
        <button type="button" class="glink" id="genExp">${T.expandir}</button> ·
        <button type="button" class="glink" id="genCol">${T.contraer}</button>
        <span class="gnote">Puede editar el texto de cada sección antes de exportar.</span>
      </div>
      <div class="gsecs">
        ${d.secciones.map((s, i) => {
          const g = s.def.grupo && s.def.grupo !== grupoPrevio ? `<div class="ggrupo">${esc(s.def.grupo[L])}</div>` : '';
          if (s.def.grupo) grupoPrevio = s.def.grupo;
          const badge = s.def.critica ? `<span class="gbadge crit">${T.critica}</span>` : '';
          const pend = s.editado ? '' : s.estado === 'manual' ? `<span class="gbadge man">${T.completar}</span>`
                     : s.estado === 'vacio' ? `<span class="gbadge pend">${T.pendiente}</span>` : '';
          return `${g}<details class="gsec" data-i="${i}">
            <summary><span class="gnum">${esc(s.num)}</span><span class="gtit">${esc(s.def.titulo[L])}</span>
              ${pend}${badge}${s.origen ? `<span class="gorig">${esc(s.origen)}</span>` : ''}<span class="gchev">▼</span></summary>
            <div class="gsec-b">
              ${s.def.nota ? `<div class="gnota">💡 ${esc(s.def.nota[L])}</div>` : ''}
              <div class="gcont" contenteditable="true" spellcheck="true"
                   data-ph="${esc(s.estado === 'manual' ? s.def.manual[L] : T.sinContenido)}"></div>
            </div>
          </details>`;
        }).join('')}
      </div>`;

    // El HTML de cada sección (4.8 puede pasar de 200 KB) se inserta al abrirla.
    box.querySelectorAll('details.gsec').forEach(det => {
      det.addEventListener('toggle', () => { if (det.open) pintarSeccion(det); });
    });
    $g('genExp').onclick = () => box.querySelectorAll('details.gsec').forEach(x => { x.open = true; pintarSeccion(x); });
    $g('genCol').onclick = () => box.querySelectorAll('details.gsec').forEach(x => { x.open = false; });
    $g('genWord').onclick = exportarWord;
    $g('genPrint').onclick = imprimir;
  }

  function pintarSeccion(det) {
    const cont = det.querySelector('.gcont');
    if (cont.dataset.ok) return;
    const s = st.doc.secciones[+det.dataset.i];
    cont.innerHTML = limpiar(s.html);
    cont.dataset.ok = '1';
    cont.addEventListener('input', () => {
      s.html = cont.innerHTML; s.editado = true;
      const b = det.querySelector('.gbadge.pend, .gbadge.man'); if (b) b.remove();
    });
  }
  const limpiar = html => global.DOMPurify.sanitize(html || '', { FORBID_ATTR: ['style', 'class'], FORBID_TAGS: ['img', 'style'] });

  // ════════════════════════════════════════════════════════════════════════
  // Imprimir: documento completo (todas las secciones) en una vista limpia
  // ════════════════════════════════════════════════════════════════════════
  function htmlDocumento() {
    const d = st.doc, T = P().TXT[d.idioma], L = d.idioma;
    const pais = P().PAISES.find(p => p.codigo === d.pais);
    const tipoDef = P().TIPOS.find(t => t.codigo === d.tipo);
    let grupoPrevio = null;
    return `
      <div class="pnorma">${esc(pais.nombre)} — ${esc(d.plantilla.norma[L])}</div>
      <h1>${esc(d.producto)}</h1>
      <div class="psub">${esc(tipoDef.nombre[L])} · ${T.idioma} · ${esc(T.generado)}: ${d.generado.toLocaleDateString('es-PE')}</div>
      <div class="psub">${esc(T.fuente)}: ${esc(d.fuente)}</div>
      ${d.plantilla.borrador ? `<p class="paviso">${esc(T.borrador)}</p>` : ''}
      ${L === 'pt' ? `<p class="paviso">${esc(T.aviso_pt)}</p>` : ''}
      ${d.secciones.map(s => {
        const g = s.def.grupo && s.def.grupo !== grupoPrevio ? `<h2 class="pgrupo">${esc(s.def.grupo[L])}</h2>` : '';
        if (s.def.grupo) grupoPrevio = s.def.grupo;
        const cuerpo = s.html ? limpiar(s.html)
          : `<p class="pvacio">${esc(s.estado === 'manual' ? s.def.manual[L] : T.sinContenido)}</p>`;
        return `${g}<h3>${esc(s.num)}. ${esc(s.def.titulo[L])}${s.def.critica ? ` <span class="pcrit">${T.critica}</span>` : ''}</h3>${cuerpo}`;
      }).join('')}`;
  }

  function imprimir() {
    let root = $g('genPrintRoot');
    if (!root) { root = document.createElement('div'); root.id = 'genPrintRoot'; document.body.appendChild(root); }
    root.innerHTML = htmlDocumento();
    document.body.classList.add('gen-imprimiendo');
    const fin = () => { document.body.classList.remove('gen-imprimiendo'); global.removeEventListener('afterprint', fin); };
    global.addEventListener('afterprint', fin);
    global.print();
  }

  // ════════════════════════════════════════════════════════════════════════
  // Exportar a Word (.docx real, generado en el navegador)
  // ════════════════════════════════════════════════════════════════════════
  let docxCargado = null;
  const cargarDocx = () => docxCargado || (docxCargado = new Promise((ok, mal) => {
    const s = document.createElement('script'); s.src = DOCX_SRC;
    s.onload = ok; s.onerror = () => { docxCargado = null; mal(new Error('No se pudo cargar la librería de Word')); };
    document.head.appendChild(s);
  }));

  function runsDe(node, D, fmtIn) {
    const out = [];
    node.childNodes.forEach(n => {
      if (n.nodeType === 3) {
        const t = n.textContent.replace(/\s+/g, ' ');
        if (t.trim() || (t === ' ' && out.length)) out.push(new D.TextRun({ text: t, bold: fmtIn.b, italics: fmtIn.i, superScript: fmtIn.sup, subScript: fmtIn.sub }));
      } else if (n.nodeType === 1) {
        const tg = n.tagName;
        if (tg === 'BR') { out.push(new D.TextRun({ text: '', break: 1 })); return; }
        const f = { ...fmtIn };
        const sty = (n.getAttribute('style') || '').toLowerCase();
        if (/^(B|STRONG)$/.test(tg) || /font-weight:\s*(bold|[6-9]00)/.test(sty)) f.b = true;
        if (/^(I|EM)$/.test(tg) || /font-style:\s*italic/.test(sty)) f.i = true;
        if (tg === 'SUP' || /vertical-align:\s*super/.test(sty)) f.sup = true;
        if (tg === 'SUB' || /vertical-align:\s*sub/.test(sty)) f.sub = true;
        out.push(...runsDe(n, D, f));
      }
    });
    return out;
  }

  function htmlADocx(html, D) {
    // Se conserva 'style' aquí (superíndices de CIMA vienen como vertical-align:super).
    const cont = document.createElement('div');
    cont.innerHTML = global.DOMPurify.sanitize(html || '', { FORBID_TAGS: ['img', 'style'] });
    const out = [];
    const bloque = /^(P|H[1-6]|PRE|BLOCKQUOTE|DT|DD)$/;
    const tieneBloques = n => n.querySelector('p,li,table,div,ul,ol,h1,h2,h3,h4,h5,h6');
    (function walk(el) {
      for (const n of el.childNodes) {
        if (n.nodeType === 3) { if (n.textContent.trim()) out.push(new D.Paragraph({ children: [new D.TextRun(n.textContent.trim())] })); continue; }
        if (n.nodeType !== 1) continue;
        const tg = n.tagName;
        if (tg === 'TABLE') { const t = tablaDocx(n, D); if (t) out.push(t, new D.Paragraph({ children: [] })); continue; }
        if (tg === 'LI' && !tieneBloques(n)) { out.push(new D.Paragraph({ bullet: { level: 0 }, children: runsDe(n, D, {}) })); continue; }
        if ((bloque.test(tg) || !n.children.length) && !tieneBloques(n)) {
          const r = runsDe(n, D, /^H/.test(tg) ? { b: true } : {});
          if (r.length) out.push(new D.Paragraph({ children: r, spacing: { after: 80 } }));
          continue;
        }
        walk(n);
      }
    })(cont);
    return out;
  }

  function tablaDocx(t, D) {
    const filas = [...t.rows].filter(r => r.cells.length);
    if (!filas.length) return null;
    return new D.Table({
      width: { size: 100, type: D.WidthType.PERCENTAGE },
      rows: filas.map(r => new D.TableRow({
        children: [...r.cells].map(c => {
          const runs = runsDe(c, D, c.tagName === 'TH' ? { b: true } : {});
          return new D.TableCell({
            columnSpan: c.colSpan > 1 ? c.colSpan : undefined,
            children: [new D.Paragraph({ children: runs.length ? runs : [new D.TextRun('')] })],
          });
        }),
      })),
    });
  }

  async function exportarWord() {
    const btn = $g('genWord'); const txt = btn.textContent;
    btn.disabled = true; btn.textContent = '⏳ Generando…';
    try {
      await cargarDocx();
      const D = global.docx, d = st.doc, T = P().TXT[d.idioma], L = d.idioma;
      const pais = P().PAISES.find(p => p.codigo === d.pais);
      const tipoDef = P().TIPOS.find(t => t.codigo === d.tipo);
      const gris = t => new D.Paragraph({ children: [new D.TextRun({ text: t, color: '666666', size: 18 })] });
      const hijos = [
        gris(`${pais.nombre} — ${d.plantilla.norma[L]}`),
        new D.Paragraph({ heading: D.HeadingLevel.TITLE, children: [new D.TextRun({ text: d.producto, bold: true })] }),
        gris(`${tipoDef.nombre[L]} · ${T.idioma} · ${T.generado}: ${d.generado.toLocaleDateString('es-PE')}`),
        gris(`${T.fuente}: ${d.fuente}`),
      ];
      if (d.plantilla.borrador) hijos.push(new D.Paragraph({ children: [new D.TextRun({ text: T.borrador, italics: true, color: 'B45309' })] }));
      if (L === 'pt') hijos.push(new D.Paragraph({ children: [new D.TextRun({ text: T.aviso_pt, italics: true, color: '1D4ED8' })] }));

      let grupoPrevio = null;
      for (const s of d.secciones) {
        if (s.def.grupo && s.def.grupo !== grupoPrevio) {
          hijos.push(new D.Paragraph({ heading: D.HeadingLevel.HEADING_1, children: [new D.TextRun(s.def.grupo[L])] }));
          grupoPrevio = s.def.grupo;
        }
        const tit = [new D.TextRun(`${s.num}. ${s.def.titulo[L]}`)];
        if (s.def.critica) tit.push(new D.TextRun({ text: `  [${T.critica}]`, color: 'B42318', size: 16 }));
        hijos.push(new D.Paragraph({ heading: D.HeadingLevel.HEADING_2, children: tit }));
        const cuerpo = s.html ? htmlADocx(s.html, D) : [];
        if (cuerpo.length) hijos.push(...cuerpo);
        else hijos.push(new D.Paragraph({ children: [new D.TextRun({
          text: `[${s.estado === 'manual' ? s.def.manual[L] : T.sinContenido}]`, italics: true, color: 'B45309' })] }));
      }

      const documento = new D.Document({
        creator: 'ConkoSafe IA',
        title: d.producto,
        styles: { default: { document: { run: { font: 'Arial', size: 20 } } } },
        sections: [{ children: hijos }],
      });
      const blob = await D.Packer.toBlob(documento);
      const nombre = `${tipoDef.nombre[L]}_${pais.codigo}_${L.toUpperCase()}_${d.producto}`
        .normalize('NFD').replace(/[̀-ͯ]/g, '')          // "técnica" → "tecnica"
        .replace(/[^\w\-]+/g, '_').replace(/_+/g, '_').slice(0, 90) + '.docx';
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = nombre;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    } catch (e) {
      alert('No se pudo exportar a Word: ' + e.message);
    } finally {
      btn.disabled = false; btn.textContent = txt;
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  function init() {
    if (!$g('genConfig')) return;
    renderConfig();
  }

  /** Preselecciona un producto desde la tabla del monitor (botón ✍ de cada fila). */
  function usarProducto(fila) {
    st.modo = 'cima';
    st.producto = { origen: 'cima', nregistro: String(fila.nreg), nombre: fila.nombre, lab: fila.lab, detalle: '', docs: [] };
    renderConfig();
  }

  global.Generador = { init, usarProducto, _estado: st };
})(window);
