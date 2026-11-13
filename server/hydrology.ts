import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getCentralForecasts, recordAndResolveForecasts } from "./forecast";
import { collectForecastContext, finiteNumber } from "./forecast-sources";

const CITY_ID = "4214805";
const SOURCE = "https://public.asthon.com.br";
export const RETENTION_DAYS = 60;
export const COLLECTION_INTERVAL_MINUTES = 5;

export type RiverStatus = "Normalidade" | "Atenção" | "Alerta" | "Emergência";

type Bridge = { id: string; name: string; river_name: string; reference_text: string | null; station_id: string };
type Dam = { id: string; name: string; river_name: string | null; capacity_m: number | null };

export const BRIDGE_STATION_ALIASES: Record<string, { ids: string[]; names: string[]; rivers: string[] }> = {
  "dom-tito": {
    ids: ["d2f60af1-53e3-497f-81d6-c6498d28f5a2", "f6360951-219f-4859-935f-b2e2d13962f1"],
    names: ["dom tito", "dom tito buss"],
    rivers: ["itajai acu", "itajai-acu"],
  },
  "ricardo-kanitz": {
    ids: ["039a5d4f-f58d-4fca-bef6-5d37e132a6f0", "30475400-b7ba-4551-9646-19df0c3bfa38"],
    names: ["hannelore", "ricardo kanitz"],
    rivers: ["itajai do sul"],
  },
  "br-470": {
    ids: ["3167e629-3bbe-48f2-9244-c65dfe6882d8"],
    names: ["br 470", "br470"],
    rivers: ["itajai do oeste"],
  },
};

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
  if (level <= 6.5) return "Alerta";
  return "Emergência";
}

function numberFrom(value: unknown): number | null {
  return finiteNumber(value);
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

function normalizeText(value: unknown) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

export function stationForBridge(stations: Record<string, unknown>[], bridge: Bridge) {
  const aliases = BRIDGE_STATION_ALIASES[bridge.id];
  const configuredId = normalizeText(bridge.station_id);
  const station = stations.find((item) => {
    const stationId = normalizeText(item.station_id ?? item.id ?? item.uuid);
    return stationId && (stationId === configuredId || aliases?.ids.some((id) => stationId === normalizeText(id)));
  });
  if (station) return station;

  return stations.find((item) => {
    const name = normalizeText(item.name);
    const river = normalizeText(item.river_name);
    const nameMatch = aliases?.names.some((alias) => name.includes(normalizeText(alias))) || name.includes(normalizeText(bridge.name));
    const riverMatch = aliases?.rivers.some((alias) => river.includes(normalizeText(alias))) || river.includes(normalizeText(bridge.river_name));
    return Boolean(nameMatch && riverMatch && firstNumber(item, ["level_m", "level", "water_level_m", "river_level_m"]) !== null);
  });
}

async function sourceJson(path: string) {
  const response = await fetch(`${SOURCE}${path}&_t=${Date.now()}`, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Fonte hidrológica respondeu ${response.status}`);
  return response.json();
}

async function sourceSnapshot() {
  const bridges = (await db().from("bridges").select("*").eq("active", true)).data as Bridge[] | null;
  const dams = (await db().from("dams").select("*").eq("active", true)).data as Dam[] | null;
  if (!bridges || !dams) throw new Error("Não foi possível carregar a configuração hidrológica");

  const [panel, live, damPayload] = await Promise.all([
    sourceJson(`/public/panel?city_id=${CITY_ID}&include_geometry=false`),
    sourceJson(`/public/stations/live?city_id=${CITY_ID}`),
    sourceJson(`/public/dams?city_id=${CITY_ID}`),
  ]);
  const stationObjects = [...objectsIn(panel), ...objectsIn(live)];
  const damObjects = objectsIn(damPayload);
  const now = new Date().toISOString();

  const rivers = bridges.flatMap((bridge) => {
    const station = stationForBridge(stationObjects, bridge);
    const level = station ? firstNumber(station, ["level_m", "level", "water_level_m", "river_level_m"]) : null;
    if (!station || level === null || level <= 0) return [];
    const measuredAt = firstString(station, ["last_reading_at", "reading_at", "updated_at", "timestamp"]);
    if (!measuredAt || !Number.isFinite(Date.parse(measuredAt)) || Date.parse(measuredAt) > Date.now()) return [];
    return [{ bridgeId: bridge.id, measuredAt, levelM: level, status: riverStatus(level), variationCm: firstNumber(station, ["variation_cm", "variation"]) }];
  });

  const damsOut = dams.flatMap((dam) => {
    const wanted = dam.name.toLowerCase();
    const item = damObjects.find((candidate) => {
      if (firstNumber(candidate, ["nivel_m", "level_m", "upstream_level_m", "montante_m"]) === null) return false;
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
  const forecastContext = await collectForecastContext(panel);
  return { rivers, dams: damsOut, forecastContext };
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
  if (!riverDue.length && !damDue.length) {
    const bridgeRows = await db().from("bridges").select("id,station_id").eq("active", true);
    if (bridgeRows.error) throw bridgeRows.error;
    const forecasts = await recordAndResolveForecasts(db(), bridgeRows.data ?? []);
    return { skipped: true, rivers: 0, dams: 0, forecasts };
  }
  const run = await db().from("collector_runs").insert({ success: false }).select("id").single();
  const payload = await sourceSnapshot();
  const rivers = payload.rivers.filter((row) => riverDue.includes(row.bridgeId));
  const dams = payload.dams.filter((row) => damDue.includes(row.damId));
  const riverInsert = rivers.length ? await db().from("river_readings").upsert(rivers.map((r) => ({ bridge_id: r.bridgeId, measured_at: r.measuredAt, level_m: r.levelM, status: r.status, variation_cm: r.variationCm })), { onConflict: "bridge_id,measured_at" }) : null;
  const damInsert = dams.length ? await db().from("dam_readings").upsert(dams.map((d) => ({ dam_id: d.damId, measured_at: d.measuredAt, level_m: d.levelM, occupancy_percent: d.occupancyPercent, gates_open: d.gatesOpen, gates_total: d.gatesTotal, gate_states: d.gateStates })), { onConflict: "dam_id,measured_at" }) : null;
  const error = riverInsert?.error ?? damInsert?.error;
  if (run.data?.id) await db().from("collector_runs").update({ finished_at: new Date().toISOString(), success: !error, rivers_saved: rivers.length, dams_saved: dams.length, error_message: error?.message ?? null }).eq("id", run.data.id);
  if (error) throw error;
  const cleanup = await db().rpc("cleanup_old_hydrology_readings");
  if (cleanup.error) throw cleanup.error;
  const contextSaved = await db().from("forecast_context").upsert({ collected_at: payload.forecastContext.captured_at, source: "Defesa Civil — telemetria pública", payload: payload.forecastContext });
  if (contextSaved.error) throw contextSaved.error;
  const bridgeRows = await db().from("bridges").select("id,station_id").eq("active", true);
  if (bridgeRows.error) throw bridgeRows.error;
  const forecasts = await recordAndResolveForecasts(db(), bridgeRows.data ?? []);
  return { skipped: false, rivers: rivers.length, dams: dams.length, forecasts };
}

export async function getSnapshot() {
  const [bridges, dams, riverRows, damRows] = await Promise.all([db().from("bridges").select("*").eq("active", true), db().from("dams").select("*").eq("active", true), latestRows("river_readings"), latestRows("dam_readings")]);
  if (bridges.error || dams.error) throw bridges.error ?? dams.error;
  return { bridges: bridges.data ?? [], dams: dams.data ?? [], rivers: Array.from(riverRows.values()), damReadings: Array.from(damRows.values()), asOf: new Date().toISOString() };
}

export async function getHistory(days = 1) {
  if (!Number.isFinite(days) || days < 1 || days > RETENTION_DAYS) throw new Error('days deve estar entre 1 e 60');
  const since = new Date(Date.now() - Math.min(days, RETENTION_DAYS) * 86400000).toISOString();
  const read = async (table: string) => {
    const rows: any[] = [];
    for (let offset = 0; offset < 100000; offset += 1000) {
      const result = await db().from(table).select('*').gte('measured_at', since)
        .order('measured_at').order('id').range(offset, offset + 999);
      if (result.error) throw result.error;
      rows.push(...(result.data ?? []));
      if ((result.data?.length ?? 0) < 1000) return rows;
    }
    throw new Error('Histórico excede o limite de paginação');
  };
  const [rivers, dams] = await Promise.all([read('river_readings'), read('dam_readings')]);
  return { rivers, dams, retention_days: RETENTION_DAYS };
}

export async function getForecasts(bridge?: string, hours = 24) {
  return getCentralForecasts(db(), bridge, hours);
}

export async function registerAccess(kind: "app" | "api" = "api") {
  const date = new Date().toISOString().slice(0, 10);
  const field = kind === "app" ? "app_opens" : "api_requests";
  const current = await db().from("daily_access").select("*").eq("access_date", date).maybeSingle();
  const value = Number(current.data?.[field] ?? 0) + 1;
  await db().from("daily_access").upsert({ access_date: date, [field]: value, updated_at: new Date().toISOString() });
  return { date, [field]: value };
}

export async function isRegisteredCollectorJob(taskUid: string) {
  const result = await db().from("forecast_jobs").select("job_key")
    .eq("schedule_cron_task_uid", taskUid).eq("enabled", true).maybeSingle();
  if (result.error) throw result.error;
  return Boolean(result.data);
}
