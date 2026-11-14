const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const STALE_AFTER_MS = 30 * MINUTE_MS;
const MAX_GAP_MS = 90 * MINUTE_MS;
const MINIMUM_SPAN_MS = 45 * MINUTE_MS;
const ISOLATED_SPIKE_THRESHOLD_M = 0.03;
const MAX_ACCELERATION_CM_H2 = 4;
const MAX_UPSTREAM_WEIGHT = 0.35;
const MAX_LAG_HOURS = 24;

export const FORECAST_V2_HEURISTICS = {
  windowsHours: [1, 3, 6] as const,
  staleAfterMinutes: 30,
  maximumGapMinutes: 90,
  minimumSpanMinutes: 45,
  minimumPoints: 4,
  isolatedSpikeThresholdCm: ISOLATED_SPIKE_THRESHOLD_M * 100,
  maximumAccelerationCmH2: MAX_ACCELERATION_CM_H2,
  maximumUpstreamWeight: MAX_UPSTREAM_WEIGHT,
  confidenceLabel: "experimental" as const,
};

type NumberLike = number | null | undefined;

export type ForecastV2Sample = {
  measured_at: string | null;
  level_m: NumberLike;
};

export type ForecastV2Bridge = {
  id: string;
  station_id: string | null;
};

export type ForecastV2Upstream = {
  id: string;
  name: string;
  samples: ForecastV2Sample[];
  lagHours?: NumberLike;
  weight?: NumberLike;
};

export type ForecastV2DamSample = {
  measured_at: string | null;
  level_m: NumberLike;
  occupancy_percent: NumberLike;
  gates_open: NumberLike;
  gates_total: NumberLike;
};

export type ForecastV2Dam = {
  id: string;
  name: string;
  samples: ForecastV2DamSample[];
  lagHours?: NumberLike;
  gateCmPerChange?: NumberLike;
};

export type ForecastV2Rain = {
  observed1hMm?: NumberLike;
  observed24hMm?: NumberLike;
  next1hMm?: NumberLike;
  next2hMm?: NumberLike;
  next3hMm?: NumberLike;
  stations?: NumberLike;
  source?: string | null;
};

export type ForecastV2Calibration = {
  rainObservedCmPerMm?: NumberLike;
  rainForecastCmPerMm?: NumberLike;
  rainLagHours?: NumberLike;
  maxRateCmH?: NumberLike;
};

export type ForecastV2Input = {
  bridge: ForecastV2Bridge;
  samples: ForecastV2Sample[];
  now: number;
  upstream?: ForecastV2Upstream[];
  dams?: ForecastV2Dam[];
  rain?: ForecastV2Rain;
  calibration?: ForecastV2Calibration;
};

export type ForecastV2Factor = {
  key: "tendencia" | "montante" | "barragens" | "chuva_obs" | "chuva_prev";
  title: string;
  cm: number;
  detail: string;
};

export type ForecastV2Horizon = {
  hours: 1 | 2 | 3;
  target_time: string;
  predicted_level: number;
  delta_cm: number;
  band_cm: number;
  confidence: 0 | 1 | 2;
  trend_cm: number;
  upstream_cm: number;
  dam_cm: number;
  rain_observed_cm: number;
  rain_forecast_cm: number;
};

export type ForecastV2Latest = {
  bridge: string;
  available: boolean;
  unavailable_reason: string;
  model_version: "deterministic-v2";
  generated_at: string;
  base_time: string;
  current_level: number | null;
  rate60: number | null;
  rate180: number | null;
  noise_cm: number | null;
  samples_used: number;
  window_minutes: number;
  horizons: ForecastV2Horizon[];
  factors: ForecastV2Factor[];
  notes: string[];
  upstream_summary: string;
  dam_summary: string;
  rain_observed_summary: string;
  rain_forecast_summary: string;
  rain_basin_1h_mm: number | null;
  rain_basin_24h_mm: number | null;
  rain_next_hour_mm: number | null;
  rain_next_2h_mm: number | null;
  rain_next_3h_mm: number | null;
  rain_probability: number | null;
  confidenceLabel: "experimental";
};

type CleanSample = { t: number; value: number };
type CleanDamSample = {
  t: number;
  levelM: number | null;
  occupancy: number | null;
  gatesOpen: number | null;
  gatesTotal: number | null;
};

type Fit = {
  rateCmH: number;
  noiseCm: number;
  n: number;
  spanMs: number;
  endMs: number;
};

type Trend = {
  fit: Fit;
  windowHours: 1 | 3 | 6;
  rate60: number | null;
  rate180: number | null;
  rate360: number | null;
  currentRate: number;
  referenceRate: number;
  acceleration: number;
  disagreementCmH: number;
};

type AccelerationEstimate = {
  currentRate: number;
  referenceRate: number;
  acceleration: number;
  centreDistanceHours: number;
};

type RainContext = {
  observed1h: number | null;
  observed24h: number | null;
  next: [number | null, number | null, number | null];
  stations: number | null;
  source: string | null;
};

type UpstreamContribution = {
  name: string;
  id: string;
  rateCmH: number | null;
  weight: number;
  lagHours: number | null;
  configured: boolean;
  detail: string;
};

type DamGateEvent = {
  delta: number;
  eventTime: number;
};

type DamContribution = {
  name: string;
  id: string;
  latest: CleanDamSample | null;
  gateEvents: DamGateEvent[];
  coefficient: number | null;
  lagHours: number | null;
  usableGateModel: boolean;
  outsideBasin: boolean;
  detail: string;
};

function finiteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value.trim().replace(",", "."));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function finiteNonNegative(value: unknown): number | null {
  const number = finiteNumber(value);
  return number !== null && number >= 0 ? number : null;
}

function timestampMs(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function clamp(value: number, lower: number, upper: number): number {
  return Math.min(upper, Math.max(lower, value));
}

function cleanRiverSamples(samples: ForecastV2Sample[] | null | undefined, now: number): CleanSample[] {
  const grouped = new Map<number, number[]>();
  for (const sample of samples ?? []) {
    const t = timestampMs(sample?.measured_at);
    const value = finiteNumber(sample?.level_m);
    if (t === null || value === null || value < 0 || t > now) continue;
    const values = grouped.get(t) ?? [];
    values.push(value);
    grouped.set(t, values);
  }
  const entries = Array.from(grouped.entries()).sort(([first], [second]) => first - second);
  return entries.map(([t, values], index) => {
    if (values.length === 1) return { t, value: values[0] };
    const localMedian = median(values) as number;
    const spread = Math.max(...values) - Math.min(...values);
    if (spread <= ISOLATED_SPIKE_THRESHOLD_M) return { t, value: localMedian };

    // Same-timestamp readings cannot establish a real rate. When a duplicate
    // is internally inconsistent, prefer the value closest to the temporal
    // neighbours rather than averaging a plausible level with an extreme
    // duplicate (which would manufacture a level that was never observed).
    const previous = index > 0 ? median(entries[index - 1][1]) : null;
    const next = index + 1 < entries.length ? median(entries[index + 1][1]) : null;
    const reference = previous !== null && next !== null ? (previous + next) / 2 : previous ?? next;
    if (reference === null) return { t, value: values[0] };
    return { t, value: values.reduce((best, value) => Math.abs(value - reference) < Math.abs(best - reference) ? value : best, values[0]) };
  });
}

function cleanDamSamples(samples: ForecastV2DamSample[] | null | undefined, now: number): CleanDamSample[] {
  const grouped = new Map<number, ForecastV2DamSample[]>();
  for (const sample of samples ?? []) {
    const t = timestampMs(sample?.measured_at);
    if (t === null || t > now) continue;
    const rows = grouped.get(t) ?? [];
    rows.push(sample);
    grouped.set(t, rows);
  }
  return Array.from(grouped.entries())
    .map(([t, rows]) => ({
      t,
      levelM: median(rows.map((row) => finiteNumber(row.level_m)).filter((value): value is number => value !== null && value >= 0)),
      occupancy: median(rows.map((row) => finiteNumber(row.occupancy_percent)).filter((value): value is number => value !== null)),
      gatesOpen: median(rows.map((row) => finiteNumber(row.gates_open)).filter((value): value is number => value !== null)),
      gatesTotal: median(rows.map((row) => finiteNumber(row.gates_total)).filter((value): value is number => value !== null)),
    }))
    .filter((sample) => sample.levelM !== null || sample.occupancy !== null || sample.gatesOpen !== null || sample.gatesTotal !== null)
    .sort((a, b) => a.t - b.t);
}

/**
 * Apply a local median only to a point that is an isolated extremum. A
 * monotone rise or fall therefore remains a rise or fall instead of being
 * silently classified as an outlier.
 */
function medianSmooth(points: CleanSample[]): CleanSample[] {
  if (points.length < 3) return points.map((point) => ({ ...point }));
  return points.map((point, index) => {
    if (index === 0 || index === points.length - 1) return { ...point };
    const previous = points[index - 1];
    const next = points[index + 1];
    const previousGap = point.t - previous.t;
    const nextGap = next.t - point.t;
    const interpolated = previous.value + ((next.value - previous.value) * previousGap) / Math.max(1, previousGap + nextGap);
    const isExtremum = (point.value - previous.value) * (point.value - next.value) > 0;
    const deviation = Math.abs(point.value - interpolated);
    const neighbourChange = Math.abs(next.value - previous.value);
    const threshold = Math.max(ISOLATED_SPIKE_THRESHOLD_M, neighbourChange * 0.75 + 0.01);
    if (isExtremum && previousGap <= 45 * MINUTE_MS && nextGap <= 45 * MINUTE_MS && deviation > threshold) {
      const localMedian = median([previous.value, point.value, next.value]) as number;
      return { t: point.t, value: localMedian };
    }
    return { ...point };
  });
}

function fitWindow(points: CleanSample[], endMs: number, windowHours: 1 | 3 | 6): Fit | null {
  const windowMs = windowHours * HOUR_MS;
  const selected = points.filter((point) => point.t <= endMs && point.t >= endMs - windowMs);
  if (selected.length < FORECAST_V2_HEURISTICS.minimumPoints) return null;
  const spanMs = selected[selected.length - 1].t - selected[0].t;
  if (spanMs < Math.max(30 * MINUTE_MS, windowMs * 0.5)) return null;
  if (endMs - selected[selected.length - 1].t > MAX_GAP_MS) return null;
  for (let index = 1; index < selected.length; index += 1) {
    if (selected[index].t - selected[index - 1].t > MAX_GAP_MS) return null;
  }

  const times = selected.map((point) => (point.t - endMs) / HOUR_MS);
  const meanT = times.reduce((sum, value) => sum + value, 0) / times.length;
  const meanV = selected.reduce((sum, point) => sum + point.value, 0) / selected.length;
  let sxx = 0;
  let sxy = 0;
  selected.forEach((point, index) => {
    const dt = times[index] - meanT;
    sxx += dt * dt;
    sxy += dt * (point.value - meanV);
  });
  if (sxx <= 0) return null;
  const slopeMPerH = sxy / sxx;
  const residuals = selected.map((point, index) => point.value - (meanV + slopeMPerH * (times[index] - meanT)));
  const noiseM = Math.sqrt(residuals.reduce((sum, residual) => sum + residual * residual, 0) / selected.length);
  return {
    rateCmH: slopeMPerH * 100,
    noiseCm: noiseM * 100,
    n: selected.length,
    spanMs,
    endMs,
  };
}

function latestContinuousSegment(points: CleanSample[], endMs: number): CleanSample[] {
  const eligible = points.filter((point) => point.t <= endMs);
  if (!eligible.length) return [];
  let segmentStart = 0;
  for (let index = eligible.length - 1; index > 0; index -= 1) {
    if (eligible[index].t - eligible[index - 1].t > MAX_GAP_MS) {
      segmentStart = index;
      break;
    }
  }
  const cutoff = endMs - 6 * HOUR_MS;
  return eligible.slice(segmentStart).filter((point) => point.t >= cutoff);
}

function calculateFits(points: CleanSample[], endMs: number): Map<1 | 3 | 6, Fit> {
  const smoothed = medianSmooth(points);
  const fits = new Map<1 | 3 | 6, Fit>();
  for (const windowHours of FORECAST_V2_HEURISTICS.windowsHours) {
    const fit = fitWindow(smoothed, endMs, windowHours);
    if (fit) fits.set(windowHours, fit);
  }
  return fits;
}

function buildTrend(points: CleanSample[], endMs: number): Trend | null {
  const fits = calculateFits(latestContinuousSegment(points, endMs), endMs);
  const fit = fits.get(1) ?? fits.get(3) ?? fits.get(6);
  if (!fit) return null;
  const rate60 = fits.get(1)?.rateCmH ?? null;
  const rate180 = fits.get(3)?.rateCmH ?? null;
  const rate360 = fits.get(6)?.rateCmH ?? null;
  const rates = [rate60, rate180, rate360].filter((rate): rate is number => rate !== null);
  const { currentRate, referenceRate, acceleration } = estimateAcceleration(rate60, rate180, rate360);
  const disagreementCmH = rates.length > 1 ? Math.max(...rates) - Math.min(...rates) : 0;
  return {
    fit,
    windowHours: fit === fits.get(1) ? 1 : fit === fits.get(3) ? 3 : 6,
    rate60,
    rate180,
    rate360,
    currentRate,
    referenceRate,
    acceleration,
    disagreementCmH,
  };
}

function estimateAcceleration(rate60: number | null, rate180: number | null, rate360: number | null): AccelerationEstimate {
  // The fitted rates are centred in their windows. Positive acceleration means
  // that the recent rate is greater than the older rate (accelerating up).
  let currentRate = rate60 ?? rate180 ?? rate360 ?? 0;
  let referenceRate = currentRate;
  let centreDistanceHours = 1;
  if (rate60 !== null && rate180 !== null) {
    currentRate = rate60;
    referenceRate = rate180;
    centreDistanceHours = 1;
  } else if (rate60 !== null && rate360 !== null) {
    currentRate = rate60;
    referenceRate = rate360;
    centreDistanceHours = 2.5;
  } else if (rate180 !== null && rate360 !== null) {
    currentRate = rate180;
    referenceRate = rate360;
    centreDistanceHours = 1.5;
  }
  const acceleration = clamp((currentRate - referenceRate) / centreDistanceHours, -MAX_ACCELERATION_CM_H2, MAX_ACCELERATION_CM_H2);
  return { currentRate, referenceRate, acceleration, centreDistanceHours };
}

function rateWithOptionalLimit(rateCmH: number, maxRateCmH: number | null): number {
  if (maxRateCmH === null || maxRateCmH <= 0) return rateCmH;
  return clamp(rateCmH, -maxRateCmH, maxRateCmH);
}

function normalisedText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function isDomTito(bridgeId: string): boolean {
  const id = normalisedText(bridgeId);
  return id.includes("dom tito") || id.includes("domtito");
}

function relatedUpstream(bridgeId: string, upstream: ForecastV2Upstream): boolean {
  if (!isDomTito(bridgeId)) return true;
  const text = normalisedText(`${upstream.id} ${upstream.name}`);
  return text.includes("br470") || text.includes("br 470") || text.includes("kanitz") || text.includes("hannelore") || text.includes("itajai do oeste") || text.includes("itajai do sul");
}

function validLag(value: unknown): number | null {
  const lag = finiteNumber(value);
  return lag !== null && lag >= 0 ? clamp(lag, 0, MAX_LAG_HOURS) : null;
}

function upstreamContributions(input: ForecastV2Input, baseMs: number, notes: string[]): UpstreamContribution[] {
  const contributions: UpstreamContribution[] = [];
  for (const source of input.upstream ?? []) {
    if (!relatedUpstream(input.bridge.id, source)) continue;
    const lag = validLag(source.lagHours);
    const rawWeight = finiteNumber(source.weight);
    const configured = rawWeight !== null && lag !== null;
    const weight = rawWeight === null ? 0 : clamp(rawWeight, -MAX_UPSTREAM_WEIGHT, MAX_UPSTREAM_WEIGHT);
    if (rawWeight !== null && rawWeight !== weight) notes.push(`Peso da estação montante ${source.name || source.id} limitado a ±${MAX_UPSTREAM_WEIGHT}; não há calibração adicional.`);
    const targetMs = baseMs - (lag ?? 0) * HOUR_MS;
    const points = cleanRiverSamples(source.samples, input.now);
    const trend = buildTrend(points, targetMs);
    const rate = trend?.currentRate ?? null;
    let detail: string;
    if (!configured) {
      detail = rawWeight !== null && lag === null
        ? "peso informado sem atraso explícito válido; contribuição 0 cm, tendência apenas contextual; não representa vazão"
        : "tendência observada apenas como contexto; peso não configurado, contribuição 0 cm; não representa vazão";
      notes.push(rawWeight !== null && lag === null
        ? `Estação montante ${source.name || source.id}: peso informado sem lagHours explícito válido; contribuição pendente.`
        : `Estação montante ${source.name || source.id}: peso pendente; a tendência é contextual e não representa vazão.`);
    } else if (!trend) {
      detail = "peso informado, mas sem janela observada suficiente para contribuição";
      notes.push(`Estação montante ${source.name || source.id}: janela observada insuficiente após sanitização; contribuição pendente.`);
    } else {
      detail = `tendência observada ${rate?.toFixed(2)} cm/h, peso ${weight.toFixed(3)}, atraso explícito ${lag.toFixed(2)} h; não representa vazão`;
    }
    contributions.push({ name: source.name || source.id, id: source.id, rateCmH: rate, weight, lagHours: lag, configured, detail });
  }
  return contributions;
}

function likelyOutsideBasin(dam: ForecastV2Dam): boolean {
  const text = normalisedText(`${dam.id} ${dam.name}`);
  return /(^| )(fora|outside|out of basin|outra bacia|other basin|outside basin)( |$)/.test(text);
}

function validGateCount(open: number | null, total: number | null): boolean {
  if (open === null || total === null || !Number.isInteger(open) || !Number.isInteger(total)) return false;
  return open >= 0 && total >= 0 && open <= total;
}

function damContributions(input: ForecastV2Input, baseMs: number, notes: string[]): DamContribution[] {
  const contributions: DamContribution[] = [];
  for (const dam of input.dams ?? []) {
    const samples = cleanDamSamples(dam.samples, input.now);
    const latest = samples.at(-1) ?? null;
    const outsideBasin = likelyOutsideBasin(dam);
    const coefficient = finiteNumber(dam.gateCmPerChange);
    const lag = validLag(dam.lagHours);
    const gateEvents: DamGateEvent[] = [];
    for (let index = 1; index < samples.length; index += 1) {
      const previous = samples[index - 1];
      const current = samples[index];
      if (!validGateCount(previous.gatesOpen, previous.gatesTotal) || !validGateCount(current.gatesOpen, current.gatesTotal)) continue;
      // Se o total mudou, a Defesa Civil acrescentou ou removeu uma comporta da lista: isso não é manobra.
      if (current.gatesTotal !== previous.gatesTotal) continue;
      if (current.gatesOpen !== null && previous.gatesOpen !== null && current.gatesOpen !== previous.gatesOpen) {
        gateEvents.push({ delta: current.gatesOpen - previous.gatesOpen, eventTime: current.t });
      }
    }
    const usableGateModel = !outsideBasin && coefficient !== null && lag !== null;
    let detail: string;
    if (outsideBasin) {
      detail = "barragem identificada fora da bacia considerada; comportas ignoradas";
      notes.push(`Barragem ${dam.name || dam.id}: fora da bacia identificada; nenhuma mudança de comporta foi convertida em cm.`);
    } else if (coefficient === null || lag === null) {
      detail = "nível/ocupação são contexto; efeito de comporta pendente de coeficiente e atraso explícitos";
      notes.push(`Barragem ${dam.name || dam.id}: efeito de comporta pendente; coeficiente e atraso explícitos são obrigatórios.`);
    } else if (!gateEvents.length) {
      detail = `coeficiente ${coefficient.toFixed(3)} cm por mudança e atraso explícito ${lag?.toFixed(2)} h, mas sem eventos em contagens inteiras válidas de comportas`;
      notes.push(`Barragem ${dam.name || dam.id}: sem evento em contagens inteiras válidas de comportas; efeito pendente.`);
    } else {
      detail = `${gateEvents.length} evento(s) de comportas, coeficiente explícito ${coefficient.toFixed(3)} cm/mudança, atraso explícito ${lag?.toFixed(2)} h`;
    }
    contributions.push({ name: dam.name || dam.id, id: dam.id, latest, gateEvents, coefficient, lagHours: lag, usableGateModel, outsideBasin, detail });
  }
  return contributions;
}

function cleanRain(input: ForecastV2Rain | undefined): RainContext {
  return {
    observed1h: finiteNonNegative(input?.observed1hMm),
    observed24h: finiteNonNegative(input?.observed24hMm),
    next: [finiteNonNegative(input?.next1hMm), finiteNonNegative(input?.next2hMm), finiteNonNegative(input?.next3hMm)],
    stations: finiteNonNegative(input?.stations),
    source: typeof input?.source === "string" && input.source.trim() ? input.source.trim() : null,
  };
}

function validRainCoefficient(value: unknown): number | null {
  return finiteNonNegative(value);
}

function rainObservedCm(rain: RainContext, coefficient: number | null, lagHours: number | null, horizon: number): number {
  if (coefficient === null || lagHours === null || rain.observed1h === null || horizon <= lagHours) return 0;
  return rain.observed1h * coefficient;
}

function rainIncrementMm(rain: RainContext, index: number): number | null {
  const cumulative = rain.next[index];
  if (cumulative === null) return null;
  if (index === 0) return cumulative;
  const previous = rain.next[index - 1];
  if (previous === null || cumulative < previous) return null;
  return cumulative - previous;
}

function rainForecastMm(rain: RainContext, lagHours: number | null, horizon: number): number | null {
  if (lagHours === null) return null;
  const fullHours = Math.floor(horizon - lagHours + 1e-9);
  if (fullHours <= 0) return 0;
  let total = 0;
  for (let index = 0; index < fullHours; index += 1) {
    const increment = rainIncrementMm(rain, index);
    if (increment === null) return null;
    total += increment;
  }
  return total;
}

function rainForecastCm(rain: RainContext, coefficient: number | null, lagHours: number | null, horizon: number): number {
  const mm = rainForecastMm(rain, lagHours, horizon);
  if (coefficient === null || mm === null) return 0;
  return mm * coefficient;
}

function rainRawForHorizon(rain: RainContext, lagHours: number | null, horizon: number): number {
  return rainForecastMm(rain, lagHours, horizon) ?? 0;
}

function rainSummaries(rain: RainContext, observedCoefficient: number | null, forecastCoefficient: number | null, lagHours: number | null): { observed: string; forecast: string } {
  const source = rain.source ? ` fonte ${rain.source}` : "";
  const stations = rain.stations === null ? "" : `, ${rain.stations} estação(ões)`;
  const observedValues = `1h=${rain.observed1h === null ? "n/d" : `${rain.observed1h} mm`}, 24h=${rain.observed24h === null ? "n/d" : `${rain.observed24h} mm`}`;
  const forecastValues = rain.next.map((value, index) => `${index + 1}h=${value === null ? "n/d" : `${value} mm`}`).join(", ");
  const observed = observedCoefficient === null
    ? `Chuva observada: ${observedValues}${stations}${source}; contexto sem conversão mm→cm válida.`
    : lagHours === null
      ? `Chuva observada: ${observedValues}${stations}${source}; coeficiente presente, mas rainLagHours explícito válido ausente; contexto sem conversão mm→cm.`
      : `Chuva observada: ${observedValues}${stations}${source}; coeficiente explícito ${observedCoefficient} cm/mm, atraso explícito ${lagHours} h.`;
  const forecast = forecastCoefficient === null
    ? `Chuva prevista: ${forecastValues}${source}; contexto sem conversão mm→cm válida.`
    : lagHours === null
      ? `Chuva prevista: ${forecastValues}${source}; coeficiente presente, mas rainLagHours explícito válido ausente; contexto sem conversão mm→cm.`
      : `Chuva prevista: ${forecastValues}${source}; coeficiente explícito ${forecastCoefficient} cm/mm, atraso explícito ${lagHours} h.`;
  return { observed, forecast };
}

function formatSigned(value: number, unit: string): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)} ${unit}`;
}

function baseNotes(trend: Trend): string[] {
  const notes = [
    "Modelo determinístico experimental; confidenceLabel é experimental e confidence não é probabilidade.",
    "Suavização mediana local de três pontos remove apenas picos isolados; subidas e descidas monotônicas não são descartadas como outliers.",
    `OLS independente nas janelas de 1 h, 3 h e 6 h; cada segmento contínuo tolera lacuna máxima ${FORECAST_V2_HEURISTICS.maximumGapMinutes} min, usa no máximo 6 h e exige ${FORECAST_V2_HEURISTICS.minimumSpanMinutes} min.`,
    `Aceleração projetada limitada simetricamente a ±${MAX_ACCELERATION_CM_H2} cm/h²; não existe teto arbitrário de 12 cm/h.`,
    `Margem crescente com ruído (${trend.fit.noiseCm.toFixed(2)} cm), discordância entre janelas (${trend.disagreementCmH.toFixed(2)} cm/h), idade e chuva.`,
  ];
  if (trend.rate180 === null && trend.rate360 === null) notes.push("Janelas de 3 h e 6 h sem cobertura suficiente; a tendência disponível é curta e a margem permanece experimental.");
  return notes;
}

function unavailableResult(input: ForecastV2Input, now: number, baseMs: number, samples: CleanSample[], reason: string, context: { upstreamSummary: string; damSummary: string; rainObservedSummary: string; rainForecastSummary: string; rain: RainContext }): ForecastV2Latest {
  return {
    bridge: input.bridge.id,
    available: false,
    unavailable_reason: reason,
    model_version: "deterministic-v2",
    generated_at: new Date(now).toISOString(),
    base_time: new Date(baseMs).toISOString(),
    current_level: samples.at(-1)?.value ?? null,
    rate60: null,
    rate180: null,
    noise_cm: null,
    samples_used: samples.length,
    window_minutes: 0,
    horizons: [],
    factors: [],
    notes: [
      "Previsão indisponível; não foi fabricado valor zero nem previsão antiga foi reutilizada.",
      reason,
      "confidenceLabel é experimental e não representa probabilidade.",
    ],
    upstream_summary: context.upstreamSummary,
    dam_summary: context.damSummary,
    rain_observed_summary: context.rainObservedSummary,
    rain_forecast_summary: context.rainForecastSummary,
    rain_basin_1h_mm: context.rain.observed1h,
    rain_basin_24h_mm: context.rain.observed24h,
    rain_next_hour_mm: context.rain.next[0],
    rain_next_2h_mm: context.rain.next[1],
    rain_next_3h_mm: context.rain.next[2],
    rain_probability: null,
    confidenceLabel: "experimental",
  };
}

function damSummary(dams: DamContribution[]): string {
  if (!dams.length) return "Sem leituras de barragens fornecidas; nenhum efeito foi inferido.";
  return dams.map((dam) => {
    const latest = dam.latest;
    if (!latest) return `${dam.name}: sem leitura válida; ${dam.detail}.`;
    const level = latest.levelM === null ? "nível n/d" : `nível ${latest.levelM.toFixed(2)} m`;
    const occupancy = latest.occupancy === null ? "ocupação n/d" : `ocupação ${latest.occupancy.toFixed(1)}%`;
    const gates = latest.gatesOpen === null ? "comportas n/d" : `comportas ${latest.gatesOpen}${latest.gatesTotal === null ? "" : `/${latest.gatesTotal}`}`;
    return `${dam.name}: ${level}, ${occupancy}, ${gates}; ${dam.detail}.`;
  }).join(" ");
}

function upstreamSummary(upstreams: UpstreamContribution[]): string {
  if (!upstreams.length) return "Sem estações montantes relacionadas fornecidas; nenhum efeito foi inferido.";
  return upstreams.map((upstream) => `${upstream.name}: ${upstream.rateCmH === null ? "tendência n/d" : formatSigned(upstream.rateCmH, "cm/h")}; ${upstream.detail}.`).join(" ");
}

function finiteOrZero(value: number): number {
  return Number.isFinite(value) && Math.abs(value) > 1e-12 ? value : 0;
}

export function computeForecastV2(input: ForecastV2Input): ForecastV2Latest {
  const now = Number.isFinite(input.now) ? input.now : 0;
  const generatedAt = new Date(now).toISOString();
  const samples = cleanRiverSamples(input.samples, now);
  const rain = cleanRain(input.rain);
  const observedRainCoefficient = validRainCoefficient(input.calibration?.rainObservedCmPerMm);
  const forecastRainCoefficient = validRainCoefficient(input.calibration?.rainForecastCmPerMm);
  const configuredRainLag = finiteNumber(input.calibration?.rainLagHours);
  const rainLagHours = configuredRainLag !== null && configuredRainLag >= 0 ? clamp(configuredRainLag, 0, MAX_LAG_HOURS) : null;
  const notes: string[] = [];
  const upstreamsWithNotes = upstreamContributions(input, samples.at(-1)?.t ?? now, notes);
  const dams = damContributions(input, samples.at(-1)?.t ?? now, notes);
  const rainText = rainSummaries(rain, observedRainCoefficient, forecastRainCoefficient, rainLagHours);
  if (input.rain && (observedRainCoefficient === null || rainLagHours === null) && rain.observed1h !== null) notes.push("Chuva observada fornecida sem coeficiente e rainLagHours explícitos válidos; não foi convertida em centímetros.");
  if (input.rain && (forecastRainCoefficient === null || rainLagHours === null) && rain.next.some((value) => value !== null)) notes.push("Chuva prevista fornecida sem coeficiente e rainLagHours explícitos válidos; não foi convertida em centímetros.");
  if (configuredRainLag !== null && configuredRainLag < 0) notes.push("rainLagHours inválido; atraso de chuva não aplicado.");
  const context = {
    upstreamSummary: upstreamSummary(upstreamsWithNotes),
    damSummary: damSummary(dams),
    rainObservedSummary: rainText.observed,
    rainForecastSummary: rainText.forecast,
    rain,
  };

  const latest = samples.at(-1);
  const baseMs = latest?.t ?? now;
  if (!latest) return unavailableResult(input, now, baseMs, samples, "Sem amostras válidas após sanitização de nulos, NaN, timestamps inválidos ou leituras futuras.", context);
  if (now - latest.t > STALE_AFTER_MS) return unavailableResult(input, now, baseMs, samples, "Amostra mais recente antiga: mais de 30 minutos desde base_time.", context);
  const recentSegment = latestContinuousSegment(samples, baseMs);
  if (recentSegment.length < FORECAST_V2_HEURISTICS.minimumPoints || latest.t - (recentSegment[0]?.t ?? latest.t) < MINIMUM_SPAN_MS) {
    return unavailableResult(input, now, baseMs, samples, "Janela curta: o último segmento contínuo precisa de pelo menos 4 leituras e 45 minutos de cobertura válida.", context);
  }
  const segmentStart = recentSegment[0];
  const previousToSegment = segmentStart ? samples.filter((sample) => sample.t < segmentStart.t).at(-1) : undefined;
  if (segmentStart && previousToSegment && segmentStart.t - previousToSegment.t > MAX_GAP_MS) {
    notes.push("Lacuna antiga descartada: a tendência usa somente o último segmento contínuo de até 6 horas e não atravessa a lacuna.");
  }

  const trend = buildTrend(samples, baseMs);
  if (!trend) return unavailableResult(input, now, baseMs, samples, "Não há janela OLS válida de 1 h, 3 h ou 6 h após sanitização e verificação de lacunas.", context);
  const maxRate = validRainCoefficient(input.calibration?.maxRateCmH);
  if (input.calibration?.maxRateCmH !== undefined && maxRate === null) notes.push("maxRateCmH inválido; nenhuma limitação calibrada de taxa foi aplicada.");
  if (maxRate !== null && maxRate > 0) notes.push(`maxRateCmH explícito de ${maxRate} cm/h aplicado simetricamente; sem esse parâmetro não há teto fixo de taxa.`);
  notes.unshift(...baseNotes(trend));
  const ageMinutes = Math.max(0, (now - baseMs) / MINUTE_MS);
  const adjustedRate60 = trend.rate60 === null ? null : rateWithOptionalLimit(trend.rate60, maxRate);
  const adjustedRate180 = trend.rate180 === null ? null : rateWithOptionalLimit(trend.rate180, maxRate);
  const adjustedRate360 = trend.rate360 === null ? null : rateWithOptionalLimit(trend.rate360, maxRate);
  const adjustedAcceleration = estimateAcceleration(adjustedRate60, adjustedRate180, adjustedRate360);
  const adjustedCurrentRate = adjustedAcceleration.currentRate;
  const acceleration = adjustedAcceleration.acceleration;
  const currentLevel = latest.value;

  const componentForHorizon = (horizon: 1 | 2 | 3) => {
    const trendCm = finiteOrZero(adjustedCurrentRate * horizon + 0.5 * acceleration * horizon * (horizon - 1));
    const upstreamCm = finiteOrZero(upstreamsWithNotes.reduce((sum, upstream) => {
      if (upstream.rateCmH === null || !upstream.configured || upstream.weight === 0 || upstream.lagHours === null) return sum;
      const effectiveHours = Math.max(0, horizon - upstream.lagHours);
      return sum + upstream.rateCmH * upstream.weight * effectiveHours;
    }, 0));
    const damCm = finiteOrZero(dams.reduce((sum, dam) => {
      if (!dam.usableGateModel || dam.coefficient === null || dam.lagHours === null) return sum;
      const coefficient = dam.coefficient;
      const lagHours = dam.lagHours;
      const targetMs = baseMs + horizon * HOUR_MS;
      return sum + dam.gateEvents.reduce((eventSum, event) => {
        const arrivalMs = event.eventTime + lagHours * HOUR_MS;
        return eventSum + (arrivalMs > baseMs && arrivalMs <= targetMs ? event.delta * coefficient : 0);
      }, 0);
    }, 0));
    const observedCm = finiteOrZero(rainObservedCm(rain, observedRainCoefficient, rainLagHours, horizon));
    const forecastCm = finiteOrZero(rainForecastCm(rain, forecastRainCoefficient, rainLagHours, horizon));
    return { trendCm, upstreamCm, damCm, observedCm, forecastCm };
  };

  const horizons: ForecastV2Horizon[] = ([1, 2, 3] as const).map((hours) => {
    const components = componentForHorizon(hours);
    const deltaCm = finiteOrZero(components.trendCm + components.upstreamCm + components.damCm + components.observedCm + components.forecastCm);
    const predictedLevel = currentLevel + deltaCm / 100;
    const rawForecastMm = rainRawForHorizon(rain, rainLagHours, hours);
    const convertedRainCm = Math.abs(components.observedCm + components.forecastCm);
    const rainUncertainty = rawForecastMm * (forecastRainCoefficient === null ? 0.02 : 0.05) + (rain.observed24h ?? 0) * (observedRainCoefficient === null ? 0.005 : 0.01);
    const ageUncertainty = ageMinutes * 0.08 * (1 + 0.2 * hours);
    const disagreementUncertainty = trend.disagreementCmH * 0.5 * hours;
    const bandCm = Math.ceil(Math.max(3 * Math.sqrt(hours), 1.8 * trend.fit.noiseCm * Math.sqrt(hours) + 0.5 * disagreementUncertainty + ageUncertainty + rainUncertainty + 0.1 * convertedRainCm));
    const confidence: 0 | 1 | 2 = bandCm <= 4 * Math.sqrt(hours) && ageMinutes <= 20 ? 2 : bandCm <= 8 * Math.sqrt(hours) && ageMinutes <= 30 ? 1 : 0;
    return {
      hours,
      target_time: new Date(baseMs + hours * HOUR_MS).toISOString(),
      predicted_level: predictedLevel,
      delta_cm: deltaCm,
      band_cm: bandCm,
      confidence,
      trend_cm: components.trendCm,
      upstream_cm: components.upstreamCm,
      dam_cm: components.damCm,
      rain_observed_cm: components.observedCm,
      rain_forecast_cm: components.forecastCm,
    };
  });

  if (horizons.some((horizon) => horizon.predicted_level > 6.5) || currentLevel > 6.5) {
    notes.push("Nível atual ou previsto cruza 6,5 m: limiar oficial de emergência; siga os avisos oficiais.");
  }
  if (dams.length === 0 && (input.dams?.length ?? 0) === 0) notes.push("Fator barragens pendente: não foram fornecidas leituras de barragens.");
  if ((observedRainCoefficient === null || rainLagHours === null) && rain.observed1h !== null) notes.push("Fator chuva_obs pendente: mm não vira cm sem coeficiente e rainLagHours explícitos válidos.");
  if ((forecastRainCoefficient === null || rainLagHours === null) && rain.next.some((value) => value !== null)) notes.push("Fator chuva_prev pendente: mm não vira cm sem coeficiente e rainLagHours explícitos válidos.");

  const first = horizons[0];
  const factors: ForecastV2Factor[] = [
    { key: "tendencia", title: "Tendência observada", cm: first.trend_cm, detail: `OLS robusta de curto prazo, ${formatSigned(first.trend_cm, "cm")} em 1 h.` },
    { key: "montante", title: "Estações montantes", cm: first.upstream_cm, detail: context.upstreamSummary },
    { key: "barragens", title: "Barragens", cm: first.dam_cm, detail: context.damSummary },
    { key: "chuva_obs", title: "Chuva observada", cm: first.rain_observed_cm, detail: context.rainObservedSummary },
    { key: "chuva_prev", title: "Chuva prevista", cm: first.rain_forecast_cm, detail: context.rainForecastSummary },
  ];

  return {
    bridge: input.bridge.id,
    available: true,
    unavailable_reason: "",
    model_version: "deterministic-v2",
    generated_at: generatedAt,
    base_time: new Date(baseMs).toISOString(),
    current_level: currentLevel,
    rate60: trend.rate60 === null ? null : rateWithOptionalLimit(trend.rate60, maxRate),
    rate180: trend.rate180 === null ? null : rateWithOptionalLimit(trend.rate180, maxRate),
    noise_cm: trend.fit.noiseCm,
    samples_used: trend.fit.n,
    window_minutes: trend.windowHours * 60,
    horizons,
    factors,
    notes,
    upstream_summary: context.upstreamSummary,
    dam_summary: context.damSummary,
    rain_observed_summary: context.rainObservedSummary,
    rain_forecast_summary: context.rainForecastSummary,
    rain_basin_1h_mm: rain.observed1h,
    rain_basin_24h_mm: rain.observed24h,
    rain_next_hour_mm: rain.next[0],
    rain_next_2h_mm: rain.next[1],
    rain_next_3h_mm: rain.next[2],
    rain_probability: null,
    confidenceLabel: "experimental",
  };
}
