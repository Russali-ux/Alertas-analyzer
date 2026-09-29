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
    registro: null,        // paso 5: { id, nro, producto, titular, vencimiento } del portafolio
    rsSugerencia: '',      // término para sugerir registros sanitarios según el producto elegido
    doc: null,             // documento generado
  };
  const $g = id => document.getElementById(id);
  // escH es un const del script principal de index.html: se accede por nombre (no es propiedad de window).
  const esc = s => escH(s);
  // Paso 5 solo para admin o usuarios con acceso a Titulares (yo es un let de index.html).
  const puedeRS = () => typeof yo !== 'undefined' && !!yo && !!yo.titulares;

  // ════════════════════════════════════════════════════════════════════════
  // Paso 5: selector de registro sanitario (portafolio de medicamentos)
  // ════════════════════════════════════════════════════════════════════════
  function badgeVencimiento(fecha) {
    if (!fecha) return '';
    const f = new Date(fecha + 'T00:00:00'), hoy = new Date();
    const dias = Math.floor((f - hoy) / 86400000);
    const txt = f.toLocaleDateString('es-PE', { day: '2-digit', month: '2-digit', year: 'numeric' });
    if (dias < 0) return `<span class="gvto venc" title="Registro sanitario vencido">VENCIDO ${txt}</span>`;
    if (dias <= 180) return `<span class="gvto prox" title="Vence en ${dias} días">vence ${txt}</span>`;
    return `<span class="gvto ok">vence ${txt}</span>`;
  }

  // La ★ (titular principal) es solo visual en la búsqueda; el snapshot guardado no la lleva.
  const rsDesdeFila = r => ({ id: r.id, nro: r.nro_registro_sanitario, producto: r.producto, titular: (r.titulares || '').replace(/ ★/g, ''),
                              vencimiento: r.vencimiento, principio: r.principio_activo });

  /** Monta buscador + resultados en `caja`. onSelect(registro) al elegir. */
  function montarSelectorRS(caja, { valorInicial = '', onSelect }) {
    caja.innerHTML = `
      <input type="search" class="ginput grs-q" placeholder="Producto, principio activo o Nº de registro sanitario (mín. 2)" autocomplete="off">
      <div class="gresultados grs-res"></div>`;
    const inp = caja.querySelector('.grs-q'), res = caja.querySelector('.grs-res');
    let t = null, n = 0, lista = [];
    const buscarRS = async q => {
      const id = ++n;
      if (q.length < 2) { res.innerHTML = ''; return; }
      res.innerHTML = '<div class="gnote">⏳ Buscando en el portafolio…</div>';
      const { data, error } = await sb.rpc('buscar_registros_sanitarios', { p_q: q });
      if (id !== n) return;
      if (error) { res.innerHTML = `<div class="gnote err">${esc(error.message)}</div>`; return; }
      lista = data || [];
      res.innerHTML = lista.length ? lista.map((r, i) => `
        <button type="button" class="gres grs-card" data-i="${i}">
          <b>${esc(r.producto)}</b>
          <small><span class="rsn">${esc(r.nro_registro_sanitario)}</span> · ${esc(r.principio_activo || '')}</small>
          <small>${esc(r.titulares || '—')}${r.fabricante ? ' · Fab.: ' + esc(r.fabricante) : ''}</small>
          <span class="gdocs">${badgeVencimiento(r.vencimiento)}</span>
        </button>`).join('') : '<div class="gnote">Sin coincidencias en el portafolio.</div>';
      res.querySelectorAll('.grs-card').forEach(b => b.onclick = () => onSelect(rsDesdeFila(lista[+b.dataset.i])));
    };
    inp.oninput = () => { clearTimeout(t); t = setTimeout(() => buscarRS(inp.value.trim()), 350); };
    inp.onkeydown = e => { if (e.key === 'Enter') { clearTimeout(t); buscarRS(inp.value.trim()); } };
    if (valorInicial) { inp.value = valorInicial; buscarRS(valorInicial); }
  }

  const htmlRSElegido = (r, conQuitar) => `
    <div class="grs-sel"><div><b>${esc(r.nro)}</b> ${badgeVencimiento(r.vencimiento)}
      <small>${esc(r.producto)}</small><small>${esc(r.titular || '—')}</small></div>
      ${conQuitar ? '<button type="button" class="glink" id="genRsQuitar">Cambiar</button>' : ''}</div>`;

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

            ${puedeRS() ? `
            <div class="glabel" style="margin-top:22px">5 · Registro sanitario (DIGEMID) <span class="gnote" style="text-transform:none;font-weight:400">— opcional</span></div>
            ${st.registro ? htmlRSElegido(st.registro, true) : `<div id="genRsSelector"></div>
              <p class="gnote">Asocia el documento a un producto del portafolio. Queda registrado en la versión controlada.</p>`}` : ''}
          </div>
          <div>
            <div class="gresumen">
              <div class="glabel">Resumen</div>
              ${pr ? `
                <div class="gres-nombre">${esc(pr.nombre)}</div>
                ${pr.detalle ? `<div class="gres-det">${esc(pr.detalle)}</div>` : ''}
                <div class="gres-meta">${pr.origen === 'cima' ? `CIMA · Nº ${esc(pr.nregistro)}${pr.lab ? ' · ' + esc(pr.lab) : ''}`
                  : pr.archivo ? `Documento subido · ${esc(pr.archivo.name)}` : pr.nregistro ? `Nº ${esc(pr.nregistro)}` : ''}</div>`
                : `<div class="gres-vacio">Seleccione un producto de CIMA o suba una ficha técnica.</div>`}
              <div class="gchips">
                <span class="gchip">${esc((P().PAISES.find(p => p.codigo === st.pais) || {}).nombre || st.pais)}</span>
                <span class="gchip">${st.idioma === 'es' ? 'Español' : 'Português'}</span>
                <span class="gchip">${esc(tipoDef.nombre.es)}</span>
                ${plantilla && plantilla.borrador ? '<span class="gchip warn">Estructura provisional</span>' : ''}
                ${st.registro ? `<span class="gchip rs">RS ${esc(st.registro.nro)}</span>` : ''}
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
      // Solo cambian títulos: no hace falta regenerar. Un documento controlado conserva el idioma
      // con el que se registró (el idioma es parte de su identidad); para otro idioma se genera aparte.
      if (st.doc && !st.doc.control && !st.doc.familia) { st.doc.idioma = st.idioma; renderDoc(); }
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

    if (puedeRS()) {
      if (st.registro) $g('genRsQuitar').onclick = () => { st.registro = null; renderConfig(); };
      else montarSelectorRS($g('genRsSelector'), {
        valorInicial: st.rsSugerencia,
        onSelect: r => { st.registro = r; renderConfig(); },
      });
    }
  }

  /** Término para sugerir el registro sanitario: primer principio activo del producto de CIMA. */
  function sugerirRS(m) {
    const pa = (m.pactivos || '').split(/[,/]/)[0].trim();
    st.rsSugerencia = pa || (m.nombre || '').split(/\s+/)[0] || '';
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
      if (!st.registro) sugerirRS(m);
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

  /** Documento CIMA segmentado: usa el guardado en Supabase si ya existe esa versión; si no, segmenta y guarda.
   *  Devuelve { res, id } — id = documentos_segmentados.id (referencia de la versión controlada). */
  async function segmentadoCIMA(meta, tipoDoc) {
    const version = global.Segmentador.fechaVersion(meta, tipoDoc);
    if (version) {
      try {
        const previo = await global.cargarDeSupabase({ origen: 'cima', tipo_documento: tipoDoc, nregistro: meta.nregistro, fecha_version_cima: version });
        if (previo) return { res: previo.res, id: previo.id };
      } catch (e) { console.warn('No se pudo leer Supabase:', e.message); }
    }
    const res = await global.Segmentador.segmentarCIMA(meta.nregistro, tipoDoc, meta);
    let id = null;
    try {
      id = await global.guardarEnSupabase(res);
      if (id === null && version) {   // otro usuario la guardó en paralelo: se usa esa
        const previo = await global.cargarDeSupabase({ origen: 'cima', tipo_documento: tipoDoc, nregistro: meta.nregistro, fecha_version_cima: version });
        if (previo) id = previo.id;
      }
    } catch (e) { console.warn('No se guardó en Supabase:', e.message); }
    return { res, id };
  }

  /** Referencia segmentada desde CIMA (según la fuente preferida de la plantilla) o desde un archivo. */
  async function obtenerReferencia(plantilla, { nregistro, archivo, res: resPrevio, docId }) {
    if (archivo) {
      const res = resPrevio || await global.Segmentador.segmentarArchivo(archivo, 'auto');
      let id = docId || null;
      if (!id) {
        estado('⏳ Guardando referencia en Supabase…');
        try { id = await global.guardarEnSupabase(res, archivo); } catch (e) { console.warn('No se guardó en Supabase:', e.message); }
      }
      return { res, id };
    }
    estado('⏳ Consultando CIMA…');
    const meta = await global.Segmentador.metaCIMA(nregistro);
    for (const tipoDoc of plantilla.fuentePreferida) {
      if (!(tipoDoc === 'FT' ? meta.docFT : meta.docP)) continue;
      estado(`⏳ Separando ${tipoDoc === 'FT' ? 'la ficha técnica' : 'el prospecto'}…`);
      try { return await segmentadoCIMA(meta, tipoDoc); }
      catch (e) { if (e.codigo !== 'SIN_SEGMENTAR') throw e; }
    }
    const pdf = (meta.docFT || meta.docP || {}).url;
    throw new Error('CIMA no publica este medicamento dividido por secciones. '
      + (pdf ? `Descargue el <a href="${esc(pdf)}" target="_blank" rel="noopener">PDF</a> y súbalo como archivo.` : 'Súbalo como archivo.'));
  }

  async function generar() {
    const plantilla = P().PLANTILLAS[st.pais][st.tipo];
    const pr = st.producto;
    const btn = $g('genGenerar');
    btn.disabled = true;
    try {
      if (!pr.archivo && !pr.nregistro) throw new Error('Seleccione un producto de CIMA o suba un documento.');
      const ref = pr.archivo
        ? await obtenerReferencia(plantilla, { archivo: pr.archivo, res: pr.res, docId: pr.docId })
        : await obtenerReferencia(plantilla, { nregistro: pr.nregistro });
      if (pr.origen === 'subida') pr.docId = ref.id;
      st.doc = construir(plantilla, ref.res, pr, ref.id);
      estado('');
      await buscarCoincidencias(st.doc, pr);
      renderDoc();
      $g('genDoc').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (e) {
      estado(e.message.includes('<a ') ? e.message : esc(e.message), true);
    } finally {
      btn.disabled = false;
    }
  }

  /** Clave estable de una sección de plantilla: su código (FT) o su posición (inserto / etiqueta). */
  const claveDe = (s, i) => s.codigo || String(i + 1);

  /** Arma las secciones de la plantilla con el contenido de los campos segmentados. */
  function construir(plantilla, res, pr, referenciaId) {
    const porCodigo = Object.fromEntries(res.campos.map(c => [c.codigo, c]));
    const secciones = [];
    plantilla.secciones.forEach((s, idx) => {
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
        def: s, clave: claveDe(s, idx), html: s.manual ? '' : html,
        estado: s.manual ? 'manual' : (html ? 'ok' : 'vacio'),
        origen: origen.join(', '), editado: false,
      });
    });
    secciones.forEach((s, i) => { s.num = plantilla.numerar === 'codigo' ? s.def.codigo : String(i + 1); });
    return {
      pais: st.pais, idioma: st.idioma, tipo: st.tipo, plantilla, secciones,
      producto: pr.nombre, detalle: pr.detalle || '',
      fuenteOrigen: res.origen, fuenteTipo: res.tipo, fuenteNreg: res.meta.nregistro || pr.nregistro || null,
      fuenteVersion: res.meta.fecha_version, fuenteArchivo: res.meta.archivo || '',
      generado: new Date(),
      get fuente() { return this.fuenteFija || textoFuente(this, this.idioma); },
      // Control de versiones
      referenciaId: referenciaId || null,
      registro: st.registro ? { ...st.registro } : null,   // paso 5 (se guarda como snapshot en la versión)
      control: null,     // versión guardada que se está viendo: { version_id, codigo_version, version, creado_en, … }
      familia: null,      // documento controlado al que pertenecerá la próxima versión
      base: null,         // versión contra la que se muestran diferencias (y base de la próxima versión)
      sucio: false,       // editado después de guardar/abrir
      coincidencias: [],  // documentos controlados existentes del mismo producto/tipo/país/idioma
    };
  }

  /** Documentos controlados que ya existen para este producto (evita duplicar familias sin querer). */
  async function buscarCoincidencias(doc, pr) {
    try {
      let q = sb.from('v_documentos_controlados')
        .select('id, codigo, version_vigente, version_vigente_id, codigo_version_vigente, total_cambios')
        .eq('tipo_documento', doc.tipo).eq('pais', doc.pais).eq('idioma', doc.idioma);
      q = pr.nregistro ? q.eq('nregistro', pr.nregistro) : q.eq('producto', doc.producto);
      const { data } = await q;
      doc.coincidencias = data || [];
    } catch (e) { doc.coincidencias = []; }
  }

  /** Vincula el documento en pantalla a un documento controlado existente: su versión vigente pasa a ser la base. */
  async function vincular(documentoId) {
    const c = st.doc.coincidencias.find(x => x.id === documentoId);
    if (!c) return;
    const cv = await global.Control.cargarVersion(c.version_vigente_id);
    st.doc.familia = { documentoId: c.id, codigo: c.codigo, versionVigente: c.version_vigente };
    st.doc.base = global.Control.baseDesde(cv);
    if (!st.doc.registro) st.doc.registro = registroDesdeVersion(cv.version);   // hereda el RS de la versión vigente
    renderDoc();
  }

  /** Registro sanitario (snapshot) de una versión guardada. */
  const registroDesdeVersion = v => v && v.medicamento_id
    ? { id: v.medicamento_id, nro: v.rs_numero, producto: v.rs_producto, titular: v.rs_titular, vencimiento: v.rs_vencimiento }
    : null;

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

    // Diferencias contra la versión base (si la hay). Informativas: el servidor recalcula al guardar.
    const cmp = d.base ? global.Control.compararConBase(d.secciones, d.base) : null;
    const hayDiff = cmp && cmp.total > 0;
    const V = n => 'V' + String(n).padStart(2, '0');

    let grupoPrevio = null;
    box.hidden = false;
    box.innerHTML = `
      <div class="gdoc-h">
        <div>
          <div class="gdoc-norma"><span class="gcode">${pais.codigo}</span> ${esc(pais.nombre)} — ${esc(d.plantilla.norma[L])}</div>
          <div class="gdoc-titulo">${esc(d.producto)}</div>
          <div class="gdoc-sub">${esc(tipoDef.nombre[L])} · ${T.idioma} · ${d.secciones.length} ${T.secciones} · ${nCrit} ${T.criticas}${nPend ? ` · <b class="pend">${nPend} ${T.pendientes}</b>` : ''}${hayDiff ? ` · <b class="pend">${cmp.total} cambio(s) vs ${esc(d.base.codigoVersion)}</b>` : ''}</div>
          <div class="gdoc-fuente">${esc(T.fuente)}: ${esc(d.fuente)}</div>
        </div>
        <div class="gdoc-acc">
          <button type="button" class="gbtn guardar" id="genGuardar">💾 ${d.control || d.familia ? 'Guardar nueva versión' : 'Guardar versión'}</button>
          <button type="button" class="gbtn prim" id="genWord">⬇ ${T.exportar}</button>
          <button type="button" class="gbtn" id="genPrint">🖨 ${T.imprimir}</button>
        </div>
      </div>
      <div class="gtraz ${estadoTraza(d).clase}" id="genTraza">${estadoTraza(d).html}</div>
      ${d.registro || puedeRS() ? `<div class="grs-doc">🏷 Registro sanitario:
        ${d.registro ? `<b>${esc(d.registro.nro)}</b> · ${esc(d.registro.producto)} · ${esc(d.registro.titular || '—')} ${badgeVencimiento(d.registro.vencimiento)}`
                     : '<span>sin asociar</span>'}
        ${d.base && (d.base.medicamentoId || null) !== (d.registro ? d.registro.id : null)
          ? `<span class="gbadge dif modificada">CAMBIO vs ${esc(d.base.codigoVersion)}</span>` : ''}
        ${puedeRS() ? `<button type="button" class="glink" id="genRsCambiar">${d.registro ? 'Cambiar' : 'Asociar'}</button>` : ''}
      </div>` : ''}
      ${!d.familia && d.coincidencias.length ? d.coincidencias.map(c => `
        <div class="gaviso">⚠ Este producto ya tiene el documento controlado <b>${esc(c.codigo)}</b>
          (vigente ${esc(c.codigo_version_vigente)}, ${c.total_cambios} cambio(s)). Si esto es una actualización, vincúlelo para registrar
          el control de cambio en lugar de crear un documento nuevo.
          <button type="button" class="gbtn mini-b" data-vincular="${esc(c.id)}">🔗 Vincular como nueva versión de ${esc(c.codigo)}</button></div>`).join('') : ''}
      ${d.plantilla.borrador ? `<div class="gaviso">⚠ ${esc(T.borrador)}</div>` : ''}
      ${L === 'pt' ? `<div class="gaviso info">${esc(T.aviso_pt)}</div>` : ''}
      ${avisoFuente}
      <div class="gdoc-tools">
        <button type="button" class="glink" id="genExp">${T.expandir}</button> ·
        <button type="button" class="glink" id="genCol">${T.contraer}</button>
        ${hayDiff ? ` · <label class="glink"><input type="checkbox" id="genSoloCambios"> Solo secciones con cambios</label>` : ''}
        <span class="gnote">Puede editar el texto de cada sección antes de guardar o exportar.</span>
      </div>
      <div class="gsecs">
        ${d.secciones.map((s, i) => {
          const g = s.def.grupo && s.def.grupo !== grupoPrevio ? `<div class="ggrupo">${esc(s.def.grupo[L])}</div>` : '';
          if (s.def.grupo) grupoPrevio = s.def.grupo;
          const badge = s.def.critica ? `<span class="gbadge crit">${T.critica}</span>` : '';
          const pend = s.editado ? '' : s.estado === 'manual' ? `<span class="gbadge man">${T.completar}</span>`
                     : s.estado === 'vacio' ? `<span class="gbadge pend">${T.pendiente}</span>` : '';
          const c = hayDiff ? cmp.porClave[s.clave] : null;
          const dif = c && c.tipo !== 'SIN_CAMBIOS' ? `<span class="gbadge dif ${c.tipo.toLowerCase()}">${c.tipo === 'AGREGADA' ? 'NUEVA' : 'MODIFICADA'}</span>` : '';
          return `${g}<details class="gsec${c && c.tipo !== 'SIN_CAMBIOS' ? ' concambio' : ''}" data-i="${i}">
            <summary><span class="gnum">${esc(s.num)}</span><span class="gtit">${esc(s.def.titulo[L])}</span>
              <span class="gdifslot">${dif}</span>${pend}${badge}${s.origen ? `<span class="gorig">${esc(s.origen)}</span>` : ''}<span class="gchev">▼</span></summary>
            <div class="gsec-b">
              ${s.def.nota ? `<div class="gnota">💡 ${esc(s.def.nota[L])}</div>` : ''}
              ${d.base ? `<button type="button" class="glink gverdif">⇄ Ver cambios vs ${esc(d.base.codigoVersion)}</button><div class="cdiff-b gdifbox" hidden></div>` : ''}
              <div class="gcont" contenteditable="true" spellcheck="true"
                   data-ph="${esc(s.estado === 'manual' ? s.def.manual[L] : T.sinContenido)}"></div>
            </div>
          </details>`;
        }).join('')}
        ${hayDiff && cmp.eliminadas.length ? `<div class="ggrupo">Secciones eliminadas respecto de ${esc(d.base.codigoVersion)}</div>
          ${cmp.eliminadas.map(b => `<div class="gelim"><span class="gbadge dif eliminada">ELIMINADA</span> ${esc(b.titulo)}</div>`).join('')}` : ''}
      </div>`;

    // El HTML de cada sección (4.8 puede pasar de 200 KB) se inserta al abrirla.
    box.querySelectorAll('details.gsec').forEach(det => {
      det.addEventListener('toggle', () => { if (det.open) pintarSeccion(det); });
      const bv = det.querySelector('.gverdif');
      if (bv) bv.onclick = () => {
        const s = d.secciones[+det.dataset.i], caja = det.querySelector('.gdifbox');
        const b = d.base.secciones[s.clave];
        caja.hidden = !caja.hidden;
        if (!caja.hidden) {
          const actual = global.Control.htmlATexto(s.html);
          caja.innerHTML = !b ? '<p class="gnote">Sección nueva (no existía en la versión base).</p>'
            : (b.texto || '').replace(/\s+/g, ' ').trim() === actual.replace(/\s+/g, ' ').trim()
              ? '<p class="gnote">Sin cambios respecto de la versión base.</p>'
              : global.Control.diffHTML(b.texto, actual);
        }
      };
    });
    box.querySelectorAll('[data-vincular]').forEach(b => b.onclick = async () => {
      b.disabled = true; b.textContent = '⏳ Cargando versión vigente…';
      try { await vincular(b.dataset.vincular); } catch (e) { alert(e.message); b.disabled = false; }
    });
    const solo = $g('genSoloCambios');
    if (solo) solo.onchange = () => box.querySelectorAll('details.gsec').forEach(x => {
      x.hidden = solo.checked && !x.classList.contains('concambio');
    });
    $g('genExp').onclick = () => box.querySelectorAll('details.gsec').forEach(x => { x.open = true; pintarSeccion(x); });
    $g('genCol').onclick = () => box.querySelectorAll('details.gsec').forEach(x => { x.open = false; });
    $g('genWord').onclick = exportarWord;
    $g('genPrint').onclick = imprimir;
    const brs = $g('genRsCambiar');
    if (brs) brs.onclick = () => {
      abrirPanel('Registro sanitario del documento', d.producto, `
        ${d.registro ? `<p class="gnote">Actual: <b>${esc(d.registro.nro)}</b> · ${esc(d.registro.producto)}</p>` : ''}
        <div id="rsPanelSel"></div>
        ${d.registro ? '<div class="bar"><button type="button" class="btn ghost" id="rsQuitar">Quitar asociación</button></div>' : ''}
        <p class="gnote">Cambiar el registro sanitario de un documento controlado genera una nueva versión con su control de cambio.</p>`);
      const aplicar = r => {
        d.registro = r;
        if (d.control) d.sucio = true;
        cerrarPanel(); renderDoc();
      };
      montarSelectorRS($g('rsPanelSel'), { valorInicial: d.registro ? '' : (st.rsSugerencia || ''), onSelect: aplicar });
      const q = $g('rsQuitar'); if (q) q.onclick = () => aplicar(null);
    };
    const bg = $g('genGuardar');
    bg.disabled = !!(d.control && !d.sucio);
    bg.title = bg.disabled ? 'Sin cambios desde la versión guardada' : '';
    bg.onclick = () => global.Control.abrirGuardar(d, r => {
      d.control = r;
      d.familia = { documentoId: r.documento_id, codigo: r.codigo, versionVigente: r.version };
      // La versión recién guardada pasa a ser la base: los cambios siguientes se comparan contra ella.
      if (r.medicamento_id) d.registro = { id: r.medicamento_id, nro: r.rs_numero, producto: r.rs_producto,
                                           titular: r.rs_titular, vencimiento: r.rs_vencimiento };  // snapshot del servidor
      d.base = { versionId: r.version_id, version: r.version, codigoVersion: r.codigo_version,
        medicamentoId: r.medicamento_id || null, rsNumero: r.rs_numero || null,
        secciones: Object.fromEntries(d.secciones.map(s => [s.clave, { clave: s.clave, titulo: s.def.titulo[d.idioma],
          texto: global.Control.htmlATexto(s.html), html: s.html }])) };
      d.sucio = false;
      d.secciones.forEach(s => { s.editado = false; });
      d.coincidencias = [];
      renderDoc();
    });
  }

  /** Franja de trazabilidad: qué es legalmente lo que se ve en pantalla. */
  function estadoTraza(d) {
    const fh = global.Control.fechaHora;
    if (d.control && !d.sucio) return { clase: 'ok', html:
      `🔒 <b>Documento controlado</b> · Código <b>${esc(d.control.codigo_version)}</b> · Versión <b>V${String(d.control.version).padStart(2, '0')}</b>
       · ${fh(d.control.creado_en)} (Lima)${d.control.creado_por_email ? ' · ' + esc(d.control.creado_por_email) : ''}
       ${d.control.control_codigo ? ' · ' + esc(d.control.control_codigo) : ''} · SHA-256 <code title="${esc(d.control.hash_contenido)}">${esc((d.control.hash_contenido || '').slice(0, 12))}…</code>` };
    if (d.control && d.sucio) return { clase: 'warn', html:
      `✏ <b>Cambios sin guardar</b> sobre ${esc(d.control.codigo_version)}. Lo que ve no es una versión controlada hasta que guarde una nueva versión.` };
    if (d.familia) return { clase: 'warn', html:
      `🔄 <b>Actualización de ${esc(d.familia.codigo)}</b> · base ${esc(d.base ? d.base.codigoVersion : '—')} · nueva versión <b>sin guardar</b>.` };
    return { clase: 'warn', html: `📝 <b>Borrador no controlado</b>: guarde la versión para asignarle código interno, fecha, versión y hash.` };
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
      if (st.doc.control && !st.doc.sucio) {
        st.doc.sucio = true;
        const t = estadoTraza(st.doc), el = $g('genTraza');
        el.className = 'gtraz ' + t.clase; el.innerHTML = t.html;
        $g('genGuardar').disabled = false; $g('genGuardar').title = '';
      }
    });
    // Al salir de la sección se recalcula su marca de diferencia contra la base.
    cont.addEventListener('focusout', () => {
      if (!st.doc.base) return;
      const b = st.doc.base.secciones[s.clave], slot = det.querySelector('.gdifslot');
      const actual = global.Control.htmlATexto(s.html).replace(/\s+/g, ' ').trim();
      const cambio = !b ? 'NUEVA' : (b.texto || '').replace(/\s+/g, ' ').trim() !== actual ? 'MODIFICADA' : '';
      slot.innerHTML = cambio ? `<span class="gbadge dif ${cambio === 'NUEVA' ? 'agregada' : 'modificada'}">${cambio}</span>` : '';
      det.classList.toggle('concambio', !!cambio);
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
    const tz = textoTrazabilidad(d);
    return `
      <div class="${tz.controlado ? 'ptraz' : 'ptraz nocontrol'}">${esc(tz.linea)}</div>
      <div class="pnorma">${esc(pais.nombre)} — ${esc(d.plantilla.norma[L])}</div>
      <h1>${esc(d.producto)}</h1>
      <div class="psub">${esc(tipoDef.nombre[L])} · ${T.idioma} · ${esc(T.generado)}: ${d.generado.toLocaleDateString('es-PE')}</div>
      <div class="psub">${esc(T.fuente)}: ${esc(d.fuente)}</div>
      ${d.registro ? `<div class="psub"><b>${esc(textoRS(d, L))}</b></div>` : ''}
      ${d.plantilla.borrador ? `<p class="paviso">${esc(T.borrador)}</p>` : ''}
      ${L === 'pt' ? `<p class="paviso">${esc(T.aviso_pt)}</p>` : ''}
      ${d.secciones.map(s => {
        const g = s.def.grupo && s.def.grupo !== grupoPrevio ? `<h2 class="pgrupo">${esc(s.def.grupo[L])}</h2>` : '';
        if (s.def.grupo) grupoPrevio = s.def.grupo;
        const cuerpo = s.html ? limpiar(s.html)
          : `<p class="pvacio">${esc(s.estado === 'manual' ? s.def.manual[L] : T.sinContenido)}</p>`;
        return `${g}<h3>${esc(s.num)}. ${esc(s.def.titulo[L])}${s.def.critica ? ` <span class="pcrit">${T.critica}</span>` : ''}</h3>${cuerpo}`;
      }).join('')}
      <div class="${tz.controlado ? 'ptraz pie' : 'ptraz pie nocontrol'}">${esc(tz.linea)}${tz.hash ? ' · SHA-256 ' + esc(tz.hash) : ''}</div>`;
  }

  function textoRS(d, L) {
    const r = d.registro;
    const vto = r.vencimiento
      ? new Date(r.vencimiento + 'T00:00:00').toLocaleDateString('es-PE', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '—';
    return L === 'pt'
      ? `Registro sanitário: ${r.nro} · ${r.producto} · Titular: ${r.titular || '—'} · Validade: ${vto}`
      : `Registro sanitario: ${r.nro} · ${r.producto} · Titular: ${r.titular || '—'} · Vencimiento: ${vto}`;
  }

  /** Línea de trazabilidad que acompaña toda copia exportada o impresa. */
  function textoTrazabilidad(d) {
    if (d.control && !d.sucio) {
      const c = d.control;
      return { controlado: true, codigo: c.codigo_version, hash: c.hash_contenido,
        linea: `Documento controlado ${c.codigo_version} · Versión V${String(c.version).padStart(2, '0')} · `
             + `Emitido ${global.Control.fechaHora(c.creado_en)} (Lima)${c.control_codigo ? ' · ' + c.control_codigo : ''}` };
    }
    return { controlado: false, codigo: null, hash: null,
      linea: `BORRADOR — COPIA NO CONTROLADA · generada ${global.Control.fechaHora(new Date().toISOString())} (Lima)`
           + (d.familia ? ` · pendiente de guardar como nueva versión de ${d.familia.codigo}` : '') };
  }

  function imprimir() {
    let root = $g('genPrintRoot');
    if (!root) { root = document.createElement('div'); root.id = 'genPrintRoot'; document.body.appendChild(root); }
    root.innerHTML = htmlDocumento();
    const d = st.doc;
    if (d.control && !d.sucio) global.Control.registrarEvento(d.control.version_id, 'IMPRIMIR');
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
      const tz = textoTrazabilidad(d);
      const hijos = [
        new D.Paragraph({ children: [new D.TextRun({ text: tz.linea, bold: true, size: 18, color: tz.controlado ? '1A3A5C' : 'B42318' })] }),
        ...(tz.hash ? [gris(`SHA-256 del contenido: ${tz.hash}`)] : []),
        gris(`${pais.nombre} — ${d.plantilla.norma[L]}`),
        new D.Paragraph({ heading: D.HeadingLevel.TITLE, children: [new D.TextRun({ text: d.producto, bold: true })] }),
        gris(`${tipoDef.nombre[L]} · ${T.idioma} · ${T.generado}: ${d.generado.toLocaleDateString('es-PE')}`),
        gris(`${T.fuente}: ${d.fuente}`),
        ...(d.registro ? [new D.Paragraph({ children: [new D.TextRun({ text: textoRS(d, L), bold: true, size: 18, color: '5B3AA6' })] })] : []),
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
        sections: [{
          footers: { default: new D.Footer({ children: [new D.Paragraph({ alignment: D.AlignmentType.CENTER, children: [
            new D.TextRun({ text: `${tz.controlado ? tz.codigo : 'COPIA NO CONTROLADA'} · Página `, size: 16, color: tz.controlado ? '666666' : 'B42318' }),
            new D.TextRun({ children: [D.PageNumber.CURRENT], size: 16, color: '666666' }),
            new D.TextRun({ text: ' de ', size: 16, color: '666666' }),
            new D.TextRun({ children: [D.PageNumber.TOTAL_PAGES], size: 16, color: '666666' }),
          ] })] }) },
          children: hijos,
        }],
      });
      const blob = await D.Packer.toBlob(documento);
      if (tz.controlado) global.Control.registrarEvento(d.control.version_id, 'EXPORTAR_WORD');
      const nombre = `${tz.controlado ? tz.codigo + '_' : 'BORRADOR_'}${tipoDef.nombre[L]}_${pais.codigo}_${L.toUpperCase()}_${d.producto}`
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')          // "técnica" → "tecnica"
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
    if (!st.registro) sugerirRS({ nombre: fila.nombre });
    renderConfig();
  }

  /** Plantilla y definición de sección para una versión guardada (tolera plantillas que cambiaron después). */
  function seccionesDesdeVersion(plantilla, filas, idioma) {
    return filas.map((f, i) => {
      const idx = plantilla ? plantilla.secciones.findIndex((s, k) => claveDe(s, k) === f.clave) : -1;
      const def = idx >= 0 ? plantilla.secciones[idx]
        : { titulo: { es: f.titulo, pt: f.titulo }, critica: f.critica };
      return {
        def, clave: f.clave, html: f.html, origen: '', editado: false,
        estado: f.estado === 'editado' ? 'ok' : f.estado,
        num: plantilla && plantilla.numerar === 'codigo' ? f.clave : String(i + 1),
      };
    });
  }

  function mostrarDocumento() {
    global.mostrarTab('tabGenerador');
    renderConfig();
    renderDoc();
    $g('genDoc').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /** Abre una versión guardada (desde el historial). Se puede editar y guardar como nueva versión. */
  function abrirVersion(cv) {
    const d = cv.documento, v = cv.version;
    const plantilla = (P().PLANTILLAS[d.pais] || {})[d.tipo_documento];
    Object.assign(st, { pais: d.pais, idioma: d.idioma, tipo: d.tipo_documento });
    st.producto = { origen: 'version', nombre: d.producto, nregistro: d.nregistro, detalle: `Versión controlada ${v.codigo_version}` };
    st.doc = {
      pais: d.pais, idioma: d.idioma, tipo: d.tipo_documento,
      plantilla: plantilla || { norma: { es: v.norma || '', pt: v.norma || '' }, secciones: [] },
      secciones: seccionesDesdeVersion(plantilla, cv.secciones, d.idioma),
      producto: d.producto, detalle: '', fuenteFija: v.referencia_descripcion || '', fuenteNreg: d.nregistro,
      fuenteTipo: null, generado: new Date(v.creado_en),
      get fuente() { return this.fuenteFija; },
      referenciaId: v.referencia_segmentado_id,
      registro: registroDesdeVersion(v),
      control: { documento_id: d.id, codigo: d.codigo, version_id: v.id, version: v.version, codigo_version: v.codigo_version,
                 creado_en: v.creado_en, creado_por_email: v.creado_por_email, hash_contenido: v.hash_contenido,
                 control_codigo: cv.control && cv.control.codigo },
      familia: { documentoId: d.id, codigo: d.codigo, versionVigente: d.version_vigente },
      base: global.Control.baseDesde(cv),
      sucio: false, coincidencias: [],
    };
    mostrarDocumento();
  }

  /**
   * Flujo de actualización: versión base elegida + nueva referencia (archivo o CIMA)
   * → separación → documento con las diferencias marcadas, listo para revisar y guardar.
   */
  async function actualizarVersion({ documento: d, baseVersionId, archivo, nregistro }) {
    const plantilla = (P().PLANTILLAS[d.pais] || {})[d.tipo_documento];
    if (!plantilla) throw new Error(`No hay plantilla para ${d.tipo_documento} / ${d.pais}.`);
    const cv = await global.Control.cargarVersion(baseVersionId);
    Object.assign(st, { pais: d.pais, idioma: d.idioma, tipo: d.tipo_documento });
    const pr = { origen: archivo ? 'subida' : 'cima', nombre: d.producto, nregistro: d.nregistro, archivo };
    const ref = await obtenerReferencia(plantilla, archivo ? { archivo } : { nregistro });
    estado('');
    st.producto = { ...pr, detalle: `Actualización de ${d.codigo} (base ${cv.version.codigo_version})` };
    st.doc = construir(plantilla, ref.res, pr, ref.id);
    st.doc.producto = d.producto;                    // la identidad del documento no cambia
    st.doc.familia = { documentoId: d.id, codigo: d.codigo, versionVigente: d.version_vigente };
    st.doc.base = global.Control.baseDesde(cv);
    st.doc.registro = registroDesdeVersion(cv.version);   // la actualización conserva el RS de la base
    global.cerrarPanel();
    mostrarDocumento();
  }

  global.Generador = { init, usarProducto, abrirVersion, actualizarVersion, _estado: st };
})(window);
