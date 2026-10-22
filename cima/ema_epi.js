/**
 * Pestaña "EMA ePI" del módulo CIMA.
 *
 * Muestra lo que alimenta el repo independiente EMA-APi (GitHub Actions →
 * Supabase, mismo proyecto que CIMA):
 *   - ema_epi_corridas      estado de la fuente (la API de la EMA a veces cae)
 *   - ema_epi_documentos    documentos ePI vigentes (SPC, prospecto, etiquetado, anexo II)
 *   - ema_epi_cambios       historial de cambios detectados (con secciones afectadas)
 *   - ema_epi_cima_vinculo  vínculo propuesto ePI → Nº CIMA (verificar / rechazar)
 *
 * Solo lee y, para el vínculo, cambia su estado (RLS: usuarios con acceso a CIMA).
 * Usa los helpers globales de cima/index.html: sb, $, escH, cargando, abrirPanel,
 * fmtFecha, fechaHoraPE, irAFichas, yo.
 */
(function (global) {
  'use strict';

  const TIPO = {
    'Summary of Product Characteristics': ['FT (SPC)', 'ft'],
    'Package Leaflet': ['Prospecto', 'prosp'],
    'Labelling': ['Etiquetado', 'both'],
    'Annex II': ['Anexo II', 'both'],
  };
  const IDIOMA = { Spanish: 'ES', English: 'EN', Desconocido: '¿?' };
  const ESTADO_FUENTE = {
    ok: ['ok', '✓ Fuente operativa'],
    parcial: ['warn', '⚠ Corrida parcial'],
    fuente_caida: ['warn', '⚠ API de la EMA caída'],
    desconocido: ['', 'Estado desconocido'],
  };
  const CONF = { alta: '#1e6b34', media: '#7a5600', baja: '#b42318' };
  const ESTADO_V = { propuesto: 'propuesto', verificado: '✓ verificado', rechazado: '✗ rechazado' };

  const st = { docs: [], cambios: [], vinculos: [], corridas: [], fichas: new Set(), abiertos: new Set(),
               f: { q: '', agencia: '', tipo: '', idioma: '', vinculo: '' }, cargado: false };

  const tipoTxt = t => (TIPO[t] || [t || '—'])[0];
  const tipoCls = t => (TIPO[t] || [null, 'both'])[1];
  const idiomaTxt = i => IDIOMA[i] || (i ? i.slice(0, 2).toUpperCase() : '¿?');
  const urlCima = n => `https://cima.aemps.es/cima/publico/detalle.html?nregistro=${encodeURIComponent(n)}`;
  const claveProd = d => `${d.agencia}|${String(d.nombre_medicamento || '').trim().toLowerCase()}`;

  async function cargar() {
    const caja = $('epiCuerpo');
    caja.innerHTML = cargando('Cargando datos ePI…');
    try {
      const [docs, cambios, vinc, corr] = await Promise.all([
        sb.from('ema_epi_documentos')
          .select('id, agencia, bundle_id, nombre_medicamento, tipo_documento, idioma, dominio, numeros_eu, fecha_primera_deteccion, fecha_ultima_actualizacion')
          .order('nombre_medicamento').limit(2000),
        sb.from('ema_epi_cambios')
          .select('id, bundle_id, nombre_medicamento, tipo_documento, agencia, idioma, fecha_deteccion, tipo_cambio, resumen_cambio')
          .order('fecha_deteccion', { ascending: false }).limit(2000),
        sb.from('ema_epi_cima_vinculo')
          .select('id, bundle_id, idioma, nregistro, nombre_cima, laboratorio_cima, metodo_match, confianza, evidencia, estado, verificado_en')
          .limit(5000),
        sb.from('ema_epi_corridas')
          .select('fin, estado, http_status, detalle_error, documentos, nuevos, modificados, github_run_url')
          .order('fin', { ascending: false }).limit(30),
      ]);
      for (const r of [docs, cambios, vinc, corr]) if (r.error) throw new Error(r.error.message);
      st.docs = docs.data; st.cambios = cambios.data; st.vinculos = vinc.data; st.corridas = corr.data;

      // ¿Qué Nº CIMA vinculados ya tienen ficha en "Fichas técnicas"?
      const nregs = [...new Set(st.vinculos.map(v => v.nregistro))];
      st.fichas = new Set();
      if (nregs.length) {
        const { data } = await sb.from('documentos_segmentados').select('nregistro')
          .in('nregistro', nregs).is('eliminado_en', null);
        (data || []).forEach(x => st.fichas.add(x.nregistro));
      }
      st.cargado = true;
      pintar();
    } catch (e) {
      caja.innerHTML = `<div class="err" style="display:block">No se pudieron leer las tablas ePI: ${escH(e.message)}.
        Verifique que se aplicaron <code>sql/schema.sql</code> y <code>sql/002_cima_puente.sql</code> del repo EMA-APi.</div>`;
    }
  }

  function bannerFuente() {
    const ult = st.corridas[0];
    if (!ult) return `<div class="gtraz warn" style="border-radius:10px;margin-bottom:14px">Aún no hay corridas registradas del monitor EMA-APi.</div>`;
    const ultOk = st.corridas.find(c => c.estado === 'ok' || c.estado === 'parcial');
    const [cls, txt] = ESTADO_FUENTE[ult.estado] || ESTADO_FUENTE.desconocido;
    const caidas = (() => { let n = 0; for (const c of st.corridas) { if (c.estado === 'fuente_caida') n++; else break; } return n; })();
    return `<div class="gtraz ${cls === 'ok' ? 'ok' : 'warn'}" style="border-radius:10px;margin-bottom:14px;display:flex;flex-wrap:wrap;gap:6px 14px;align-items:center">
      <b>${escH(txt)}</b>
      <span>Última corrida: ${escH(fechaHoraPE(ult.fin))}${ult.http_status ? ' · HTTP ' + ult.http_status : ''}</span>
      ${caidas > 1 ? `<span>${caidas} corridas seguidas sin respuesta de la EMA</span>` : ''}
      ${ultOk ? `<span>Último dato recibido: ${escH(fechaHoraPE(ultOk.fin))}</span>` : ''}
      ${ult.detalle_error ? `<code title="${escH(ult.detalle_error)}">${escH(ult.detalle_error.slice(0, 120))}</code>` : ''}
      ${ult.github_run_url ? `<a href="${escH(ult.github_run_url)}" target="_blank" rel="noopener">ver run ↗</a>` : ''}
    </div>`;
  }

  function agrupar() {
    const vPorBundle = {};
    st.vinculos.forEach(v => (vPorBundle[`${v.bundle_id}|${v.idioma}`] ||= []).push(v));
    const cPorBundle = {};
    st.cambios.forEach(c => (cPorBundle[c.bundle_id] ||= []).push(c));
    const grupos = new Map();
    for (const d of st.docs) {
      const k = claveProd(d);
      if (!grupos.has(k)) grupos.set(k, { k, agencia: d.agencia, nombre: d.nombre_medicamento, docs: [], vinculos: [], cambios: [] });
      const g = grupos.get(k);
      g.docs.push(d);
      g.vinculos.push(...(vPorBundle[`${d.bundle_id}|${d.idioma || 'und'}`] || []));
      g.cambios.push(...(cPorBundle[d.bundle_id] || []));
    }
    return [...grupos.values()].map(g => {
      g.cambios.sort((a, b) => new Date(b.fecha_deteccion) - new Date(a.fecha_deteccion));
      g.ultimo = g.cambios[0] || null;
      g.ultimaAct = Math.max(...g.docs.map(d => +new Date(d.fecha_ultima_actualizacion)));
      // Un mismo Nº CIMA puede venir de varios documentos (SPC, prospecto…): se muestra una vez,
      // con el mejor estado (verificado > propuesto > rechazado).
      const rango = { verificado: 3, propuesto: 2, rechazado: 1 };
      const porN = {};
      g.vinculos.forEach(v => { const p = porN[v.nregistro]; if (!p || rango[v.estado] > rango[p.estado]) porN[v.nregistro] = v; });
      g.vinc = Object.values(porN).sort((a, b) => rango[b.estado] - rango[a.estado] || a.nregistro.localeCompare(b.nregistro));
      g.tipos = [...new Set(g.docs.map(d => d.tipo_documento))];
      g.idiomas = [...new Set(g.docs.map(d => d.idioma || 'Desconocido'))];
      g.buscar = [g.nombre, g.agencia, ...g.vinc.flatMap(v => [v.nregistro, v.nombre_cima, v.laboratorio_cima]),
                  ...g.docs.flatMap(d => d.numeros_eu || [])].join(' ').toLowerCase();
      return g;
    }).sort((a, b) => (b.ultimo ? +new Date(b.ultimo.fecha_deteccion) : 0) - (a.ultimo ? +new Date(a.ultimo.fecha_deteccion) : 0)
                      || a.nombre.localeCompare(b.nombre));
  }

  function chipVinculo(v, conAcciones) {
    const color = CONF[v.confianza] || '#67788c';
    const ficha = st.fichas.has(v.nregistro);
    return `<div class="cfam" style="border-top:none;padding:3px 0">
      <span><b class="nreg" style="color:${v.estado === 'rechazado' ? '#a11;text-decoration:line-through' : 'var(--header)'}">${escH(v.nregistro)}</b>
        <span class="cmono" style="display:inline">${escH(v.nombre_cima || '')}${v.laboratorio_cima ? ' · ' + escH(v.laboratorio_cima) : ''}</span>
        <span class="ctipo" style="background:#f3f5f8;color:${color}" title="${escH(v.evidencia || '')}">${escH(v.metodo_match)} · ${escH(v.confianza)}</span>
        <span class="cmono" style="display:inline">${escH(ESTADO_V[v.estado] || v.estado)}</span></span>
      ${conAcciones ? `<span style="white-space:nowrap">
        <a class="glink" href="${urlCima(v.nregistro)}" target="_blank" rel="noopener">CIMA ↗</a>
        ${ficha ? `<button type="button" class="glink epi-ficha" data-n="${escH(v.nregistro)}" style="margin-left:8px">📚 Ficha técnica</button>` : ''}
        ${v.estado !== 'verificado' ? `<button type="button" class="mini hist-b epi-v" data-id="${escH(v.id)}" data-e="verificado" style="margin-left:8px">✓ Verificar</button>` : ''}
        ${v.estado !== 'rechazado' ? `<button type="button" class="mini del epi-v" data-id="${escH(v.id)}" data-e="rechazado">✗ Rechazar</button>` : ''}
      </span>` : ''}</div>`;
  }

  function detalle(g) {
    const docs = [...g.docs].sort((a, b) => tipoTxt(a.tipo_documento).localeCompare(tipoTxt(b.tipo_documento)) || String(a.idioma).localeCompare(String(b.idioma)));
    return `
      <table class="ver"><thead><tr><th>Tipo</th><th>Idioma</th><th>Bundle ePI</th><th>Nº UE</th><th>Detectado</th><th>Última actualización</th><th style="text-align:right">Acción</th></tr></thead>
      <tbody>${docs.map(d => `<tr>
        <td><span class="tag ${tipoCls(d.tipo_documento)}">${escH(tipoTxt(d.tipo_documento))}</span></td>
        <td class="nreg">${escH(idiomaTxt(d.idioma))}</td>
        <td class="nreg" title="${escH(d.bundle_id)}">${escH(d.bundle_id.slice(0, 8))}…</td>
        <td class="nreg">${(d.numeros_eu || []).map(escH).join('<br>') || '—'}</td>
        <td class="nreg">${escH(fmtFecha(d.fecha_primera_deteccion))}</td>
        <td class="nreg">${escH(fmtFecha(d.fecha_ultima_actualizacion))}</td>
        <td class="acc"><button type="button" class="mini abrir epi-ver" data-id="${escH(d.id)}">Ver secciones</button></td></tr>`).join('')}
      </tbody></table>
      <div class="czona" style="margin:10px 0 0">
        <b>Vínculo con CIMA</b>
        ${g.vinc.length ? g.vinc.map(v => chipVinculo(v, true)).join('')
          : '<div class="gnote" style="margin:4px 0 0">Sin vínculo propuesto (el monitor lo intenta por Nº UE, identificadores y nombre).</div>'}
      </div>
      ${g.cambios.length ? `<div style="margin-top:10px"><b style="font-size:13px">Historial de cambios (${g.cambios.length})</b>
        <table class="ver" style="margin-top:6px"><thead><tr><th>Fecha</th><th>Documento</th><th>Cambio</th><th>Secciones afectadas</th></tr></thead>
        <tbody>${g.cambios.slice(0, 30).map(c => `<tr>
          <td class="nreg">${escH(fechaHoraPE(c.fecha_deteccion))}</td>
          <td>${escH(tipoTxt(c.tipo_documento))} · ${escH(idiomaTxt(c.idioma))}</td>
          <td>${c.tipo_cambio === 'contenido_modificado' ? '<span class="ctipo modificada">modificado</span>' : '<span class="ctipo agregada">nuevo</span>'}</td>
          <td style="font-size:12px">${escH(c.resumen_cambio || (c.tipo_cambio === 'nuevo_documento' ? 'Primera detección' : '—'))}</td></tr>`).join('')}
        </tbody></table></div>` : ''}`;
  }

  function pintar() {
    const grupos = agrupar();
    const hace30 = Date.now() - 30 * 864e5;
    const mod30 = st.cambios.filter(c => c.tipo_cambio === 'contenido_modificado' && +new Date(c.fecha_deteccion) >= hace30).length;
    const nVer = new Set(st.vinculos.filter(v => v.estado === 'verificado').map(v => v.nregistro)).size;
    const nProp = new Set(st.vinculos.filter(v => v.estado === 'propuesto').map(v => v.nregistro)).size;
    const tipos = [...new Set(st.docs.map(d => d.tipo_documento))].sort();
    const idiomas = [...new Set(st.docs.map(d => d.idioma || 'Desconocido'))].sort();
    const f = st.f;

    $('epiCuerpo').innerHTML = `
      ${bannerFuente()}
      <div class="stats">
        <div class="stat total"><div class="n">${grupos.length}</div><div class="l">Productos ePI</div></div>
        <div class="stat ft"><div class="n">${st.docs.length}</div><div class="l">Documentos vigentes</div></div>
        <div class="stat ambos"><div class="n">${mod30}</div><div class="l">Modificaciones (30 días)</div></div>
        <div class="stat prosp"><div class="n">${nVer}<span style="font-size:14px;color:var(--muted)"> / ${nProp} prop.</span></div><div class="l">Nº CIMA verificados</div></div>
      </div>
      <div class="controls ftfiltros">
        <div class="ctrl" style="flex:1 1 260px"><label>Buscar</label>
          <input type="search" id="epiQ" class="ginput" style="min-width:0" value="${escH(f.q)}" placeholder="Medicamento, Nº CIMA, Nº UE (EU/1/…)"></div>
        <div class="ctrl"><label>Agencia</label><select id="epiAg" style="min-width:130px"><option value="">Todas</option>
          <option value="EMA">EMA (centralizado)</option><option value="AEMPS">AEMPS (España)</option></select></div>
        <div class="ctrl"><label>Documento</label><select id="epiTipo" style="min-width:150px"><option value="">Todos</option>
          ${tipos.map(t => `<option value="${escH(t)}">${escH(tipoTxt(t))}</option>`).join('')}</select></div>
        <div class="ctrl"><label>Idioma</label><select id="epiIdioma" style="min-width:110px"><option value="">Todos</option>
          ${idiomas.map(i => `<option value="${escH(i)}">${escH(idiomaTxt(i))} · ${escH(i)}</option>`).join('')}</select></div>
        <div class="ctrl"><label>Vínculo CIMA</label><select id="epiVinc" style="min-width:150px"><option value="">Todos</option>
          <option value="verificado">Verificado</option><option value="propuesto">Pendiente de revisar</option><option value="sin">Sin vínculo</option></select></div>
        <span class="gnote" id="epiCuenta" style="margin:0 0 8px"></span>
      </div>
      <div class="table-scroll"><table class="sgm"><thead><tr>
        <th>Nº</th><th>Producto</th><th>Agencia</th><th>Documentos</th><th>Nº CIMA vinculado</th><th>Último cambio</th><th>Acción</th></tr></thead>
      <tbody>${grupos.map((g, i) => {
        const abierto = st.abiertos.has(g.k);
        const estV = g.vinc.some(v => v.estado === 'verificado') ? 'verificado' : g.vinc.some(v => v.estado === 'propuesto') ? 'propuesto' : 'sin';
        const docsChips = g.tipos.map(t => `<span class="tag ${tipoCls(t)}">${escH(tipoTxt(t))}</span>`).join(' ');
        return `<tr class="grp${abierto ? ' open' : ''}" data-k="${escH(g.k)}" data-buscar="${escH(g.buscar)}"
            data-ag="${escH(g.agencia)}" data-tipos="${escH(g.tipos.join('\n'))}" data-idiomas="${escH(g.idiomas.join('\n'))}" data-vinc="${estV}">
          <td class="num">${i + 1}</td>
          <td class="prod">${escH(g.nombre || '—')}<span class="cmono">${g.docs.length} documento(s) · ${g.idiomas.map(idiomaTxt).join(', ')}</span></td>
          <td><span class="vchip">${escH(g.agencia)}</span></td>
          <td>${docsChips}</td>
          <td style="min-width:200px">${g.vinc.filter(v => v.estado !== 'rechazado').map(v => chipVinculo(v, false)).join('') || '<span style="color:var(--muted)">—</span>'}</td>
          <td class="nreg">${g.ultimo ? `${escH(fmtFecha(g.ultimo.fecha_deteccion))}<span class="cmono">${g.ultimo.tipo_cambio === 'contenido_modificado' ? '✎ modificado' : 'nuevo'}</span>` : '—'}</td>
          <td><button type="button" class="tgl"><span class="car">▸</span> Detalle</button></td></tr>
        <tr class="det" data-k="${escH(g.k)}"${abierto ? '' : ' hidden'}><td colspan="7">${detalle(g)}</td></tr>`;
      }).join('')}</tbody></table></div>
      <footer>Fuente: <a href="https://epi.ema.europa.eu" target="_blank" rel="noopener">EMA ePI (API FHIR oficial)</a> ·
        datos cargados por el repo <code>EMA-APi</code> (GitHub Actions, diario). El piloto ePI de la EMA cubre pocos productos:
        es una fuente complementaria a CIMA, no la reemplaza.</footer>`;

    $('epiAg').value = f.agencia; $('epiTipo').value = f.tipo; $('epiIdioma').value = f.idioma; $('epiVinc').value = f.vinculo;
    const aplicar = () => {
      f.q = $('epiQ').value; f.agencia = $('epiAg').value; f.tipo = $('epiTipo').value;
      f.idioma = $('epiIdioma').value; f.vinculo = $('epiVinc').value;
      const q = f.q.trim().toLowerCase();
      let n = 0;
      $('epiCuerpo').querySelectorAll('tr.grp').forEach(tr => {
        const ok = (!q || tr.dataset.buscar.includes(q)) && (!f.agencia || tr.dataset.ag === f.agencia)
          && (!f.tipo || tr.dataset.tipos.split('\n').includes(f.tipo))
          && (!f.idioma || tr.dataset.idiomas.split('\n').includes(f.idioma))
          && (!f.vinculo || tr.dataset.vinc === f.vinculo);
        tr.hidden = !ok; tr.nextElementSibling.hidden = !ok || !tr.classList.contains('open');
        if (ok) n++;
      });
      const activos = q || f.agencia || f.tipo || f.idioma || f.vinculo;
      $('epiCuenta').textContent = activos ? `${n} de ${grupos.length} producto(s)` : '';
    };
    $('epiQ').oninput = aplicar;
    ['epiAg', 'epiTipo', 'epiIdioma', 'epiVinc'].forEach(id => $(id).onchange = aplicar);
    aplicar();

    $('epiCuerpo').querySelector('table.sgm > tbody').onclick = async e => {
      const ver = e.target.closest('button.epi-ver');
      if (ver) { verSecciones(ver.dataset.id); return; }
      const fi = e.target.closest('button.epi-ficha');
      if (fi) { irAFichas(fi.dataset.n); return; }
      const bv = e.target.closest('button.epi-v');
      if (bv) { await cambiarVinculo(bv); return; }
      if (e.target.closest('a')) return;
      const grp = e.target.closest('tr.grp');
      if (grp) {
        const ab = grp.classList.toggle('open');
        grp.nextElementSibling.hidden = !ab;
        ab ? st.abiertos.add(grp.dataset.k) : st.abiertos.delete(grp.dataset.k);
      }
    };
  }

  async function cambiarVinculo(btn) {
    const estado = btn.dataset.e;
    btn.disabled = true;
    const { error } = await sb.from('ema_epi_cima_vinculo')
      .update({ estado, verificado_por: yo && yo.id, verificado_en: new Date().toISOString() })
      .eq('id', btn.dataset.id);
    if (error) { alert('No se pudo actualizar el vínculo: ' + error.message); btn.disabled = false; return; }
    const v = st.vinculos.find(x => x.id === btn.dataset.id);
    if (v) { v.estado = estado; v.verificado_en = new Date().toISOString(); }
    pintar();
  }

  async function verSecciones(id) {
    const d = st.docs.find(x => x.id === id);
    abrirPanel(`${tipoTxt(d && d.tipo_documento)} · ${d ? d.nombre_medicamento : ''}`,
      d ? `${d.agencia} · ${d.idioma || ''} · Bundle ${d.bundle_id}` : '', cargando('Cargando secciones…'));
    const { data, error } = await sb.from('ema_epi_documentos').select('contenido_secciones').eq('id', id).single();
    if (error) { $('segCuerpo').innerHTML = `<div class="err" style="display:block">${escH(error.message)}</div>`; return; }
    const secs = data.contenido_secciones || [];
    if (!secs.length) {
      $('segCuerpo').innerHTML = `<div class="empty">El texto de este documento aún no está cargado.<br>
        Se completa en la próxima corrida del monitor en que la API de la EMA responda.</div>`;
      return;
    }
    $('segCuerpo').innerHTML = secs.map((s, i) => `<details class="campo" data-i="${i}" style="margin-left:${Math.min(s.nivel || 0, 4) * 14}px">
      <summary><span class="cod">${escH(s.codigo || '')}</span><span class="tit">${escH(s.titulo || '(sin título)')}</span>
      <span class="src">${(s.texto || '').length.toLocaleString('es-PE')} car.</span></summary><div class="contenido"></div></details>`).join('');
    $('segCuerpo').querySelectorAll('details.campo').forEach(det => det.addEventListener('toggle', () => {
      const box = det.querySelector('.contenido');
      if (!det.open || box.dataset.ok) return;
      const s = secs[+det.dataset.i];
      box.innerHTML = s.html ? DOMPurify.sanitize(s.html, { FORBID_ATTR: ['style'] })
        : `<p>${escH(s.texto || '')}</p>`;
      box.dataset.ok = '1';
    }));
  }

  function init() {
    const b = document.getElementById('epiRecargar');
    if (b) b.onclick = () => cargar();
  }
  document.addEventListener('DOMContentLoaded', init);

  global.EmaEpi = { cargar };
})(window);
