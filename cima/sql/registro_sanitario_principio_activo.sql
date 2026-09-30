-- ════════════════════════════════════════════════════════════════════════════
-- Snapshot del registro sanitario: agrega el PRINCIPIO ACTIVO del portafolio.
--
-- Compatible hacia atrás: las versiones guardadas antes (sin principio activo)
-- conservan su hash_asociacion original; la fórmula solo incorpora el
-- principio activo cuando existe (hash_asociacion_rs de 6 argumentos).
-- ════════════════════════════════════════════════════════════════════════════

alter table public.documento_versiones
  add column if not exists rs_principio_activo text;

create or replace function public.hash_asociacion_rs(p_medicamento_id uuid, p_rs text, p_producto text, p_titular text,
                                                     p_vencimiento date, p_principio_activo text)
returns text language sql immutable set search_path = '' as $$
  select case when p_principio_activo is null
    then public.hash_asociacion_rs(p_medicamento_id, p_rs, p_producto, p_titular, p_vencimiento)
    else case when p_medicamento_id is null then null else
      public.sha256_texto(p_medicamento_id::text || '|' || coalesce(p_rs, '') || '|' || coalesce(p_producto, '') || '|' ||
                          coalesce(p_titular, '') || '|' || coalesce(p_vencimiento::text, '') || '|' || p_principio_activo) end
  end;
$$;

-- guardar_version_documento: igual que en registro_sanitario.sql + snapshot del principio activo
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
  p_medicamento_id           uuid default null
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
  v_rs text; v_rs_prod text; v_rs_tit text; v_rs_vto date; v_rs_pa text; v_hash_asoc text;
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

  if p_medicamento_id is not null then
    select m.nro_registro_sanitario, m.descripcion_producto, m.vcto_registro_sanitario, nullif(btrim(m.principio_activo), ''),
           (select string_agg(t.razon_social, ' / ' order by mt.es_principal desc, t.razon_social)
              from public.medicamento_titulares mt join public.titulares_registro_sanitario t on t.id = mt.titular_id
             where mt.medicamento_id = m.id)
      into v_rs, v_rs_prod, v_rs_vto, v_rs_pa, v_rs_tit
      from public.medicamentos m where m.id = p_medicamento_id;
    if not found then raise exception 'El registro sanitario seleccionado no existe en el portafolio.'; end if;
    v_hash_asoc := public.hash_asociacion_rs(p_medicamento_id, v_rs, v_rs_prod, v_rs_tit, v_rs_vto, v_rs_pa);
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
      medicamento_id, rs_numero, rs_producto, rs_titular, rs_vencimiento, rs_principio_activo, hash_asociacion)
  values (v_doc.id, v_ver, v_doc.codigo || '-V' || lpad(v_ver::text, 2, '0'), p_version_base_id, p_norma,
      p_referencia_segmentado_id, p_referencia_descripcion, jsonb_array_length(v_secs), v_hash, v_cadena,
      v_uid, v_email, v_nombre, v_now,
      p_medicamento_id, v_rs, v_rs_prod, v_rs_tit, v_rs_vto, v_rs_pa, v_hash_asoc)
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
    'medicamento_id', p_medicamento_id, 'rs_numero', v_rs, 'rs_producto', v_rs_prod, 'rs_titular', v_rs_tit,
    'rs_vencimiento', v_rs_vto, 'rs_principio_activo', v_rs_pa);
end;
$$;

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
         public.hash_asociacion_rs(v.medicamento_id, v.rs_numero, v.rs_producto, v.rs_titular, v.rs_vencimiento, v.rs_principio_activo)
           is not distinct from v.hash_asociacion
    from v order by v.version;
$$;
