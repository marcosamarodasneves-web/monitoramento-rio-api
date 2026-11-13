import { describe, expect, it } from "vitest";
import { computeForecastV2, type ForecastV2Dam, type ForecastV2Sample } from "./forecast-model-v2";

const START = Date.parse("2026-11-12T20:00:00.000Z");
const BRIDGE = { id: "dom-tito", station_id: "station-dom-tito" };

function samplesFrom(values: number[], stepMinutes = 5, start = START): ForecastV2Sample[] {
  return values.map((level, index) => ({
    measured_at: new Date(start + index * stepMinutes * 60_000).toISOString(),
    level_m: level,
  }));
}

function linearSamples(level = 5, slopeCmH = 6, count = 25, stepMinutes = 5, start = START): ForecastV2Sample[] {
  return samplesFrom(valuesForSlope(level, slopeCmH, count, stepMinutes), stepMinutes, start);
}

function valuesForSlope(level: number, slopeCmH: number, count: number, stepMinutes: number): number[] {
  return Array.from({ length: count }, (_, index) => level + (slopeCmH / 100) * (index * stepMinutes) / 60);
}

function baseInput(samples: ForecastV2Sample[], now = START + (samples.length - 1) * 5 * 60_000) {
  return { bridge: BRIDGE, samples, now };
}

function damSamples(gates: number[], start = START, stepMinutes = 5): ForecastV2Dam["samples"] {
  return gates.map((gatesOpen, index) => ({
    measured_at: new Date(start + index * stepMinutes * 60_000).toISOString(),
    level_m: 3.2,
    occupancy_percent: 60,
    gates_open: gatesOpen,
    gates_total: 4,
  }));
}

describe("computeForecastV2", () => {
  it("retorna a forma latest, é estável e gera os três horizontes", () => {
    const input = baseInput(linearSamples(5, 6));
    const first = computeForecastV2(input);
    const second = computeForecastV2(input);

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      bridge: "dom-tito",
      available: true,
      model_version: "deterministic-v2",
      current_level: 5.12,
      rate60: expect.any(Number),
      rate180: expect.any(Number),
      noise_cm: expect.any(Number),
      samples_used: 13,
      window_minutes: 60,
      confidenceLabel: "experimental",
      rain_probability: null,
    });
    expect(first.horizons.map((horizon) => horizon.hours)).toEqual([1, 2, 3]);
    expect(first.horizons.every((horizon) => Number.isFinite(horizon.predicted_level))).toBe(true);
    expect(first.factors.map((factor) => factor.key)).toEqual(["tendencia", "montante", "barragens", "chuva_obs", "chuva_prev"]);
    expect(first.horizons[0].delta_cm).toBeCloseTo(first.factors.reduce((sum, factor) => sum + factor.cm, 0), 10);
  });

  it("sanitiza nulos, NaN, duplicatas e leituras futuras sem lookahead", () => {
    const valid = linearSamples(5, 6);
    const now = START + 24 * 5 * 60_000;
    const noisy: ForecastV2Sample[] = [
      ...valid,
      { measured_at: valid[10].measured_at, level_m: 99 },
      { measured_at: valid[10].measured_at, level_m: null },
      { measured_at: valid[11].measured_at, level_m: Number.NaN },
      { measured_at: new Date(now + 60_000).toISOString(), level_m: 99 },
      { measured_at: "not-a-date", level_m: 12 },
    ];
    const result = computeForecastV2(baseInput(noisy, now));
    const baseline = computeForecastV2(baseInput(valid, now));

    expect(result.available).toBe(true);
    expect(result.current_level).toBe(baseline.current_level);
    expect(result.base_time).toBe(baseline.base_time);
    expect(result.horizons).toEqual(baseline.horizons);
    expect(result.samples_used).toBe(13);
  });

  it("remove somente spike isolado e preserva subida e queda fortes sem teto de 12 cm/h", () => {
    const rising = computeForecastV2(baseInput(linearSamples(4, 60, 25)));
    const falling = computeForecastV2(baseInput(linearSamples(8, -60, 25)));

    expect(rising.available).toBe(true);
    expect(falling.available).toBe(true);
    expect(rising.rate60).toBeGreaterThan(12);
    expect(falling.rate60).toBeLessThan(-12);
    expect(rising.horizons[0].trend_cm).toBeGreaterThan(12);
    expect(falling.horizons[0].trend_cm).toBeLessThan(-12);

    const withSpike = linearSamples(5, 6);
    withSpike[7] = { ...withSpike[7], level_m: Number(withSpike[7].level_m) + 0.3 };
    const smoothed = computeForecastV2(baseInput(withSpike));
    const clean = computeForecastV2(baseInput(linearSamples(5, 6)));
    expect(smoothed.rate60).toBeCloseTo(clean.rate60 as number, 2);
  });

  it("limita aceleração de forma simétrica, sem descartar reversão", () => {
    const values = Array.from({ length: 37 }, (_, index) => {
      const hours = (index * 5) / 60;
      if (hours <= 2) return 5;
      return 5 + ((hours - 2) * 30) / 100;
    });
    const accelerating = computeForecastV2(baseInput(samplesFrom(values)));
    const reversed = computeForecastV2(baseInput(samplesFrom(values.map((value, index) => 6.2 - (value - 5) + (index > 24 ? 0.02 : 0)))));
    const acceleratingDown = computeForecastV2(baseInput(samplesFrom(values.map((value, index) => 6 - (value - 5)))));

    expect(accelerating.available).toBe(true);
    expect(accelerating.horizons[1].trend_cm - 2 * accelerating.horizons[0].trend_cm).toBeGreaterThanOrEqual(-4.01);
    expect(accelerating.horizons[1].trend_cm - 2 * accelerating.horizons[0].trend_cm).toBeLessThanOrEqual(4.01);
    expect(reversed.available).toBe(true);
    expect(reversed.horizons[0].trend_cm).not.toBe(0);
    expect(acceleratingDown.available).toBe(true);
    expect(accelerating.horizons[1].trend_cm - 2 * accelerating.horizons[0].trend_cm).toBeGreaterThan(0);
    expect(acceleratingDown.horizons[1].trend_cm - 2 * acceleratingDown.horizons[0].trend_cm).toBeLessThan(0);
  });

  it("usa o último segmento contínuo e descarta lacuna antiga sem atravessá-la", () => {
    const fresh = linearSamples(5, 6);
    const staleNow = START + 25 * 5 * 60_000 + 31 * 60_000;
    const stale = computeForecastV2(baseInput(fresh, staleNow));
    const shortSamples = fresh.slice(-3);
    const short = computeForecastV2(baseInput(shortSamples, Date.parse(shortSamples.at(-1)?.measured_at ?? "")));
    const recent = linearSamples(5, 6, 10, 5, START + 2 * 60 * 60_000);
    const gap = [...fresh.slice(0, 2), ...recent];
    const gapNow = Date.parse(gap.at(-1)?.measured_at ?? "");

    expect(stale.available).toBe(false);
    expect(stale.unavailable_reason).toMatch(/30 minutos/i);
    expect(short.available).toBe(false);
    expect(short.unavailable_reason).toMatch(/curta/i);
    const gapResult = computeForecastV2(baseInput(gap, gapNow));
    expect(gapResult.available).toBe(true);
    expect(gapResult.notes.join(" ")).toMatch(/Lacuna antiga descartada/i);

    const tooShortRecent = [...fresh.slice(0, 2), ...recent.slice(-3)];
    const tooShortResult = computeForecastV2(baseInput(tooShortRecent, Date.parse(tooShortRecent.at(-1)?.measured_at ?? "")));
    expect(tooShortResult.available).toBe(false);
    expect(tooShortResult.unavailable_reason).toMatch(/curta/i);
  });

  it("mantém null distinto de zero na chuva e não converte mm sem calibração", () => {
    const result = computeForecastV2({
      ...baseInput(linearSamples(5, 6)),
      rain: { observed1hMm: 10, observed24hMm: null, next1hMm: 4, next2hMm: null, next3hMm: 0, stations: 2 },
    });

    expect(result.available).toBe(true);
    expect(result.rain_basin_1h_mm).toBe(10);
    expect(result.rain_basin_24h_mm).toBeNull();
    expect(result.rain_next_hour_mm).toBe(4);
    expect(result.rain_next_2h_mm).toBeNull();
    expect(result.rain_next_3h_mm).toBe(0);
    expect(result.horizons.every((horizon) => horizon.rain_observed_cm === 0 && horizon.rain_forecast_cm === 0)).toBe(true);
    expect(result.notes.join(" ")).toMatch(/mm.*cm|chuva.*calibra/i);

    const missingLag = computeForecastV2({
      ...baseInput(linearSamples(5, 6)),
      rain: { next1hMm: 2, next2hMm: 5, next3hMm: 9 },
      calibration: { rainForecastCmPerMm: 0.02 },
    });
    expect(missingLag.horizons.every((horizon) => horizon.rain_forecast_cm === 0)).toBe(true);
    expect(missingLag.rain_forecast_summary).toMatch(/rainLagHours.*explícito válido ausente/i);
  });

  it("aplica unidade mm→cm somente com coeficientes explícitos e conserva a soma dos fatores", () => {
    const result = computeForecastV2({
      ...baseInput(linearSamples(5, 6)),
      rain: { observed1hMm: 10, observed24hMm: 12, next1hMm: 2, next2hMm: 5, next3hMm: 9 },
      calibration: { rainObservedCmPerMm: 0.01, rainForecastCmPerMm: 0.02, rainLagHours: 0 },
    });
    const horizon = result.horizons[0];

    expect(horizon.rain_observed_cm).toBeCloseTo(0.1, 10);
    expect(horizon.rain_forecast_cm).toBeCloseTo(0.04, 10);
    expect(result.horizons[1].rain_forecast_cm).toBeCloseTo(0.1, 10);
    expect(result.horizons[2].rain_forecast_cm).toBeCloseTo(0.18, 10);
    expect(horizon.delta_cm).toBeCloseTo(result.factors.reduce((sum, factor) => sum + factor.cm, 0), 10);
    expect(result.rain_observed_summary).toMatch(/0.01 cm\/mm/);
    expect(result.rain_forecast_summary).toMatch(/0.02 cm\/mm/);
  });

  it("não aplica efeito de comportas sem coeficiente e atraso, mas aplica apenas o efeito explicitamente configurado", () => {
    const baseDam: ForecastV2Dam = { id: "dam-a", name: "Barragem A", samples: damSamples([1, 3, 3], START + 2 * 60 * 60_000) };
    const noCalibration = computeForecastV2({ ...baseInput(linearSamples(5, 6)), dams: [baseDam] });
    const configured = computeForecastV2({
      ...baseInput(linearSamples(5, 6)),
      dams: [{ ...baseDam, lagHours: 0, gateCmPerChange: 2 }],
      now: START + 2 * 60 * 60_000 + 10 * 60_000,
    });

    expect(noCalibration.horizons.every((horizon) => horizon.dam_cm === 0)).toBe(true);
    expect(configured.horizons[0].dam_cm).toBe(4);
    expect(configured.factors.find((factor) => factor.key === "barragens")?.cm).toBe(4);
    expect(noCalibration.dam_summary).toMatch(/pendente|coeficiente/i);
  });

  it("ignora comportas identificadas fora da bacia e respeita atraso", () => {
    const dam: ForecastV2Dam = {
      id: "dam-outside-basin",
      name: "Barragem outra bacia",
      samples: damSamples([1, 3]),
      lagHours: 3,
      gateCmPerChange: 2,
    };
    const result = computeForecastV2({ ...baseInput(linearSamples(5, 6)), dams: [dam] });

    expect(result.horizons.every((horizon) => horizon.dam_cm === 0)).toBe(true);
    expect(result.dam_summary).toMatch(/fora da bacia/i);

    const delayed: ForecastV2Dam = { ...dam, name: "Barragem A", id: "dam-a" };
    const delayedResult = computeForecastV2({ ...baseInput(linearSamples(5, 6)), dams: [delayed] });
    expect(delayedResult.horizons[0].dam_cm).toBe(0);
    expect(delayedResult.horizons[1].dam_cm).toBe(4);
    expect(delayedResult.horizons[2].dam_cm).toBe(4);
  });

  it("não reaplica eventos antigos e soma todos os eventos ainda não chegados", () => {
    const eventStart = START + 2 * 60 * 60_000;
    const dam: ForecastV2Dam = {
      id: "dam-a",
      name: "Barragem A",
      samples: damSamples([1, 3, 2, 4], eventStart),
      lagHours: 0,
      gateCmPerChange: 2,
    };
    const first = computeForecastV2({
      ...baseInput(linearSamples(5, 6)),
      dams: [dam],
      now: eventStart + 10 * 60_000,
    });
    expect(first.horizons[0].dam_cm).toBe(2);

    const nextCycle = computeForecastV2({
      ...baseInput(linearSamples(5, 6, 29)),
      dams: [dam],
      now: START + 2 * 60 * 60_000,
    });
    expect(nextCycle.horizons.every((horizon) => horizon.dam_cm === 0)).toBe(true);
  });

  it("exige lag explícito para peso montante e rejeita nível de ponte negativo", () => {
    const noLag = computeForecastV2({
      ...baseInput(linearSamples(5, 6)),
      upstream: [{ id: "kanitz", name: "Kanitz", samples: linearSamples(3, 20), weight: 0.2 }],
    });
    expect(noLag.horizons.every((horizon) => horizon.upstream_cm === 0)).toBe(true);
    expect(noLag.notes.join(" ")).toMatch(/sem lagHours explícito válido/i);

    const negative = computeForecastV2({
      ...baseInput([{ measured_at: new Date(START).toISOString(), level_m: -1 }]),
    });
    expect(negative.available).toBe(false);
    expect(negative.current_level).toBeNull();
  });

  it("usa BR470/Kanitz apenas como tendência contextual e aplica peso limitado quando configurado", () => {
    const upstreamSamples = linearSamples(3, 20);
    const contextual = computeForecastV2({
      ...baseInput(linearSamples(5, 6)),
      upstream: [
        { id: "br-470", name: "BR470", samples: upstreamSamples },
        { id: "kanitz", name: "Kanitz", samples: upstreamSamples, weight: 0.8, lagHours: 0 },
      ],
    });
    const weighted = contextual.horizons[0].upstream_cm;

    expect(contextual.upstream_summary).toMatch(/não representa vazão/i);
    expect(weighted).toBeGreaterThan(0);
    expect(weighted).toBeLessThanOrEqual(7);
    expect(contextual.notes.join(" ")).toMatch(/peso.*pendente/i);
  });

  it("marca a travessia do limiar oficial de emergência acima de 6,5 m", () => {
    const result = computeForecastV2(baseInput(linearSamples(6.2, 30)));

    expect(result.available).toBe(true);
    expect(result.horizons.some((horizon) => horizon.predicted_level > 6.5)).toBe(true);
    expect(result.notes.join(" ")).toMatch(/6,5 m.*emergência/i);
  });
});
