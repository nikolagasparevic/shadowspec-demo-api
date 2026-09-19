import { createHash } from "node:crypto";
import { canonicalStringify } from "./canonical";
import type { ShadowSpecScenario } from "./load-scenarios";
import { validateScenarios } from "./scenario-validation";

export const SCENARIO_BUNDLE_VERSION = 2 as const;
export const SCENARIO_BUNDLE_KIND =
  "shadowspec-scenario-bundle" as const;

export type CaptureDispositionKind =
  | "EXECUTABLE_STANDALONE"
  | "EXECUTABLE_LIFECYCLE_STEP"
  | "REJECTED_INVALID_CAPTURE"
  | "REJECTED_UNSUPPORTED"
  | "REJECTED_SANITIZATION"
  | "REJECTED_LIFECYCLE_AMBIGUOUS"
  | "EXCLUDED_SHADOWSPEC_INTERNAL"
  | "EXCLUDED_INACTIVE";

export type CaptureDisposition = {
  captureId: number;
  disposition: CaptureDispositionKind;
  reason?: string;
  method: string;
  safePath: string;
  scenarioId?: number;
  step?: number;
  checkCount: 0 | 1;
};

export type BundleInput = {
  projectId: string;
  isolation: "repeatable-read";
  maxVisibleCaptureId: number | null;
  captureCount: number;
  captureIdsSha256: string;
};

export type BundleCoverage = {
  complete: boolean;
  executableCaptures: number;
  rejectedCaptures: number;
  excludedCaptures: number;
  checkCount: number;
  dispositions: CaptureDisposition[];
};

export type ScenarioBundle = {
  version: typeof SCENARIO_BUNDLE_VERSION;
  kind: typeof SCENARIO_BUNDLE_KIND;
  exportId: string;
  input: BundleInput;
  coverage: BundleCoverage;
  scenarios: ShadowSpecScenario[];
};

export class ScenarioBundleError extends Error {
  readonly name = "ScenarioBundleError";

  constructor(
    readonly code:
      | "EXPORT_CAPTURE_UNACCOUNTED"
      | "EXPORT_CAPTURE_DUPLICATED"
      | "EXPORT_COVERAGE_INCOMPLETE"
      | "EXPORT_ARTIFACT_CORRELATION_INVALID",
    message: string
  ) {
    super(message);
  }
}

const EXECUTABLE = new Set<CaptureDispositionKind>([
  "EXECUTABLE_STANDALONE",
  "EXECUTABLE_LIFECYCLE_STEP"
]);
const DISPOSITIONS = new Set<CaptureDispositionKind>([
  "EXECUTABLE_STANDALONE",
  "EXECUTABLE_LIFECYCLE_STEP",
  "REJECTED_INVALID_CAPTURE",
  "REJECTED_UNSUPPORTED",
  "REJECTED_SANITIZATION",
  "REJECTED_LIFECYCLE_AMBIGUOUS",
  "EXCLUDED_SHADOWSPEC_INTERNAL",
  "EXCLUDED_INACTIVE"
]);
const REJECTED_PREFIX = "REJECTED_";
const EXCLUDED_PREFIX = "EXCLUDED_";

export function hashCaptureIds(ids: readonly number[]): string {
  return createHash("sha256")
    .update(canonicalStringify([...ids]))
    .digest("hex");
}

export function computeExportId(
  value: Omit<ScenarioBundle, "exportId">
): string {
  return createHash("sha256")
    .update(canonicalStringify(value))
    .digest("hex");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isJsonValue(value: unknown): boolean {
  return value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value)) ||
    (Array.isArray(value) && value.every(isJsonValue)) ||
    (isObject(value) && Object.values(value).every(isJsonValue));
}

function isScenarioRequest(value: unknown): boolean {
  if (
    !isObject(value) ||
    typeof value.method !== "string" ||
    value.method.length === 0 ||
    typeof value.path !== "string" ||
    !value.path.startsWith("/") ||
    !("body" in value) ||
    !isJsonValue(value.body)
  ) {
    return false;
  }
  return (
    value.pathParams === undefined ||
    (isObject(value.pathParams) && Object.values(value.pathParams).every(
      isJsonValue
    ))
  ) && (
    value.queryParams === undefined ||
    (isObject(value.queryParams) && Object.values(value.queryParams).every(
      (item) => typeof item === "string"
    ))
  );
}

function isScenarioExpected(value: unknown): boolean {
  return isObject(value) &&
    Number.isSafeInteger(value.status) &&
    Number(value.status) >= 100 &&
    Number(value.status) <= 599 &&
    "body" in value &&
    isJsonValue(value.body);
}

function isReplaySetup(value: unknown): boolean {
  if (!isObject(value) || !isObject(value.tables)) {
    return false;
  }
  return Object.values(value.tables).every((table) =>
    isObject(table) &&
    Array.isArray(table.rows) &&
    table.rows.every((row) => isObject(row) && isJsonValue(row))
  );
}

function scenarioSafePath(request: {
  path: string;
  pathParams?: Record<string, unknown>;
}): string | undefined {
  const parameters = request.pathParams ?? {};
  const segments = request.path.split("/");
  for (const [name, value] of Object.entries(parameters)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      return undefined;
    }
    const placeholders = segments.filter(
      (segment) => segment === `:${name}`
    ).length;
    if (placeholders > 0) {
      if (placeholders !== 1) {
        return undefined;
      }
      continue;
    }
    if (isObject(value) && value.$ref !== undefined) {
      return undefined;
    }
    if (typeof value !== "string") {
      return undefined;
    }
    const matches: number[] = [];
    for (let index = 0; index < segments.length; index++) {
      try {
        if (decodeURIComponent(segments[index]) === value) matches.push(index);
      } catch {
        return undefined;
      }
    }
    if (matches.length !== 1) return undefined;
    segments[matches[0]] = `:${name}`;
  }
  return segments.join("/");
}

function fail(
  code: ScenarioBundleError["code"],
  message: string
): never {
  throw new ScenarioBundleError(code, message);
}

export function validateScenarioBundle(
  value: unknown,
  expectedProjectId?: string
): ScenarioBundle {
  if (!isObject(value) || Array.isArray(value)) {
    fail(
      "EXPORT_ARTIFACT_CORRELATION_INVALID",
      "ShadowSpec requires a version-2 scenario bundle."
    );
  }
  const bundle = value as unknown as ScenarioBundle;
  if (
    bundle.version !== SCENARIO_BUNDLE_VERSION ||
    bundle.kind !== SCENARIO_BUNDLE_KIND ||
    typeof bundle.exportId !== "string" ||
    !/^[0-9a-f]{64}$/.test(bundle.exportId) ||
    !isObject(bundle.input) ||
    !isObject(bundle.coverage) ||
    !Array.isArray(bundle.scenarios)
  ) {
    fail(
      "EXPORT_ARTIFACT_CORRELATION_INVALID",
      "ShadowSpec scenario bundle schema is invalid."
    );
  }
  const input = bundle.input;
  const coverage = bundle.coverage;
  if (
    typeof input.projectId !== "string" ||
    input.projectId.length === 0 ||
    input.isolation !== "repeatable-read" ||
    (input.maxVisibleCaptureId !== null &&
      (!Number.isSafeInteger(input.maxVisibleCaptureId) || input.maxVisibleCaptureId < 1)) ||
    !Number.isSafeInteger(input.captureCount) || input.captureCount < 0 ||
    typeof input.captureIdsSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(input.captureIdsSha256) ||
    typeof coverage.complete !== "boolean" ||
    !Number.isSafeInteger(coverage.executableCaptures) || coverage.executableCaptures < 0 ||
    !Number.isSafeInteger(coverage.rejectedCaptures) || coverage.rejectedCaptures < 0 ||
    !Number.isSafeInteger(coverage.excludedCaptures) || coverage.excludedCaptures < 0 ||
    !Number.isSafeInteger(coverage.checkCount) || coverage.checkCount < 0 ||
    !Array.isArray(coverage.dispositions)
  ) {
    fail(
      "EXPORT_ARTIFACT_CORRELATION_INVALID",
      "ShadowSpec scenario bundle accounting schema is invalid."
    );
  }
  if (expectedProjectId !== undefined && input.projectId !== expectedProjectId) {
    fail(
      "EXPORT_ARTIFACT_CORRELATION_INVALID",
      "ShadowSpec scenario bundle belongs to a different project."
    );
  }

  const dispositionIds = new Set<number>();
  const locations = new Set<string>();
  let executable = 0;
  let rejected = 0;
  let excluded = 0;
  for (const disposition of coverage.dispositions) {
    if (
      !isObject(disposition) ||
      !Number.isSafeInteger(disposition.captureId) || disposition.captureId < 1 ||
      typeof disposition.disposition !== "string" ||
      !DISPOSITIONS.has(disposition.disposition as CaptureDispositionKind) ||
      typeof disposition.method !== "string" ||
      disposition.method.length === 0 ||
      typeof disposition.safePath !== "string" ||
      disposition.safePath.length === 0 ||
      (disposition.checkCount !== 0 && disposition.checkCount !== 1)
    ) {
      fail("EXPORT_ARTIFACT_CORRELATION_INVALID", "ShadowSpec capture disposition is invalid.");
    }
    if (dispositionIds.has(disposition.captureId)) {
      fail("EXPORT_CAPTURE_DUPLICATED", "A capture has more than one terminal disposition.");
    }
    dispositionIds.add(disposition.captureId);
    if (EXECUTABLE.has(disposition.disposition as CaptureDispositionKind)) {
      executable++;
      if (
        disposition.checkCount !== 1 ||
        !Number.isSafeInteger(disposition.scenarioId) ||
        Number(disposition.scenarioId) < 1
      ) {
        fail("EXPORT_ARTIFACT_CORRELATION_INVALID", "Executable capture mapping is invalid.");
      }
      const location = disposition.disposition === "EXECUTABLE_STANDALONE"
        ? `${disposition.scenarioId}:standalone`
        : `${disposition.scenarioId}:step:${disposition.step}`;
      if (
        disposition.disposition === "EXECUTABLE_LIFECYCLE_STEP" &&
        (!Number.isSafeInteger(disposition.step) || Number(disposition.step) < 1)
      ) {
        fail("EXPORT_ARTIFACT_CORRELATION_INVALID", "Lifecycle capture mapping is invalid.");
      }
      if (locations.has(location)) {
        fail("EXPORT_CAPTURE_DUPLICATED", "An executable check location maps to multiple captures.");
      }
      locations.add(location);
    } else if (disposition.disposition.startsWith(REJECTED_PREFIX)) {
      rejected++;
      if (
        disposition.checkCount !== 0 ||
        typeof disposition.reason !== "string" ||
        disposition.reason.length === 0 ||
        disposition.scenarioId !== undefined ||
        disposition.step !== undefined
      ) {
        fail("EXPORT_ARTIFACT_CORRELATION_INVALID", "Rejected capture disposition is invalid.");
      }
    } else if (disposition.disposition.startsWith(EXCLUDED_PREFIX)) {
      excluded++;
      if (
        disposition.checkCount !== 0 ||
        disposition.scenarioId !== undefined ||
        disposition.step !== undefined
      ) {
        fail("EXPORT_ARTIFACT_CORRELATION_INVALID", "Excluded capture disposition is invalid.");
      }
    } else {
      fail("EXPORT_ARTIFACT_CORRELATION_INVALID", "Capture disposition is unsupported.");
    }
  }

  const ids = [...dispositionIds].sort((a, b) => a - b);
  if (
    (ids.length === 0 && input.maxVisibleCaptureId !== null) ||
    (ids.length > 0 && (
      input.maxVisibleCaptureId === null ||
      Number(input.maxVisibleCaptureId) !== ids[ids.length - 1]
    ))
  ) {
    fail("EXPORT_CAPTURE_UNACCOUNTED", "ShadowSpec capture watermark does not cover its input identities.");
  }
  const expectedLocations = new Map<
    string,
    { method: string; safePath: string | undefined }
  >();
  const scenarioIds = new Set<number>();
  for (const scenario of bundle.scenarios) {
    if (!Number.isSafeInteger(scenario.id) || scenario.id < 1 || scenarioIds.has(scenario.id)) {
      fail("EXPORT_ARTIFACT_CORRELATION_INVALID", "Scenario identity is invalid or duplicated.");
    }
    scenarioIds.add(scenario.id);
    if (scenario.setup !== undefined && !isReplaySetup(scenario.setup)) {
      fail("EXPORT_ARTIFACT_CORRELATION_INVALID", "Scenario replay setup is invalid.");
    }
    if (scenario.steps !== undefined) {
      if (!Array.isArray(scenario.steps) || scenario.steps.length === 0) {
        fail("EXPORT_ARTIFACT_CORRELATION_INVALID", "Lifecycle scenario must contain steps.");
      }
      scenario.steps.forEach((step, index) => {
        if (!isScenarioRequest(step?.request) || !isScenarioExpected(step?.expected)) {
          fail("EXPORT_ARTIFACT_CORRELATION_INVALID", "Lifecycle scenario step schema is invalid.");
        }
        expectedLocations.set(`${scenario.id}:step:${index + 1}`, {
          method: step.request.method,
          safePath: scenarioSafePath(step.request)
        });
      });
    } else {
      if (!isScenarioRequest(scenario.request) || !isScenarioExpected(scenario.expected)) {
        fail("EXPORT_ARTIFACT_CORRELATION_INVALID", "Standalone scenario schema is invalid.");
      }
      expectedLocations.set(`${scenario.id}:standalone`, {
        method: scenario.request.method,
        safePath: scenarioSafePath(scenario.request)
      });
    }
  }
  for (const disposition of coverage.dispositions) {
    if (!EXECUTABLE.has(disposition.disposition)) continue;
    const location = disposition.disposition === "EXECUTABLE_STANDALONE"
      ? `${disposition.scenarioId}:standalone`
      : `${disposition.scenarioId}:step:${disposition.step}`;
    const request = expectedLocations.get(location);
    if (
      !request ||
      request.method !== disposition.method ||
      request.safePath === undefined ||
      request.safePath !== disposition.safePath
    ) {
      fail("EXPORT_ARTIFACT_CORRELATION_INVALID", "Executable capture mapping does not match its scenario request.");
    }
  }
  if (
    input.captureCount !== dispositionIds.size ||
    input.captureCount !== executable + rejected + excluded ||
    input.captureIdsSha256 !== hashCaptureIds(ids)
  ) {
    fail("EXPORT_CAPTURE_UNACCOUNTED", "ShadowSpec capture accounting does not reconcile.");
  }
  if (
    coverage.executableCaptures !== executable ||
    coverage.rejectedCaptures !== rejected ||
    coverage.excludedCaptures !== excluded ||
    coverage.checkCount !== executable ||
    expectedLocations.size !== executable ||
    expectedLocations.size !== locations.size ||
    [...expectedLocations.keys()].some((location) => !locations.has(location))
  ) {
    fail("EXPORT_CAPTURE_UNACCOUNTED", "ShadowSpec executable mapping does not reconcile.");
  }
  if (
    coverage.complete !== (rejected === 0) ||
    !coverage.complete ||
    rejected !== 0
  ) {
    fail("EXPORT_COVERAGE_INCOMPLETE", "ShadowSpec scenario coverage is incomplete.");
  }
  validateScenarios(bundle.scenarios);
  const { exportId: _ignored, ...semantic } = bundle;
  if (computeExportId(semantic) !== bundle.exportId) {
    fail("EXPORT_ARTIFACT_CORRELATION_INVALID", "ShadowSpec scenario bundle content hash is invalid.");
  }
  return bundle;
}

export function createScenarioBundle(
  input: BundleInput,
  coverage: BundleCoverage,
  scenarios: ShadowSpecScenario[]
): ScenarioBundle {
  const semantic = {
    version: SCENARIO_BUNDLE_VERSION,
    kind: SCENARIO_BUNDLE_KIND,
    input,
    coverage,
    scenarios
  } as const;
  return validateScenarioBundle({
    ...semantic,
    exportId: computeExportId(semantic)
  });
}
