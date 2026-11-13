import {
  type ForecastV2Horizon,
  type ForecastV2Latest,
} from "./forecast-model-v2";

export const ADAPTIVE_MODEL_VERSION = "adaptive-v3" as const;

export type Regime = "stable" | "rising" | "falling" | "turning";
export type Specialist = "persistence" | "damped" | "trend" | "acceleration";

const SPECIALISTS = ["persistence", "damped", "trend", "acceleration"] as const satisfies readonly Specialist[];
const HORIZONS = [1, 2, 3] as const;
const EWMA_ALPHA = 0.25;
const MIN_HISTORY_BEFORE_CHANGE = 24;
const PROSPECTIVE_BATCH_SIZE = 12;
const CHALLENGER_COOLDOWN = 4;
const CRITICAL_LEVEL_M = 6.5;

export type CandidateLevels = Record<Specialist, number>;
export type NullableCandidateLevels = Record<Specialist, number | null>;
export type AdaptiveWeights = Record<Specialist, number>;

export type SpecialistErrorState = {
  count: number;
  mae_cm: number;
  bias_cm: number;
  loss: number;
  critical_loss_cm: number;
  ewma_error_cm: number;
  ewma_bias_cm: number;
  ewma_loss: number;
  underestimation_count: number;
};

export type ChampionState = {
  weights: AdaptiveWeights;
  revision: number;
  score: number;
};

export type ChallengerState = {
  weights: AdaptiveWeights;
  base_revision: number;
  prospective_count: number;
  champion_loss_cm: number;
  challenger_loss_cm: number;
};

/**
 * Estado agregado e JSON-serializável. Não contém leituras, datas mutáveis,
 * funções ou referências a banco: o chamador pode persistir este objeto como
 * jsonb e coordenar a revisão/idempotência fora deste núcleo.
 */
export type LearningState = {
  version: typeof ADAPTIVE_MODEL_VERSION;
  regime: Regime;
  revision: number;
  state_count: number;
  weights: AdaptiveWeights;
  errors: Record<Specialist, SpecialistErrorState>;
  champion: ChampionState;
  challenger: ChallengerState | null;
  cooldown_until: number;
};

export type Evaluation = {
  candidates: CandidateLevels;
  actual_level: number;
  issued_level: number;
  current_level: number;
  issued_at?: number;
  actual_time?: number;
  /** Revisão congelada na emissão; outcomes anteriores não validam challengers posteriores. */
  issued_revision?: number;
};

export type LearningMetrics = {
  accepted: boolean;
  reason?: string;
  revision: number;
  state_count: number;
  actual_category: OfficialCategory | "unknown";
  issued_error_cm: number | null;
  issued_loss_cm: number | null;
  issued_critical_loss_cm: number | null;
  candidate_errors: Partial<Record<Specialist, {
    error_cm: number;
    absolute_error_cm: number;
    underestimation_loss_cm: number;
    critical_loss_cm: number;
    loss_cm: number;
  }>>;
  challenger_created: boolean;
  challenger_promoted: boolean;
  champion_rollback: boolean;
  prospective_count: number;
  time_delta_minutes: number | null;
};

export type AdaptiveHorizonDetails = {
  regime: Regime;
  candidates: NullableCandidateLevels;
  weights: AdaptiveWeights;
  revision?: number;
  state_count: number;
  selected_level: number | null;
};

export type AdaptiveDetails = {
  model_version: typeof ADAPTIVE_MODEL_VERSION;
  comments: string[];
  horizons: Record<1 | 2 | 3, AdaptiveHorizonDetails>;
};

export type AdaptiveForecast = Omit<ForecastV2Latest, "model_version"> & {
  model_version: typeof ADAPTIVE_MODEL_VERSION;
  adaptive: AdaptiveDetails;
};

type AnyRecord = Record<string, unknown>;

type LossBreakdown = {
  valid: boolean;
  errorCm: number;
  absoluteErrorCm: number;
  underestimationLossCm: number;
  criticalLossCm: number;
  lossCm: number;
  category: OfficialCategory | "unknown";
};

type SpecialistErrorInput = SpecialistErrorState & {
  errorCm: number;
  absoluteErrorCm: number;
  underestimationLossCm: number;
  criticalLossCm: number;
  lossCm: number;
};

type OfficialCategory = "normal" | "attention" | "alert" | "emergency";

function finiteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value.trim().replace(",", "."));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function finiteNonNegative(value: unknown, fallback = 0): number {
  const parsed = finiteNumber(value);
  return parsed !== null && parsed >= 0 ? parsed : fallback;
}

function finiteInteger(value: unknown, fallback = 0): number {
  const parsed = finiteNumber(value);
  return parsed !== null && Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function clamp(value: number, lower: number, upper: number): number {
  return Math.min(upper, Math.max(lower, value));
}

function isRegime(value: unknown): value is Regime {
  return value === "stable" || value === "rising" || value === "falling" || value === "turning";
}

function isSpecialist(value: string): value is Specialist {
  return (SPECIALISTS as readonly string[]).includes(value);
}

function normaliseWeights(raw: unknown, fallback: AdaptiveWeights): AdaptiveWeights {
  const candidate = (raw && typeof raw === "object" ? raw : {}) as AnyRecord;
  const values = SPECIALISTS.map((name) => {
    const value = finiteNumber(candidate[name]);
    return value !== null && value >= 0 ? value : 0;
  });
  const sum = values.reduce((total, value) => total + value, 0);
  if (!Number.isFinite(sum) || sum <= 0) return { ...fallback };
  return {
    persistence: values[0] / sum,
    damped: values[1] / sum,
    trend: values[2] / sum,
    acceleration: values[3] / sum,
  };
}

function weightsForRegime(regime: Regime): AdaptiveWeights {
  // Cold start is intentionally conservative. A sustained rise gets trend as
  // its champion, rather than blindly selecting persistence in every regime.
  if (regime === "rising") return { persistence: 0.14, damped: 0.20, trend: 0.48, acceleration: 0.18 };
  if (regime === "falling") return { persistence: 0.18, damped: 0.25, trend: 0.40, acceleration: 0.17 };
  if (regime === "turning") return { persistence: 0.34, damped: 0.34, trend: 0.20, acceleration: 0.12 };
  return { persistence: 0.52, damped: 0.25, trend: 0.14, acceleration: 0.09 };
}

function emptyErrorState(): SpecialistErrorState {
  return {
    count: 0,
    mae_cm: 0,
    bias_cm: 0,
    loss: 0,
    critical_loss_cm: 0,
    ewma_error_cm: 0,
    ewma_bias_cm: 0,
    ewma_loss: 0,
    underestimation_count: 0,
  };
}

function emptyErrors(): Record<Specialist, SpecialistErrorState> {
  return {
    persistence: emptyErrorState(),
    damped: emptyErrorState(),
    trend: emptyErrorState(),
    acceleration: emptyErrorState(),
  };
}

function safeScore(value: unknown): number {
  const parsed = finiteNumber(value);
  return parsed !== null && parsed >= 0 ? parsed : 0;
}

function normaliseErrorState(raw: unknown): SpecialistErrorState {
  const value = (raw && typeof raw === "object" ? raw : {}) as AnyRecord;
  return {
    count: finiteInteger(value.count),
    mae_cm: safeScore(value.mae_cm),
    bias_cm: finiteNumber(value.bias_cm) ?? 0,
    loss: safeScore(value.loss),
    critical_loss_cm: safeScore(value.critical_loss_cm),
    ewma_error_cm: safeScore(value.ewma_error_cm),
    ewma_bias_cm: finiteNumber(value.ewma_bias_cm) ?? 0,
    ewma_loss: safeScore(value.ewma_loss),
    underestimation_count: finiteInteger(value.underestimation_count),
  };
}

function normaliseState(input: LearningState): LearningState {
  const value = (input && typeof input === "object" ? input : {}) as unknown as AnyRecord;
  const regime = isRegime(value.regime) ? value.regime : "stable";
  const defaults = weightsForRegime(regime);
  const weights = normaliseWeights(value.weights, defaults);
  const championValue = value.champion && typeof value.champion === "object" ? value.champion as AnyRecord : {};
  const championWeights = normaliseWeights(championValue.weights, weights);
  const errorsValue = value.errors && typeof value.errors === "object" ? value.errors as AnyRecord : {};
  const errors = emptyErrors();
  for (const specialist of SPECIALISTS) errors[specialist] = normaliseErrorState(errorsValue[specialist]);

  let challenger: ChallengerState | null = null;
  if (value.challenger && typeof value.challenger === "object") {
    const challengerValue = value.challenger as AnyRecord;
    const challengerWeights = normaliseWeights(challengerValue.weights, championWeights);
    challenger = {
      weights: challengerWeights,
      base_revision: finiteInteger(challengerValue.base_revision),
      prospective_count: finiteInteger(challengerValue.prospective_count),
      champion_loss_cm: safeScore(challengerValue.champion_loss_cm),
      challenger_loss_cm: safeScore(challengerValue.challenger_loss_cm),
    };
  }

  return {
    version: ADAPTIVE_MODEL_VERSION,
    regime,
    revision: finiteInteger(value.revision),
    state_count: finiteInteger(value.state_count),
    weights,
    errors,
    champion: {
      weights: championWeights,
      revision: finiteInteger(championValue.revision),
      score: safeScore(championValue.score),
    },
    challenger,
    cooldown_until: finiteInteger(value.cooldown_until),
  };
}

export function initialLearningState(regime: Regime): LearningState {
  const safeRegime: Regime = isRegime(regime) ? regime : "stable";
  const weights = weightsForRegime(safeRegime);
  return {
    version: ADAPTIVE_MODEL_VERSION,
    regime: safeRegime,
    revision: 0,
    state_count: 0,
    weights: { ...weights },
    errors: emptyErrors(),
    champion: { weights: { ...weights }, revision: 0, score: 0 },
    challenger: null,
    cooldown_until: 0,
  };
}

/**
 * Regime uses only observed rate60/rate180/noise. Horizon predictions are
 * deliberately not consulted, so a future target cannot feed back into the
 * regime label. Thresholds are operational heuristics, not hydrological fits.
 */
export function detectRegime(baseV2Forecast: ForecastV2Latest): Regime {
  const rate60 = finiteNumber(baseV2Forecast?.rate60);
  const rate180 = finiteNumber(baseV2Forecast?.rate180);
  const noise = finiteNonNegative(baseV2Forecast?.noise_cm, 0);
  const quietThreshold = Math.max(0.75, noise * 0.25);

  if (rate60 === null && rate180 === null) return "stable";
  const recent = rate60 ?? rate180 ?? 0;
  const older = rate180 ?? rate60 ?? 0;
  const oppositeMeaningful = Math.abs(recent) >= quietThreshold && Math.abs(older) >= quietThreshold && recent * older < 0;
  if (oppositeMeaningful) return "turning";

  const disagreement = Math.abs(recent - older);
  if (Math.abs(recent) <= quietThreshold && Math.abs(older) <= quietThreshold && disagreement <= Math.max(2, noise)) {
    return "stable";
  }
  if (recent >= 1.25 && older >= 0.35) return "rising";
  if (recent <= -1.25 && older <= -0.35) return "falling";

  // A strong recent reversal signal is turning even when the older window is
  // small; otherwise a one-window signal gets a cautious directional label.
  if (disagreement >= Math.max(2.5, noise * 0.75) && Math.abs(recent) >= 1.25) return "turning";
  if (recent > quietThreshold || older > quietThreshold) return "rising";
  if (recent < -quietThreshold || older < -quietThreshold) return "falling";
  return "stable";
}

function contextCm(horizon: ForecastV2Horizon): number {
  return [horizon.upstream_cm, horizon.dam_cm, horizon.rain_observed_cm, horizon.rain_forecast_cm]
    .map((value) => finiteNumber(value) ?? 0)
    .reduce((sum, value) => sum + value, 0);
}

function horizonFor(base: ForecastV2Latest, hours: 1 | 2 | 3): ForecastV2Horizon | null {
  return base.horizons.find((horizon) => horizon.hours === hours) ?? null;
}

function candidateLevels(
  base: ForecastV2Latest,
  horizon: ForecastV2Horizon,
  regime: Regime,
): NullableCandidateLevels {
  const current = finiteNumber(base.current_level);
  if (current === null) {
    return { persistence: null, damped: null, trend: null, acceleration: null };
  }

  const context = contextCm(horizon);
  const baseTrend = finiteNumber(horizon.trend_cm) ?? 0;
  const rate = finiteNumber(base.rate60) ?? finiteNumber(base.rate180) ?? 0;
  const hours = horizon.hours;
  const linearTrend = rate * hours;
  const dampingByRegime: Record<Regime, number> = {
    stable: 0.35,
    rising: 0.65,
    falling: 0.65,
    turning: 0.40,
  };
  const dampedTrend = linearTrend * dampingByRegime[regime] / (1 + 0.08 * (hours - 1));

  // Context is carried through every specialist exactly as emitted by v2.
  // Trend uses only the linear observed rate, while acceleration uses v2's
  // complete trend component exactly once; no new acceleration is invented.
  const persistence = current + context / 100;
  const damped = current + (context + dampedTrend) / 100;
  const trend = current + (context + linearTrend) / 100;
  const acceleration = current + (context + baseTrend) / 100;
  return {
    persistence: Number.isFinite(persistence) ? persistence : null,
    damped: Number.isFinite(damped) ? damped : null,
    trend: Number.isFinite(trend) ? trend : null,
    acceleration: Number.isFinite(acceleration) ? acceleration : null,
  };
}

function selectedLevel(candidates: NullableCandidateLevels, weights: AdaptiveWeights): number | null {
  let total = 0;
  let weightTotal = 0;
  for (const specialist of SPECIALISTS) {
    const level = candidates[specialist];
    const weight = finiteNumber(weights[specialist]);
    if (level === null || weight === null || weight < 0) continue;
    total += level * weight;
    weightTotal += weight;
  }
  if (!Number.isFinite(total) || weightTotal <= 0) return null;
  const selected = total / weightTotal;
  return Number.isFinite(selected) ? selected : null;
}

function adaptiveHorizonDetails(
  base: ForecastV2Latest,
  hours: 1 | 2 | 3,
  regime: Regime,
  state: LearningState,
): AdaptiveHorizonDetails {
  const horizon = horizonFor(base, hours);
  const candidates = horizon ? candidateLevels(base, horizon, regime) : {
    persistence: null,
    damped: null,
    trend: null,
    acceleration: null,
  };
  return {
    regime,
    candidates,
    weights: { ...state.weights },
    revision: state.revision,
    state_count: state.state_count,
    selected_level: selectedLevel(candidates, state.weights),
  };
}

function adaptiveComments(regime: Regime): string[] {
  return [
    "Adaptive-v3 é experimental: ajusta pesos de especialistas determinísticos e não reescreve o modelo v2.",
    `Regime heurístico observado: ${regime}; usa somente rate60, rate180 e noise_cm, sem alvo futuro.`,
    "Candidatas são congeladas em metros na emissão; persistência, amortecimento, tendência e aceleração variam somente a componente tendência.",
    "Montante, barragens e chuva preservam os componentes quantitativos do v2; nenhum coeficiente hidrológico novo é inferido.",
    "Margens band_cm, tolerância e confidence do v2 permanecem inalteradas; aprendizado não melhora percentual por relaxamento de tolerância.",
    `Cold start heurístico (não é estimativa estatística), EWMA e champion/challenger exigem ${MIN_HISTORY_BEFORE_CHANGE} resultados antes de propor pesos e um lote prospectivo de ${PROSPECTIVE_BATCH_SIZE} resultados antes de promover.`,
  ];
}

function replaceTrendFactor(base: ForecastV2Latest, trendCm: number, regime: Regime): ForecastV2Latest["factors"] {
  return base.factors.map((factor) => factor.key === "tendencia"
    ? {
        ...factor,
        cm: trendCm,
        detail: `${factor.detail} Adaptive-v3: tendência ajustada por pesos no regime ${regime}; demais fatores preservados.`,
      }
    : { ...factor });
}

export function applyAdaptiveForecast(
  baseV2Forecast: ForecastV2Latest,
  states: Partial<Record<1 | 2 | 3, LearningState>>,
): AdaptiveForecast {
  const base = baseV2Forecast;
  const regime = detectRegime(base);
  const stateFor = (hours: 1 | 2 | 3): LearningState => {
    const supplied = states?.[hours];
    // State rows are regime-scoped. A row from another regime must not leak its
    // learned weights into this forecast; the correct row starts conservatively.
    return supplied && supplied.regime === regime
      ? normaliseState(supplied)
      : initialLearningState(regime);
  };
  const stateByHorizon = {
    1: stateFor(1),
    2: stateFor(2),
    3: stateFor(3),
  } as const;
  const metadata = {
    1: adaptiveHorizonDetails(base, 1, regime, stateByHorizon[1]),
    2: adaptiveHorizonDetails(base, 2, regime, stateByHorizon[2]),
    3: adaptiveHorizonDetails(base, 3, regime, stateByHorizon[3]),
  } satisfies Record<1 | 2 | 3, AdaptiveHorizonDetails>;

  const current = finiteNumber(base.current_level);
  const horizons = base.horizons.map((horizon) => {
    const hours = horizon.hours as 1 | 2 | 3;
    const details = metadata[hours];
    const selected = details.selected_level;
    if (current === null || selected === null) return { ...horizon };
    const context = contextCm(horizon);
    const deltaCm = (selected - current) * 100;
    const trendCm = deltaCm - context;
    if (![deltaCm, trendCm, selected].every(Number.isFinite)) return { ...horizon };
    return {
      ...horizon,
      predicted_level: selected,
      delta_cm: deltaCm,
      trend_cm: trendCm,
    };
  });

  const first = horizons.find((horizon) => horizon.hours === 1);
  const factors = first
    ? replaceTrendFactor(base, finiteNumber(first.trend_cm) ?? 0, regime)
    : base.factors.map((factor) => ({ ...factor }));
  const comments = adaptiveComments(regime);
  const notes = [...(base.notes ?? []), ...comments];
  const levels = [current, ...horizons.map((horizon) => finiteNumber(horizon.predicted_level))]
    .filter((level): level is number => level !== null);
  if (levels.some((level) => level >= CRITICAL_LEVEL_M)) {
    notes.push("Nível atual ou previsto atinge 6,5 m: faixa oficial de alerta/emergência deve seguir os avisos oficiais.");
  }

  return {
    ...base,
    model_version: ADAPTIVE_MODEL_VERSION,
    horizons,
    factors,
    notes,
    adaptive: {
      model_version: ADAPTIVE_MODEL_VERSION,
      comments,
      horizons: metadata,
    },
  };
}

function officialCategory(level: number): OfficialCategory {
  if (level < 4.5) return "normal";
  if (level < 5.5) return "attention";
  if (level <= CRITICAL_LEVEL_M) return "alert";
  return "emergency";
}

function lossForLevel(predicted: unknown, actual: number): LossBreakdown {
  const level = finiteNumber(predicted);
  if (level === null || !Number.isFinite(actual)) {
    return {
      valid: false,
      errorCm: 0,
      absoluteErrorCm: 0,
      underestimationLossCm: 0,
      criticalLossCm: 0,
      lossCm: 0,
      category: "unknown",
    };
  }
  const errorCm = (level - actual) * 100;
  const absoluteErrorCm = Math.abs(errorCm);
  const predictedCategory = officialCategory(level);
  const actualCategory = officialCategory(actual);
  const categoryRank: Record<OfficialCategory, number> = { normal: 0, attention: 1, alert: 2, emergency: 3 };
  const categoryGap = Math.max(0, categoryRank[actualCategory] - categoryRank[predictedCategory]);
  // Category mistakes carry a fixed operational penalty in addition to cm MAE.
  // At >6.5 m, predicting <=6.5 m receives an extra critical penalty.
  const underestimationLossCm = categoryGap * 8;
  const criticalLossCm = actual > CRITICAL_LEVEL_M && level <= CRITICAL_LEVEL_M ? 18 : 0;
  return {
    valid: true,
    errorCm: Number.isFinite(errorCm) ? errorCm : 0,
    absoluteErrorCm: Number.isFinite(absoluteErrorCm) ? absoluteErrorCm : 0,
    underestimationLossCm,
    criticalLossCm,
    lossCm: absoluteErrorCm + underestimationLossCm + criticalLossCm,
    category: actualCategory,
  };
}

function updateErrorState(previous: SpecialistErrorState, observation: SpecialistErrorInput): SpecialistErrorState {
  const count = previous.count + 1;
  const oldCount = previous.count;
  const ewma = (old: number, next: number) => oldCount === 0 ? next : (1 - EWMA_ALPHA) * old + EWMA_ALPHA * next;
  return {
    count,
    mae_cm: (previous.mae_cm * oldCount + observation.absoluteErrorCm) / count,
    bias_cm: (previous.bias_cm * oldCount + observation.errorCm) / count,
    loss: (previous.loss * oldCount + observation.lossCm) / count,
    critical_loss_cm: (previous.critical_loss_cm * oldCount + observation.criticalLossCm + observation.underestimationLossCm) / count,
    ewma_error_cm: ewma(previous.ewma_error_cm, observation.absoluteErrorCm),
    ewma_bias_cm: ewma(previous.ewma_bias_cm, observation.errorCm),
    ewma_loss: ewma(previous.ewma_loss, observation.lossCm),
    underestimation_count: previous.underestimation_count + (observation.underestimationLossCm > 0 ? 1 : 0),
  };
}

function candidateLoss(weights: AdaptiveWeights, candidates: CandidateLevels, actual: number): LossBreakdown {
  const selected = selectedLevel(candidates, weights);
  return lossForLevel(selected, actual);
}

function softmaxWeights(errors: Record<Specialist, SpecialistErrorState>, fallback: AdaptiveWeights): AdaptiveWeights {
  const scores = SPECIALISTS.map((specialist) => {
    const error = errors[specialist];
    const score = error.count > 0 ? error.ewma_loss + error.critical_loss_cm * 0.25 : 0;
    return Number.isFinite(score) && score >= 0 ? score : 0;
  });
  const temperature = 4;
  const logits = scores.map((score) => -score / temperature);
  const maxLogit = Math.max(...logits);
  const exponentials = logits.map((logit) => Math.exp(clamp(logit - maxLogit, -50, 50)));
  const sum = exponentials.reduce((total, value) => total + value, 0);
  if (!Number.isFinite(sum) || sum <= 0) return { ...fallback };
  return {
    persistence: exponentials[0] / sum,
    damped: exponentials[1] / sum,
    trend: exponentials[2] / sum,
    acceleration: exponentials[3] / sum,
  };
}

function gradualProposal(current: AdaptiveWeights, target: AdaptiveWeights): AdaptiveWeights {
  // The target comes from a softmax, but only a 0.1 interpolation step is
  // frozen into the challenger, capped at 0.05 per weight. This prevents one
  // noisy reading from replacing a champion and keeps proposals gradual.
  const maxWeightDelta = Math.max(...SPECIALISTS.map((specialist) => Math.abs(target[specialist] - current[specialist])));
  const interpolation = maxWeightDelta > 0
    ? Math.min(0.1, 0.05 / maxWeightDelta)
    : 0;
  const proposal = {
    persistence: current.persistence + (target.persistence - current.persistence) * interpolation,
    damped: current.damped + (target.damped - current.damped) * interpolation,
    trend: current.trend + (target.trend - current.trend) * interpolation,
    acceleration: current.acceleration + (target.acceleration - current.acceleration) * interpolation,
  };
  return normaliseWeights(proposal, current);
}

function materiallyDifferent(first: AdaptiveWeights, second: AdaptiveWeights): boolean {
  return SPECIALISTS.some((specialist) => Math.abs(first[specialist] - second[specialist]) >= 0.015);
}

function safeTimeDeltaMinutes(evaluation: Evaluation): number | null {
  const issued = finiteNumber(evaluation.issued_at);
  const actual = finiteNumber(evaluation.actual_time);
  if (issued === null || actual === null) return null;
  const delta = Math.abs(actual - issued) / 60_000;
  return Number.isFinite(delta) ? delta : null;
}

function invalidMetrics(state: LearningState, reason: string, timeDelta: number | null): LearningMetrics {
  return {
    accepted: false,
    reason,
    revision: state.revision,
    state_count: state.state_count,
    actual_category: "unknown",
    issued_error_cm: null,
    issued_loss_cm: null,
    issued_critical_loss_cm: null,
    candidate_errors: {},
    challenger_created: false,
    challenger_promoted: false,
    champion_rollback: false,
    prospective_count: state.challenger?.prospective_count ?? 0,
    time_delta_minutes: timeDelta,
  };
}

export function learnFromOutcome(
  inputState: LearningState,
  evaluation: Evaluation,
): { state: LearningState; metrics: LearningMetrics } {
  const state = normaliseState(inputState);
  const timeDelta = safeTimeDeltaMinutes(evaluation);
  const actual = finiteNumber(evaluation.actual_level);
  const issued = finiteNumber(evaluation.issued_level);
  const current = finiteNumber(evaluation.current_level);
  if (actual === null || issued === null || current === null) {
    return { state, metrics: invalidMetrics(state, "Outcome ignorado: actual_level, issued_level e current_level precisam ser finitos.", timeDelta) };
  }

  const candidateErrors: Partial<Record<Specialist, SpecialistErrorInput>> = {};
  const rawCandidates = evaluation.candidates && typeof evaluation.candidates === "object"
    ? evaluation.candidates as Partial<Record<Specialist, unknown>>
    : {};
  for (const specialist of SPECIALISTS) {
    const candidate = finiteNumber(rawCandidates[specialist]);
    if (candidate === null) continue;
    const loss = lossForLevel(candidate, actual);
    if (!loss.valid) continue;
    candidateErrors[specialist] = {
      ...state.errors[specialist],
      errorCm: loss.errorCm,
      absoluteErrorCm: loss.absoluteErrorCm,
      underestimationLossCm: loss.underestimationLossCm,
      criticalLossCm: loss.criticalLossCm,
      lossCm: loss.lossCm,
    };
  }
  if (!SPECIALISTS.some((specialist) => candidateErrors[specialist])) {
    return { state, metrics: invalidMetrics(state, "Outcome ignorado: candidatas sem níveis finitos.", timeDelta) };
  }

  const next: LearningState = {
    ...state,
    revision: state.revision + 1,
    state_count: state.state_count + 1,
    weights: { ...state.weights },
    errors: { ...state.errors },
    champion: { ...state.champion, weights: { ...state.champion.weights } },
    challenger: state.challenger
      ? { ...state.challenger, weights: { ...state.challenger.weights } }
      : null,
  };
  const candidateMetrics: LearningMetrics["candidate_errors"] = {};
  for (const specialist of SPECIALISTS) {
    const observation = candidateErrors[specialist];
    if (!observation) continue;
    next.errors[specialist] = updateErrorState(state.errors[specialist], observation);
    candidateMetrics[specialist] = {
      error_cm: observation.errorCm,
      absolute_error_cm: observation.absoluteErrorCm,
      underestimation_loss_cm: observation.underestimationLossCm,
      critical_loss_cm: observation.criticalLossCm,
      loss_cm: observation.lossCm,
    };
  }

  const issuedLoss = lossForLevel(issued, actual);
  const issuedErrorCm = (issued - actual) * 100;
  let challengerCreated = false;
  let challengerPromoted = false;
  let championRollback = false;

  if (next.challenger) {
    const challenge = next.challenger;
    const issuedRevision = finiteNumber(evaluation.issued_revision);
    const isProspective = issuedRevision !== null
      && Number.isInteger(issuedRevision)
      && issuedRevision >= challenge.base_revision;
    if (isProspective) {
      const candidates = rawCandidates as CandidateLevels;
      const championLoss = candidateLoss(next.champion.weights, candidates, actual);
      const challengerLoss = candidateLoss(challenge.weights, candidates, actual);
      if (championLoss.valid && challengerLoss.valid) {
        challenge.prospective_count += 1;
        challenge.champion_loss_cm += championLoss.lossCm;
        challenge.challenger_loss_cm += challengerLoss.lossCm;
      }
    }
    if (isProspective && challenge.prospective_count >= PROSPECTIVE_BATCH_SIZE) {
      const challengerMean = challenge.challenger_loss_cm / challenge.prospective_count;
      const championMean = challenge.champion_loss_cm / challenge.prospective_count;
      if (Number.isFinite(challengerMean) && challengerMean <= championMean) {
        next.weights = { ...challenge.weights };
        next.champion = {
          weights: { ...challenge.weights },
          revision: next.revision,
          score: challengerMean,
        };
        next.challenger = null;
        next.cooldown_until = next.state_count + 1;
        challengerPromoted = true;
      } else {
        // Automatic rollback: the champion remains the only active model when
        // combined MAE plus official-band/critical loss is worse.
        next.weights = { ...next.champion.weights };
        next.challenger = null;
        next.cooldown_until = next.state_count + CHALLENGER_COOLDOWN;
        championRollback = true;
      }
    }
  } else if (next.state_count >= MIN_HISTORY_BEFORE_CHANGE && next.state_count >= next.cooldown_until) {
    const target = softmaxWeights(next.errors, next.weights);
    const proposal = gradualProposal(next.weights, target);
    if (materiallyDifferent(next.weights, proposal)) {
      next.challenger = {
        weights: proposal,
        base_revision: next.revision,
        prospective_count: 0,
        champion_loss_cm: 0,
        challenger_loss_cm: 0,
      };
      challengerCreated = true;
    }
  }

  next.weights = normaliseWeights(next.weights, next.champion.weights);
  next.champion.weights = normaliseWeights(next.champion.weights, next.weights);
  if (next.challenger) next.challenger.weights = normaliseWeights(next.challenger.weights, next.weights);

  const metrics: LearningMetrics = {
    accepted: true,
    revision: next.revision,
    state_count: next.state_count,
    actual_category: officialCategory(actual),
    issued_error_cm: Number.isFinite(issuedErrorCm) ? issuedErrorCm : null,
    issued_loss_cm: issuedLoss.valid ? issuedLoss.lossCm : null,
    issued_critical_loss_cm: issuedLoss.valid ? issuedLoss.criticalLossCm + issuedLoss.underestimationLossCm : null,
    candidate_errors: candidateMetrics,
    challenger_created: challengerCreated,
    challenger_promoted: challengerPromoted,
    champion_rollback: championRollback,
    prospective_count: next.challenger?.prospective_count ?? 0,
    time_delta_minutes: timeDelta,
  };
  return { state: next, metrics };
}

// Keep this type guard local to the implementation while retaining a compact
// state shape for JSON persistence and avoiding an exported runtime registry.
void isSpecialist;
