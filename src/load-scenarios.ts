import fs from "fs";
import type { ReplaySetup } from "./setup-replay";

export type ShadowSpecRequest = {
  method: string;
  path: string;
  body: unknown;
  pathParams?: Record<
    string,
    string | BindingReference
  >;
  queryParams?: Record<string, string>;
};

export type BindingReference = {
  $ref: string;
};

export type CapturePrimitiveType =
  | "string"
  | "number"
  | "boolean";

export type IgnoredValueDefinition = {
  pointer: string;
  type: CapturePrimitiveType;
};

export type ShadowSpecComparison = {
  ignoredValues?: IgnoredValueDefinition[];
};

export type CaptureDefinition = {
  from: "response.body";
  pointer: string;
  type: CapturePrimitiveType;
};

export type ShadowSpecExpected = {
  status: number;
  body: unknown;
};

export type ShadowSpecStep = {
  request: ShadowSpecRequest;
  expected: ShadowSpecExpected;
  dynamicFields?: string[];
  comparison?: ShadowSpecComparison;
  capture?: Record<
    string,
    CaptureDefinition
  >;
};

export type ShadowSpecScenario = {
  id: number;

  request: ShadowSpecRequest;

  expected: ShadowSpecExpected;

  dynamicFields?: string[];

  comparison?: ShadowSpecComparison;

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
