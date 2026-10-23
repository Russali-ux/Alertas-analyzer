create schema if not exists public;  -- Producto & Titular: edición/eliminación auditada (correr una vez en Supabase SQL Editor; idempotente)

-- 1) Tabla de auditoría (sin FK a medicamentos: el historial sobrevive a la eliminación)
create table if not exists public.medicamentos_auditoria (
  id bigint generated always as identity primary key,
  medicamento_id uuid not null,
  producto text,                       -- nombre del producto al momento del cambio
  accion text not null check (accion in ('CREADO','EDITADO','ELIMINADO','TITULAR AGREGADO','TITULAR QUITADO','TITULAR PRINCIPAL')),
  cambios jsonb,                       -- {campo:{antes,despues}} o snapshot completo
  motivo text,
  usuario_id uuid,
  usuario_email text,
  creado_en timestamptz not null default now()
);
create index if not exists med_aud_med_idx on public.medicamentos_auditoria(medicamento_id, creado_en desc);
create index if not exists med_aud_fecha_idx on public.medicamentos_auditoria(creado_en desc);
alter table public.medicamentos_auditoria enable row level security;
drop policy if exists "Admin lee auditoria medicamentos" on public.medicamentos_auditoria;
create policy "Admin lee auditoria medicamentos" on public.medicamentos_auditoria
  for select to authenticated using (public.es_admin());
revoke insert, update, delete, truncate on public.medicamentos_auditoria from anon, authenticated;

-- Helper: email del usuario actual
create or replace function public._aud_email() returns text
language sql stable security definer set search_path to 'public'
as $$ select email from public.perfiles where id = auth.uid() $$;

-- 2) Trigger sobre medicamentos
create or replace function public.auditar_medicamentos()
returns trigger language plpgsql security definer set search_path to 'public'
as $$
declare diff jsonb := '{}'::jsonb; k text; o jsonb; n jsonb;
        motivo text := nullif(current_setting('app.motivo', true), '');
begin
  if tg_op = 'INSERT' then
    insert into medicamentos_auditoria(medicamento_id, producto, accion, cambios, motivo, usuario_id, usuario_email)
    values (new.id, new.descripcion_producto, 'CREADO', to_jsonb(new) - 'creado_en' - 'actualizado_en', motivo, auth.uid(), _aud_email());
    return new;
  elsif tg_op = 'UPDATE' then
    o := to_jsonb(old); n := to_jsonb(new);
    for k in select jsonb_object_keys(n) loop
      if k not in ('creado_en','actualizado_en') and (o->k) is distinct from (n->k) then
        diff := diff || jsonb_build_object(k, jsonb_build_object('antes', o->k, 'despues', n->k));
      end if;
    end loop;
    if diff <> '{}'::jsonb then
      insert into medicamentos_auditoria(medicamento_id, producto, accion, cambios, motivo, usuario_id, usuario_email)
      values (new.id, new.descripcion_producto, 'EDITADO', diff, motivo, auth.uid(), _aud_email());
    end if;
    return new;
  else
    insert into medicamentos_auditoria(medicamento_id, producto, accion, cambios, motivo, usuario_id, usuario_email)
    values (old.id, old.descripcion_producto, 'ELIMINADO',
            to_jsonb(old) || jsonb_build_object('titulares',
              (select coalesce(jsonb_agg(t.razon_social), '[]'::jsonb) from medicamento_titulares mt
                 join titulares_registro_sanitario t on t.id = mt.titular_id where mt.medicamento_id = old.id)),
            motivo, auth.uid(), _aud_email());
    return old;
  end if;
end $$;
drop trigger if exists trg_auditar_medicamentos on public.medicamentos;
create trigger trg_auditar_medicamentos after insert or update on public.medicamentos
  for each row execute function public.auditar_medicamentos();
-- BEFORE DELETE: captura los titulares antes de que el CASCADE los borre
drop trigger if exists trg_auditar_medicamentos_del on public.medicamentos;
create trigger trg_auditar_medicamentos_del before delete on public.medicamentos
  for each row execute function public.auditar_medicamentos();

-- 3) Trigger sobre medicamento_titulares (asignaciones)
create or replace function public.auditar_medicamento_titulares()
returns trigger language plpgsql security definer set search_path to 'public'
as $$
declare r record; tit text; prod text; motivo text := nullif(current_setting('app.motivo', true), '');
begin
  -- Si el producto se está eliminando (cascade), no registrar cada titular por separado
  if tg_op = 'DELETE' and current_setting('app.eliminando', true) = old.medicamento_id::text then return old; end if;
  if tg_op = 'DELETE' then r := old; else r := new; end if;
  select razon_social into tit from titulares_registro_sanitario where id = r.titular_id;
  select descripcion_producto into prod from medicamentos where id = r.medicamento_id;
  if tg_op = 'INSERT' then
    insert into medicamentos_auditoria(medicamento_id, producto, accion, cambios, motivo, usuario_id, usuario_email)
    values (new.medicamento_id, prod, 'TITULAR AGREGADO', jsonb_build_object('titular', tit, 'es_principal', new.es_principal), motivo, auth.uid(), _aud_email());
  elsif tg_op = 'DELETE' then
    insert into medicamentos_auditoria(medicamento_id, producto, accion, cambios, motivo, usuario_id, usuario_email)
    values (old.medicamento_id, prod, 'TITULAR QUITADO', jsonb_build_object('titular', tit, 'es_principal', old.es_principal), motivo, auth.uid(), _aud_email());
  elsif old.es_principal is distinct from new.es_principal then
    insert into medicamentos_auditoria(medicamento_id, producto, accion, cambios, motivo, usuario_id, usuario_email)
    values (new.medicamento_id, prod, 'TITULAR PRINCIPAL', jsonb_build_object('titular', tit, 'es_principal', jsonb_build_object('antes', old.es_principal, 'despues', new.es_principal)), motivo, auth.uid(), _aud_email());
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
drop trigger if exists trg_auditar_medtit on public.medicamento_titulares;
create trigger trg_auditar_medtit after insert or update or delete on public.medicamento_titulares
  for each row execute function public.auditar_medicamento_titulares();

-- 4) RPC: editar producto + titulares en una sola transacción, con motivo obligatorio
--    cambios   = {"descripcion_producto": "...", "vcto_registro_sanitario": "2027-01-31", ...}
--    titulares = [{"titular_id": "uuid", "es_principal": true}, ...]   (null = no tocar titulares)
create or replace function public.admin_actualizar_medicamento(target_id uuid, cambios jsonb, titulares jsonb default null, motivo text default null)
returns public.medicamentos
language plpgsql security definer set search_path to 'public'
as $$
declare
  editables constant text[] := array['nro','descripcion_producto','principio_activo','accion_terapeutica','via_administracion',
    'presentacion','tvu','fabricante','nro_registro_sanitario','vcto_registro_sanitario','nro_expediente_reinscripcion',
    'condicion_almacenamiento','pais'];
  k text; fila public.medicamentos; nuevos uuid[]; ppal uuid;
begin
  if not public.es_admin() then raise exception 'Solo un administrador puede editar productos.'; end if;
  if not exists (select 1 from medicamentos where id = target_id) then raise exception 'No se encontró el producto.'; end if;
  if coalesce(btrim(motivo), '') = '' then raise exception 'Indica el motivo del cambio.'; end if;
  perform set_config('app.motivo', btrim(motivo), true);
  cambios := coalesce(cambios, '{}'::jsonb);
  for k in select jsonb_object_keys(cambios) loop
    if not k = any(editables) then raise exception 'Campo no editable: %', k; end if;
  end loop;
  if cambios ? 'descripcion_producto' and coalesce(btrim(cambios->>'descripcion_producto'), '') = '' then
    raise exception 'El nombre del producto es obligatorio.';
  end if;

  if cambios <> '{}'::jsonb then
  update medicamentos m set
    nro                          = case when cambios ? 'nro' then nullif(cambios->>'nro','')::int else m.nro end,
    descripcion_producto         = case when cambios ? 'descripcion_producto' then btrim(cambios->>'descripcion_producto') else m.descripcion_producto end,
    principio_activo             = case when cambios ? 'principio_activo' then nullif(btrim(cambios->>'principio_activo'),'') else m.principio_activo end,
    accion_terapeutica           = case when cambios ? 'accion_terapeutica' then nullif(btrim(cambios->>'accion_terapeutica'),'') else m.accion_terapeutica end,
    via_administracion           = case when cambios ? 'via_administracion' then nullif(btrim(cambios->>'via_administracion'),'') else m.via_administracion end,
    presentacion                 = case when cambios ? 'presentacion' then nullif(btrim(cambios->>'presentacion'),'') else m.presentacion end,
    tvu                          = case when cambios ? 'tvu' then nullif(btrim(cambios->>'tvu'),'') else m.tvu end,
    fabricante                   = case when cambios ? 'fabricante' then nullif(btrim(cambios->>'fabricante'),'') else m.fabricante end,
    nro_registro_sanitario       = case when cambios ? 'nro_registro_sanitario' then nullif(btrim(cambios->>'nro_registro_sanitario'),'') else m.nro_registro_sanitario end,
    vcto_registro_sanitario      = case when cambios ? 'vcto_registro_sanitario' then nullif(cambios->>'vcto_registro_sanitario','')::date else m.vcto_registro_sanitario end,
    nro_expediente_reinscripcion = case when cambios ? 'nro_expediente_reinscripcion' then nullif(btrim(cambios->>'nro_expediente_reinscripcion'),'') else m.nro_expediente_reinscripcion end,
    condicion_almacenamiento     = case when cambios ? 'condicion_almacenamiento' then nullif(btrim(cambios->>'condicion_almacenamiento'),'') else m.condicion_almacenamiento end,
    pais                         = case when cambios ? 'pais' then nullif(btrim(cambios->>'pais'),'') else m.pais end,
    actualizado_en = now()
  where id = target_id;
  end if;

  -- Titulares: solo se tocan las filas que cambian (historial limpio)
  if titulares is not null then
    select coalesce(array_agg((x->>'titular_id')::uuid), '{}') into nuevos from jsonb_array_elements(titulares) x;
    select (x->>'titular_id')::uuid into ppal from jsonb_array_elements(titulares) x where (x->>'es_principal')::boolean limit 1;
    if ppal is null and coalesce(array_length(nuevos, 1), 0) > 0 then ppal := nuevos[1]; end if;
    delete from medicamento_titulares where medicamento_id = target_id and not (titular_id = any(nuevos));
    insert into medicamento_titulares(medicamento_id, titular_id, es_principal)
      select target_id, u, u = ppal from unnest(nuevos) u
      where not exists (select 1 from medicamento_titulares where medicamento_id = target_id and titular_id = u);
    update medicamento_titulares set es_principal = (titular_id = ppal)
      where medicamento_id = target_id and es_principal is distinct from (titular_id = ppal);
  end if;

  select * into fila from medicamentos where id = target_id;
  return fila;
end $$;
revoke all on function public.admin_actualizar_medicamento(uuid, jsonb, jsonb, text) from public, anon;
grant execute on function public.admin_actualizar_medicamento(uuid, jsonb, jsonb, text) to authenticated;

-- 5) RPC: eliminar producto con motivo obligatorio.
--    Se bloquea si tiene alertas vinculadas (alertas_producto_titular) para no romper
--    la trazabilidad de los FT-68/FT-69 ya emitidos.
create or replace function public.admin_eliminar_medicamento(target_id uuid, motivo text)
returns void
language plpgsql security definer set search_path to 'public'
as $$
declare n int;
begin
  if not public.es_admin() then raise exception 'Solo un administrador puede eliminar productos.'; end if;
  if coalesce(btrim(motivo), '') = '' then raise exception 'Indica el motivo de la eliminación.'; end if;
  select count(*) into n from alertas_producto_titular where medicamento_id = target_id;
  if n > 0 then
    raise exception 'No se puede eliminar: el producto tiene % alerta(s) registrada(s). Elimina o reasigna esas alertas primero.', n;
  end if;
  perform set_config('app.motivo', btrim(motivo), true);
  perform set_config('app.eliminando', target_id::text, true);
  delete from medicamentos where id = target_id;
  if not found then raise exception 'No se encontró el producto.'; end if;
end $$;
revoke all on function public.admin_eliminar_medicamento(uuid, text) from public, anon;
grant execute on function public.admin_eliminar_medicamento(uuid, text) to authenticated;

-- 6) Conteo de alertas por producto (para avisar antes de eliminar)
create or replace function public.medicamento_n_alertas(target_id uuid)
returns int language sql stable security definer set search_path to 'public'
as $$ select case when public.es_admin() then (select count(*)::int from alertas_producto_titular where medicamento_id = target_id) else null end $$;
grant execute on function public.medicamento_n_alertas(uuid) to authenticated;
