-- ════════════════════════════════════════════════════════════════════════════
-- El REGISTRO SANITARIO identifica al documento controlado.
--
-- Identidad = registro sanitario (medicamento_id) + tipo de documento + país + idioma.
--  · Generar un documento para un RS que ya tiene documento controlado crea una
--    NUEVA VERSIÓN de ese documento (base = versión vigente), aunque el cliente
--    lo envíe como emisión nueva. Lo decide el servidor, con bloqueo por RS para
--    que dos guardados simultáneos no creen dos documentos.
--  · El RS de un documento ya asociado NO puede cambiarse ni quitarse (es su
--    identidad). Un documento sin RS puede asociarse a uno que no tenga ya su
--    propio documento.
--  · Documentos duplicados creados antes de esta regla (mismo RS) se conservan
--    (son inmutables); las nuevas versiones van al MÁS ANTIGUO de ellos.
-- ════════════════════════════════════════════════════════════════════════════

-- Documento controlado vigente para un RS (el más antiguo si hubiera duplicados previos a la regla).
create or replace function public.documento_de_registro(p_medicamento_id uuid, p_tipo text, p_pais text, p_idioma text)
returns uuid language sql stable set search_path = 'public' as $$
  select d.id
    from public.documentos_controlados d
   where d.tipo_documento = p_tipo and d.pais = upper(p_pais) and d.idioma = p_idioma
     and (select x.medicamento_id from public.documento_versiones x
           where x.documento_id = d.id order by x.version desc limit 1) = p_medicamento_id
   order by d.creado_en, d.codigo
   limit 1;
$$;

-- Vista: marca documentos duplicados para un mismo RS (creados antes de la regla)
create or replace view public.v_documentos_controlados with (security_invoker = true) as
select d.*,
       lv.id as version_vigente_id, lv.version as version_vigente, lv.codigo_version as codigo_version_vigente,
       lv.creado_en as ultima_fecha,
       (select count(*) from public.documento_versiones x where x.documento_id = d.id)::int as total_versiones,
       (select count(*) from public.control_cambios c where c.documento_id = d.id and c.tipo = 'ACTUALIZACION')::int as total_cambios,
       lv.rs_numero, lv.rs_producto, lv.rs_titular, lv.medicamento_id,
       case when lv.medicamento_id is null then null
            else public.documento_de_registro(lv.medicamento_id, d.tipo_documento, d.pais, d.idioma) end as documento_principal_rs_id
  from public.documentos_controlados d
  left join lateral (select id, version, codigo_version, creado_en, rs_numero, rs_producto, rs_titular, medicamento_id
                       from public.documento_versiones x
                      where x.documento_id = d.id order by version desc limit 1) lv on true;

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
  v_doc_rs uuid; v_por_rs boolean := false; v_otro text;
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
    -- Serializa guardados del mismo RS/tipo/país/idioma: no pueden nacer dos documentos para un RS.
    perform pg_advisory_xact_lock(hashtext('doc_rs|' || p_medicamento_id || '|' || p_tipo_documento || '|' || upper(p_pais) || '|' || p_idioma));
    select m.nro_registro_sanitario, m.descripcion_producto, m.vcto_registro_sanitario, nullif(btrim(m.principio_activo), ''),
           (select string_agg(t.razon_social, ' / ' order by mt.es_principal desc, t.razon_social)
              from public.medicamento_titulares mt join public.titulares_registro_sanitario t on t.id = mt.titular_id
             where mt.medicamento_id = m.id)
      into v_rs, v_rs_prod, v_rs_vto, v_rs_pa, v_rs_tit
      from public.medicamentos m where m.id = p_medicamento_id;
    if not found then raise exception 'El registro sanitario seleccionado no existe en el portafolio.'; end if;
    v_hash_asoc := public.hash_asociacion_rs(p_medicamento_id, v_rs, v_rs_prod, v_rs_tit, v_rs_vto, v_rs_pa);
    v_doc_rs := public.documento_de_registro(p_medicamento_id, p_tipo_documento, p_pais, p_idioma);
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

  if p_documento_id is null and p_version_base_id is not null then
    raise exception 'Una emisión inicial no puede tener versión base.';
  end if;

  if p_documento_id is null and v_doc_rs is not null then
    -- El RS ya tiene documento controlado: esto es una NUEVA VERSIÓN de ese documento (base = vigente).
    select * into v_doc from public.documentos_controlados where id = v_doc_rs for update;
    select * into v_base from public.documento_versiones where documento_id = v_doc.id order by version desc limit 1;
    v_por_rs := true;
  elsif p_documento_id is null then
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

  select * into v_prev from public.documento_versiones where documento_id = v_doc.id order by version desc limit 1;

  -- Identidad por RS en documentos existentes
  if v_prev.id is not null then
    if v_prev.medicamento_id is not null and p_medicamento_id is distinct from v_prev.medicamento_id then
      raise exception 'El registro sanitario % identifica al documento %: no puede cambiarse ni quitarse. Para otro registro sanitario genere su propio documento.',
        v_prev.rs_numero, v_doc.codigo using errcode = '42501';
    end if;
    if v_prev.medicamento_id is null and v_doc_rs is not null and v_doc_rs <> v_doc.id then
      select codigo into v_otro from public.documentos_controlados where id = v_doc_rs;
      raise exception 'El registro sanitario % ya tiene su documento (%). Genere la nueva versión en ese documento.', v_rs, v_otro;
    end if;
  end if;

  if p_medicamento_id is distinct from v_base.medicamento_id and not public.tiene_acceso_titulares() then
    raise exception 'Asociar o cambiar el registro sanitario requiere acceso al módulo de Titulares.' using errcode = '42501';
  end if;

  v_ver := coalesce(v_prev.version, 0) + 1;

  if v_base.id is not null then
    select count(*) filter (where b.clave is null),
           count(*) filter (where b.clave is not null and n.clave is not null and b.hash_texto <> n.hash_texto),
           count(*) filter (where n.clave is null)
      into v_ag, v_mod, v_el
      from (select x->>'clave' clave, x->>'hash_texto' hash_texto from jsonb_array_elements(v_secs) x) n
      full join (select clave, hash_texto from public.documento_version_secciones where version_id = v_base.id) b
        on b.clave = n.clave;
    v_asoc_cambio := v_base.medicamento_id is distinct from p_medicamento_id;
    if v_ag + v_mod + v_el = 0 and not v_asoc_cambio then
      raise exception 'No hay cambios respecto de la versión base (%): no se crea una versión nueva.', v_base.codigo_version;
    end if;
  end if;

  v_hash   := public.hash_secciones_documento(v_secs);
  v_cadena := public.hash_cadena_documento(v_prev.hash_cadena, v_doc.codigo, v_ver, v_now, v_hash, v_hash_asoc);

  insert into public.documento_versiones (documento_id, version, codigo_version, version_base_id, norma,
      referencia_segmentado_id, referencia_descripcion, total_secciones, hash_contenido, hash_cadena,
      creado_por, creado_por_email, creado_por_nombre, creado_en,
      medicamento_id, rs_numero, rs_producto, rs_titular, rs_vencimiento, rs_principio_activo, hash_asociacion)
  values (v_doc.id, v_ver, v_doc.codigo || '-V' || lpad(v_ver::text, 2, '0'), v_base.id, p_norma,
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
  values (v_cc, v_doc.id, v_version_id, v_base.id,
      case when v_base.id is null then 'EMISION_INICIAL' else 'ACTUALIZACION' end,
      btrim(p_motivo), v_ag, v_mod, v_el, v_asoc_cambio, v_uid, v_email, v_nombre, v_now)
  returning id into v_control_id;

  if v_base.id is not null then
    insert into public.control_cambios_detalle (control_id, clave, titulo, tipo_cambio, hash_anterior, hash_nuevo)
    select v_control_id, coalesce(n.clave, b.clave), coalesce(n.titulo, b.titulo),
           case when b.clave is null then 'AGREGADA' when n.clave is null then 'ELIMINADA' else 'MODIFICADA' end,
           b.hash_texto, n.hash_texto
      from (select (x->>'orden')::int orden, x->>'clave' clave, x->>'titulo' titulo, x->>'hash_texto' hash_texto
              from jsonb_array_elements(v_secs) x) n
      full join (select orden, clave, titulo, hash_texto from public.documento_version_secciones where version_id = v_base.id) b
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
    'version_base_codigo', v_base.codigo_version, 'vinculado_por_rs', v_por_rs,
    'control_codigo', v_cc, 'tipo_control', case when v_base.id is null then 'EMISION_INICIAL' else 'ACTUALIZACION' end,
    'creado_en', v_now, 'creado_por_email', v_email,
    'hash_contenido', v_hash, 'hash_cadena', v_cadena,
    'agregadas', v_ag, 'modificadas', v_mod, 'eliminadas', v_el,
    'registro_sanitario_cambiado', v_asoc_cambio,
    'medicamento_id', p_medicamento_id, 'rs_numero', v_rs, 'rs_producto', v_rs_prod, 'rs_titular', v_rs_tit,
    'rs_vencimiento', v_rs_vto, 'rs_principio_activo', v_rs_pa);
end;
$$;
