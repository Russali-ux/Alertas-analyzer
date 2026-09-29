-- ════════════════════════════════════════════════════════════════════════════
-- Paso 5 del generador: asociar el documento controlado a un REGISTRO SANITARIO
-- del portafolio (public.medicamentos + titulares).
--
--  · La asociación es parte de la VERSIÓN controlada: se guarda el id del
--    medicamento y un SNAPSHOT (Nº RS, producto, titular(es), vencimiento) tal
--    como estaban al guardar, para que el registro siga siendo fiel aunque el
--    portafolio se actualice después (sin FK: el portafolio se recarga desde Excel).
--  · hash_asociacion = SHA-256 del snapshot; se encadena en hash_cadena de las
--    versiones que tienen asociación. Las versiones anteriores (sin asociación)
--    conservan su fórmula original: la verificación sigue siendo válida.
--  · Cambiar el registro asociado es un CAMBIO: genera nueva versión y control de
--    cambio (detalle "Registro sanitario asociado").
--  · Usuarios CIMA consultan el portafolio solo vía buscar_registros_sanitarios
--    (columnas mínimas); no se amplía la política de lectura de medicamentos.
-- ════════════════════════════════════════════════════════════════════════════

alter table public.documento_versiones
  add column if not exists medicamento_id  uuid,
  add column if not exists rs_numero       text,
  add column if not exists rs_producto     text,
  add column if not exists rs_titular      text,
  add column if not exists rs_vencimiento  date,
  add column if not exists hash_asociacion text;
create index if not exists documento_versiones_medicamento_idx on public.documento_versiones (medicamento_id);
create index if not exists documento_versiones_rs_idx on public.documento_versiones (rs_numero);

alter table public.control_cambios
  add column if not exists registro_sanitario_cambiado boolean not null default false;

-- Cadena de hash con asociación (6 argumentos). Sin asociación = fórmula original.
create or replace function public.hash_cadena_documento(p_anterior text, p_codigo text, p_version int, p_creado_en timestamptz,
                                                        p_hash_contenido text, p_hash_asociacion text)
returns text language sql immutable set search_path = '' as $$
  select case when p_hash_asociacion is null
    then public.hash_cadena_documento(p_anterior, p_codigo, p_version, p_creado_en, p_hash_contenido)
    else public.sha256_texto(coalesce(p_anterior, 'GENESIS') || '|' || p_codigo || '|' || p_version || '|' ||
           to_char(p_creado_en at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || '|' || p_hash_contenido || '|' || p_hash_asociacion)
  end;
$$;

create or replace function public.hash_asociacion_rs(p_medicamento_id uuid, p_rs text, p_producto text, p_titular text, p_vencimiento date)
returns text language sql immutable set search_path = '' as $$
  select case when p_medicamento_id is null then null else
    public.sha256_texto(p_medicamento_id::text || '|' || coalesce(p_rs, '') || '|' || coalesce(p_producto, '') || '|' ||
                        coalesce(p_titular, '') || '|' || coalesce(p_vencimiento::text, '')) end;
$$;

-- ── Acceso al portafolio de registros sanitarios: admin o acceso_titulares ──
-- (misma regla que las políticas de lectura de medicamentos / titulares)
create or replace function public.tiene_acceso_titulares()
returns boolean language sql stable security definer set search_path to 'public' as $$
  select exists(select 1 from public.perfiles
                 where id = auth.uid() and (rol = 'admin' or acceso_titulares = true));
$$;
revoke execute on function public.tiene_acceso_titulares() from public, anon;
grant  execute on function public.tiene_acceso_titulares() to authenticated;

-- ── Búsqueda de registros sanitarios (paso 5): requiere CIMA + Titulares ────
create or replace function public.buscar_registros_sanitarios(p_q text)
returns table (id uuid, producto text, principio_activo text, nro_registro_sanitario text, vencimiento date,
               fabricante text, pais_fabricacion text, titulares text)
language plpgsql stable security definer set search_path = 'public' as $$
begin
  if auth.uid() is null or not public.tiene_acceso_cima() or not public.tiene_acceso_titulares() then
    raise exception 'Asociar un registro sanitario requiere acceso al módulo de Titulares.' using errcode = '42501';
  end if;
  if length(btrim(coalesce(p_q, ''))) < 2 then return; end if;
  return query
    select m.id, m.descripcion_producto, m.principio_activo, m.nro_registro_sanitario, m.vcto_registro_sanitario,
           m.fabricante, m.pais,
           (select string_agg(t.razon_social || case when mt.es_principal then ' ★' else '' end, ' / '
                              order by mt.es_principal desc, t.razon_social)
              from public.medicamento_titulares mt join public.titulares_registro_sanitario t on t.id = mt.titular_id
             where mt.medicamento_id = m.id)
      from public.medicamentos m
     where m.descripcion_producto ilike '%' || btrim(p_q) || '%'
        or m.principio_activo     ilike '%' || btrim(p_q) || '%'
        or m.nro_registro_sanitario ilike '%' || btrim(p_q) || '%'
     order by m.descripcion_producto
     limit 30;
end;
$$;
revoke execute on function public.buscar_registros_sanitarios(text) from public, anon;
grant  execute on function public.buscar_registros_sanitarios(text) to authenticated;

-- ── guardar_version_documento con asociación a registro sanitario ───────────
drop function if exists public.guardar_version_documento(uuid, uuid, text, text, text, text, text, text, uuid, text, text, jsonb);

create or replace function public.guardar_version_documento(
  p_documento_id             uuid,
  p_version_base_id          uuid,
  p_tipo_documento           text,
  p_pais                     text,
  p_idioma                   text,
  p_producto                 text,
  p_nregistro                text,
  p_norma                    text,
  p_referencia_segmentado_id uuid,
  p_referencia_descripcion   text,
  p_motivo                   text,
  p_secciones                jsonb,
  p_medicamento_id           uuid default null    -- registro sanitario del portafolio (opcional)
) returns jsonb
language plpgsql security definer set search_path = 'public' as $$
declare
  v_uid   uuid := auth.uid();
  v_now   timestamptz := now();
  v_email text; v_nombre text;
  v_doc   public.documentos_controlados;
  v_prev  public.documento_versiones;
  v_base  public.documento_versiones;
  v_ver   int;
  v_secs  jsonb;
  v_hash  text; v_cadena text;
  v_version_id uuid; v_control_id uuid; v_cc text;
  v_ag int := 0; v_mod int := 0; v_el int := 0;
  v_rs text; v_rs_prod text; v_rs_tit text; v_rs_vto date; v_hash_asoc text;
  v_asoc_cambio boolean := false;
begin
  if v_uid is null or not public.tiene_acceso_cima() then
    raise exception 'Sin acceso al módulo CIMA.' using errcode = '42501';
  end if;
  if length(btrim(coalesce(p_motivo, ''))) < 10 then
    raise exception 'El motivo del cambio es obligatorio (mínimo 10 caracteres).';
  end if;
  if p_secciones is null or jsonb_typeof(p_secciones) <> 'array' or jsonb_array_length(p_secciones) = 0 then
    raise exception 'El documento no tiene secciones.';
  end if;

  select email, nombre into v_email, v_nombre from public.perfiles where id = v_uid;

  -- Snapshot del registro sanitario asociado (tal como está hoy en el portafolio)
  if p_medicamento_id is not null then
    select m.nro_registro_sanitario, m.descripcion_producto, m.vcto_registro_sanitario,
           (select string_agg(t.razon_social, ' / ' order by mt.es_principal desc, t.razon_social)
              from public.medicamento_titulares mt join public.titulares_registro_sanitario t on t.id = mt.titular_id
             where mt.medicamento_id = m.id)
      into v_rs, v_rs_prod, v_rs_vto, v_rs_tit
      from public.medicamentos m where m.id = p_medicamento_id;
    if not found then raise exception 'El registro sanitario seleccionado no existe en el portafolio.'; end if;
    v_hash_asoc := public.hash_asociacion_rs(p_medicamento_id, v_rs, v_rs_prod, v_rs_tit, v_rs_vto);
  end if;

  select jsonb_agg(jsonb_build_object(
           'orden',      (s->>'orden')::int,
           'clave',      s->>'clave',
           'titulo',     coalesce(s->>'titulo', ''),
           'critica',    coalesce((s->>'critica')::boolean, false),
           'estado',     coalesce(s->>'estado', 'ok'),
           'html',       coalesce(s->>'html', ''),
           'texto',      coalesce(s->>'texto', ''),
           'hash_texto', public.sha256_texto(public.normalizar_texto_documento(s->>'texto')))
         order by (s->>'orden')::int)
    into v_secs
    from jsonb_array_elements(p_secciones) s;

  if (select count(distinct x->>'clave') from jsonb_array_elements(v_secs) x) <> jsonb_array_length(v_secs)
     or exists (select 1 from jsonb_array_elements(v_secs) x where coalesce(x->>'clave', '') = '') then
    raise exception 'Cada sección debe tener una clave única.';
  end if;

  if p_documento_id is null then
    if p_version_base_id is not null then
      raise exception 'Una emisión inicial no puede tener versión base.';
    end if;
    if p_tipo_documento not in ('FT', 'INSERTO', 'ETIQUETA') then
      raise exception 'Tipo de documento inválido: %', p_tipo_documento;
    end if;
    insert into public.documentos_controlados (codigo, tipo_documento, pais, idioma, producto, nregistro,
                                               creado_por, creado_por_email, creado_por_nombre, creado_en)
    values ('CKS-' || case p_tipo_documento when 'FT' then 'FT' when 'INSERTO' then 'IN' else 'ET' end
                   || '-' || upper(p_pais) || '-' || lpad(nextval('public.doc_controlado_seq')::text, 5, '0'),
            p_tipo_documento, upper(p_pais), p_idioma, p_producto, nullif(p_nregistro, ''),
            v_uid, v_email, v_nombre, v_now)
    returning * into v_doc;
  else
    select * into v_doc from public.documentos_controlados where id = p_documento_id for update;
    if not found then raise exception 'Documento controlado inexistente.'; end if;
    if p_version_base_id is null then
      raise exception 'Una nueva versión debe indicar su versión base.';
    end if;
    select * into v_base from public.documento_versiones where id = p_version_base_id and documento_id = v_doc.id;
    if not found then
      raise exception 'La versión base no pertenece a este documento.';
    end if;
  end if;

  -- Asociar o CAMBIAR el registro sanitario requiere acceso a Titulares. Mantener
  -- el mismo registro de la versión base no (quien solo edita contenido no lo toca).
  if p_medicamento_id is distinct from v_base.medicamento_id and not public.tiene_acceso_titulares() then
    raise exception 'Asociar o cambiar el registro sanitario requiere acceso al módulo de Titulares.' using errcode = '42501';
  end if;

  select * into v_prev from public.documento_versiones where documento_id = v_doc.id order by version desc limit 1;
  v_ver := coalesce(v_prev.version, 0) + 1;

  if p_version_base_id is not null then
    select count(*) filter (where b.clave is null),
           count(*) filter (where b.clave is not null and n.clave is not null and b.hash_texto <> n.hash_texto),
           count(*) filter (where n.clave is null)
      into v_ag, v_mod, v_el
      from (select x->>'clave' clave, x->>'hash_texto' hash_texto from jsonb_array_elements(v_secs) x) n
      full join (select clave, hash_texto from public.documento_version_secciones where version_id = p_version_base_id) b
        on b.clave = n.clave;
    v_asoc_cambio := v_base.medicamento_id is distinct from p_medicamento_id;
    if v_ag + v_mod + v_el = 0 and not v_asoc_cambio then
      raise exception 'No hay cambios respecto de la versión base: no se crea una versión nueva.';
    end if;
  end if;

  v_hash   := public.hash_secciones_documento(v_secs);
  v_cadena := public.hash_cadena_documento(v_prev.hash_cadena, v_doc.codigo, v_ver, v_now, v_hash, v_hash_asoc);

  insert into public.documento_versiones (documento_id, version, codigo_version, version_base_id, norma,
      referencia_segmentado_id, referencia_descripcion, total_secciones, hash_contenido, hash_cadena,
      creado_por, creado_por_email, creado_por_nombre, creado_en,
      medicamento_id, rs_numero, rs_producto, rs_titular, rs_vencimiento, hash_asociacion)
  values (v_doc.id, v_ver, v_doc.codigo || '-V' || lpad(v_ver::text, 2, '0'), p_version_base_id, p_norma,
      p_referencia_segmentado_id, p_referencia_descripcion, jsonb_array_length(v_secs), v_hash, v_cadena,
      v_uid, v_email, v_nombre, v_now,
      p_medicamento_id, v_rs, v_rs_prod, v_rs_tit, v_rs_vto, v_hash_asoc)
  returning id into v_version_id;

  insert into public.documento_version_secciones (version_id, orden, clave, titulo, critica, estado, html, texto, hash_texto)
  select v_version_id, (x->>'orden')::int, x->>'clave', x->>'titulo', (x->>'critica')::boolean, x->>'estado',
         x->>'html', x->>'texto', x->>'hash_texto'
    from jsonb_array_elements(v_secs) x;

  v_cc := 'CC-' || to_char(v_now at time zone 'America/Lima', 'YYYY') || '-' || lpad(nextval('public.control_cambio_seq')::text, 5, '0');
  insert into public.control_cambios (codigo, documento_id, version_id, version_base_id, tipo, motivo,
      secciones_agregadas, secciones_modificadas, secciones_eliminadas, registro_sanitario_cambiado,
      creado_por, creado_por_email, creado_por_nombre, creado_en)
  values (v_cc, v_doc.id, v_version_id, p_version_base_id,
      case when p_version_base_id is null then 'EMISION_INICIAL' else 'ACTUALIZACION' end,
      btrim(p_motivo), v_ag, v_mod, v_el, v_asoc_cambio, v_uid, v_email, v_nombre, v_now)
  returning id into v_control_id;

  if p_version_base_id is not null then
    insert into public.control_cambios_detalle (control_id, clave, titulo, tipo_cambio, hash_anterior, hash_nuevo)
    select v_control_id, coalesce(n.clave, b.clave), coalesce(n.titulo, b.titulo),
           case when b.clave is null then 'AGREGADA' when n.clave is null then 'ELIMINADA' else 'MODIFICADA' end,
           b.hash_texto, n.hash_texto
      from (select (x->>'orden')::int orden, x->>'clave' clave, x->>'titulo' titulo, x->>'hash_texto' hash_texto
              from jsonb_array_elements(v_secs) x) n
      full join (select orden, clave, titulo, hash_texto from public.documento_version_secciones where version_id = p_version_base_id) b
        on b.clave = n.clave
     where b.clave is null or n.clave is null or b.hash_texto <> n.hash_texto
     order by coalesce(n.orden, b.orden);

    if v_asoc_cambio then
      insert into public.control_cambios_detalle (control_id, clave, titulo, tipo_cambio, hash_anterior, hash_nuevo)
      values (v_control_id, '__registro_sanitario',
              'Registro sanitario asociado: ' || coalesce(v_base.rs_numero, '—') || ' → ' || coalesce(v_rs, '—'),
              case when v_base.medicamento_id is null then 'AGREGADA' when p_medicamento_id is null then 'ELIMINADA' else 'MODIFICADA' end,
              v_base.hash_asociacion, v_hash_asoc);
    end if;
  end if;

  return jsonb_build_object(
    'documento_id', v_doc.id, 'codigo', v_doc.codigo,
    'version_id', v_version_id, 'version', v_ver, 'codigo_version', v_doc.codigo || '-V' || lpad(v_ver::text, 2, '0'),
    'control_codigo', v_cc, 'tipo_control', case when p_version_base_id is null then 'EMISION_INICIAL' else 'ACTUALIZACION' end,
    'creado_en', v_now, 'creado_por_email', v_email,
    'hash_contenido', v_hash, 'hash_cadena', v_cadena,
    'agregadas', v_ag, 'modificadas', v_mod, 'eliminadas', v_el,
    'registro_sanitario_cambiado', v_asoc_cambio,
    'medicamento_id', p_medicamento_id, 'rs_numero', v_rs, 'rs_producto', v_rs_prod, 'rs_titular', v_rs_tit, 'rs_vencimiento', v_rs_vto);
end;
$$;
revoke execute on function public.guardar_version_documento(uuid, uuid, text, text, text, text, text, text, uuid, text, text, jsonb, uuid) from public, anon;
grant  execute on function public.guardar_version_documento(uuid, uuid, text, text, text, text, text, text, uuid, text, text, jsonb, uuid) to authenticated;

-- ── Verificación de integridad: incluye el snapshot del registro sanitario ──
drop function if exists public.verificar_integridad_documento(uuid);
create or replace function public.verificar_integridad_documento(p_documento_id uuid)
returns table (version int, codigo_version text, secciones_ok boolean, contenido_ok boolean, cadena_ok boolean, asociacion_ok boolean)
language sql stable security invoker set search_path = 'public' as $$
  with v as (
    select dv.*, d.codigo,
           lag(dv.hash_cadena) over (order by dv.version) as cadena_anterior
      from public.documento_versiones dv
      join public.documentos_controlados d on d.id = dv.documento_id
     where dv.documento_id = p_documento_id
  )
  select v.version, v.codigo_version,
         not exists (select 1 from public.documento_version_secciones s
                      where s.version_id = v.id
                        and s.hash_texto <> public.sha256_texto(public.normalizar_texto_documento(s.texto))),
         public.hash_secciones_documento((
           select jsonb_agg(jsonb_build_object('orden', s.orden, 'clave', s.clave, 'titulo', s.titulo,
                                               'critica', s.critica, 'hash_texto', s.hash_texto, 'html', s.html))
             from public.documento_version_secciones s where s.version_id = v.id)) = v.hash_contenido,
         public.hash_cadena_documento(v.cadena_anterior, v.codigo, v.version, v.creado_en, v.hash_contenido, v.hash_asociacion) = v.hash_cadena,
         public.hash_asociacion_rs(v.medicamento_id, v.rs_numero, v.rs_producto, v.rs_titular, v.rs_vencimiento) is not distinct from v.hash_asociacion
    from v order by v.version;
$$;
revoke execute on function public.verificar_integridad_documento(uuid) from public, anon;
grant  execute on function public.verificar_integridad_documento(uuid) to authenticated;

-- ── Vista: agrega el registro sanitario de la versión vigente ───────────────
create or replace view public.v_documentos_controlados with (security_invoker = true) as
select d.*,
       lv.id as version_vigente_id, lv.version as version_vigente, lv.codigo_version as codigo_version_vigente,
       lv.creado_en as ultima_fecha,
       (select count(*) from public.documento_versiones x where x.documento_id = d.id)::int as total_versiones,
       (select count(*) from public.control_cambios c where c.documento_id = d.id and c.tipo = 'ACTUALIZACION')::int as total_cambios,
       lv.rs_numero, lv.rs_producto, lv.rs_titular, lv.medicamento_id
  from public.documentos_controlados d
  left join lateral (select id, version, codigo_version, creado_en, rs_numero, rs_producto, rs_titular, medicamento_id
                       from public.documento_versiones x
                      where x.documento_id = d.id order by version desc limit 1) lv on true;
