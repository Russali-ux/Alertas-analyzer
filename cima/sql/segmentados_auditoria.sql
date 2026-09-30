-- ════════════════════════════════════════════════════════════════════════════
-- DOCUMENTOS SEGMENTADOS · ELIMINACIÓN LÓGICA + BITÁCORA DE AUDITORÍA
-- (ALCOA+ · 21 CFR Part 11 · EU GMP Anexo 11)
--
-- Ejecutar DESPUÉS de documentos_segmentados.sql y control_versiones.sql.
--
--  · "Eliminar" una versión ya NO borra la fila: la marca como eliminada
--    (eliminado_en / eliminado_por / motivo). Sus campos y su archivo se conservan.
--  · Cada alta y cada eliminación queda en documentos_segmentados_auditoria
--    (quién, cuándo —hora del servidor—, motivo y snapshot de la fila). Inmutable.
--  · Única vía para eliminar: RPC eliminar_documento_segmentado(p_id, p_motivo).
--  · El DELETE físico queda bloqueado, salvo la limpieza de una cabecera
--    huérfana (sin campos) recién creada por el mismo usuario, que también se audita.
-- ════════════════════════════════════════════════════════════════════════════

-- ── 1. Columnas de eliminación lógica ───────────────────────────────────────
alter table public.documentos_segmentados
  add column if not exists eliminado_en         timestamptz,
  add column if not exists eliminado_por        uuid,
  add column if not exists eliminado_por_email  text,
  add column if not exists eliminado_por_nombre text,
  add column if not exists motivo_eliminacion   text;

-- Una versión CIMA eliminada no debe impedir volver a segmentar esa misma versión.
drop index if exists public.documentos_segmentados_cima_version_uq;
create unique index documentos_segmentados_cima_version_uq
  on public.documentos_segmentados (tipo_documento, nregistro, fecha_version_cima)
  where origen = 'cima' and eliminado_en is null;
create index if not exists documentos_segmentados_eliminado_idx
  on public.documentos_segmentados (eliminado_en);

-- ── 2. Bitácora de auditoría (inmutable) ────────────────────────────────────
-- Sin FK a documentos_segmentados a propósito: el registro de auditoría debe
-- sobrevivir aunque la fila de origen desaparezca.
create table if not exists public.documentos_segmentados_auditoria (
  id             bigint generated always as identity primary key,
  documento_id   uuid not null,
  evento         text not null check (evento in ('CREAR', 'ELIMINAR', 'DESCARTAR_INCOMPLETO')),
  motivo         text,
  snapshot       jsonb not null,            -- fila completa al momento del evento
  usuario        uuid,
  usuario_email  text,
  usuario_nombre text,
  creado_en      timestamptz not null default now()
);
comment on table public.documentos_segmentados_auditoria is
  'Bitácora inmutable de altas y eliminaciones de documentos segmentados (FT / Prospecto).';
create index if not exists docseg_aud_doc_idx   on public.documentos_segmentados_auditoria (documento_id);
create index if not exists docseg_aud_fecha_idx on public.documentos_segmentados_auditoria (creado_en desc);

drop trigger if exists documentos_segmentados_auditoria_inmutable on public.documentos_segmentados_auditoria;
create trigger documentos_segmentados_auditoria_inmutable
  before update or delete on public.documentos_segmentados_auditoria
  for each row execute function public.bloquear_registro_controlado();
drop trigger if exists documentos_segmentados_auditoria_no_truncate on public.documentos_segmentados_auditoria;
create trigger documentos_segmentados_auditoria_no_truncate
  before truncate on public.documentos_segmentados_auditoria
  for each statement execute function public.bloquear_registro_controlado();

alter table public.documentos_segmentados_auditoria enable row level security;
revoke insert, update, delete, truncate on public.documentos_segmentados_auditoria from anon, authenticated;
drop policy if exists docseg_aud_select on public.documentos_segmentados_auditoria;
create policy docseg_aud_select on public.documentos_segmentados_auditoria
  for select to authenticated using ((select public.tiene_acceso_cima()));

-- Helper interno: escribe un evento con los datos del usuario actual.
create or replace function public._auditar_docseg(p_row public.documentos_segmentados, p_evento text, p_motivo text)
returns void language plpgsql security definer set search_path = 'public' as $$
declare v_email text; v_nombre text;
begin
  select email, nombre into v_email, v_nombre from public.perfiles where id = auth.uid();
  insert into public.documentos_segmentados_auditoria
    (documento_id, evento, motivo, snapshot, usuario, usuario_email, usuario_nombre)
  values (p_row.id, p_evento, p_motivo, to_jsonb(p_row), auth.uid(), v_email, v_nombre);
end;
$$;
revoke execute on function public._auditar_docseg(public.documentos_segmentados, text, text) from public, anon, authenticated;

-- ── 3. Triggers sobre documentos_segmentados ────────────────────────────────
-- 3a. Alta → evento CREAR
create or replace function public.docseg_trg_insert()
returns trigger language plpgsql security definer set search_path = 'public' as $$
begin
  perform public._auditar_docseg(new, 'CREAR', null);
  return new;
end;
$$;
drop trigger if exists docseg_auditar_insert on public.documentos_segmentados;
create trigger docseg_auditar_insert after insert on public.documentos_segmentados
  for each row execute function public.docseg_trg_insert();

-- 3b. UPDATE: solo se permite pasar de "vigente" a "eliminado"; el contenido es inmutable
--     y una fila eliminada no se puede modificar ni "des-eliminar".
create or replace function public.docseg_trg_update()
returns trigger language plpgsql set search_path = '' as $$
declare
  cols_elim text[] := array['eliminado_en','eliminado_por','eliminado_por_email','eliminado_por_nombre','motivo_eliminacion'];
begin
  if old.eliminado_en is not null then
    raise exception 'El documento segmentado ya fue eliminado: el registro es de solo lectura.' using errcode = '42501';
  end if;
  if (to_jsonb(new) - cols_elim) is distinct from (to_jsonb(old) - cols_elim) then
    raise exception 'El contenido de un documento segmentado no se puede modificar.' using errcode = '42501';
  end if;
  return new;
end;
$$;
drop trigger if exists docseg_proteger_update on public.documentos_segmentados;
create trigger docseg_proteger_update before update on public.documentos_segmentados
  for each row execute function public.docseg_trg_update();

-- 3c. DELETE físico: bloqueado. Única excepción: cabecera huérfana (0 campos),
--     del mismo usuario, creada hace menos de 15 min (falló el guardado de campos).
create or replace function public.docseg_trg_delete()
returns trigger language plpgsql security definer set search_path = 'public' as $$
begin
  if old.creado_por = auth.uid()
     and old.creado_en > now() - interval '15 minutes'
     and not exists (select 1 from public.documento_secciones s where s.documento_id = old.id) then
    perform public._auditar_docseg(old, 'DESCARTAR_INCOMPLETO', 'Guardado incompleto: no se pudieron registrar los campos.');
    return old;
  end if;
  raise exception 'No se permite borrar documentos segmentados: use "Eliminar" (queda registrado en la bitácora).'
    using errcode = '42501';
end;
$$;
drop trigger if exists docseg_proteger_delete on public.documentos_segmentados;
create trigger docseg_proteger_delete before delete on public.documentos_segmentados
  for each row execute function public.docseg_trg_delete();

-- Los campos tampoco se borran ni se editan.
drop trigger if exists documento_secciones_inmutable on public.documento_secciones;
create trigger documento_secciones_inmutable before update or delete on public.documento_secciones
  for each row execute function public.bloquear_registro_controlado();

-- ── 4. RPC: eliminar una versión (única vía) ────────────────────────────────
create or replace function public.eliminar_documento_segmentado(p_id uuid, p_motivo text)
returns jsonb language plpgsql security definer set search_path = 'public' as $$
declare
  v_uid uuid := auth.uid();
  v_doc public.documentos_segmentados;
  v_email text; v_nombre text;
begin
  if v_uid is null or not public.tiene_acceso_cima() then
    raise exception 'Sin acceso al módulo CIMA.' using errcode = '42501';
  end if;
  if length(btrim(coalesce(p_motivo, ''))) < 10 then
    raise exception 'El motivo de la eliminación es obligatorio (mínimo 10 caracteres).';
  end if;

  select * into v_doc from public.documentos_segmentados where id = p_id for update;
  if not found then raise exception 'Documento no encontrado.'; end if;
  if v_doc.eliminado_en is not null then raise exception 'El documento ya estaba eliminado.'; end if;
  if not (public.es_admin() or v_doc.creado_por = v_uid) then
    raise exception 'Solo quien guardó el documento o un administrador puede eliminarlo.' using errcode = '42501';
  end if;
  if exists (select 1 from public.documento_versiones v where v.referencia_segmentado_id = p_id) then
    raise exception 'Este documento es la referencia de una versión controlada y no puede eliminarse (integridad del registro).';
  end if;

  select email, nombre into v_email, v_nombre from public.perfiles where id = v_uid;

  update public.documentos_segmentados
     set eliminado_en = now(), eliminado_por = v_uid, eliminado_por_email = v_email,
         eliminado_por_nombre = v_nombre, motivo_eliminacion = btrim(p_motivo)
   where id = p_id
  returning * into v_doc;

  perform public._auditar_docseg(v_doc, 'ELIMINAR', btrim(p_motivo));
  return jsonb_build_object('id', v_doc.id, 'eliminado_en', v_doc.eliminado_en);
end;
$$;
revoke execute on function public.eliminar_documento_segmentado(uuid, text) from public, anon;
grant  execute on function public.eliminar_documento_segmentado(uuid, text) to authenticated;

-- La política de DELETE directo ya no se usa (todo pasa por la RPC).
drop policy if exists docseg_delete on public.documentos_segmentados;
-- Se recrea solo para la limpieza de cabeceras huérfanas (el trigger 3c decide).
create policy docseg_delete on public.documentos_segmentados
  for delete to authenticated using (creado_por = (select auth.uid()));

-- ── 5. Alta retroactiva en la bitácora de los documentos ya existentes ──────
insert into public.documentos_segmentados_auditoria (documento_id, evento, motivo, snapshot, usuario, creado_en)
select d.id, 'CREAR', 'Registro retroactivo al activar la bitácora', to_jsonb(d), d.creado_por, d.creado_en
  from public.documentos_segmentados d
 where not exists (select 1 from public.documentos_segmentados_auditoria a
                    where a.documento_id = d.id and a.evento = 'CREAR');
