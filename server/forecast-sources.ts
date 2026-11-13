export type LevelSample = { measured_at: string; level_m: number };
export type GaugeObservation = { station_id: string; name: string; river_name: string; measured_at: string; mm1h: number | null; mm2h: number | null; mm24h: number | null };
export type ForecastContext = {
  captured_at: string;
  gauges: GaugeObservation[];
  upstream: { id: string; name: string; samples: LevelSample[] }[];
  weather: { next1hMm: number; next2hMm: number; next3hMm: number; source: string } | null;
  notes: string[];
};
const BASE = "https://public.asthon.com.br";
const UPSTREAM = [
  { id: "d1f36c77-3b26-4f0b-a43f-5c7f5f39f665", name: "SDC-SC Laurentino" },
  { id: "9be9253b-7525-441e-924f-1a1be0944530", name: "Agronômica — Rio Trombudo" },
];
export function finiteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") return null;
  const n = Number(typeof value === "string" ? value.replace(",", ".") : value);
  return Number.isFinite(n) ? n : null;
}
function records(root: unknown): Record<string, unknown>[] {
  if (!root || typeof root !== "object") return [];
  if (Array.isArray(root)) return root.flatMap(records);
  const obj = root as Record<string, unknown>;
  return [obj, ...Object.values(obj).flatMap(records)];
}
export function parseGaugeObservations(root: unknown, now: number): GaugeObservation[] {
  const result = new Map<string, GaugeObservation>();
  for (const s of records(root)) {
    if (Number(s.rainfall_sensor) !== 1 || typeof s.station_id !== "string" || typeof s.last_reading_at !== "string") continue;
    const time = Date.parse(s.last_reading_at);
    // Missing/silent telemetry is not zero rain. Future values are rejected.
    if (!Number.isFinite(time) || time > now || now - time > 30 * 60000) continue;
    const nonnegative = (v: unknown) => { const n = finiteNumber(v); return n !== null && n >= 0 ? n : null; };
    const mm1h = nonnegative(s.rainfall_1h), mm2h = nonnegative(s.rainfall_2h), mm24h = nonnegative(s.rainfall_24h);
    if (mm1h === null && mm24h === null) continue;
    if (mm1h !== null && mm24h !== null && mm1h > mm24h + 0.1) continue;
    result.set(s.station_id, { station_id: s.station_id, name: String(s.name ?? ""), river_name: String(s.river_name ?? ""), measured_at: new Date(time).toISOString(), mm1h, mm2h, mm24h });
  }
  return Array.from(result.values());
}
export function parseLevelHistory(root: unknown, now: number): LevelSample[] {
  const level = root && typeof root === "object" ? (root as Record<string, unknown>).level : null;
  if (!Array.isArray(level)) return [];
  return level.flatMap((s) => {
    if (!s || typeof s !== "object") return [];
    const r = s as Record<string, unknown>, t = Date.parse(String(r.timestamp ?? "")), v = finiteNumber(r.value);
    return Number.isFinite(t) && t <= now && v !== null && v > 0 ? [{ measured_at: new Date(t).toISOString(), level_m: v }] : [];
  }).sort((a, b) => Date.parse(a.measured_at) - Date.parse(b.measured_at));
}
async function json(url: string) {
  const response = await fetch(url, { signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error(`Telemetria ${response.status}`);
  return response.json();
}
export async function collectForecastContext(panel: unknown, now = Date.now()): Promise<ForecastContext> {
  const context: ForecastContext = { captured_at: new Date(now).toISOString(), gauges: parseGaugeObservations(panel, now), upstream: [], weather: null, notes: [] };
  await Promise.all(UPSTREAM.map(async (station) => {
    try {
      const q = new URLSearchParams({ station_id: station.id, start: new Date(now - 6 * 3600000).toISOString(), end: new Date(now).toISOString(), fields: "level" });
      const samples = parseLevelHistory(await json(`${BASE}/public/station-history?${q}`), now);
      context.upstream.push({ ...station, samples });
    } catch { context.notes.push(`Série de ${station.name} indisponível; não foi substituída por zero.`); }
  }));
  // Explicit opt-in: the public Open-Meteo endpoint is licensed for non-commercial use.
  if (process.env.OPEN_METEO_NON_COMMERCIAL_ENABLED === "true") {
    try {
      const url = "https://api.open-meteo.com/v1/forecast?latitude=-27.2142,-27.1164,-27.4144,-27.2581,-27.7003&longitude=-49.6431,-49.9989,-49.6017,-49.9342,-49.3336&hourly=precipitation&past_hours=1&forecast_hours=5&timeformat=unixtime&timezone=GMT";
      const data = await json(url); const totals: number[][] = [];
      for (const item of Array.isArray(data) ? data : [data]) {
        const hours = item?.hourly;
        if (!Array.isArray(hours?.time) || !Array.isArray(hours?.precipitation)) continue;
        const points = hours.time.map((t: number, i: number) => ({ t: t * 1000, v: finiteNumber(hours.precipitation[i]) })).filter((p: {t:number;v:number|null}) => p.t >= now && p.v !== null && p.v >= 0).slice(0, 3);
        if (points.length === 3) totals.push([points[0].v, points[0].v + points[1].v, points[0].v + points[1].v + points[2].v]);
      }
      if (totals.length) context.weather = { next1hMm: totals.reduce((s, p) => s + p[0], 0) / totals.length, next2hMm: totals.reduce((s, p) => s + p[1], 0) / totals.length, next3hMm: totals.reduce((s, p) => s + p[2], 0) / totals.length, source: "Open-Meteo — modelo meteorológico, não medição" };
    } catch { context.notes.push("Previsão meteorológica indisponível."); }
  } else context.notes.push("Chuva prevista não ativada; requer fonte meteorológica com licença compatível com o uso do app.");
  return context;
}
export function rainForBridge(context: ForecastContext | null, bridge: string) {
  if (!context) return undefined;
  const west = /oeste|trombudo|taió|taio|laurentino|agronômica|agronomica/i;
  const south = /itaj[aá]i do sul|ituporanga/i;
  const gauges = context.gauges.filter(g => bridge === "dom-tito" ? west.test(g.river_name + " " + g.name) || south.test(g.river_name + " " + g.name) || /dom tito/i.test(g.name) : (bridge === "br-470" ? west : south).test(g.river_name + " " + g.name));
  const mean = (key: "mm1h" | "mm24h") => {const vals = gauges.map(g=>g[key]).filter((v):v is number=>v!==null); return vals.length ? vals.reduce((a,b)=>a+b,0)/vals.length : undefined;};
  return { observed1hMm: mean("mm1h"), observed24hMm: mean("mm24h"), stations: gauges.length, next1hMm: context.weather?.next1hMm, next2hMm: context.weather?.next2hMm, next3hMm: context.weather?.next3hMm, source: "Pluviômetros Defesa Civil; média dos pontos disponíveis, não média areal da bacia" };
}
