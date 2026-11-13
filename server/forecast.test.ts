import { describe, expect, it } from "vitest";
import { classifyForecast, computeForecast } from "./forecast";

function samples() {
  return Array.from({ length: 13 }, (_, i) => ({
    measured_at: new Date(Date.parse("2026-11-12T20:00:00.000Z") + i * 5 * 60_000).toISOString(),
    level_m: 5 + i * 0.01,
  }));
}

describe("previsão centralizada", () => {
  it("gera os horizontes de uma, duas e três horas", () => {
    const result = computeForecast({ id: "dom-tito", station_id: "station" }, samples(), [], Date.parse("2026-11-12T21:00:00.000Z"));
    expect(result).toHaveLength(3);
    expect(result.map((row) => row.horizon_h)).toEqual([1, 2, 3]);
    expect(result[0].predicted_level).toBeGreaterThan(5.05);
  });

  it("confere usando exatamente a margem emitida", () => {
    const result = computeForecast({ id: "br-470", station_id: "station" }, samples(), [], Date.parse("2026-11-12T21:00:00.000Z"));
    expect(result.every((row) => row.tolerance_cm === row.band_cm && row.band_cm > 0)).toBe(true);
  });

  it("classifica o erro conforme a margem", () => {
    expect(classifyForecast(4.9, 5)).toBe("dentro");
    expect(classifyForecast(8, 5)).toBe("quase");
    expect(classifyForecast(11, 5)).toBe("fora");
    expect(classifyForecast(4, 3)).toBe("quase");
    expect(classifyForecast(NaN, 3)).toBe("sem_medicao");
  });

  it("não prevê sem leituras suficientes para a tendência", () => {
    expect(computeForecast({ id: "ricardo-kanitz", station_id: "station" }, samples().slice(0, 2), [], Date.now())).toEqual([]);
  });
});
