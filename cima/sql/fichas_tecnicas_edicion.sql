-- ════════════════════════════════════════════════════════════════════════════
-- FICHAS TÉCNICAS · EDICIÓN AUDITADA DE DATOS DEL DOCUMENTO
-- (ALCOA+ · 21 CFR Part 11 · EU GMP Anexo 11)
--
-- Ejecutar DESPUÉS de segmentados_auditoria.sql.
--
-- Motivo: un PDF subido (p. ej. FT DIGEMID del titular) no siempre tiene una
-- FT de referencia en CIMA. El administrador (o quien lo subió) necesita
-- completar/corregir sus datos: nombre, laboratorio, fuente, fecha de versión
-- y el registro sanitario del portafolio al que pertenece.
--
--  · Las SECCIONES (documento_secciones) siguen siendo inmutables.
--  · Solo se editan datos descriptivos, y solo vía la RPC
--    editar_documento_segmentado(p_id, p_cambios, p_motivo), con motivo
--    obligatorio y evento EDITAR en la bitácora (antes → después).
--  · Documentos de origen CIMA: solo se puede cambiar el registro sanitario
--    vinculado y la fuente (nombre / Nº / laboratorio vienen de CIMA).
-- Idempotente.
-- ════════════════════════════════════════════════════════════════════════════

-- ── 1. Columnas nuevas ──────────────────────────────────────────────────────
alter table public.documentos_segmentados
  add column if not exists fuente_referencia        text,         -- DIGEMID, Fabricante, EMA, AEMPS (CIMA), Otra…
  add column if not exists fecha_version_documento  date,         -- fecha de revisión que figura en el documento
  -- Sin FK a propósito: un ON DELETE SET NULL chocaría con el trigger de inmutabilidad
  -- y bloquearía borrar un producto del portafolio. El snapshot rs_* conserva el dato.
  add column if not exists medicamento_id           uuid,
  add column if not exists rs_numero                text,         -- snapshot del registro sanitario al vincular
  add column if not exists rs_producto              text,
  add column if not exists rs_principio_activo      text,
  add column if not exists editado_en               timestamptz,
  add column if not exists editado_por              uuid,
  add column if not exists editado_por_nombre       text;

create index if not exists documentos_segmentados_medicamento_idx
  on public.documentos_segmentados (medicamento_id);

-- ── 2. Bitácora: nuevo evento EDITAR ────────────────────────────────────────
alter table public.documentos_segmentados_auditoria
  drop constraint if exists documentos_segmentados_auditoria_evento_check;
alter table public.documentos_segmentados_auditoria
  add constraint documentos_segmentados_auditoria_evento_check
  check (evento in ('CREAR', 'ELIMINAR', 'DESCARTAR_INCOMPLETO', 'EDITAR'));

-- ── 3. Trigger de UPDATE: además de eliminar, permite editar los datos
--       descriptivos, pero SOLO cuando lo hace la RPC (bandera de transacción).
create or replace function public.docseg_trg_update()
returns trigger language plpgsql set search_path = '' as $$
declare
  cols_elim text[] := array['eliminado_en','eliminado_por','eliminado_por_email','eliminado_por_nombre','motivo_eliminacion'];
  cols_edit text[] := array['nombre_medicamento','laboratorio_titular','nregistro','fuente_referencia',
                            'fecha_version_documento','medicamento_id','rs_numero','rs_producto',
                            'rs_principio_activo','editado_en','editado_por','editado_por_nombre'];
  permitidas text[] := cols_elim;
begin
  if old.eliminado_en is not null then
    raise exception 'El documento segmentado ya fue eliminado: el registro es de solo lectura.' using errcode = '42501';
  end if;
  if coalesce(current_setting('app.docseg_editar', true), '') = 'on' then
    permitidas := cols_elim || cols_edit;
  end if;
  if (to_jsonb(new) - permitidas) is distinct from (to_jsonb(old) - permitidas) then
    raise exception 'El contenido de un documento segmentado no se puede modificar.' using errcode = '42501';
  end if;
  return new;
end;
$$;

-- ── 4. RPC: editar datos del documento (única vía) ──────────────────────────
-- p_cambios: objeto JSON con cualquiera de estas claves (null o '' = vaciar):
--   nombre_medicamento, laboratorio_titular, nregistro, fuente_referencia,
--   fecha_version_documento ('AAAA-MM-DD'), medicamento_id (uuid)
create or replace function public.editar_documento_segmentado(p_id uuid, p_cambios jsonb, p_motivo text)
returns jsonb language plpgsql security definer set search_path = 'public' as $$
declare
  v_uid    uuid := auth.uid();
  v_old    public.documentos_segmentados;
  v_new    public.documentos_segmentados;
  v_email  text; v_nombre text;
  v_med    public.medicamentos;
  v_claves text[] := array['nombre_medicamento','laboratorio_titular','nregistro','fuente_referencia',
                           'fecha_version_documento','medicamento_id'];
  v_solo_cima text[] := array['fuente_referencia','medicamento_id'];
  k        text;
  v_diff   jsonb := '{}'::jsonb;
  txt      text;
begin
  if v_uid is null or not public.tiene_acceso_cima() then
    raise exception 'Sin acceso al módulo CIMA.' using errcode = '42501';
  end if;
  if length(btrim(coalesce(p_motivo, ''))) < 10 then
    raise exception 'El motivo de la edición es obligatorio (mínimo 10 caracteres).';
  end if;
  if p_cambios is null or jsonb_typeof(p_cambios) <> 'object' then
    raise exception 'No se indicaron cambios.';
  end if;
  for k in select jsonb_object_keys(p_cambios) loop
    if not (k = any (v_claves)) then
      raise exception 'Campo no editable: %', k;
    end if;
  end loop;

  select * into v_old from public.documentos_segmentados where id = p_id for update;
  if not found then raise exception 'Documento no encontrado.'; end if;
  if v_old.eliminado_en is not null then raise exception 'El documento está eliminado: no se puede editar.'; end if;
  if not (public.es_admin() or v_old.creado_por = v_uid) then
    raise exception 'Solo quien guardó el documento o un administrador puede editarlo.' using errcode = '42501';
  end if;
  if v_old.origen = 'cima' then
    for k in select jsonb_object_keys(p_cambios) loop
      if not (k = any (v_solo_cima)) then
        raise exception 'En un documento de CIMA solo se puede cambiar el registro sanitario vinculado y la fuente (el resto viene de CIMA).';
      end if;
    end loop;
  end if;

  v_new := v_old;
  if p_cambios ? 'nombre_medicamento' then
    txt := nullif(btrim(p_cambios->>'nombre_medicamento'), '');
    if txt is null then raise exception 'El nombre del medicamento no puede quedar vacío.'; end if;
    v_new.nombre_medicamento := txt;
  end if;
  if p_cambios ? 'laboratorio_titular' then v_new.laboratorio_titular := nullif(btrim(p_cambios->>'laboratorio_titular'), ''); end if;
  if p_cambios ? 'nregistro'           then v_new.nregistro           := nullif(btrim(p_cambios->>'nregistro'), ''); end if;
  if p_cambios ? 'fuente_referencia'   then v_new.fuente_referencia   := nullif(btrim(p_cambios->>'fuente_referencia'), ''); end if;
  if p_cambios ? 'fecha_version_documento' then
    v_new.fecha_version_documento := nullif(btrim(p_cambios->>'fecha_version_documento'), '')::date;
  end if;
  if p_cambios ? 'medicamento_id' then
    if nullif(p_cambios->>'medicamento_id', '') is null then
      v_new.medicamento_id := null; v_new.rs_numero := null; v_new.rs_producto := null; v_new.rs_principio_activo := null;
    else
      select * into v_med from public.medicamentos where id = (p_cambios->>'medicamento_id')::uuid;
      if not found then raise exception 'Registro sanitario no encontrado en el portafolio.'; end if;
      if not (public.es_admin() or public.medicamento_visible(v_med.id)) then
        raise exception 'No tiene acceso a ese registro sanitario.' using errcode = '42501';
      end if;
      v_new.medicamento_id := v_med.id;
      v_new.rs_numero := v_med.nro_registro_sanitario;
      v_new.rs_producto := v_med.descripcion_producto;
      v_new.rs_principio_activo := v_med.principio_activo;
    end if;
  end if;

  -- Diferencias (antes → después) para la bitácora
  foreach k in array v_claves || array['rs_numero','rs_producto'] loop
    if (to_jsonb(v_old)->k) is distinct from (to_jsonb(v_new)->k) then
      v_diff := v_diff || jsonb_build_object(k, jsonb_build_object('antes', to_jsonb(v_old)->k, 'despues', to_jsonb(v_new)->k));
    end if;
  end loop;
  if v_diff = '{}'::jsonb then
    raise exception 'No hay cambios respecto a los datos actuales.';
  end if;

  select email, nombre into v_email, v_nombre from public.perfiles where id = v_uid;

  perform set_config('app.docseg_editar', 'on', true);
  update public.documentos_segmentados
     set nombre_medicamento = v_new.nombre_medicamento,
         laboratorio_titular = v_new.laboratorio_titular,
         nregistro = v_new.nregistro,
         fuente_referencia = v_new.fuente_referencia,
         fecha_version_documento = v_new.fecha_version_documento,
         medicamento_id = v_new.medicamento_id,
         rs_numero = v_new.rs_numero, rs_producto = v_new.rs_producto, rs_principio_activo = v_new.rs_principio_activo,
         editado_en = now(), editado_por = v_uid, editado_por_nombre = coalesce(v_nombre, v_email)
   where id = p_id
  returning * into v_new;
  perform set_config('app.docseg_editar', 'off', true);

  insert into public.documentos_segmentados_auditoria
    (documento_id, evento, motivo, snapshot, usuario, usuario_email, usuario_nombre)
  values (v_new.id, 'EDITAR', btrim(p_motivo), to_jsonb(v_new) || jsonb_build_object('_cambios', v_diff),
          v_uid, v_email, v_nombre);

  return jsonb_build_object('id', v_new.id, 'editado_en', v_new.editado_en, 'cambios', v_diff);
end;
$$;
revoke execute on function public.editar_documento_segmentado(uuid, jsonb, text) from public, anon;
grant  execute on function public.editar_documento_segmentado(uuid, jsonb, text) to authenticated;

-- PostgREST: refrescar el esquema para que la RPC y las columnas se vean al instante.
notify pgrst, 'reload schema';
