import fs from "fs";
import type { ReplaySetup } from "./setup-replay";

export type ShadowSpecScenario = {
  id: number;

  request: {
    method: string;
    path: string;
    body: unknown;
    pathParams?: Record<string, string>;
    queryParams?: Record<string, string>;
  };

  expected: {
    status: number;
    body: unknown;
  };

  dynamicFields?: string[];

  setup?: ReplaySetup;
};

export function loadScenarios(): ShadowSpecScenario[] {
  const data = fs.readFileSync(
    "shadowspec-scenarios.json",
    "utf-8"
  );

  return JSON.parse(data);
}