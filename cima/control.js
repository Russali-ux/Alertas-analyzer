/*
 * control.js — Control de versiones y control de cambios de documentos
 * generados (FT / Inserto / Etiqueta). Esquema: cima/sql/control_versiones.sql
 *
 * Toda escritura va por la RPC guardar_version_documento: el servidor asigna
 * códigos, número de versión, fecha/hora, usuario y hashes SHA-256, y calcula
 * qué secciones cambiaron. Aquí solo se arma el contenido, se muestran las
 * diferencias (informativas) y se consultan historial e integridad.
 *
 * Usa globals de cima/index.html: sb, escH, abrirPanel, cargando, mostrarTab,
 * y de otros módulos: Segmentador, Generador, Plantillas, Diff (jsdiff).
 */
(function (global) {
  'use strict';

  const esc = s => escH(s);
  const TZ = 'America/Lima';
  const fechaHora = iso => iso ? new Date(iso).toLocaleString('es-PE', {
    timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '—';
  const corto = h => h ? h.slice(0, 12) + '…' : '—';

  // ── Texto plano de un HTML (mismo criterio de bloques que el segmentador) ──
  function htmlATexto(html) {
    if (!html) return '';
    return global.Segmentador._bloquesDesdeHTML(html).map(b => b.texto).join('\n').trim();
  }
  const normal = t => (t || '').replace(/\s+/g, ' ').trim();

  // ── Diferencias palabra a palabra (solo visual; lo que vale es el servidor) ─
  function diffHTML(antes, despues) {
    const a = antes || '', b = despues || '';
    if (!global.Diff) return `<p class="gnote">No se pudo cargar el comparador.</p>`;
    // En textos muy largos se compara por líneas para no bloquear el navegador.
    const partes = (a.length + b.length > 60000) ? global.Diff.diffLines(a, b) : global.Diff.diffWordsWithSpace(a, b);
    return partes.map(p => {
      const t = esc(p.value).replace(/\n/g, '<br>');
      return p.added ? `<ins>${t}</ins>` : p.removed ? `<del>${t}</del>` : `<span>${t}</span>`;
    }).join('');
  }

  /** Compara secciones actuales vs base por clave. Devuelve {porClave, eliminadas, agregadas, modificadas}. */
  function compararConBase(secciones, base) {
    const porClave = {};
    let ag = 0, mod = 0;
    const vistas = new Set();
    for (const s of secciones) {
      vistas.add(s.clave);
      const b = base.secciones[s.clave];
      const actual = htmlATexto(s.html);
      if (!b) { porClave[s.clave] = { tipo: 'AGREGADA', antes: '', despues: actual }; ag++; continue; }
      const igual = normal(b.texto) === normal(actual);
      porClave[s.clave] = { tipo: igual ? 'SIN_CAMBIOS' : 'MODIFICADA', antes: b.texto, despues: actual };
      if (!igual) mod++;
    }
    const eliminadas = Object.values(base.secciones).filter(b => !vistas.has(b.clave));
    return { porClave, eliminadas, agregadas: ag, modificadas: mod, total: ag + mod + eliminadas.length };
  }

  // ════════════════════════════════════════════════════════════════════════
  // API (Supabase)
  // ════════════════════════════════════════════════════════════════════════
  async function guardarVersion(doc, motivo) {
    const L = doc.idioma;
    const secciones = doc.secciones.map((s, i) => ({
      orden: i + 1, clave: s.clave, titulo: s.def.titulo[L], critica: !!s.def.critica,
      estado: s.editado ? 'editado' : s.estado, html: s.html || '', texto: htmlATexto(s.html),
    }));
    const { data, error } = await sb.rpc('guardar_version_documento', {
      p_documento_id: doc.familia ? doc.familia.documentoId : null,
      p_version_base_id: doc.base ? doc.base.versionId : null,
      p_tipo_documento: doc.tipo, p_pais: doc.pais, p_idioma: doc.idioma,
      p_producto: doc.producto, p_nregistro: doc.fuenteNreg || null,
      p_norma: doc.plantilla.norma[L],
      p_referencia_segmentado_id: doc.referenciaId || null,
      p_referencia_descripcion: doc.fuente,
      p_motivo: motivo, p_secciones: secciones,
    });
    if (error) throw new Error(error.message);
    return data;
  }

  async function cargarVersion(versionId) {
    const { data: v, error } = await sb.from('documento_versiones').select('*').eq('id', versionId).single();
    if (error) throw new Error(error.message);
    const [{ data: d, error: e1 }, { data: secs, error: e2 }, { data: cc, error: e3 }] = await Promise.all([
      sb.from('v_documentos_controlados').select('*').eq('id', v.documento_id).single(),
      sb.from('documento_version_secciones').select('*').eq('version_id', versionId).order('orden'),
      sb.from('control_cambios').select('codigo, tipo').eq('version_id', versionId).maybeSingle(),
    ]);
    if (e1 || e2 || e3) throw new Error((e1 || e2 || e3).message);
    return { version: v, documento: d, secciones: secs || [], control: cc };
  }

  /** Base de comparación a partir de una versión guardada. */
  function baseDesde(cv) {
    return {
      versionId: cv.version.id, version: cv.version.version, codigoVersion: cv.version.codigo_version,
      secciones: Object.fromEntries(cv.secciones.map(s => [s.clave, { clave: s.clave, titulo: s.titulo, texto: s.texto, html: s.html }])),
    };
  }

  /** Versiones controladas que usan cada documento segmentado como referencia. */
  async function versionesPorReferencia(ids) {
    if (!ids.length) return {};
    const { data, error } = await sb.from('documento_versiones')
      .select('id, version, codigo_version, referencia_segmentado_id, documento_id')
      .in('referencia_segmentado_id', ids);
    if (error) throw new Error(error.message);
    const docIds = [...new Set((data || []).map(v => v.documento_id))];
    const { data: docs, error: e2 } = docIds.length
      ? await sb.from('v_documentos_controlados').select('id, codigo, version_vigente, codigo_version_vigente, total_versiones, total_cambios').in('id', docIds)
      : { data: [] };
    if (e2) throw new Error(e2.message);
    const porDoc = Object.fromEntries((docs || []).map(d => [d.id, d]));
    const out = {};
    for (const v of data || []) (out[v.referencia_segmentado_id] ||= []).push({ ...v, documento: porDoc[v.documento_id] });
    return out;
  }

  async function registrarEvento(versionId, evento) {
    try { await sb.rpc('registrar_evento_documento', { p_version_id: versionId, p_evento: evento }); }
    catch (e) { console.warn('No se registró el evento', evento, e); }
  }

  // ════════════════════════════════════════════════════════════════════════
  // Modal: guardar versión controlada
  // ════════════════════════════════════════════════════════════════════════
  function abrirGuardar(doc, alGuardar) {
    const esNueva = !!doc.familia;
    const cmp = doc.base ? compararConBase(doc.secciones, doc.base) : null;
    const vigente = doc.familia && doc.familia.versionVigente;
    const baseNoVigente = doc.base && vigente && doc.base.version !== vigente;
    const sinCambios = cmp && cmp.total === 0;

    const lista = cmp ? [
      ...doc.secciones.filter(s => cmp.porClave[s.clave].tipo !== 'SIN_CAMBIOS')
        .map(s => `<li><span class="ctipo ${cmp.porClave[s.clave].tipo.toLowerCase()}">${cmp.porClave[s.clave].tipo}</span> ${esc(s.num)}. ${esc(s.def.titulo[doc.idioma])}</li>`),
      ...cmp.eliminadas.map(b => `<li><span class="ctipo eliminada">ELIMINADA</span> ${esc(b.titulo)}</li>`),
    ].join('') : '';

    abrirPanel(esNueva ? 'Guardar nueva versión controlada' : 'Guardar versión controlada (emisión inicial)',
      `${doc.producto}`, `
      <div class="cgrid">
        <div><label>Documento</label><b>${esNueva ? esc(doc.familia.codigo) : 'Se asignará al guardar (CKS-…)'}</b></div>
        <div><label>Versión a crear</label><b>${esNueva ? 'V' + String((vigente || 0) + 1).padStart(2, '0') : 'V01'}</b><small>el servidor asigna el número definitivo</small></div>
        <div><label>Versión base</label><b>${doc.base ? esc(doc.base.codigoVersion) : '— (emisión inicial)'}</b></div>
        <div><label>Referencia</label><span>${esc(doc.fuente)}</span></div>
      </div>
      ${baseNoVigente ? `<div class="gaviso">⚠ La versión base (V${String(doc.base.version).padStart(2, '0')}) no es la vigente (V${String(vigente).padStart(2, '0')}). La nueva versión quedará registrada como derivada de la base elegida.</div>` : ''}
      ${cmp ? `<div class="cresumen"><b>Cambios respecto de ${esc(doc.base.codigoVersion)}:</b>
          ${cmp.agregadas} agregada(s) · ${cmp.modificadas} modificada(s) · ${cmp.eliminadas.length} eliminada(s)
          ${lista ? `<ul>${lista}</ul>` : ''}</div>` : ''}
      ${sinCambios ? `<div class="err" style="display:block">No hay cambios respecto de la versión base: no se puede crear una versión nueva.</div>` : `
      <label class="clabel" for="ctlMotivo">Motivo del cambio <span class="req">*</span></label>
      <textarea id="ctlMotivo" class="ctextarea" rows="3" maxlength="1000"
        placeholder="${esNueva ? 'Ej.: Actualización de la sección c.4 según nueva ficha técnica de CIMA del 23/09/2026.' : 'Ej.: Emisión inicial de la ficha técnica para registro en DIGEMID.'}"></textarea>
      <div class="ccontador" id="ctlContador">0 / 10 caracteres mínimos</div>
      <label class="ccheck"><input type="checkbox" id="ctlConfirmo"> Declaro que revisé el contenido y que este registro es exacto y completo.</label>
      <p class="gnote">Se registrarán automáticamente: su usuario, la fecha y hora del servidor, el hash SHA-256 del contenido y un código de control de cambio.
        <b>Las versiones guardadas no se pueden modificar ni eliminar</b>; cualquier corrección se hace con una nueva versión.</p>
      <div class="bar"><button type="button" class="btn" id="ctlGuardar" disabled>💾 Guardar versión</button>
        <span class="cfalta" id="ctlFalta"></span>
        <span class="estado" id="ctlEstado"></span></div>`}`);

    if (sinCambios) return;
    const motivo = document.getElementById('ctlMotivo'), chk = document.getElementById('ctlConfirmo'), btn = document.getElementById('ctlGuardar');
    const contador = document.getElementById('ctlContador'), falta = document.getElementById('ctlFalta');
    // El motivo es un requisito de auditoría: se explica en pantalla qué falta en lugar de solo bloquear el botón.
    const validar = () => {
      const n = motivo.value.trim().length;
      contador.textContent = n >= 10 ? `✓ ${n} caracteres` : `${n} / 10 caracteres mínimos`;
      contador.classList.toggle('ok', n >= 10);
      const faltan = [];
      if (n < 10) faltan.push(`escriba un motivo descriptivo (faltan ${10 - n} caracteres)`);
      if (!chk.checked) faltan.push('marque la declaración de revisión');
      falta.textContent = faltan.length ? 'Para guardar: ' + faltan.join(' y ') + '.' : '';
      btn.disabled = faltan.length > 0;
    };
    motivo.oninput = validar; chk.onchange = validar;
    validar();
    motivo.focus();
    btn.onclick = async () => {
      btn.disabled = true; document.getElementById('ctlEstado').textContent = '⏳ Guardando…';
      try {
        const r = await guardarVersion(doc, motivo.value.trim());
        alGuardar(r);
        document.getElementById('segCuerpo').innerHTML = `
          <div class="estado ok" style="display:inline-block">✓ Versión controlada guardada</div>
          <div class="cgrid" style="margin-top:14px">
            <div><label>Código interno</label><b>${esc(r.codigo_version)}</b></div>
            <div><label>Versión</label><b>V${String(r.version).padStart(2, '0')}</b></div>
            <div><label>Fecha y hora (Lima)</label><b>${fechaHora(r.creado_en)}</b></div>
            <div><label>Control de cambio</label><b>${esc(r.control_codigo)}</b><small>${r.tipo_control === 'EMISION_INICIAL' ? 'Emisión inicial' : `+${r.agregadas} ~${r.modificadas} −${r.eliminadas}`}</small></div>
            <div><label>Usuario</label><span>${esc(r.creado_por_email || '')}</span></div>
            <div><label>SHA-256 contenido</label><code class="chash">${esc(r.hash_contenido)}</code></div>
          </div>`;
      } catch (e) {
        document.getElementById('ctlEstado').innerHTML = `<span style="color:#a11">⚠ ${esc(e.message)}</span>`;
        validar();
      }
    };
  }

  // ════════════════════════════════════════════════════════════════════════
  // Historial de un documento controlado
  // ════════════════════════════════════════════════════════════════════════
  async function abrirHistorial(documentoId) {
    abrirPanel('Historial de versiones', '', cargando('Cargando historial…'));
    try {
      const [{ data: d, error: e1 }, { data: vs, error: e2 }, { data: ccs, error: e3 }] = await Promise.all([
        sb.from('v_documentos_controlados').select('*').eq('id', documentoId).single(),
        sb.from('documento_versiones').select('id, version, codigo_version, version_base_id, referencia_descripcion, hash_contenido, hash_cadena, creado_por_email, creado_por_nombre, creado_en').eq('documento_id', documentoId).order('version', { ascending: false }),
        sb.from('control_cambios').select('*, control_cambios_detalle(clave, titulo, tipo_cambio)').eq('documento_id', documentoId),
      ]);
      if (e1 || e2 || e3) throw new Error((e1 || e2 || e3).message);
      const ccPorVersion = Object.fromEntries((ccs || []).map(c => [c.version_id, c]));
      const codPorId = Object.fromEntries(vs.map(v => [v.id, v.codigo_version]));
      const tipoNom = { FT: 'Ficha técnica', INSERTO: 'Inserto', ETIQUETA: 'Etiqueta' }[d.tipo_documento] || d.tipo_documento;

      abrirPanel(`Historial · ${d.codigo}`, `${d.producto} · ${tipoNom} · ${d.pais} · ${d.idioma.toUpperCase()}`, `
        <div class="cstats">
          <div><b>${d.total_versiones}</b><span>versiones</span></div>
          <div><b>${d.total_cambios}</b><span>controles de cambio (actualizaciones)</span></div>
          <div><b>V${String(d.version_vigente).padStart(2, '0')}</b><span>vigente desde ${fechaHora(d.ultima_fecha)}</span></div>
          <div><b>${esc(d.creado_por_email || '—')}</b><span>emitió el ${fechaHora(d.creado_en)}</span></div>
        </div>
        <div class="bar">
          <button type="button" class="btn" id="ctlActualizar">🔄 Nueva versión (actualizar)</button>
          <button type="button" class="btn ghost" id="ctlComparar">⇄ Comparar versiones</button>
          <button type="button" class="btn ghost" id="ctlVerificar">🛡 Verificar integridad</button>
          <span class="estado" id="ctlVerEstado"></span>
        </div>
        <div id="ctlZona"></div>
        <div class="table-scroll"><table class="hist ctimeline"><thead><tr>
          <th>Versión</th><th>Fecha y hora (Lima)</th><th>Usuario</th><th>Control de cambio</th><th class="med">Motivo</th><th>Secciones</th><th>SHA-256</th><th class="acc">Acciones</th>
        </tr></thead><tbody>
        ${vs.map(v => {
          const c = ccPorVersion[v.id] || {};
          const det = (c.control_cambios_detalle || []).map(x => `<li><span class="ctipo ${x.tipo_cambio.toLowerCase()}">${x.tipo_cambio}</span> ${esc(x.clave)} · ${esc(x.titulo)}</li>`).join('');
          return `<tr data-v="${esc(v.id)}">
            <td><b>V${String(v.version).padStart(2, '0')}</b>${v.version === d.version_vigente ? ' <span class="gchip">vigente</span>' : ''}<div class="cmono">${esc(v.codigo_version)}</div></td>
            <td class="nreg">${fechaHora(v.creado_en)}</td>
            <td>${esc(v.creado_por_nombre || '')}<div class="cmono">${esc(v.creado_por_email || '')}</div></td>
            <td><b>${esc(c.codigo || '—')}</b><div class="cmono">${c.tipo === 'EMISION_INICIAL' ? 'Emisión inicial' : `Base: ${esc(codPorId[c.version_base_id] || '—')}`}</div></td>
            <td class="med">${esc(c.motivo || '')}${det ? `<details class="cdet"><summary>Ver secciones</summary><ul>${det}</ul></details>` : ''}<div class="cmono">Ref.: ${esc(v.referencia_descripcion || '—')}</div></td>
            <td class="nreg">${c.tipo === 'ACTUALIZACION' ? `+${c.secciones_agregadas} ~${c.secciones_modificadas} −${c.secciones_eliminadas}` : '—'}</td>
            <td><code class="chash" title="Contenido: ${esc(v.hash_contenido)}&#10;Cadena: ${esc(v.hash_cadena)}">${corto(v.hash_contenido)}</code></td>
            <td class="acc"><button type="button" class="mini abrir" data-abrir="${esc(v.id)}">Abrir</button></td>
          </tr>`;
        }).join('')}
        </tbody></table></div>`);

      const zona = document.getElementById('ctlZona');
      document.querySelectorAll('[data-abrir]').forEach(b => b.onclick = () => abrirVersionEnGenerador(b.dataset.abrir));

      document.getElementById('ctlVerificar').onclick = async () => {
        const est = document.getElementById('ctlVerEstado');
        est.textContent = '⏳ Recalculando hashes…'; est.className = 'estado';
        const { data, error } = await sb.rpc('verificar_integridad_documento', { p_documento_id: documentoId });
        if (error) { est.textContent = '⚠ ' + error.message; est.className = 'estado warn'; return; }
        const malas = data.filter(r => !(r.secciones_ok && r.contenido_ok && r.cadena_ok));
        est.className = 'estado ' + (malas.length ? 'warn' : 'ok');
        est.textContent = malas.length
          ? `⚠ Integridad comprometida en: ${malas.map(r => r.codigo_version).join(', ')}`
          : `✓ Integridad verificada: ${data.length} versión(es), hashes y cadena correctos (${fechaHora(new Date().toISOString())})`;
      };

      const opts = sel => vs.map(v => `<option value="${esc(v.id)}"${v.id === sel ? ' selected' : ''}>V${String(v.version).padStart(2, '0')} · ${fechaHora(v.creado_en)}</option>`).join('');

      document.getElementById('ctlComparar').onclick = () => {
        zona.innerHTML = `<div class="czona"><b>Comparar versiones</b>
          <div class="bar"><select id="cmpA">${opts(vs[1] ? vs[1].id : vs[0].id)}</select> → <select id="cmpB">${opts(vs[0].id)}</select>
          <button type="button" class="btn" id="cmpIr">Comparar</button></div><div id="cmpRes"></div></div>`;
        document.getElementById('cmpIr').onclick = async () => {
          const res = document.getElementById('cmpRes');
          res.innerHTML = cargando('Comparando…');
          try {
            const [a, b] = await Promise.all([cargarVersion(document.getElementById('cmpA').value), cargarVersion(document.getElementById('cmpB').value)]);
            res.innerHTML = htmlComparacion(a, b);
          } catch (e) { res.innerHTML = `<div class="err" style="display:block">${esc(e.message)}</div>`; }
        };
      };

      document.getElementById('ctlActualizar').onclick = () => {
        zona.innerHTML = `<div class="czona"><b>Nueva versión (actualización)</b>
          <ol class="cpasos">
            <li>Versión anterior (base): <select id="actBase">${opts(vs[0].id)}</select></li>
            <li>Nueva versión de referencia:
              <div class="bar">
                <label class="btn ghost" for="actArchivo">⬆ Subir ficha técnica / prospecto</label>
                <input type="file" id="actArchivo" accept=".pdf,.docx,.html,.htm" hidden>
                ${d.nregistro ? `<button type="button" class="btn ghost" id="actCima">☁ Usar la versión vigente en CIMA (Nº ${esc(d.nregistro)})</button>` : ''}
              </div></li>
            <li>Se ejecuta la separación y se muestran las diferencias contra la base. Revise, edite y guarde la nueva versión.</li>
          </ol><div id="actEstado" class="gnote"></div></div>`;
        const base = () => document.getElementById('actBase').value;
        const est = document.getElementById('actEstado');
        const correr = async fn => {
          est.textContent = '⏳ Ejecutando separación…';
          try { await fn(); } catch (e) { est.innerHTML = `<span style="color:#a11">⚠ ${e.message.includes('<a ') ? e.message : esc(e.message)}</span>`; }
        };
        document.getElementById('actArchivo').onchange = e => {
          const f = e.target.files[0];
          if (f) correr(() => global.Generador.actualizarVersion({ documento: d, baseVersionId: base(), archivo: f }));
        };
        const bc = document.getElementById('actCima');
        if (bc) bc.onclick = () => correr(() => global.Generador.actualizarVersion({ documento: d, baseVersionId: base(), nregistro: d.nregistro }));
      };
    } catch (e) {
      document.getElementById('segCuerpo').innerHTML = `<div class="err" style="display:block">${esc(e.message)}</div>`;
    }
  }

  function htmlComparacion(a, b) {
    const A = Object.fromEntries(a.secciones.map(s => [s.clave, s]));
    const B = Object.fromEntries(b.secciones.map(s => [s.clave, s]));
    const claves = [...new Set([...a.secciones.map(s => s.clave), ...b.secciones.map(s => s.clave)])];
    const cambios = claves.map(k => {
      const x = A[k], y = B[k];
      const tipo = !x ? 'AGREGADA' : !y ? 'ELIMINADA' : x.hash_texto !== y.hash_texto ? 'MODIFICADA' : null;
      return tipo && { k, tipo, titulo: (y || x).titulo, antes: x ? x.texto : '', despues: y ? y.texto : '' };
    }).filter(Boolean);
    const ca = a.version.codigo_version, cb = b.version.codigo_version;
    if (!cambios.length) return `<p class="gnote">${esc(ca)} y ${esc(cb)} tienen el mismo contenido.</p>`;
    return `<p class="gnote">${cambios.length} sección(es) con diferencias entre <b>${esc(ca)}</b> y <b>${esc(cb)}</b>
        (<del>eliminado</del> · <ins>agregado</ins>).</p>
      ${cambios.map(c => `<details class="cdiff" open><summary><span class="ctipo ${c.tipo.toLowerCase()}">${c.tipo}</span> ${esc(c.k)} · ${esc(c.titulo)}</summary>
        <div class="cdiff-b">${diffHTML(c.antes, c.despues)}</div></details>`).join('')}`;
  }

  async function abrirVersionEnGenerador(versionId) {
    document.getElementById('segCuerpo').innerHTML = cargando('Abriendo versión…');
    try {
      const cv = await cargarVersion(versionId);
      global.Generador.abrirVersion(cv);
      cerrarPanel();
    } catch (e) {
      document.getElementById('segCuerpo').innerHTML = `<div class="err" style="display:block">${esc(e.message)}</div>`;
    }
  }

  global.Control = {
    htmlATexto, diffHTML, compararConBase, guardarVersion, cargarVersion, baseDesde,
    versionesPorReferencia, registrarEvento, abrirGuardar, abrirHistorial, fechaHora,
  };
})(window);
