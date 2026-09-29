-- ════════════════════════════════════════════════════════════════════════════
-- Documentos FT / Prospecto segmentados en los campos de la Ficha Técnica
-- (a … e.6, f, g.1, g.2 + x.* fuera del esquema). Los escribe cima/index.html
-- (cima/segmentador.js) con la sesión del usuario: no hay servidor intermedio.
--
--   documentos_segmentados  1 fila por documento procesado (CIMA o subido)
--   documento_secciones     1 fila por campo del documento
--   storage: documentos-segmentados   archivo original de las subidas
--
-- Acceso: admin o perfiles.acceso_cima = true (mismo criterio que el visor).
-- ════════════════════════════════════════════════════════════════════════════

create or replace function public.tiene_acceso_cima()
returns boolean
language sql
stable security definer
set search_path to 'public'
as $$
  select exists(
    select 1 from public.perfiles
    where id = auth.uid() and (rol = 'admin' or acceso_cima = true)
  );
$$;
revoke execute on function public.tiene_acceso_cima() from public, anon;
grant execute on function public.tiene_acceso_cima() to authenticated;

create table if not exists public.documentos_segmentados (
  id                  uuid primary key default gen_random_uuid(),
  origen              text not null check (origen in ('cima', 'subida')),
  tipo_documento      text not null check (tipo_documento in ('FT', 'P')),
  nregistro           text,
  nombre_medicamento  text,
  laboratorio_titular text,
  fecha_version_cima  timestamptz,          -- docs[].fecha de CIMA: identifica la versión del documento
  url_origen          text,
  archivo_nombre      text,
  archivo_path        text,                 -- ruta en storage (solo subidas)
  campos_vacios       text[] not null default '{}',
  avisos              text[] not null default '{}',
  creado_por          uuid default auth.uid() references auth.users (id) on delete set null,
  creado_en           timestamptz not null default now()
);
comment on table public.documentos_segmentados is
  'FT / Prospecto (CIMA o subido) separado en los campos de la Ficha Técnica. Lo escribe el visor cima/index.html.';

-- Una sola segmentación por versión de documento CIMA: si CIMA publica una nueva
-- versión (fecha distinta) se guarda otra fila y la anterior queda como histórico.
create unique index if not exists documentos_segmentados_cima_version_uq
  on public.documentos_segmentados (tipo_documento, nregistro, fecha_version_cima)
  where origen = 'cima';
create index if not exists documentos_segmentados_nregistro_idx on public.documentos_segmentados (nregistro);
create index if not exists documentos_segmentados_creado_por_idx on public.documentos_segmentados (creado_por);

create table if not exists public.documento_secciones (
  id               bigint generated always as identity primary key,
  documento_id     uuid not null references public.documentos_segmentados (id) on delete cascade,
  campo            text not null,           -- 'a', 'b', 'c.1' … 'e.6', 'f', 'g.1', 'x.titular' …
  campo_titulo     text not null,
  orden            int  not null,
  secciones_origen text,                    -- p. ej. '4.3' (FT) o 'P2' (Prospecto)
  texto            text not null,
  html             text,
  unique (documento_id, campo)
);
comment on table public.documento_secciones is
  'Un campo (a … e.6) de un documento de documentos_segmentados, con su texto plano y HTML.';

alter table public.documentos_segmentados enable row level security;
alter table public.documento_secciones   enable row level security;

drop policy if exists docseg_select on public.documentos_segmentados;
create policy docseg_select on public.documentos_segmentados
  for select to authenticated using ((select public.tiene_acceso_cima()));

drop policy if exists docseg_insert on public.documentos_segmentados;
create policy docseg_insert on public.documentos_segmentados
  for insert to authenticated
  with check ((select public.tiene_acceso_cima()) and creado_por = (select auth.uid()));

drop policy if exists docseg_delete on public.documentos_segmentados;
create policy docseg_delete on public.documentos_segmentados
  for delete to authenticated
  using ((select public.es_admin()) or creado_por = (select auth.uid()));

drop policy if exists docsec_select on public.documento_secciones;
create policy docsec_select on public.documento_secciones
  for select to authenticated using ((select public.tiene_acceso_cima()));

-- Solo se pueden agregar campos a documentos propios.
drop policy if exists docsec_insert on public.documento_secciones;
create policy docsec_insert on public.documento_secciones
  for insert to authenticated
  with check (exists (
    select 1 from public.documentos_segmentados d
    where d.id = documento_id and d.creado_por = (select auth.uid())
  ));

-- ── Storage: archivo original de los documentos subidos (privado) ───────────
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('documentos-segmentados', 'documentos-segmentados', false, 20971520,
        array['application/pdf',
              'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
              'text/html'])
on conflict (id) do nothing;

drop policy if exists docseg_storage_select on storage.objects;
create policy docseg_storage_select on storage.objects
  for select to authenticated
  using (bucket_id = 'documentos-segmentados' and (select public.tiene_acceso_cima()));

drop policy if exists docseg_storage_insert on storage.objects;
create policy docseg_storage_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'documentos-segmentados' and (select public.tiene_acceso_cima()));

-- Borrar el archivo original: quien lo subió o un administrador (igual que docseg_delete).
drop policy if exists docseg_storage_delete on storage.objects;
create policy docseg_storage_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'documentos-segmentados'
         and ((select public.es_admin()) or owner_id = (select auth.uid())::text));
