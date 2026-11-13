import { describe, expect, it } from "vitest";
import { BRIDGE_STATION_ALIASES, COLLECTION_INTERVAL_MINUTES, isCollectionDue, riverStatus, stationForBridge } from "./hydrology";

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
    expect(riverStatus(6.5)).toBe("Alerta");
  });
  it("classifica acima de 6,50 m como Emergência", () => {
    expect(riverStatus(6.501)).toBe("Emergência");
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

describe("identificação das estações da Defesa Civil", () => {
  const bridge = (id: string, name: string, river_name: string, station_id: string) => ({
    id,
    name,
    river_name,
    reference_text: null,
    station_id,
  });

  it("reconhece os IDs atuais publicados para Dom Tito e Hannelore/Ricardo", () => {
    expect(BRIDGE_STATION_ALIASES["dom-tito"].ids[0]).toBe("d2f60af1-53e3-497f-81d6-c6498d28f5a2");
    expect(BRIDGE_STATION_ALIASES["ricardo-kanitz"].ids[0]).toBe("039a5d4f-f58d-4fca-bef6-5d37e132a6f0");
  });

  it("encontra as estações atuais mesmo quando o cadastro do banco tem o ID antigo", () => {
    const stations = [
      { station_id: "d2f60af1-53e3-497f-81d6-c6498d28f5a2", name: "Ponte Dom Tito Buss", river_name: "Rio Itajaí-Açu", level_m: 5.86 },
      { station_id: "039a5d4f-f58d-4fca-bef6-5d37e132a6f0", name: "Ponte Hannelore Hartmann Eyng", river_name: "Rio Itajaí do Sul", level_m: 6.26 },
      { station_id: "3167e629-3bbe-48f2-9244-c65dfe6882d8", name: "Ponte BR 470", river_name: "Rio Itajaí do Oeste", level_m: 5.70 },
    ];

    expect(stationForBridge(stations, bridge("dom-tito", "Ponte Dom Tito Buss", "Rio Itajaí-Açu", "f6360951-219f-4859-935f-b2e2d13962f1"))?.station_id).toBe("d2f60af1-53e3-497f-81d6-c6498d28f5a2");
    expect(stationForBridge(stations, bridge("ricardo-kanitz", "Ponte Hannelore H. Eyng", "Rio Itajaí do Sul", "30475400-b7ba-4551-9646-19df0c3bfa38"))?.station_id).toBe("039a5d4f-f58d-4fca-bef6-5d37e132a6f0");
    expect(stationForBridge(stations, bridge("br-470", "Ponte BR-470", "Rio Itajaí do Oeste", "3167e629-3bbe-48f2-9244-c65dfe6882d8"))?.station_id).toBe("3167e629-3bbe-48f2-9244-c65dfe6882d8");
  });
});
