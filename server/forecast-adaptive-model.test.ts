import { describe, expect, it } from "vitest";
import { computeForecastV2, type ForecastV2Latest, type ForecastV2Sample } from "./forecast-model-v2";
import {
  ADAPTIVE_MODEL_VERSION,
  applyAdaptiveForecast,
  detectRegime,
  initialLearningState,
  learnFromOutcome,
  type CandidateLevels,
  type LearningState,
} from "./forecast-adaptive-model";

const START = Date.parse("2026-11-12T20:00:00.000Z");
const BRIDGE = { id: "dom-tito", station_id: "station-dom-tito" };

function samplesForSlope(level: number, slopeCmH: number, count = 25, stepMinutes = 5): ForecastV2Sample[] {
  return Array.from({ length: count }, (_, index) => ({
    measured_at: new Date(START + index * stepMinutes * 60_000).toISOString(),
    level_m: level + (slopeCmH / 100) * (index * stepMinutes) / 60,
  }));
}

function baseForecast(level = 5, slopeCmH = 6): ForecastV2Latest {
  const samples = samplesForSlope(level, slopeCmH);
  return computeForecastV2({
    bridge: BRIDGE,
    samples,
    now: START + (samples.length - 1) * 5 * 60_000,
  });
}

function candidateLevels(value: number): CandidateLevels {
  return {
    persistence: value,
    damped: value,
    trend: value,
    acceleration: value,
  };
}

type OutcomeInput = {
  candidates: CandidateLevels;
  actual_level: number;
  issued_revision?: number;
};

function learnMany(state: LearningState, outcomes: OutcomeInput[]): LearningState {
  return outcomes.reduce((current, outcome) => learnFromOutcome(current, {
    ...outcome,
    issued_level: outcome.candidates.trend,
    current_level: 5,
    issued_revision: outcome.issued_revision ?? current.revision,
  }).state, state);
}

function seedChallenger(): LearningState {
  const candidates = { persistence: 5, damped: 5.02, trend: 5.2, acceleration: 5.25 };
  let state = initialLearningState("stable");
  for (let index = 0; index < 24; index += 1) {
    state = learnFromOutcome(state, {
      candidates,
      actual_level: 5.24,
      issued_level: candidates.trend,
      current_level: 5,
      issued_revision: state.revision,
    }).state;
  }
  return state;
}

describe("adaptive-v3 pure model", () => {
  it("mantém estabilidade, campos v2 e metadata adaptive top-level", () => {
    const base = baseForecast(5, 0);
    expect(base.available).toBe(true);
    const state = initialLearningState("stable");
    const result = applyAdaptiveForecast(base, { 1: state, 2: state, 3: state });

    expect(result).toMatchObject({
      model_version: ADAPTIVE_MODEL_VERSION,
      bridge: base.bridge,
      available: true,
      current_level: base.current_level,
      rate60: base.rate60,
      rate180: base.rate180,
      noise_cm: base.noise_cm,
      confidenceLabel: base.confidenceLabel,
      upstream_summary: base.upstream_summary,
      dam_summary: base.dam_summary,
      rain_observed_summary: base.rain_observed_summary,
      rain_forecast_summary: base.rain_forecast_summary,
    });
    expect(result.horizons).toHaveLength(3);
    expect(result.factors.map((factor) => factor.key)).toEqual(base.factors.map((factor) => factor.key));
    expect(result.adaptive.model_version).toBe(ADAPTIVE_MODEL_VERSION);
    expect(result.details).toBeUndefined();
    expect(Object.keys(result.adaptive.horizons)).toEqual(["1", "2", "3"]);
    expect(result.adaptive.horizons[1]).toMatchObject({
      regime: "stable",
      state_count: 0,
      revision: 0,
      weights: state.weights,
    });
    expect(result.adaptive.horizons[1].candidates).toEqual({
      persistence: expect.any(Number),
      damped: expect.any(Number),
      trend: expect.any(Number),
      acceleration: expect.any(Number),
    });
    expect(result.adaptive.horizons[1].selected_level).toEqual(expect.any(Number));
    expect(result.horizons.every((horizon) => Number.isFinite(horizon.predicted_level))).toBe(true);
  });

  it("detecta subida sustentada e reversão somente por rate60, rate180 e noise", () => {
    const rising = baseForecast(5, 12);
    const turning = {
      ...rising,
      rate60: 8,
      rate180: -4,
      noise_cm: 0.4,
      horizons: rising.horizons.map((horizon) => ({ ...horizon, predicted_level: 99 })),
    };

    expect(detectRegime(rising)).toBe("rising");
    expect(detectRegime(turning)).toBe("turning");
    expect(detectRegime({ ...turning, rate60: Number.NaN, rate180: Number.NaN, noise_cm: Number.NaN })).toBe("stable");

    const adaptive = applyAdaptiveForecast(rising, { 1: initialLearningState("rising") });
    expect(adaptive.adaptive.horizons[1].regime).toBe("rising");
    expect(adaptive.adaptive.horizons[1].weights.trend).toBeGreaterThan(adaptive.adaptive.horizons[1].weights.persistence);
    expect(adaptive.horizons[0].predicted_level).toBeGreaterThan(rising.current_level as number);
  });

  it("separa tendência linear, amortecimento e aceleração v2 sem dupla aceleração", () => {
    const base = baseForecast(5, 0);
    const crafted: ForecastV2Latest = {
      ...base,
      current_level: 5,
      rate60: 8,
      rate180: 4,
      horizons: base.horizons.map((horizon) => ({
        ...horizon,
        upstream_cm: 1,
        dam_cm: 2,
        rain_observed_cm: 3,
        rain_forecast_cm: 4,
        trend_cm: horizon.hours === 1 ? 12 : horizon.hours === 2 ? 30 : 48,
      })),
    };
    const adaptive = applyAdaptiveForecast(crafted, { 1: initialLearningState("rising"), 2: initialLearningState("rising"), 3: initialLearningState("rising") });
    const oneHour = adaptive.adaptive.horizons[1].candidates;
    const twoHours = adaptive.adaptive.horizons[2].candidates;

    expect(oneHour.persistence).toBeCloseTo(5.1, 10);
    expect(oneHour.trend).toBeCloseTo(5.18, 10);
    expect(oneHour.damped).toBeCloseTo(5.152, 10);
    expect(oneHour.acceleration).toBeCloseTo(5.22, 10);
    expect(twoHours.trend).toBeCloseTo(5.26, 10);
    expect(twoHours.acceleration).toBeCloseTo(5.4, 10);
    expect(twoHours.damped).toBeCloseTo(5 + (10 + (16 * 0.65) / 1.08) / 100, 10);

    const fallback = applyAdaptiveForecast({ ...crafted, rate60: null, rate180: 5 }, { 2: initialLearningState("rising") });
    expect(fallback.adaptive.horizons[2].candidates.trend).toBeCloseTo(5.2, 10);
  });

  it("preserva band_cm/confiança, recompõe a soma e considera 6,5 m como alerta", () => {
    const base = baseForecast(6.45, 4);
    const state = initialLearningState("rising");
    const adaptive = applyAdaptiveForecast(base, { 1: state, 2: state, 3: state });

    expect(adaptive.horizons.map((horizon) => horizon.band_cm)).toEqual(base.horizons.map((horizon) => horizon.band_cm));
    expect(adaptive.horizons.map((horizon) => horizon.confidence)).toEqual(base.horizons.map((horizon) => horizon.confidence));
    expect(adaptive.horizons[0].delta_cm).toBeCloseTo((adaptive.horizons[0].predicted_level - (adaptive.current_level as number)) * 100, 10);
    expect(adaptive.horizons[0].trend_cm).toBeCloseTo(
      adaptive.horizons[0].delta_cm - base.horizons[0].upstream_cm - base.horizons[0].dam_cm - base.horizons[0].rain_observed_cm - base.horizons[0].rain_forecast_cm,
      10,
    );
    expect(adaptive.factors.reduce((sum, factor) => sum + factor.cm, 0)).toBeCloseTo(adaptive.horizons[0].delta_cm, 10);

    const critical = applyAdaptiveForecast(baseForecast(6.5, 0), { 1: initialLearningState("stable") });
    expect(critical.notes.join(" ")).toMatch(/6,5 m/);
    const atAlert = learnFromOutcome(initialLearningState("stable"), {
      candidates: candidateLevels(6.5),
      actual_level: 6.5,
      issued_level: 6.5,
      current_level: 6.5,
      issued_revision: 0,
    });
    expect(atAlert.metrics.actual_category).toBe("alert");
  });

  it("guarda NaN em forecast, estado e aprendizado sem fabricar nível", () => {
    const base = baseForecast(5, 6);
    const poisoned = {
      ...base,
      current_level: Number.NaN,
      rate60: Number.NaN,
      rate180: Number.NaN,
      noise_cm: Number.NaN,
      horizons: base.horizons.map((horizon) => ({ ...horizon, predicted_level: Number.NaN, delta_cm: Number.NaN })),
    };
    const result = applyAdaptiveForecast(poisoned, { 1: initialLearningState("stable") });
    expect(result.model_version).toBe(ADAPTIVE_MODEL_VERSION);
    expect(result.horizons.every((horizon) => Number.isNaN(horizon.predicted_level))).toBe(true);
    expect(result.adaptive.horizons[1].selected_level).toBeNull();

    const state = initialLearningState("stable");
    const learned = learnFromOutcome(state, {
      candidates: { persistence: Number.NaN, damped: Number.POSITIVE_INFINITY, trend: Number.NaN, acceleration: Number.NaN },
      actual_level: Number.NaN,
      issued_level: Number.NaN,
      current_level: Number.NaN,
    });
    expect(learned.metrics.accepted).toBe(false);
    expect(learned.state).toEqual(state);
  });

  it("mantém cold start heurístico e só propõe após 24 outcomes, com passo gradual", () => {
    const initial = initialLearningState("stable");
    expect(initial.state_count).toBe(0);
    expect(initial.revision).toBe(0);
    expect(initial.challenger).toBeNull();
    expect(initial.weights.persistence).toBeGreaterThan(initial.weights.trend);

    const candidates = { persistence: 5, damped: 5.02, trend: 5.2, acceleration: 5.25 };
    let state = initial;
    for (let index = 0; index < 23; index += 1) {
      const learned = learnFromOutcome(state, {
        candidates,
        actual_level: 5.24,
        issued_level: 5.2,
        current_level: 5,
        issued_revision: state.revision,
      });
      state = learned.state;
      expect(state.challenger).toBeNull();
    }
    expect(state.state_count).toBe(23);

    const afterHistory = learnFromOutcome(state, {
      candidates,
      actual_level: 5.24,
      issued_level: 5.2,
      current_level: 5,
      issued_revision: state.revision,
    });
    expect(afterHistory.state.state_count).toBe(24);
    expect(afterHistory.metrics.challenger_created).toBe(true);
    expect(afterHistory.state.challenger).not.toBeNull();
    expect(afterHistory.state.challenger?.base_revision).toBe(afterHistory.state.revision);
    expect(Object.values(afterHistory.state.challenger?.weights ?? {}).reduce((sum, weight) => sum + weight, 0)).toBeCloseTo(1, 10);
    expect(afterHistory.state.weights).toEqual(afterHistory.state.champion.weights);
    for (const specialist of ["persistence", "damped", "trend", "acceleration"] as const) {
      expect(Math.abs(afterHistory.state.challenger!.weights[specialist] - afterHistory.state.weights[specialist])).toBeLessThanOrEqual(0.05 + 1e-10);
    }
    const comment = applyAdaptiveForecast(baseForecast(), { 1: afterHistory.state }).adaptive.comments.join(" ");
    expect(comment).toMatch(/não é estimativa estatística/);
  });

  it("ignora outcomes emitidos antes da proposta, mas treina EWMA e promove com 12 novos", () => {
    const seeded = seedChallenger();
    expect(seeded.challenger).not.toBeNull();
    const baseRevision = seeded.challenger!.base_revision;
    expect(baseRevision).toBe(seeded.revision);

    const old = learnFromOutcome(seeded, {
      candidates: { persistence: 5, damped: 5.02, trend: 5.2, acceleration: 5.25 },
      actual_level: 5.2,
      issued_level: 5.2,
      current_level: 5,
      issued_revision: baseRevision - 1,
    });
    expect(old.metrics.challenger_promoted).toBe(false);
    expect(old.metrics.prospective_count).toBe(0);
    expect(old.state.challenger?.prospective_count).toBe(0);
    expect(old.state.errors.persistence.count).toBe(25);

    let state = old.state;
    let last = old.metrics;
    const candidates = { persistence: 5, damped: 5.02, trend: 5.2, acceleration: 5.25 };
    for (let index = 0; index < 12; index += 1) {
      const learned = learnFromOutcome(state, {
        candidates,
        actual_level: 5.2,
        issued_level: 5.2,
        current_level: 5,
        issued_revision: state.revision,
      });
      state = learned.state;
      last = learned.metrics;
    }
    expect(last.challenger_promoted).toBe(true);
    expect(state.challenger).toBeNull();
    expect(state.champion.revision).toBe(state.revision);
    expect(state.weights).not.toEqual(seeded.champion.weights);
  });

  it("faz rollback somente após 12 avaliações prospectivas piores", () => {
    let state = seedChallenger();
    expect(state.challenger).not.toBeNull();
    const candidates = { persistence: 5, damped: 6, trend: 6, acceleration: 6 };
    let last = learnFromOutcome(state, {
      candidates,
      actual_level: 5,
      issued_level: 5.24,
      current_level: 5,
      issued_revision: state.revision,
    }).metrics;
    state = learnFromOutcome(state, {
      candidates,
      actual_level: 5,
      issued_level: 5.24,
      current_level: 5,
      issued_revision: state.revision,
    }).state;
    for (let index = 1; index < 12; index += 1) {
      const learned = learnFromOutcome(state, {
        candidates,
        actual_level: 5,
        issued_level: 5.24,
        current_level: 5,
        issued_revision: state.revision,
      });
      state = learned.state;
      last = learned.metrics;
    }
    expect(last.champion_rollback).toBe(true);
    expect(state.challenger).toBeNull();
    expect(state.weights).toEqual(state.champion.weights);
  });

  it("mantém campos memoriais JSON e não altera regime por alvo futuro", () => {
    const base = baseForecast(5, 6);
    const state = initialLearningState("rising");
    const result = applyAdaptiveForecast({
      ...base,
      horizons: base.horizons.map((horizon) => ({ ...horizon, predicted_level: 99 })),
    }, { 1: state });
    const serialised = JSON.parse(JSON.stringify(result.adaptive));

    expect(serialised.horizons["1"].regime).toBe("rising");
    expect(serialised.horizons["1"].state_count).toBe(0);
    expect(serialised.horizons["1"].revision).toBe(0);
    expect(serialised.horizons["1"].candidates.persistence).toEqual(expect.any(Number));
    expect(result.adaptive.horizons[1].regime).toBe(detectRegime(base));
  });
});
