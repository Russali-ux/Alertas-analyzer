-- ════════════════════════════════════════════════════════════════════════════
-- Alertas por Producto & Titular · vincular alertas PAVS (alta vigilancia)
-- Ejecutar en Supabase ANTES de publicar titulares/index.html.
-- Cambio aditivo: los registros existentes (DIGEMID / manual) no se modifican.
-- ════════════════════════════════════════════════════════════════════════════

-- 1. Referencia a la alerta PAVS
alter table public.alertas_producto_titular
  add column if not exists alerta_pavs_id uuid
  references public.pavs_alertas(id) on delete set null;

create index if not exists idx_apt_pavs on public.alertas_producto_titular (alerta_pavs_id);

-- 2. Nuevo origen permitido: 'pavs_vinculada'
alter table public.alertas_producto_titular drop constraint if exists alertas_producto_titular_origen_check;
alter table public.alertas_producto_titular
  add constraint alertas_producto_titular_origen_check
  check (origen = any (array['digemid_vinculada','pavs_vinculada','manual']));

-- 3. Un registro se vincula a UNA sola fuente (DIGEMID o PAVS), nunca a ambas
alter table public.alertas_producto_titular drop constraint if exists chk_apt_una_fuente;
alter table public.alertas_producto_titular
  add constraint chk_apt_una_fuente
  check (num_nonnulls(alerta_digemid_id, alerta_pavs_id) <= 1);

-- 4. Refrescar el esquema de la API para que el embed pavs:pavs_alertas(...) funcione ya
notify pgrst, 'reload schema';
