// Supabase Edge Function: agente-despachar
// ---------------------------------------------------------------
// La llama agente/index.html justo después de insertar una tarea.
// Verifica que la tarea sea del usuario y esté pendiente, y despierta
// al agente en GitHub Actions con un repository_dispatch.
//
// Secretos (Supabase → Edge Functions → Secrets):
//   GH_DISPATCH_TOKEN  PAT fine-grained del repo Alertas-analyzer con
//                      permiso "Contents: Read and write"
//   GH_REPO            Russali-ux/Alertas-analyzer
// SUPABASE_URL y SUPABASE_ANON_KEY ya vienen inyectadas.
//
// Si esta función falla o no está desplegada, la tarea no se pierde:
// el workflow del agente también revisa pendientes cada 15 minutos.
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);

  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return json({ error: "Sin sesión" }, 401);

  let tareaId = "";
  try { tareaId = (await req.json()).tarea_id ?? ""; } catch { /* cuerpo inválido */ }
  if (!/^[0-9a-f-]{36}$/i.test(tareaId)) return json({ error: "tarea_id inválido" }, 400);

  // Cliente con el JWT del usuario: la RLS garantiza que solo vea sus tareas.
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: auth } },
  });
  const { data: tarea, error } = await sb.from("agente_tareas")
    .select("id, estado").eq("id", tareaId).maybeSingle();
  if (error) return json({ error: error.message }, 500);
  if (!tarea) return json({ error: "Tarea no encontrada" }, 404);
  if (tarea.estado !== "pendiente") return json({ ok: true, aviso: `La tarea ya está ${tarea.estado}` });

  const token = Deno.env.get("GH_DISPATCH_TOKEN");
  const repo = Deno.env.get("GH_REPO") ?? "Russali-ux/Alertas-analyzer";
  if (!token) return json({ ok: false, aviso: "Sin GH_DISPATCH_TOKEN; la tomará el ciclo de 15 min" });

  const r = await fetch(`https://api.github.com/repos/${repo}/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "conkosafe-agente",
    },
    body: JSON.stringify({ event_type: "agente_tarea", client_payload: { tarea_id: tareaId } }),
  });
  if (r.status !== 204) return json({ ok: false, aviso: `GitHub respondió ${r.status}` }, 502);
  return json({ ok: true });
});
