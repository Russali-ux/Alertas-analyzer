-- =====================================================================
-- Modificatorias DIGEMID · Edición por administrador + gestión + auditoría
-- Ejecutar UNA vez en Supabase → SQL Editor (proyecto ggbnfdaxtsngsjssrwrl).
-- Idempotente: se puede volver a correr sin romper nada. No borra datos.
-- =====================================================================

-- 1) Columnas de gestión y trazabilidad
alter table public.modificatorias_digemid
  add column if not exists estado_gestion text not null default 'PENDIENTE',
  add column if not exists notas_admin text,
  add column if not exists editado_manualmente boolean not null default false,
  add column if not exists editado_por uuid,
  add column if not exists editado_en timestamptz;

do $$ begin
  alter table public.modificatorias_digemid
    add constraint modificatorias_estado_gestion_chk
    check (estado_gestion in ('PENDIENTE','EN EVALUACION','COMUNICADO DIGEMID','CERRADO','NO APLICA'));
exception when duplicate_object then null; end $$;

-- 2) Auditoría: quién, cuándo, valor anterior → nuevo (solo la leen admins)
create table if not exists public.modificatorias_digemid_auditoria (
  id bigint generated always as identity primary key,
  modificatoria_id uuid not null references public.modificatorias_digemid(id) on delete cascade,
  usuario_id uuid,
  usuario_email text,
  cambios jsonb not null,
  creado_en timestamptz not null default now()
);
create index if not exists modif_aud_modif_idx
  on public.modificatorias_digemid_auditoria(modificatoria_id, creado_en desc);
alter table public.modificatorias_digemid_auditoria enable row level security;
drop policy if exists "Admin lee auditoria modificatorias" on public.modificatorias_digemid_auditoria;
create policy "Admin lee auditoria modificatorias" on public.modificatorias_digemid_auditoria
  for select to authenticated using (public.es_admin());
revoke insert, update, delete, truncate on public.modificatorias_digemid_auditoria from anon, authenticated;

-- 3) RPC de edición: solo admin, lista blanca de campos, registra el diff.
--    n_modificacion y fecha_publicacion NO son editables: forman la clave única
--    que usa el scraper para el upsert (editarlas generaría duplicados).
create or replace function public.admin_actualizar_modificatoria(target_id uuid, cambios jsonb)
returns public.modificatorias_digemid
language plpgsql security definer set search_path to 'public'
as $$
declare
  editables constant text[] := array['producto','principio_activo','titular_rs','tipo_modificacion','urgencia',
    'accion_requerida','indicador_tiempos','base_legal','resumen','url_pagina_digemid','url_pdf_digemid',
    'estado_gestion','notas_admin'];
  antes jsonb; diff jsonb := '{}'::jsonb; k text; v_new text; v_old text; fila public.modificatorias_digemid;
begin
  if not public.es_admin() then raise exception 'Solo un administrador puede editar modificatorias.'; end if;
  select to_jsonb(m) into antes from public.modificatorias_digemid m where id = target_id;
  if antes is null then raise exception 'No se encontró la modificatoria indicada.'; end if;

  for k in select jsonb_object_keys(cambios) loop
    if not k = any(editables) then raise exception 'Campo no editable: %', k; end if;
    v_new := nullif(btrim(cambios->>k), '');
    if k = 'urgencia' then v_new := upper(v_new); end if;
    v_old := antes->>k;
    if v_new is distinct from v_old then
      diff := diff || jsonb_build_object(k, jsonb_build_object('antes', v_old, 'despues', v_new));
    end if;
  end loop;

  if diff = '{}'::jsonb then
    select * into fila from public.modificatorias_digemid where id = target_id; return fila;
  end if;

  update public.modificatorias_digemid m set
    producto           = case when diff ? 'producto'           then diff->'producto'->>'despues'           else m.producto end,
    principio_activo   = case when diff ? 'principio_activo'   then diff->'principio_activo'->>'despues'   else m.principio_activo end,
    titular_rs         = case when diff ? 'titular_rs'         then diff->'titular_rs'->>'despues'         else m.titular_rs end,
    tipo_modificacion  = case when diff ? 'tipo_modificacion'  then diff->'tipo_modificacion'->>'despues'  else m.tipo_modificacion end,
    urgencia           = case when diff ? 'urgencia'           then diff->'urgencia'->>'despues'           else m.urgencia end,
    accion_requerida   = case when diff ? 'accion_requerida'   then diff->'accion_requerida'->>'despues'   else m.accion_requerida end,
    indicador_tiempos  = case when diff ? 'indicador_tiempos'  then diff->'indicador_tiempos'->>'despues'  else m.indicador_tiempos end,
    base_legal         = case when diff ? 'base_legal'         then diff->'base_legal'->>'despues'         else m.base_legal end,
    resumen            = case when diff ? 'resumen'            then diff->'resumen'->>'despues'            else m.resumen end,
    url_pagina_digemid = case when diff ? 'url_pagina_digemid' then diff->'url_pagina_digemid'->>'despues' else m.url_pagina_digemid end,
    url_pdf_digemid    = case when diff ? 'url_pdf_digemid'    then diff->'url_pdf_digemid'->>'despues'    else m.url_pdf_digemid end,
    estado_gestion     = case when diff ? 'estado_gestion'     then coalesce(diff->'estado_gestion'->>'despues','PENDIENTE') else m.estado_gestion end,
    notas_admin        = case when diff ? 'notas_admin'        then diff->'notas_admin'->>'despues'        else m.notas_admin end,
    editado_manualmente = true, editado_por = auth.uid(), editado_en = now()
  where id = target_id
  returning * into fila;

  insert into public.modificatorias_digemid_auditoria(modificatoria_id, usuario_id, usuario_email, cambios)
  values (target_id, auth.uid(), (select email from public.perfiles where id = auth.uid()), diff);
  return fila;
end $$;
revoke all on function public.admin_actualizar_modificatoria(uuid, jsonb) from public, anon;
grant execute on function public.admin_actualizar_modificatoria(uuid, jsonb) to authenticated;

-- 4) Protección: si el scraper (service_role, sin usuario) re-sube una fila
--    ya corregida a mano, se conservan los valores del administrador.
create or replace function public.proteger_modificatoria_editada()
returns trigger language plpgsql as $$
begin
  if old.editado_manualmente and auth.uid() is null then
    new.producto := old.producto; new.principio_activo := old.principio_activo; new.titular_rs := old.titular_rs;
    new.tipo_modificacion := old.tipo_modificacion; new.urgencia := old.urgencia;
    new.accion_requerida := old.accion_requerida; new.indicador_tiempos := old.indicador_tiempos;
    new.base_legal := old.base_legal; new.resumen := old.resumen;
    new.url_pagina_digemid := coalesce(old.url_pagina_digemid, new.url_pagina_digemid);
    new.url_pdf_digemid := coalesce(old.url_pdf_digemid, new.url_pdf_digemid);
    new.estado_gestion := old.estado_gestion; new.notas_admin := old.notas_admin;
    new.editado_manualmente := true; new.editado_por := old.editado_por; new.editado_en := old.editado_en;
  end if;
  return new;
end $$;
drop trigger if exists trg_proteger_modificatoria_editada on public.modificatorias_digemid;
create trigger trg_proteger_modificatoria_editada before update on public.modificatorias_digemid
  for each row execute function public.proteger_modificatoria_editada();

-- 5) Endurecer: anon/authenticated ya no escriben directo en la tabla (solo vía la RPC).
--    El scraper usa service_role, que no se ve afectado.
revoke insert, update, delete, truncate on public.modificatorias_digemid from anon, authenticated;
