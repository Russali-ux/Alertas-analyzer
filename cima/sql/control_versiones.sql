-- ════════════════════════════════════════════════════════════════════════════
-- CONTROL DE VERSIONES Y CONTROL DE CAMBIOS de documentos generados
-- (Ficha técnica / Inserto / Etiqueta) — módulo CIMA.
--
-- Criterios (ALCOA+ · 21 CFR Part 11 · EU GMP Anexo 11):
--  · Atribuible   : usuario (id + email + nombre al momento) en cada registro.
--  · Contemporáneo: fecha/hora del SERVIDOR (now()), nunca del navegador.
--  · Original     : el contenido de cada versión se guarda completo (snapshot).
--  · Íntegro      : SHA-256 por sección y del documento; cadena de hash entre
--                   versiones (cada una incluye el hash de la anterior).
--  · Inmutable    : triggers bloquean UPDATE / DELETE / TRUNCATE; sin permisos
--                   de escritura directa. Solo se escribe vía la función
--                   guardar_version_documento (atómica, numeración en servidor).
--  · Trazable     : cada versión genera un control de cambio (CC-AAAA-NNNNN)
--                   con motivo obligatorio y detalle de secciones afectadas,
--                   calculado en el servidor comparando hashes.
--
--   documentos_controlados        documento (familia): CKS-FT-PE-00001
--   documento_versiones           versión: CKS-FT-PE-00001-V01 (+ hashes)
--   documento_version_secciones   contenido de cada sección de la versión
--   control_cambios               CC-2026-00001: motivo, base, conteos
--   control_cambios_detalle       secciones AGREGADA / MODIFICADA / ELIMINADA
--   documento_eventos             bitácora de exportaciones e impresiones
-- ════════════════════════════════════════════════════════════════════════════

create sequence if not exists public.doc_controlado_seq;
create sequence if not exists public.control_cambio_seq;

-- ── Utilidades de hash (deterministas; mismas en guardado y verificación) ───
create or replace function public.normalizar_texto_documento(t text)
returns text language sql immutable set search_path = '' as $$
  select regexp_replace(btrim(coalesce(t, '')), '\s+', ' ', 'g');
$$;

create or replace function public.sha256_texto(t text)
returns text language sql immutable set search_path = '' as $$
  select encode(pg_catalog.sha256(convert_to(coalesce(t, ''), 'UTF8')), 'hex');
$$;

-- p: [{orden, clave, titulo, critica, hash_texto, html}, …]
create or replace function public.hash_secciones_documento(p jsonb)
returns text language sql immutable set search_path = '' as $$
  select public.sha256_texto(coalesce(string_agg(
           (x->>'orden') || '|' || (x->>'clave') || '|' || (x->>'titulo') || '|' ||
           (x->>'critica') || '|' || (x->>'hash_texto') || '|' || public.sha256_texto(x->>'html'),
           E'\n' order by (x->>'orden')::int), ''))
  from jsonb_array_elements(p) x;
$$;

create or replace function public.hash_cadena_documento(p_anterior text, p_codigo text, p_version int, p_creado_en timestamptz, p_hash_contenido text)
returns text language sql immutable set search_path = '' as $$
  select public.sha256_texto(coalesce(p_anterior, 'GENESIS') || '|' || p_codigo || '|' || p_version || '|' ||
         to_char(p_creado_en at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || '|' || p_hash_contenido);
$$;

-- ── Tablas ──────────────────────────────────────────────────────────────────
create table if not exists public.documentos_controlados (
  id             uuid primary key default gen_random_uuid(),
  codigo         text not null unique,
  tipo_documento text not null check (tipo_documento in ('FT', 'INSERTO', 'ETIQUETA')),
  pais           text not null check (pais ~ '^[A-Z]{2}$'),
  idioma         text not null check (idioma in ('es', 'pt')),
  producto       text not null,
  nregistro      text,
  creado_por          uuid not null,
  creado_por_email    text,
  creado_por_nombre   text,
  creado_en      timestamptz not null default now()
);
comment on table public.documentos_controlados is 'Documento controlado (familia de versiones) generado en el módulo CIMA. Inmutable.';

create table if not exists public.documento_versiones (
  id                       uuid primary key default gen_random_uuid(),
  documento_id             uuid not null references public.documentos_controlados (id) on delete restrict,
  version                  int  not null check (version > 0),
  codigo_version           text not null unique,
  version_base_id          uuid references public.documento_versiones (id) on delete restrict,
  norma                    text,
  referencia_segmentado_id uuid references public.documentos_segmentados (id) on delete restrict,
  referencia_descripcion   text,
  total_secciones          int  not null,
  hash_contenido           text not null,
  hash_cadena              text not null,
  creado_por               uuid not null,
  creado_por_email         text,
  creado_por_nombre        text,
  creado_en                timestamptz not null default now(),
  unique (documento_id, version)
);
comment on table public.documento_versiones is 'Versión de un documento controlado, con hash SHA-256 del contenido y cadena de hash. Inmutable.';
create index if not exists documento_versiones_ref_idx on public.documento_versiones (referencia_segmentado_id);

create table if not exists public.documento_version_secciones (
  id         bigint generated always as identity primary key,
  version_id uuid not null references public.documento_versiones (id) on delete restrict,
  orden      int  not null,
  clave      text not null,
  titulo     text not null,
  critica    boolean not null default false,
  estado     text not null check (estado in ('ok', 'vacio', 'manual', 'editado')),
  html       text not null default '',
  texto      text not null default '',
  hash_texto text not null,
  unique (version_id, orden),
  unique (version_id, clave)
);
comment on table public.documento_version_secciones is 'Contenido de cada sección de una versión controlada. Inmutable.';

create table if not exists public.control_cambios (
  id                    uuid primary key default gen_random_uuid(),
  codigo                text not null unique,
  documento_id          uuid not null references public.documentos_controlados (id) on delete restrict,
  version_id            uuid not null unique references public.documento_versiones (id) on delete restrict,
  version_base_id       uuid references public.documento_versiones (id) on delete restrict,
  tipo                  text not null check (tipo in ('EMISION_INICIAL', 'ACTUALIZACION')),
  motivo                text not null check (length(btrim(motivo)) >= 10),
  secciones_agregadas   int  not null default 0,
  secciones_modificadas int  not null default 0,
  secciones_eliminadas  int  not null default 0,
  creado_por            uuid not null,
  creado_por_email      text,
  creado_por_nombre     text,
  creado_en             timestamptz not null default now()
);
comment on table public.control_cambios is 'Control de cambio (CC-AAAA-NNNNN) asociado a cada versión: motivo, versión base y conteo de secciones afectadas. Inmutable.';
create index if not exists control_cambios_documento_idx on public.control_cambios (documento_id);

create table if not exists public.control_cambios_detalle (
  id            bigint generated always as identity primary key,
  control_id    uuid not null references public.control_cambios (id) on delete restrict,
  clave         text not null,
  titulo        text not null,
  tipo_cambio   text not null check (tipo_cambio in ('AGREGADA', 'MODIFICADA', 'ELIMINADA')),
  hash_anterior text,
  hash_nuevo    text
);
comment on table public.control_cambios_detalle is 'Secciones afectadas por un control de cambio, determinadas en el servidor por comparación de hashes. Inmutable.';
create index if not exists control_cambios_detalle_control_idx on public.control_cambios_detalle (control_id);

create table if not exists public.documento_eventos (
  id            bigint generated always as identity primary key,
  version_id    uuid not null references public.documento_versiones (id) on delete restrict,
  evento        text not null check (evento in ('EXPORTAR_WORD', 'IMPRIMIR')),
  usuario       uuid not null,
  usuario_email text,
  creado_en     timestamptz not null default now()
);
comment on table public.documento_eventos is 'Bitácora de exportaciones e impresiones de versiones controladas. Inmutable.';
create index if not exists documento_eventos_version_idx on public.documento_eventos (version_id);

-- ── Inmutabilidad ───────────────────────────────────────────────────────────
create or replace function public.bloquear_registro_controlado()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'Registro controlado (%): no se permite %. Para cambiar el contenido guarde una nueva versión.', tg_table_name, tg_op
    using errcode = '42501';
end;
$$;

do $$
declare t text;
begin
  foreach t in array array['documentos_controlados', 'documento_versiones', 'documento_version_secciones',
                           'control_cambios', 'control_cambios_detalle', 'documento_eventos'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_inmutable', t);
    execute format('create trigger %I before update or delete on public.%I for each row execute function public.bloquear_registro_controlado()', t || '_inmutable', t);
    execute format('drop trigger if exists %I on public.%I', t || '_no_truncate', t);
    execute format('create trigger %I before truncate on public.%I for each statement execute function public.bloquear_registro_controlado()', t || '_no_truncate', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke insert, update, delete, truncate on public.%I from anon, authenticated', t);
    execute format('drop policy if exists %I on public.%I', t || '_select', t);
    execute format('create policy %I on public.%I for select to authenticated using ((select public.tiene_acceso_cima()))', t || '_select', t);
  end loop;
end $$;

-- ── Guardado atómico de una versión (única vía de escritura) ────────────────
create or replace function public.guardar_version_documento(
  p_documento_id             uuid,     -- null = emisión inicial (crea el documento)
  p_version_base_id          uuid,     -- versión de la que parte (obligatoria si p_documento_id no es null)
  p_tipo_documento           text,
  p_pais                     text,
  p_idioma                   text,
  p_producto                 text,
  p_nregistro                text,
  p_norma                    text,
  p_referencia_segmentado_id uuid,
  p_referencia_descripcion   text,
  p_motivo                   text,
  p_secciones                jsonb     -- [{orden, clave, titulo, critica, estado, html, texto}]
) returns jsonb
language plpgsql security definer set search_path = 'public' as $$
declare
  v_uid   uuid := auth.uid();
  v_now   timestamptz := now();
  v_email text; v_nombre text;
  v_doc   public.documentos_controlados;
  v_prev  public.documento_versiones;
  v_ver   int;
  v_secs  jsonb;
  v_hash  text; v_cadena text;
  v_version_id uuid; v_control_id uuid; v_cc text;
  v_ag int := 0; v_mod int := 0; v_el int := 0;
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

  -- Secciones normalizadas + hash por sección (calculado aquí, no en el navegador)
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
    -- Bloqueo de la familia: serializa versiones concurrentes (sin números duplicados)
    select * into v_doc from public.documentos_controlados where id = p_documento_id for update;
    if not found then raise exception 'Documento controlado inexistente.'; end if;
    if p_version_base_id is null then
      raise exception 'Una nueva versión debe indicar su versión base.';
    end if;
    if not exists (select 1 from public.documento_versiones where id = p_version_base_id and documento_id = v_doc.id) then
      raise exception 'La versión base no pertenece a este documento.';
    end if;
  end if;

  select * into v_prev from public.documento_versiones where documento_id = v_doc.id order by version desc limit 1;
  v_ver := coalesce(v_prev.version, 0) + 1;

  -- Diferencias contra la versión base (solo actualizaciones)
  if p_version_base_id is not null then
    select count(*) filter (where b.clave is null),
           count(*) filter (where b.clave is not null and n.clave is not null and b.hash_texto <> n.hash_texto),
           count(*) filter (where n.clave is null)
      into v_ag, v_mod, v_el
      from (select x->>'clave' clave, x->>'hash_texto' hash_texto from jsonb_array_elements(v_secs) x) n
      full join (select clave, hash_texto from public.documento_version_secciones where version_id = p_version_base_id) b
        on b.clave = n.clave;
    if v_ag + v_mod + v_el = 0 then
      raise exception 'No hay cambios respecto de la versión base: no se crea una versión nueva.';
    end if;
  end if;

  v_hash   := public.hash_secciones_documento(v_secs);
  v_cadena := public.hash_cadena_documento(v_prev.hash_cadena, v_doc.codigo, v_ver, v_now, v_hash);

  insert into public.documento_versiones (documento_id, version, codigo_version, version_base_id, norma,
      referencia_segmentado_id, referencia_descripcion, total_secciones, hash_contenido, hash_cadena,
      creado_por, creado_por_email, creado_por_nombre, creado_en)
  values (v_doc.id, v_ver, v_doc.codigo || '-V' || lpad(v_ver::text, 2, '0'), p_version_base_id, p_norma,
      p_referencia_segmentado_id, p_referencia_descripcion, jsonb_array_length(v_secs), v_hash, v_cadena,
      v_uid, v_email, v_nombre, v_now)
  returning id into v_version_id;

  insert into public.documento_version_secciones (version_id, orden, clave, titulo, critica, estado, html, texto, hash_texto)
  select v_version_id, (x->>'orden')::int, x->>'clave', x->>'titulo', (x->>'critica')::boolean, x->>'estado',
         x->>'html', x->>'texto', x->>'hash_texto'
    from jsonb_array_elements(v_secs) x;

  v_cc := 'CC-' || to_char(v_now at time zone 'America/Lima', 'YYYY') || '-' || lpad(nextval('public.control_cambio_seq')::text, 5, '0');
  insert into public.control_cambios (codigo, documento_id, version_id, version_base_id, tipo, motivo,
      secciones_agregadas, secciones_modificadas, secciones_eliminadas,
      creado_por, creado_por_email, creado_por_nombre, creado_en)
  values (v_cc, v_doc.id, v_version_id, p_version_base_id,
      case when p_version_base_id is null then 'EMISION_INICIAL' else 'ACTUALIZACION' end,
      btrim(p_motivo), v_ag, v_mod, v_el, v_uid, v_email, v_nombre, v_now)
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
  end if;

  return jsonb_build_object(
    'documento_id', v_doc.id, 'codigo', v_doc.codigo,
    'version_id', v_version_id, 'version', v_ver, 'codigo_version', v_doc.codigo || '-V' || lpad(v_ver::text, 2, '0'),
    'control_codigo', v_cc, 'tipo_control', case when p_version_base_id is null then 'EMISION_INICIAL' else 'ACTUALIZACION' end,
    'creado_en', v_now, 'creado_por_email', v_email,
    'hash_contenido', v_hash, 'hash_cadena', v_cadena,
    'agregadas', v_ag, 'modificadas', v_mod, 'eliminadas', v_el);
end;
$$;

-- ── Bitácora de exportación / impresión ─────────────────────────────────────
create or replace function public.registrar_evento_documento(p_version_id uuid, p_evento text)
returns void language plpgsql security definer set search_path = 'public' as $$
begin
  if auth.uid() is null or not public.tiene_acceso_cima() then
    raise exception 'Sin acceso al módulo CIMA.' using errcode = '42501';
  end if;
  insert into public.documento_eventos (version_id, evento, usuario, usuario_email)
  values (p_version_id, p_evento, auth.uid(), (select email from public.perfiles where id = auth.uid()));
end;
$$;

-- ── Verificación de integridad (recalcula hashes y cadena) ──────────────────
create or replace function public.verificar_integridad_documento(p_documento_id uuid)
returns table (version int, codigo_version text, secciones_ok boolean, contenido_ok boolean, cadena_ok boolean)
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
         public.hash_cadena_documento(v.cadena_anterior, v.codigo, v.version, v.creado_en, v.hash_contenido) = v.hash_cadena
    from v order by v.version;
$$;

-- ── Vista de resumen (respeta RLS del usuario) ──────────────────────────────
create or replace view public.v_documentos_controlados with (security_invoker = true) as
select d.*,
       lv.id as version_vigente_id, lv.version as version_vigente, lv.codigo_version as codigo_version_vigente,
       lv.creado_en as ultima_fecha,
       (select count(*) from public.documento_versiones x where x.documento_id = d.id)::int as total_versiones,
       (select count(*) from public.control_cambios c where c.documento_id = d.id and c.tipo = 'ACTUALIZACION')::int as total_cambios
  from public.documentos_controlados d
  left join lateral (select id, version, codigo_version, creado_en from public.documento_versiones x
                      where x.documento_id = d.id order by version desc limit 1) lv on true;

-- ── Permisos de ejecución ───────────────────────────────────────────────────
revoke execute on function public.guardar_version_documento(uuid, uuid, text, text, text, text, text, text, uuid, text, text, jsonb) from public, anon;
grant  execute on function public.guardar_version_documento(uuid, uuid, text, text, text, text, text, text, uuid, text, text, jsonb) to authenticated;
revoke execute on function public.registrar_evento_documento(uuid, text) from public, anon;
grant  execute on function public.registrar_evento_documento(uuid, text) to authenticated;
revoke execute on function public.verificar_integridad_documento(uuid) from public, anon;
grant  execute on function public.verificar_integridad_documento(uuid) to authenticated;
revoke execute on function public.bloquear_registro_controlado() from public, anon, authenticated;
revoke all on public.v_documentos_controlados from anon;
grant select on public.v_documentos_controlados to authenticated;
