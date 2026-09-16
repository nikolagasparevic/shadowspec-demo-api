import fs from "fs";
import type { ReplaySetup } from "./setup-replay";

export type ShadowSpecRequest = {
  method: string;
  path: string;
  body: unknown;
  pathParams?: Record<string, string>;
  queryParams?: Record<string, string>;
};

export type ShadowSpecExpected = {
  status: number;
  body: unknown;
};

export type ShadowSpecStep = {
  request: ShadowSpecRequest;
  expected: ShadowSpecExpected;
  dynamicFields?: string[];
};

export type ShadowSpecScenario = {
  id: number;

  request: ShadowSpecRequest;

  expected: ShadowSpecExpected;

  dynamicFields?: string[];

  setup?: ReplaySetup;

  steps?: ShadowSpecStep[];
};

export function loadScenarios(): ShadowSpecScenario[] {
  const data = fs.readFileSync(
    "shadowspec-scenarios.json",
    "utf-8"
  );

  return JSON.parse(data);
}