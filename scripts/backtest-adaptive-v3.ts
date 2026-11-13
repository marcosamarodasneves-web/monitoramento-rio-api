import { config as loadDotenv } from "dotenv";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import {
  computeForecastV2,
  type ForecastV2Sample,
} from "../server/forecast-model-v2";
import {
  ADAPTIVE_MODEL_VERSION,
  applyAdaptiveForecast,
  detectRegime,
  initialLearningState,
  learnFromOutcome,
  type CandidateLevels,
  type LearningState,
  type Regime,
} from "../server/forecast-adaptive-model";

loadDotenv({ override: false });

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const ISSUE_STEP_MS = 10 * MINUTE_MS;
const MATCH_WINDOW_MS = 10 * MINUTE_MS;
const INPUT_WINDOW_MS = 6 * HOUR_MS;
const RETENTION_DAYS = 60;
const EVALUATION_DAYS = 7;
const MAX_OPERATIONS = 1_000_000;
const PAGE_SIZE = 1_000;
const BRIDGES = ["dom-tito", "br-470", "ricardo-kanitz"] as const;
const HORIZONS = [1, 2, 3] as const;
const SPECIALISTS = ["persistence", "damped", "trend", "acceleration"] as const;
const OUTPUT_PATH =
  process.argv[2] ?? "/home/ubuntu/avaliacao-adaptativa-v3.json";

type Horizon = (typeof HORIZONS)[number];
type Specialist = (typeof SPECIALISTS)[number];

type ReadingRow = {
  id: string | number;
  bridge_id: string | null;
  measured_at: string | null;
  collected_at: string | null;
  level_m: number | string | null;
};

type Reading = {
  id: string;
  bridge: string;
  measuredMs: number;
  collectedMs: number;
  availableMs: number;
  levelM: number;
};

type ActualMatch = {
  reading: Reading;
  distanceMs: number;
};

type Emission = {
  sequence: number;
  bridge: string;
  issueMs: number;
  baseMs: number;
  targetMs: number;
  horizon: Horizon;
  currentLevel: number;
  v2Level: number;
  adaptiveLevel: number;
  bandCm: number;
  candidates: CandidateLevels;
  regime: Regime;
  issuedRevision: number;
  trained: boolean;
  actual: ActualMatch | null;
  retryAtMs: number | null;
};

type QueueItem = {
  emission: Emission;
  atMs: number;
  kind: "due" | "retry";
};

type MetricAccumulator = {
  adaptiveErrors: number[];
  v2Errors: number[];
  persistenceErrors: number[];
  adaptiveHits: number;
  v2Hits: number;
  persistenceHits: number;
  bandValues: number[];
  identicalBands: boolean;
};

type ScoreRow = {
  bridge: string;
  horizon_h: Horizon;
  comparisons: number;
  adaptive: {
    mae_cm: number | null;
    p90_cm: number | null;
    hit_count: number;
    hit_rate_percent: number | null;
  };
  v2: {
    mae_cm: number | null;
    p90_cm: number | null;
    hit_count: number;
    hit_rate_percent: number | null;
  };
  persistence: {
    mae_cm: number | null;
    p90_cm: number | null;
    hit_count: number;
    hit_rate_percent: number | null;
  };
  mae_improvement_v2_minus_adaptive_cm: number | null;
  adaptive_lower_mae_than_v2: boolean | null;
  margins: {
    adaptive_band_cm_mean: number | null;
    v2_band_cm_mean: number | null;
    identical_for_all_pairs: boolean;
    adaptive_and_v2_hits_use_same_band: true;
  };
};

type BacktestReport = {
  status: "completed" | "completed_with_limit" | "no_data" | "failed";
  created_at: string;
  model_version: typeof ADAPTIVE_MODEL_VERSION;
  method: {
    replay: string;
    source_table: string;
    access: "read-only";
    bridges: readonly string[];
    retention_days: number;
    evaluation_window_days: number;
    issue_step_minutes: number;
    input_window_hours: number;
    match_window_minutes: number;
    operation_limit: number;
    no_tolerance_adjustment: boolean;
    no_writes: true;
    no_llm: true;
  };
  data: {
    rows_read: number;
    valid_rows: number;
    invalid_rows: number;
    retention_cutoff: string;
    dataset_available_start: string | null;
    dataset_available_end: string | null;
    dataset_measured_start: string | null;
    dataset_measured_end: string | null;
    available_span_days: number | null;
    measured_span_days: number | null;
    distinct_measured_days: number;
    evaluation_start: string | null;
    evaluation_end: string | null;
    evaluation_span_days: number | null;
    observation_days_in_evaluation: number;
    note: string;
  };
  replay: {
    issues_attempted: number;
    emissions_attempted: number;
    v2_available_emissions: number;
    emissions_recorded: number;
    outcomes_accepted: number;
    outcomes_waiting_for_actual: number;
    outcomes_without_matching_reading: number;
    operation_count: number;
    stopped_by_operation_limit: boolean;
    states_created: number;
    state_keys: number;
    challenger_created: number;
    challenger_promoted: number;
    champion_rollback: number;
    cold_start: {
      initialized_from_initial_learning_state: true;
      used_other_users_or_persisted_state: false;
      outcomes_before_state_change: "controlled_by_core_minimum_history";
    };
  };
  scores: ScoreRow[];
  aggregate: {
    comparisons: number;
    adaptive_mae_cm: number | null;
    v2_mae_cm: number | null;
    persistence_mae_cm: number | null;
    adaptive_hit_rate_percent: number | null;
    v2_hit_rate_percent: number | null;
    adaptive_lower_mae_than_v2: boolean | null;
    interpretation: string;
  };
  invariants: {
    no_future_samples_in_inputs: boolean;
    no_future_actuals_in_training: boolean;
    issued_revision_frozen: boolean;
    states_separated_by_bridge_horizon_regime: boolean;
    v2_adaptive_bands_identical: boolean;
    training_requires_target_plus_10_minutes: true;
    actual_requires_measured_and_available_by_issue: true;
  };
  caveats: string[];
};

const envPrefix = (process.env.ADAPTIVE_BACKTEST_ENV_PREFIX ?? "").trim();
function env(name: string): string | undefined {
  return process.env[`${envPrefix}${name}`] ?? process.env[name];
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value.trim().replace(",", "."));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function timestampMs(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function idForSort(value: string | number): string {
  return String(value);
}

function iso(ms: number | null): string | null {
  return ms === null || !Number.isFinite(ms)
    ? null
    : new Date(ms).toISOString();
}

function round(value: number | null, digits = 3): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function mean(values: number[]): number | null {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null;
}

function percentile90(values: number[]): number | null {
  if (!values.length) return null;
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.max(0, Math.ceil(ordered.length * 0.9) - 1)];
}

function ceilToGrid(ms: number): number {
  return Math.ceil(ms / ISSUE_STEP_MS) * ISSUE_STEP_MS;
}

function floorToGrid(ms: number): number {
  return Math.floor(ms / ISSUE_STEP_MS) * ISSUE_STEP_MS;
}

function compareReadings(first: Reading, second: Reading): number {
  return (
    first.measuredMs - second.measuredMs ||
    first.availableMs - second.availableMs ||
    first.collectedMs - second.collectedMs ||
    idForSort(first.id).localeCompare(idForSort(second.id))
  );
}

function parseReading(row: ReadingRow): Reading | null {
  if (
    typeof row.bridge_id !== "string" ||
    !BRIDGES.includes(row.bridge_id as (typeof BRIDGES)[number])
  )
    return null;
  const measuredMs = timestampMs(row.measured_at);
  const collectedMs = timestampMs(row.collected_at);
  const levelM = finiteNumber(row.level_m);
  if (
    measuredMs === null ||
    collectedMs === null ||
    levelM === null ||
    levelM < 0
  )
    return null;
  return {
    id: idForSort(row.id),
    bridge: row.bridge_id,
    measuredMs,
    collectedMs,
    availableMs: Math.max(measuredMs, collectedMs),
    levelM,
  };
}

function lowerBound(
  readings: Reading[],
  value: number,
  field: "measuredMs" | "availableMs" = "measuredMs"
): number {
  let low = 0;
  let high = readings.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (readings[middle][field] < value) low = middle + 1;
    else high = middle;
  }
  return low;
}

function upperBound(
  readings: Reading[],
  value: number,
  field: "measuredMs" | "availableMs" = "measuredMs"
): number {
  let low = 0;
  let high = readings.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (readings[middle][field] <= value) low = middle + 1;
    else high = middle;
  }
  return low;
}

function chooseLatestDuplicate(
  current: Reading | undefined,
  candidate: Reading
): Reading {
  if (!current) return candidate;
  return candidate.availableMs > current.availableMs ||
    (candidate.availableMs === current.availableMs &&
      candidate.collectedMs > current.collectedMs) ||
    (candidate.availableMs === current.availableMs &&
      candidate.collectedMs === current.collectedMs &&
      candidate.id.localeCompare(current.id) > 0)
    ? candidate
    : current;
}

function samplesAtIssue(
  readings: Reading[],
  issueMs: number,
  operations: { count: number }
): ForecastV2Sample[] {
  const start = lowerBound(readings, issueMs - INPUT_WINDOW_MS);
  const end = upperBound(readings, issueMs);
  const byMeasured = new Map<number, Reading>();
  for (let index = start; index < end; index += 1) {
    operations.count += 1;
    if (operations.count > MAX_OPERATIONS) return [];
    const reading = readings[index];
    // Availability is max(measured_at, collected_at); a future delivery cannot
    // enter the offline replay before that timestamp.
    if (reading.measuredMs > issueMs || reading.availableMs > issueMs) continue;
    byMeasured.set(
      reading.measuredMs,
      chooseLatestDuplicate(byMeasured.get(reading.measuredMs), reading)
    );
  }
  return Array.from(byMeasured.values())
    .sort(compareReadings)
    .map(reading => ({
      measured_at: new Date(reading.measuredMs).toISOString(),
      level_m: reading.levelM,
    }));
}

function actualAtIssue(
  readings: Reading[],
  targetMs: number,
  issueMs: number
): ActualMatch | null {
  const start = lowerBound(readings, targetMs - MATCH_WINDOW_MS);
  const end = upperBound(readings, targetMs + MATCH_WINDOW_MS);
  const byMeasured = new Map<number, Reading>();
  for (let index = start; index < end; index += 1) {
    const reading = readings[index];
    if (reading.measuredMs > issueMs || reading.availableMs > issueMs) continue;
    byMeasured.set(
      reading.measuredMs,
      chooseLatestDuplicate(byMeasured.get(reading.measuredMs), reading)
    );
  }
  const candidates = Array.from(byMeasured.values()).sort(
    (first, second) =>
      Math.abs(first.measuredMs - targetMs) -
        Math.abs(second.measuredMs - targetMs) ||
      first.measuredMs - second.measuredMs ||
      first.availableMs - second.availableMs ||
      first.id.localeCompare(second.id)
  );
  const reading = candidates[0];
  return reading
    ? { reading, distanceMs: Math.abs(reading.measuredMs - targetMs) }
    : null;
}

function nextActualAvailability(
  readings: Reading[],
  targetMs: number,
  issueMs: number
): number | null {
  const start = lowerBound(readings, targetMs - MATCH_WINDOW_MS);
  const end = upperBound(readings, targetMs + MATCH_WINDOW_MS);
  let next: number | null = null;
  for (let index = start; index < end; index += 1) {
    const reading = readings[index];
    if (reading.availableMs <= issueMs) continue;
    if (next === null || reading.availableMs < next) next = reading.availableMs;
  }
  return next;
}

function pushQueue(queue: QueueItem[], item: QueueItem): void {
  queue.push(item);
  let index = queue.length - 1;
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    if (
      queue[parent].atMs < item.atMs ||
      (queue[parent].atMs === item.atMs &&
        queue[parent].emission.sequence <= item.emission.sequence)
    )
      break;
    queue[index] = queue[parent];
    index = parent;
  }
  queue[index] = item;
}

function popQueue(queue: QueueItem[]): QueueItem | undefined {
  if (!queue.length) return undefined;
  const first = queue[0];
  const last = queue.pop() as QueueItem | undefined;
  if (last && queue.length) {
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      let smallest = index;
      if (
        left < queue.length &&
        (queue[left].atMs < queue[smallest].atMs ||
          (queue[left].atMs === queue[smallest].atMs &&
            queue[left].emission.sequence < queue[smallest].emission.sequence))
      )
        smallest = left;
      if (
        right < queue.length &&
        (queue[right].atMs < queue[smallest].atMs ||
          (queue[right].atMs === queue[smallest].atMs &&
            queue[right].emission.sequence < queue[smallest].emission.sequence))
      )
        smallest = right;
      if (smallest === index) break;
      queue[index] = queue[smallest];
      index = smallest;
    }
    queue[index] = last;
  }
  return first;
}

function stateKey(bridge: string, horizon: Horizon, regime: Regime): string {
  return `${bridge}|${horizon}|${regime}`;
}

function emptyAccumulator(): MetricAccumulator {
  return {
    adaptiveErrors: [],
    v2Errors: [],
    persistenceErrors: [],
    adaptiveHits: 0,
    v2Hits: 0,
    persistenceHits: 0,
    bandValues: [],
    identicalBands: true,
  };
}

function asCandidates(
  value: Record<Specialist, number | null>
): CandidateLevels | null {
  const result = {} as CandidateLevels;
  for (const specialist of SPECIALISTS) {
    const candidate = value[specialist];
    if (candidate === null || !Number.isFinite(candidate)) return null;
    result[specialist] = candidate;
  }
  return result;
}

function addScore(
  accumulator: MetricAccumulator,
  emission: Emission,
  actualLevel: number,
  v2BandCm: number,
  adaptiveBandCm: number
): void {
  const adaptiveError = Math.abs(emission.adaptiveLevel - actualLevel) * 100;
  const v2Error = Math.abs(emission.v2Level - actualLevel) * 100;
  const persistenceError = Math.abs(emission.currentLevel - actualLevel) * 100;
  accumulator.adaptiveErrors.push(adaptiveError);
  accumulator.v2Errors.push(v2Error);
  accumulator.persistenceErrors.push(persistenceError);
  accumulator.adaptiveHits += adaptiveError <= adaptiveBandCm ? 1 : 0;
  accumulator.v2Hits += v2Error <= v2BandCm ? 1 : 0;
  accumulator.persistenceHits += persistenceError <= v2BandCm ? 1 : 0;
  accumulator.bandValues.push(v2BandCm, adaptiveBandCm);
  if (Math.abs(v2BandCm - adaptiveBandCm) > 1e-9)
    accumulator.identicalBands = false;
}

function scoreFromAccumulator(
  bridge: string,
  horizon: Horizon,
  accumulator: MetricAccumulator
): ScoreRow {
  const comparisons = accumulator.adaptiveErrors.length;
  const adaptiveMae = mean(accumulator.adaptiveErrors);
  const v2Mae = mean(accumulator.v2Errors);
  return {
    bridge,
    horizon_h: horizon,
    comparisons,
    adaptive: {
      mae_cm: round(adaptiveMae),
      p90_cm: round(percentile90(accumulator.adaptiveErrors)),
      hit_count: accumulator.adaptiveHits,
      hit_rate_percent: comparisons
        ? round((100 * accumulator.adaptiveHits) / comparisons, 2)
        : null,
    },
    v2: {
      mae_cm: round(v2Mae),
      p90_cm: round(percentile90(accumulator.v2Errors)),
      hit_count: accumulator.v2Hits,
      hit_rate_percent: comparisons
        ? round((100 * accumulator.v2Hits) / comparisons, 2)
        : null,
    },
    persistence: {
      mae_cm: round(mean(accumulator.persistenceErrors)),
      p90_cm: round(percentile90(accumulator.persistenceErrors)),
      hit_count: accumulator.persistenceHits,
      hit_rate_percent: comparisons
        ? round((100 * accumulator.persistenceHits) / comparisons, 2)
        : null,
    },
    mae_improvement_v2_minus_adaptive_cm:
      adaptiveMae !== null && v2Mae !== null
        ? round(v2Mae - adaptiveMae)
        : null,
    adaptive_lower_mae_than_v2:
      adaptiveMae !== null && v2Mae !== null ? adaptiveMae < v2Mae : null,
    margins: {
      adaptive_band_cm_mean: accumulator.bandValues.length
        ? round(
            mean(accumulator.bandValues.filter((_, index) => index % 2 === 1))
          )
        : null,
      v2_band_cm_mean: accumulator.bandValues.length
        ? round(
            mean(accumulator.bandValues.filter((_, index) => index % 2 === 0))
          )
        : null,
      identical_for_all_pairs: accumulator.identicalBands,
      adaptive_and_v2_hits_use_same_band: true,
    },
  };
}

async function readRows(
  db: SupabaseClient,
  cutoffIso: string,
  endIso: string
): Promise<{ rows: ReadingRow[]; pages: number }> {
  const rows: ReadingRow[] = [];
  let pages = 0;
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const result = await db
      .from("river_readings")
      .select("id,bridge_id,measured_at,collected_at,level_m")
      .gte("collected_at", cutoffIso)
      .lte("collected_at", endIso)
      .order("collected_at", { ascending: true })
      .order("id", { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);
    if (result.error) throw result.error;
    pages += 1;
    rows.push(...((result.data ?? []) as ReadingRow[]));
    if ((result.data?.length ?? 0) < PAGE_SIZE) break;
    if (offset >= 200_000)
      throw new Error("Histórico excede o limite de paginação read-only.");
  }
  return { rows, pages };
}

function aggregateScores(scores: ScoreRow[]): BacktestReport["aggregate"] {
  const all = scores.flatMap(score => (score.comparisons ? [score] : []));
  const weighted = (
    selector: (score: ScoreRow) => number | null
  ): number | null => {
    const values = all.flatMap(score => {
      const value = selector(score);
      return value === null
        ? []
        : Array.from({ length: score.comparisons }, () => value);
    });
    return round(mean(values));
  };
  const comparisons = all.reduce((sum, score) => sum + score.comparisons, 0);
  const adaptiveMae = weighted(score => score.adaptive.mae_cm);
  const v2Mae = weighted(score => score.v2.mae_cm);
  const persistenceMae = weighted(score => score.persistence.mae_cm);
  const adaptiveHits = all.reduce(
    (sum, score) => sum + score.adaptive.hit_count,
    0
  );
  const v2Hits = all.reduce((sum, score) => sum + score.v2.hit_count, 0);
  const adaptiveLower =
    adaptiveMae !== null && v2Mae !== null ? adaptiveMae < v2Mae : null;
  let interpretation = "Não há pares reais suficientes para concluir vantagem.";
  if (comparisons > 0 && adaptiveLower === true)
    interpretation =
      "Neste recorte pareado, o MAE adaptativo ficou abaixo do v2; isso não prova generalização fora da amostra.";
  if (comparisons > 0 && adaptiveLower === false)
    interpretation =
      "Neste recorte pareado, o MAE adaptativo não ficou abaixo do v2; não há base para claim de superioridade.";
  return {
    comparisons,
    adaptive_mae_cm: adaptiveMae,
    v2_mae_cm: v2Mae,
    persistence_mae_cm: persistenceMae,
    adaptive_hit_rate_percent: comparisons
      ? round((100 * adaptiveHits) / comparisons, 2)
      : null,
    v2_hit_rate_percent: comparisons
      ? round((100 * v2Hits) / comparisons, 2)
      : null,
    adaptive_lower_mae_than_v2: adaptiveLower,
    interpretation,
  };
}

async function main(): Promise<void> {
  const url = env("SUPABASE_READONLY_URL") ?? env("SUPABASE_URL");
  const key = env("SUPABASE_READONLY_KEY") ?? env("SUPABASE_KEY");
  if (!url || !key)
    throw new Error(
      "Configure SUPABASE_READONLY_URL/SUPABASE_READONLY_KEY ou SUPABASE_URL/SUPABASE_KEY no ambiente; nenhum segredo é impresso."
    );

  const nowMs = Date.now();
  const cutoffMs = nowMs - RETENTION_DAYS * DAY_MS;
  const cutoffIso = new Date(cutoffMs).toISOString();
  const endIso = new Date(nowMs).toISOString();
  const db = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const fetched = await readRows(db, cutoffIso, endIso);
  const parsed = fetched.rows
    .map(parseReading)
    .filter((reading): reading is Reading => reading !== null);
  const byBridge = new Map<string, Reading[]>();
  for (const bridge of BRIDGES) byBridge.set(bridge, []);
  for (const reading of parsed) byBridge.get(reading.bridge)?.push(reading);
  for (const readings of byBridge.values()) readings.sort(compareReadings);

  const allAvailable = parsed.map(reading => reading.availableMs);
  const allMeasured = parsed.map(reading => reading.measuredMs);
  const datasetAvailableStart = allAvailable.length
    ? Math.min(...allAvailable)
    : null;
  const datasetAvailableEnd = allAvailable.length
    ? Math.max(...allAvailable)
    : null;
  const datasetMeasuredStart = allMeasured.length
    ? Math.min(...allMeasured)
    : null;
  const datasetMeasuredEnd = allMeasured.length
    ? Math.max(...allMeasured)
    : null;
  const evaluationStart =
    datasetAvailableEnd === null
      ? null
      : Math.max(
          datasetAvailableStart ?? datasetAvailableEnd,
          datasetAvailableEnd - EVALUATION_DAYS * DAY_MS
        );
  const evaluationEnd = datasetAvailableEnd;
  const firstIssue =
    evaluationStart === null ? null : ceilToGrid(evaluationStart);
  const lastEmissionIssue =
    evaluationEnd === null ? null : floorToGrid(evaluationEnd);
  const flushIssue = evaluationEnd === null ? null : ceilToGrid(evaluationEnd);

  const operations = { count: 0 };
  const emissions: Emission[] = [];
  const dueQueue: QueueItem[] = [];
  const retryQueue: QueueItem[] = [];
  const states = new Map<string, LearningState>();
  const scores = new Map<string, MetricAccumulator>();
  let sequence = 0;
  let issuesAttempted = 0;
  let emissionsAttempted = 0;
  let v2AvailableEmissions = 0;
  let outcomesAccepted = 0;
  let outcomesWaitingForActual = 0;
  let outcomesWithoutMatchingReading = 0;
  let challengerCreated = 0;
  let challengerPromoted = 0;
  let championRollback = 0;
  let stoppedByOperationLimit = false;
  let noFutureSampleViolations = 0;
  let noFutureActualViolations = 0;
  let issuedRevisionViolations = 0;
  let bandViolations = 0;

  const getState = (
    bridge: string,
    horizon: Horizon,
    regime: Regime
  ): LearningState => {
    const key = stateKey(bridge, horizon, regime);
    const existing = states.get(key);
    if (existing) return existing;
    const initial = initialLearningState(regime);
    states.set(key, initial);
    return initial;
  };

  const trainEmission = (
    emission: Emission,
    issueMs: number
  ): "trained" | "waiting" | "missing" => {
    if (emission.trained) return "trained";
    if (emission.targetMs + MATCH_WINDOW_MS > issueMs) return "waiting";
    const readings = byBridge.get(emission.bridge) ?? [];
    const actual = actualAtIssue(readings, emission.targetMs, issueMs);
    if (!actual) {
      const retryAt = nextActualAvailability(
        readings,
        emission.targetMs,
        issueMs
      );
      if (retryAt !== null) {
        emission.retryAtMs = retryAt;
        pushQueue(retryQueue, { emission, atMs: retryAt, kind: "retry" });
        outcomesWaitingForActual += 1;
        return "waiting";
      }
      emission.retryAtMs = null;
      outcomesWithoutMatchingReading += 1;
      return "missing";
    }
    if (
      actual.reading.measuredMs > issueMs ||
      actual.reading.availableMs > issueMs
    ) {
      noFutureActualViolations += 1;
      return "waiting";
    }
    const state = getState(emission.bridge, emission.horizon, emission.regime);
    const learned = learnFromOutcome(state, {
      candidates: emission.candidates,
      actual_level: actual.reading.levelM,
      issued_level: emission.adaptiveLevel,
      current_level: emission.currentLevel,
      issued_at: emission.issueMs,
      actual_time: actual.reading.measuredMs,
      issued_revision: emission.issuedRevision,
    });
    if (!learned.metrics.accepted) {
      outcomesWithoutMatchingReading += 1;
      return "missing";
    }
    states.set(
      stateKey(emission.bridge, emission.horizon, emission.regime),
      learned.state
    );
    emission.trained = true;
    emission.actual = actual;
    emission.retryAtMs = null;
    outcomesAccepted += 1;
    challengerCreated += learned.metrics.challenger_created ? 1 : 0;
    challengerPromoted += learned.metrics.challenger_promoted ? 1 : 0;
    championRollback += learned.metrics.champion_rollback ? 1 : 0;

    const scoreKey = `${emission.bridge}|${emission.horizon}`;
    const accumulator = scores.get(scoreKey) ?? emptyAccumulator();
    addScore(
      accumulator,
      emission,
      actual.reading.levelM,
      emission.bandCm,
      emission.bandCm
    );
    scores.set(scoreKey, accumulator);
    return "trained";
  };

  const processTrainingAt = (issueMs: number): void => {
    while (dueQueue.length && dueQueue[0].atMs <= issueMs) {
      const item = popQueue(dueQueue) as QueueItem;
      trainEmission(item.emission, issueMs);
    }
    while (retryQueue.length && retryQueue[0].atMs <= issueMs) {
      const item = popQueue(retryQueue) as QueueItem;
      if (!item.emission.trained) trainEmission(item.emission, issueMs);
    }
  };

  if (
    firstIssue !== null &&
    lastEmissionIssue !== null &&
    firstIssue <= lastEmissionIssue
  ) {
    for (
      let issueMs = firstIssue;
      issueMs <= lastEmissionIssue;
      issueMs += ISSUE_STEP_MS
    ) {
      if (operations.count >= MAX_OPERATIONS) {
        stoppedByOperationLimit = true;
        break;
      }
      issuesAttempted += 1;
      processTrainingAt(issueMs);
      for (const bridge of BRIDGES) {
        emissionsAttempted += 1;
        const readings = byBridge.get(bridge) ?? [];
        const samples = samplesAtIssue(readings, issueMs, operations);
        if (operations.count > MAX_OPERATIONS) {
          stoppedByOperationLimit = true;
          break;
        }
        const base = computeForecastV2({
          bridge: { id: bridge, station_id: null },
          samples,
          now: issueMs,
        });
        operations.count += 1;
        if (!base.available) continue;
        v2AvailableEmissions += 1;
        const regime = detectRegime(base);
        const selectedStates: Partial<Record<Horizon, LearningState>> = {
          1: getState(bridge, 1, regime),
          2: getState(bridge, 2, regime),
          3: getState(bridge, 3, regime),
        };
        const adaptive = applyAdaptiveForecast(base, selectedStates);
        for (const horizon of HORIZONS) {
          const baseHorizon = base.horizons.find(
            candidate => candidate.hours === horizon
          );
          const adaptiveHorizon = adaptive.horizons.find(
            candidate => candidate.hours === horizon
          );
          const details = adaptive.adaptive.horizons[horizon];
          const candidates = asCandidates(details.candidates);
          if (
            !baseHorizon ||
            !adaptiveHorizon ||
            candidates === null ||
            !Number.isFinite(adaptiveHorizon.predicted_level)
          )
            continue;
          if (
            baseHorizon.target_time !== adaptiveHorizon.target_time ||
            baseHorizon.band_cm !== adaptiveHorizon.band_cm
          )
            bandViolations += 1;
          if (
            baseHorizon.target_time &&
            Date.parse(baseHorizon.target_time) > issueMs + 3 * HOUR_MS
          )
            noFutureSampleViolations += 1;
          const emission: Emission = {
            sequence: sequence++,
            bridge,
            issueMs,
            baseMs: Date.parse(base.base_time),
            targetMs: Date.parse(baseHorizon.target_time),
            horizon,
            currentLevel: Number(base.current_level),
            v2Level: baseHorizon.predicted_level,
            adaptiveLevel: adaptiveHorizon.predicted_level,
            bandCm: baseHorizon.band_cm,
            candidates,
            regime,
            issuedRevision: Number(details.revision ?? 0),
            trained: false,
            actual: null,
            retryAtMs: null,
          };
          if (
            !Number.isFinite(emission.baseMs) ||
            !Number.isFinite(emission.targetMs) ||
            !Number.isFinite(emission.currentLevel)
          )
            continue;
          emissions.push(emission);
          pushQueue(dueQueue, {
            emission,
            atMs: emission.targetMs + MATCH_WINDOW_MS,
            kind: "due",
          });
          if (emission.issuedRevision !== Number(details.revision ?? 0))
            issuedRevisionViolations += 1;
        }
      }
      if (stoppedByOperationLimit) break;
    }
    // Training-only flush: it emits nothing and only allows a final reading
    // whose collection time is at the dataset end to be used without leaking
    // data beyond the retained observation horizon.
    if (!stoppedByOperationLimit && flushIssue !== null)
      processTrainingAt(flushIssue);
  }

  const scoreRows: ScoreRow[] = [];
  for (const bridge of BRIDGES) {
    for (const horizon of HORIZONS) {
      scoreRows.push(
        scoreFromAccumulator(
          bridge,
          horizon,
          scores.get(`${bridge}|${horizon}`) ?? emptyAccumulator()
        )
      );
    }
  }

  const measuredDays = new Set<string>();
  const evaluationMeasuredStart = evaluationStart ?? Number.POSITIVE_INFINITY;
  const evaluationMeasuredEnd = evaluationEnd ?? Number.NEGATIVE_INFINITY;
  for (const reading of parsed) {
    if (
      reading.measuredMs >= evaluationMeasuredStart &&
      reading.measuredMs <= evaluationMeasuredEnd
    )
      measuredDays.add(new Date(reading.measuredMs).toISOString().slice(0, 10));
  }
  const observationsForBridge = parsed.filter(
    reading =>
      reading.measuredMs >= evaluationMeasuredStart &&
      reading.measuredMs <= evaluationMeasuredEnd
  );
  const distinctMeasuredDays = new Set(
    parsed.map(reading =>
      new Date(reading.measuredMs).toISOString().slice(0, 10)
    )
  ).size;
  const evaluationSpanDays =
    evaluationStart !== null && evaluationEnd !== null
      ? (evaluationEnd - evaluationStart) / DAY_MS
      : null;
  const aggregate = aggregateScores(scoreRows);
  const allBandsIdentical = scoreRows.every(
    score => score.margins.identical_for_all_pairs
  );
  const report: BacktestReport = {
    status:
      parsed.length === 0
        ? "no_data"
        : stoppedByOperationLimit
          ? "completed_with_limit"
          : "completed",
    created_at: new Date(nowMs).toISOString(),
    model_version: ADAPTIVE_MODEL_VERSION,
    method: {
      replay:
        "Replay temporal offline a cada 10 minutos; em cada issue treina outcomes elegíveis antes de emitir v2 + adaptive-v3.",
      source_table: "river_readings",
      access: "read-only",
      bridges: BRIDGES,
      retention_days: RETENTION_DAYS,
      evaluation_window_days: EVALUATION_DAYS,
      issue_step_minutes: 10,
      input_window_hours: 6,
      match_window_minutes: 10,
      operation_limit: MAX_OPERATIONS,
      no_tolerance_adjustment: true,
      no_writes: true,
      no_llm: true,
    },
    data: {
      rows_read: fetched.rows.length,
      valid_rows: parsed.length,
      invalid_rows: fetched.rows.length - parsed.length,
      retention_cutoff: cutoffIso,
      dataset_available_start: iso(datasetAvailableStart),
      dataset_available_end: iso(datasetAvailableEnd),
      dataset_measured_start: iso(datasetMeasuredStart),
      dataset_measured_end: iso(datasetMeasuredEnd),
      available_span_days:
        datasetAvailableStart !== null && datasetAvailableEnd !== null
          ? round((datasetAvailableEnd - datasetAvailableStart) / DAY_MS, 3)
          : null,
      measured_span_days:
        datasetMeasuredStart !== null && datasetMeasuredEnd !== null
          ? round((datasetMeasuredEnd - datasetMeasuredStart) / DAY_MS, 3)
          : null,
      distinct_measured_days: distinctMeasuredDays,
      evaluation_start: iso(evaluationStart),
      evaluation_end: iso(evaluationEnd),
      evaluation_span_days: round(evaluationSpanDays),
      observation_days_in_evaluation: measuredDays.size,
      note:
        observationsForBridge.length < 7
          ? "Poucos dias de observações reais no recorte; a janela nominal de 7 dias não implica cobertura contínua."
          : "A retenção consultada é de 60 dias, mas a avaliação foi limitada aos 7 dias finais disponíveis para runtime curto.",
    },
    replay: {
      issues_attempted: issuesAttempted,
      emissions_attempted: emissionsAttempted,
      v2_available_emissions: v2AvailableEmissions,
      emissions_recorded: emissions.length,
      outcomes_accepted: outcomesAccepted,
      outcomes_waiting_for_actual: outcomesWaitingForActual,
      outcomes_without_matching_reading: outcomesWithoutMatchingReading,
      operation_count: operations.count,
      stopped_by_operation_limit: stoppedByOperationLimit,
      states_created: states.size,
      state_keys: states.size,
      challenger_created: challengerCreated,
      challenger_promoted: challengerPromoted,
      champion_rollback: championRollback,
      cold_start: {
        initialized_from_initial_learning_state: true,
        used_other_users_or_persisted_state: false,
        outcomes_before_state_change: "controlled_by_core_minimum_history",
      },
    },
    scores: scoreRows,
    aggregate: {
      ...aggregate,
      interpretation: aggregate.interpretation,
    },
    invariants: {
      no_future_samples_in_inputs: noFutureSampleViolations === 0,
      no_future_actuals_in_training: noFutureActualViolations === 0,
      issued_revision_frozen: issuedRevisionViolations === 0,
      states_separated_by_bridge_horizon_regime: true,
      v2_adaptive_bands_identical: bandViolations === 0 && allBandsIdentical,
      training_requires_target_plus_10_minutes: true,
      actual_requires_measured_and_available_by_issue: true,
    },
    caveats: [
      "Actual availability foi definida como max(measured_at, collected_at); uma leitura futura na medição ou na coleta não entra antes do issue.",
      "Duplicatas de measured_at são resolvidas no instante do replay pela leitura disponível mais recente; não há deduplicação global que possa vazar uma correção futura.",
      "O estado adaptativo começa frio por bridge/horizon/regime com initialLearningState; nenhum estado persistido ou dado de outros usuários é importado.",
      "MAE é pareado no mesmo outcome real para adaptive, v2 e persistência; acerto só conta dentro da band_cm original, idêntica entre v2 e adaptive.",
      "Amostras temporais próximas são correlacionadas; poucas cheias, poucos dias ou um único evento não demonstram generalização hidrológica.",
      "Contextos de chuva, montante e barragens não foram inventados no replay; a comparação usa somente river_readings, como o backtest v2 de referência.",
      "O resultado não autoriza claim de superioridade quando os números não indicarem vantagem consistente; a avaliação é retrospectiva e experimental.",
    ],
  };

  writeFileSync(OUTPUT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Backtest adaptive-v3 falhou: ${message}`);
  process.exitCode = 1;
});
