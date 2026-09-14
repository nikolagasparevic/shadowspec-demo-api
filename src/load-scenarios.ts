import fs from "fs";

export type ShadowSpecScenario = {
  id: number;

  request: {
    method: string;
    path: string;
    body: unknown;
  };

  expected: {
    status: number;
    body: unknown;
  };
};

export function loadScenarios(): ShadowSpecScenario[] {
  const data = fs.readFileSync(
    "shadowspec-scenarios.json",
    "utf-8"
  );

  return JSON.parse(data);
}