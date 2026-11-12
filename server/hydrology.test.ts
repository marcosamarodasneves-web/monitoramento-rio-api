import { describe, expect, it } from "vitest";
import { COLLECTION_INTERVAL_MINUTES, isCollectionDue, riverStatus } from "./hydrology";

describe("faixas oficiais de criticidade", () => {
  it("classifica abaixo de 4,50 m como Normalidade", () => {
    expect(riverStatus(4.49)).toBe("Normalidade");
  });
  it("classifica de 4,50 m até antes de 5,50 m como Atenção", () => {
    expect(riverStatus(4.5)).toBe("Atenção");
    expect(riverStatus(5.49)).toBe("Atenção");
  });
  it("classifica de 5,50 m até antes de 6,50 m como Alerta", () => {
    expect(riverStatus(5.5)).toBe("Alerta");
    expect(riverStatus(6.49)).toBe("Alerta");
  });
  it("classifica 6,50 m ou mais como Emergência", () => {
    expect(riverStatus(6.5)).toBe("Emergência");
  });
});

describe("intervalo do coletor", () => {
  const now = Date.parse("2026-11-12T19:00:00.000Z");

  it("usa cinco minutos como intervalo fixo", () => {
    expect(COLLECTION_INTERVAL_MINUTES).toBe(5);
  });

  it("considera um alvo vencido aos cinco minutos", () => {
    const collectedAt = new Date(now - 5 * 60 * 1000).toISOString();
    expect(isCollectionDue(collectedAt, now)).toBe(true);
  });

  it("não repete um alvo antes de completar cinco minutos", () => {
    const collectedAt = new Date(now - (5 * 60 * 1000 - 1)).toISOString();
    expect(isCollectionDue(collectedAt, now)).toBe(false);
  });

  it("coleta imediatamente um alvo sem leitura anterior", () => {
    expect(isCollectionDue(null, now)).toBe(true);
  });
});
