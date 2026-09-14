import fs from "fs";

export type ShadowSpecScenario = {
  id: number;
  method: string;
  path: string;
  requestBody: unknown;
  expectedStatus: number;
  expectedBody: unknown;
};

export function loadScenarios(): ShadowSpecScenario[] {
  const data = fs.readFileSync(
    "shadowspec-scenarios.json",
    "utf-8"
  );

  return JSON.parse(data);
}