import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const CITY_ID = "4214805";
const SOURCE = "https://public.asthon.com.br";
const RETENTION_DAYS = 7;
export const COLLECTION_INTERVAL_MINUTES = 5;

export type RiverStatus = "Normalidade" | "Atenção" | "Alerta" | "Emergência";

type Bridge = { id: string; name: string; river_name: string; reference_text: string | null; station_id: string };
type Dam = { id: string; name: string; river_name: string | null; capacity_m: number | null };

let client: SupabaseClient | null = null;
function db() {
  if (!client) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_KEY;
    if (!url || !key) throw new Error("SUPABASE_URL e SUPABASE_KEY não configurados");
    client = createClient(url, key, { auth: { persistSession: false } });
  }
  return client;
}

export function riverStatus(level: number): RiverStatus {
  if (level < 4.5) return "Normalidade";
  if (level < 5.5) return "Atenção";
  if (level < 6.5) return "Alerta";
  return "Emergência";
}

function numberFrom(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(String(value ?? "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function firstNumber(object: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = numberFrom(object[key]);
    if (value !== null) return value;
  }
  return null;
}

function firstString(object: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = object[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

function objectsIn(value: unknown): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  const visit = (item: unknown) => {
    if (!item || typeof item !== "object") return;
    if (Array.isArray(item)) return item.forEach(visit);
    const object = item as Record<string, unknown>;
    found.push(object);
    Object.values(object).forEach(visit);
  };
  visit(value);
  return found;
}

async function sourceJson(path: string) {
  const response = await fetch(`${SOURCE}${path}&_t=${Date.now()}`);
  if (!response.ok) throw new Error(`Fonte hidrológica respondeu ${response.status}`);
  return response.json();
}

async function sourceSnapshot() {
  const bridges = (await db().from("bridges").select("*").eq("active", true)).data as Bridge[] | null;
  const dams = (await db().from("dams").select("*").eq("active", true)).data as Dam[] | null;
  if (!bridges || !dams) throw new Error("Não foi possível carregar a configuração hidrológica");

  const panel = await sourceJson(`/public/panel?city_id=${CITY_ID}&include_geometry=false`);
  const live = await sourceJson(`/public/stations/live?city_id=${CITY_ID}`);
  const damPayload = await sourceJson(`/public/dams?city_id=${CITY_ID}`);
  const stationObjects = [...objectsIn(panel), ...objectsIn(live)];
  const damObjects = objectsIn(damPayload);
  const now = new Date().toISOString();

  const rivers = bridges.flatMap((bridge) => {
    const station = stationObjects.find((item) =>
      String(item.station_id ?? item.id ?? item.uuid ?? "") === bridge.station_id,
    );
    const level = station ? firstNumber(station, ["level_m", "level", "water_level_m", "river_level_m"]) : null;
    if (!station || level === null || level <= 0) return [];
    const measuredAt = firstString(station, ["last_reading_at", "reading_at", "updated_at", "timestamp"]) ?? now;
    return [{ bridgeId: bridge.id, measuredAt, levelM: level, status: riverStatus(level), variationCm: firstNumber(station, ["variation_cm", "variation"]) }];
  });

  const damsOut = dams.flatMap((dam) => {
    const wanted = dam.name.toLowerCase();
    const item = damObjects.find((candidate) => {
      const text = JSON.stringify(candidate).toLowerCase();
      return text.includes(wanted) || (wanted === "taió" && text.includes("taio")) || (wanted === "ituporanga" && text.includes("ituporanga"));
    });
    if (!item) return [];
    const levelM = firstNumber(item, ["nivel_m", "level_m", "level", "water_level_m", "upstream_level_m", "montante_m"]);
    const occupancyPercent = firstNumber(item, ["percent_use", "capacidade_atual", "capacity_percent", "capacity_percentage", "percentage", "percent", "occupancy_percent"]);
    const gates = item.gates ?? item.sluice_gates ?? item.floodgates ?? item.comportas;
    const gateStates = Array.isArray(gates) ? gates : [];
    const gatesOpen = firstNumber(item, ["comportas_abertas", "gates_open", "open_gates", "open_count"]) ?? gateStates.filter((gate) => String((gate as Record<string, unknown>).aberta ?? (gate as Record<string, unknown>).open ?? "").toLowerCase() === "true").length;
    const gatesTotal = firstNumber(item, ["comportas_total", "gates_total", "total_gates", "gate_count"]) ?? gateStates.length;
    return [{ damId: dam.id, measuredAt: firstString(item, ["last_reading_at", "reading_at", "updated_at", "timestamp"]) ?? now, levelM, occupancyPercent, gatesOpen, gatesTotal, gateStates }];
  });
  return { rivers, dams: damsOut };
}

async function latestRows(table: string) {
  const result = await db().from(table).select("*").gte("collected_at", new Date(Date.now() - RETENTION_DAYS * 86400000).toISOString()).order("collected_at", { ascending: false });
  if (result.error) throw result.error;
  const latest = new Map<string, Record<string, any>>();
  for (const row of result.data ?? []) {
    const key = table === "river_readings" ? row.bridge_id : row.dam_id;
    if (!latest.has(key)) latest.set(key, row);
  }
  return latest;
}

export function isCollectionDue(latestCollectedAt: string | Date | null | undefined, now = Date.now()) {
  if (!latestCollectedAt) return true;
  const collectedAt = new Date(latestCollectedAt).getTime();
  if (!Number.isFinite(collectedAt)) return true;
  return now - collectedAt >= COLLECTION_INTERVAL_MINUTES * 60000;
}

async function dueTargets() {
  const [bridges, dams, rivers, damRows] = await Promise.all([
    db().from("bridges").select("*").eq("active", true),
    db().from("dams").select("*").eq("active", true),
    latestRows("river_readings"),
    latestRows("dam_readings"),
  ]);
  if (bridges.error || dams.error) throw bridges.error ?? dams.error;
  const riverDue = (bridges.data ?? []).filter((b) => isCollectionDue(rivers.get(b.id)?.collected_at)).map((b) => b.id);
  const damDue = (dams.data ?? []).filter((d) => isCollectionDue(damRows.get(d.id)?.collected_at)).map((d) => d.id);
  return { riverDue, damDue };
}

export async function collectTick() {
  const { riverDue, damDue } = await dueTargets();
  if (!riverDue.length && !damDue.length) return { skipped: true, rivers: 0, dams: 0 };
  const run = await db().from("collector_runs").insert({ success: false }).select("id").single();
  const payload = await sourceSnapshot();
  const rivers = payload.rivers.filter((row) => riverDue.includes(row.bridgeId));
  const dams = payload.dams.filter((row) => damDue.includes(row.damId));
  const riverInsert = rivers.length ? await db().from("river_readings").upsert(rivers.map((r) => ({ bridge_id: r.bridgeId, measured_at: r.measuredAt, level_m: r.levelM, status: r.status, variation_cm: r.variationCm })), { onConflict: "bridge_id,measured_at" }) : null;
  const damInsert = dams.length ? await db().from("dam_readings").upsert(dams.map((d) => ({ dam_id: d.damId, measured_at: d.measuredAt, level_m: d.levelM, occupancy_percent: d.occupancyPercent, gates_open: d.gatesOpen, gates_total: d.gatesTotal, gate_states: d.gateStates })), { onConflict: "dam_id,measured_at" }) : null;
  const error = riverInsert?.error ?? damInsert?.error;
  if (run.data?.id) await db().from("collector_runs").update({ finished_at: new Date().toISOString(), success: !error, rivers_saved: rivers.length, dams_saved: dams.length, error_message: error?.message ?? null }).eq("id", run.data.id);
  if (error) throw error;
  await db().rpc("cleanup_old_hydrology_readings");
  return { skipped: false, rivers: rivers.length, dams: dams.length };
}

export async function getSnapshot() {
  const [bridges, dams, riverRows, damRows] = await Promise.all([db().from("bridges").select("*").eq("active", true), db().from("dams").select("*").eq("active", true), latestRows("river_readings"), latestRows("dam_readings")]);
  if (bridges.error || dams.error) throw bridges.error ?? dams.error;
  return { bridges: bridges.data ?? [], dams: dams.data ?? [], rivers: Array.from(riverRows.values()), damReadings: Array.from(damRows.values()), asOf: new Date().toISOString() };
}

export async function getHistory(days = 1) {
  const since = new Date(Date.now() - Math.min(days, RETENTION_DAYS) * 86400000).toISOString();
  const [rivers, dams] = await Promise.all([db().from("river_readings").select("*").gte("measured_at", since).order("measured_at", { ascending: true }), db().from("dam_readings").select("*").gte("measured_at", since).order("measured_at", { ascending: true })]);
  if (rivers.error || dams.error) throw rivers.error ?? dams.error;
  return { rivers: rivers.data ?? [], dams: dams.data ?? [] };
}

export async function registerAccess(kind: "app" | "api" = "api") {
  const date = new Date().toISOString().slice(0, 10);
  const field = kind === "app" ? "app_opens" : "api_requests";
  const current = await db().from("daily_access").select("*").eq("access_date", date).maybeSingle();
  const value = Number(current.data?.[field] ?? 0) + 1;
  await db().from("daily_access").upsert({ access_date: date, [field]: value, updated_at: new Date().toISOString() });
  return { date, [field]: value };
}

export function startCollector() {
  const run = () => collectTick().catch((error) => console.error("[Collector]", error));
  run();
  return setInterval(run, 5 * 60 * 1000);
}
