import type { SupabaseClient } from "@supabase/supabase-js";
import { computeForecastV2 } from "./forecast-model-v2";
import { rainForBridge, type ForecastContext } from "./forecast-sources";

export const FORECAST_RETENTION_DAYS = 7;
export const FORECAST_MODEL_VERSION = "deterministic-v2";
export const CENTRAL_FORECAST_TABLE = "central_river_forecasts";
const MINUTE = 60000;
const HOUR = 60 * MINUTE;
const MATCH_WINDOW = 10 * MINUTE;
export type ForecastOutcome = "pendente" | "dentro" | "quase" | "fora" | "sem_medicao";
export type ForecastSample = { measured_at: string; level_m: number };
export type ForecastBridge = { id: string; station_id: string | null };
export type ForecastDam = { id: string; gates_open: number | null; gates_total: number | null; gate_delta?: number };
export function classifyForecast(errorCm: number, toleranceCm: number): ForecastOutcome {
  if (!Number.isFinite(errorCm) || !Number.isFinite(toleranceCm) || toleranceCm <= 0) return "sem_medicao";
  const tolerance = toleranceCm;
  return Math.abs(errorCm) <= tolerance ? "dentro" : Math.abs(errorCm) <= tolerance * 2 ? "quase" : "fora";
}

// Compatibility adapter for existing unit tests; no v1 forecasting implementation remains.
export function computeForecast(bridge: ForecastBridge, samples: ForecastSample[], _dams: ForecastDam[], now = Date.now()) {
  const f = computeForecastV2({ bridge, samples, now });
  return f.horizons.map(h => ({ bridge: bridge.id, horizon_h: h.hours, target_time: h.target_time, base_time: f.base_time, current_level: f.current_level, predicted_level: h.predicted_level, band_cm: h.band_cm, tolerance_cm: h.band_cm, confidence: h.confidence, outcome: "pendente" as const }));
}

async function allRows(build: () => any) {
  const rows: any[] = [];
  for (let offset = 0; offset < 50000; offset += 1000) {
    const result = await build().range(offset, offset + 999);
    if (result.error) throw result.error;
    rows.push(...(result.data ?? []));
    if ((result.data?.length ?? 0) < 1000) return rows;
  }
  throw new Error("Histórico excede o limite de paginação; revise a retenção.");
}
export async function recordAndResolveForecasts(db: SupabaseClient, bridges: ForecastBridge[], _dams: ForecastDam[] = [], now = Date.now()) {
  const cutoff = new Date(now - FORECAST_RETENTION_DAYS * 24 * HOUR).toISOString();
  const recent = new Date(now - 12 * HOUR).toISOString();
  const [history, damHistory, contexts, calibration, pending] = await Promise.all([
    allRows(() => db.from("river_readings").select("id,bridge_id,measured_at,level_m").gte("measured_at", recent).lte("measured_at", new Date(now).toISOString()).order("measured_at").order("id")),
    allRows(() => db.from("dam_readings").select("id,dam_id,measured_at,level_m,occupancy_percent,gates_open,gates_total").gte("measured_at", recent).lte("measured_at", new Date(now).toISOString()).order("measured_at").order("id")),
    db.from("forecast_context").select("payload,collected_at").lte("collected_at", new Date(now).toISOString()).order("collected_at", { ascending: false }).limit(1),
    db.from("forecast_calibration").select("bridge_id,parameters"),
    allRows(() => db.from(CENTRAL_FORECAST_TABLE).select("*").eq("model_version", FORECAST_MODEL_VERSION).eq("outcome", "pendente").gte("base_time", cutoff).lte("target_time", new Date(now).toISOString()).order("id")),
  ]);
  if (contexts.error || calibration.error) throw contexts.error ?? calibration.error;
  const context: ForecastContext | null = contexts.data?.[0] && now - Date.parse(contexts.data[0].collected_at) <= 30 * MINUTE ? contexts.data[0].payload : null;
  const byBridge = new Map<string, ForecastSample[]>();
  for (const row of history) {
    // Null must not become a made-up zero observation.
    if (row.level_m === null) continue;
    const list = byBridge.get(row.bridge_id) ?? [];
    list.push({ measured_at: row.measured_at, level_m: Number(row.level_m) }); byBridge.set(row.bridge_id, list);
  }
  let generated = 0;
  for (const bridge of bridges) {
    const parameters = calibration.data?.find(row => row.bridge_id === bridge.id)?.parameters ?? {};
    const tributaries = bridge.id === "dom-tito" ? ["br-470", "ricardo-kanitz"].map(id => ({ id, name: id === "br-470" ? "Itajaí do Oeste — BR-470" : "Itajaí do Sul — Hannelore", samples: byBridge.get(id) ?? [], ...(parameters.upstream?.[id] ?? {}) })) : [];
    const upper = bridge.id === "br-470" ? (context?.upstream ?? []).map(station => ({ ...station, ...(parameters.upstream?.[station.id] ?? {}) })) : [];
    const damIds = bridge.id === "br-470" ? ["taio"] : bridge.id === "ricardo-kanitz" ? ["ituporanga"] : ["taio", "ituporanga"];
    const dams = damIds.map(id => ({ id, name: id === "taio" ? "Taió" : "Ituporanga", samples: damHistory.filter(r => r.dam_id === id), ...(parameters.dams?.[id] ?? {}) }));
    const f = computeForecastV2({ bridge, samples: byBridge.get(bridge.id) ?? [], now, upstream: [...tributaries, ...upper], dams, rain: rainForBridge(context, bridge.id), calibration: parameters });
    if (!f.available) continue;
    f.notes.push(...(context?.notes ?? ["Chuva e dados a montante indisponíveis nesta coleta."]));
    const rows = f.horizons.map(h => ({ bridge: bridge.id, horizon_h: h.hours, base_time: f.base_time, target_time: h.target_time, station_id: bridge.station_id ?? "", device_bucket: "backend-v2", current_level: f.current_level, predicted_level: h.predicted_level, band_cm: h.band_cm, tolerance_cm: h.band_cm, confidence: h.confidence, outcome: "pendente", model_version: FORECAST_MODEL_VERSION, details: f }));
    // Do not overwrite an issued forecast to improve its later score.
    const result = await db.from(CENTRAL_FORECAST_TABLE).upsert(rows, { onConflict: "bridge,target_time,horizon_h,model_version", ignoreDuplicates: true }).select("id");
    if (result.error) throw result.error;
    generated += result.data?.length ?? 0;
  }
  let resolved = 0;
  const targetTimes = pending.map(row => Date.parse(row.target_time)).filter(Number.isFinite);
  const actuals = targetTimes.length ? await allRows(() => db.from("river_readings")
    .select("id,bridge_id,measured_at,level_m")
    .gte("measured_at", new Date(Math.min(...targetTimes) - MATCH_WINDOW).toISOString())
    .lte("measured_at", new Date(now).toISOString()).order("measured_at").order("id")) : [];
  const updates: { id: number; patch: Record<string, unknown> }[] = [];
  for (const row of pending) {
    const target = Date.parse(row.target_time);
    if (!Number.isFinite(target)) continue;
    if (now < target + MATCH_WINDOW) continue; // wait for complete matching window
    const candidates = actuals.filter(r => r.bridge_id === row.bridge &&
      Math.abs(Date.parse(r.measured_at) - target) <= MATCH_WINDOW &&
      r.level_m !== null && Number.isFinite(Number(r.level_m)) && Number(r.level_m) >= 0)
      .sort((a, b) => Math.abs(Date.parse(a.measured_at) - target) - Math.abs(Date.parse(b.measured_at) - target));
    const match = candidates[0];
    if (!match && now < target + 6 * HOUR) continue;
    const errorCm = match ? (Number(row.predicted_level) - Number(match.level_m)) * 100 : null;
    const patch = match ? { actual_level: Number(match.level_m), actual_time: match.measured_at, error_cm: errorCm, outcome: classifyForecast(errorCm!, Number(row.tolerance_cm)) } : { outcome: "sem_medicao" };
    updates.push({ id: row.id, patch });
  }
  for (let i = 0; i < updates.length; i += 8) {
    await Promise.all(updates.slice(i, i + 8).map(async ({ id, patch }) => {
      const result = await db.from(CENTRAL_FORECAST_TABLE).update({ ...patch, updated_at: new Date(now).toISOString() }).eq("id", id).eq("outcome", "pendente").eq("model_version", FORECAST_MODEL_VERSION);
      if (result.error) throw result.error;
      resolved++;
    }));
  }
  const cleanup = await db.rpc("cleanup_forecast_v2");
  if (cleanup.error) throw cleanup.error;
  return { model_version: FORECAST_MODEL_VERSION, generated, resolved, pendingChecked: pending.length };
}

export async function getCentralForecasts(db: SupabaseClient, bridge?: string, hours = 24, now = Date.now()) {
  if (bridge && !["dom-tito", "br-470", "ricardo-kanitz"].includes(bridge)) throw new Error("Ponte inválida");
  if (!Number.isFinite(hours) || hours < 1 || hours > 168) throw new Error("hours deve estar entre 1 e 168");
  const wanted = bridge ? [bridge] : ["dom-tito", "br-470", "ricardo-kanitz"];
  let historyQuery = db.from(CENTRAL_FORECAST_TABLE).select("*").eq("model_version", FORECAST_MODEL_VERSION).gte("base_time", new Date(now - hours * HOUR).toISOString()).order("base_time", { ascending: false }).order("id", { ascending: false }).limit(1000);
  if (bridge) historyQuery = historyQuery.eq("bridge", bridge);
  const [historyResult, accuracyResult, ...latestResults] = await Promise.all([
    historyQuery,
    bridge ? db.from("river_forecasts_accuracy_v2").select("*").eq("bridge", bridge) : db.from("river_forecasts_accuracy_v2").select("*"),
    ...wanted.map(id => db.from(CENTRAL_FORECAST_TABLE).select("details").eq("model_version", FORECAST_MODEL_VERSION).eq("bridge", id).order("base_time", { ascending: false }).limit(1)),
  ]);
  if (historyResult.error || accuracyResult.error) throw historyResult.error ?? accuracyResult.error;
  const latest = latestResults.map((result, i) => {
    if (result.error) throw result.error;
    const f = result.data?.[0]?.details;
    if (!f || !Number.isFinite(Date.parse(f.base_time)) || now - Date.parse(f.base_time) > 30 * MINUTE || Date.parse(f.base_time) > now) return { bridge: wanted[i], available: false, unavailable_reason: "Sem previsão centralizada recente. O servidor aguarda leituras válidas.", model_version: FORECAST_MODEL_VERSION, horizons: [], notes: [] };
    return f;
  });
  const forecasts = (historyResult.data ?? []).map(({ details, device_bucket, ...row }) => row);
  return { model_version: FORECAST_MODEL_VERSION, as_of: new Date(now).toISOString(), latest, forecasts, history_truncated: forecasts.length === 1000, accuracy: accuracyResult.data ?? [], disclaimer: "Estimativa experimental; não substitui os avisos oficiais da Defesa Civil." };
}
