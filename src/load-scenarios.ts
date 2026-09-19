import fs from "fs";
import type { ReplaySetup } from "./setup-replay";
import {
  ScenarioBundleError,
  validateScenarioBundle,
  type ScenarioBundle
} from "./scenario-bundle";

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

export class ScenarioLoadError extends Error {
  readonly name = "ScenarioLoadError";
  constructor(
    readonly code:
      | "SCENARIO_CONFIGURATION_INVALID"
      | "EXPORT_CAPTURE_UNACCOUNTED"
      | "EXPORT_CAPTURE_DUPLICATED"
      | "EXPORT_COVERAGE_INCOMPLETE"
      | "EXPORT_ARTIFACT_CORRELATION_INVALID" =
        "SCENARIO_CONFIGURATION_INVALID",
    options?: ErrorOptions
  ) {
    super(
      "ShadowSpec scenario configuration could not be loaded or parsed.",
      options
    );
  }
}

export function loadScenarios(
  environment: NodeJS.ProcessEnv = process.env
): ScenarioBundle {
  try {
    const data = fs.readFileSync(
      "shadowspec-scenarios.json",
      "utf-8"
    );
    return validateScenarioBundle(
      JSON.parse(data),
      environment.SHADOWSPEC_PROJECT_ID
    );
  } catch (error) {
    throw new ScenarioLoadError(
      error instanceof ScenarioBundleError
        ? error.code
        : "SCENARIO_CONFIGURATION_INVALID",
      { cause: error }
    );
  }
}
