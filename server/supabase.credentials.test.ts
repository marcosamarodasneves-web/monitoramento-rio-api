import { describe, expect, it } from "vitest";

describe("Supabase credentials", () => {
  it("can reach the PostgREST endpoint with the configured server key", async () => {
    const baseUrl = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_KEY;
    expect(baseUrl).toBeTruthy();
    expect(key).toBeTruthy();

    const response = await fetch(`${baseUrl}/rest/v1/`, {
      headers: {
        apikey: key!,
        Authorization: `Bearer ${key!}`,
      },
    });

    expect(response.status).toBeLessThan(500);
    expect(response.status).not.toBe(401);
    expect(response.status).not.toBe(403);
  }, 15_000);
});
