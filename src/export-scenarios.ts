import fs from "fs";
import {
  createHash,
  randomUUID
} from "node:crypto";
import path from "node:path";
import { canonicalStringify } from "./canonical";
import type { DatabaseSnapshot } from "./db-snapshot";
import {
  getScenarioGroups,
  buildScenarioSequences
} from "./scenario";
import { sanitizeObject } from "./sanitize";
import {
  detectDynamicCandidates,
  type DynamicCandidate
} from "./dynamic-fields";
import {
  hasValidSnapshot,
  isStateDerivedField
} from "./state-derived";
import {
  escapeJsonPointerToken,
  getJsonPointerTokens
} from "./json-pointer";
import type {
  CapturedRequest,
  ScenarioGroup,
  ScenarioResponse,
  ScenarioSequence
} from "./scenario-types";
import type { ShadowSpecScenario } from "./load-scenarios";
import { REPLAY_TARGET_ENDPOINT } from "./replay-target-protocol";
import {
  loadFrozenCaptureSet,
  type FrozenCaptureSet,
  type PersistedCapture
} from "./export-captures";
import {
  createScenarioBundle,
  hashCaptureIds,
  type BundleCoverage,
  type BundleInput,
  type CaptureDisposition,
  type ScenarioBundle
} from "./scenario-bundle";
import { validateScenarios } from "./scenario-validation";
import {
  inferLifecycleBindings,
  type InferenceLifecycleScenario,
  type InferenceScenarioStep
} from "./lifecycle-binding-inference";

type ExportedScenarioRequest = {
  method: string;
  path: string;
  body: unknown;
  pathParams?: Record<string, string>;
  queryParams?: Record<string, string>;
};

type ExportedScenarioStep =
  InferenceScenarioStep;

type ExportedScenario = {
  id: number;
  request: ExportedScenarioRequest;
  expected: {
    status: number;
    body: unknown;
  };
  setup?: unknown;
};

type ExportedLifecycleScenario =
  InferenceLifecycleScenario;

export type CandidateDiagnostic =
  DynamicCandidate & {
    scenarioId: number;
    scenarioKey: string;
    method: string;
    path: string;
  };

export type CandidateArtifact = {
  version: 1;
  exportId?: string;
  candidates: CandidateDiagnostic[];
};

export class ScenarioExportError extends Error {
  readonly name = "ScenarioExportError";

  constructor(
    readonly code:
      | "SANITIZED_RESPONSE_FIELD_UNSUPPORTED"
      | "EXPORT_CAPTURE_INVALID"
      | "EXPORT_CAPTURE_UNSUPPORTED"
      | "EXPORT_LIFECYCLE_AMBIGUOUS"
      | "EXPORT_CAPTURE_UNACCOUNTED"
      | "EXPORT_CAPTURE_DUPLICATED"
      | "EXPORT_COVERAGE_INCOMPLETE",
    message: string
  ) {
    super(message);
  }
}

export class ScenarioArtifactError extends Error {
  readonly name = "ScenarioArtifactError";

  constructor(
    readonly code:
      | "ARTIFACT_INVALIDATION_FAILED"
      | "ARTIFACT_WRITE_FAILED",
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
  }
}

type ExportFileSystem = Pick<
  typeof fs,
  | "openSync"
  | "writeFileSync"
  | "fsyncSync"
  | "closeSync"
  | "renameSync"
  | "unlinkSync"
>;

export type ScenarioExportDependencies = {
  scenarioPath?: string;
  candidatePath?: string;
  diagnosticPath?: string;
  projectId?: string;
  fileSystem?: ExportFileSystem;
  loadFrozenCaptureSet?: typeof loadFrozenCaptureSet;
  log?: (message: string) => void;
};

type ValidCapture = CapturedRequest & {
  active: true;
  snapshot: NonNullable<CapturedRequest["snapshot"]>;
};

type CaptureState = {
  source: PersistedCapture;
  capture?: ValidCapture;
  disposition?: CaptureDisposition;
};

type ExportConstruction = {
  input: BundleInput;
  coverage: BundleCoverage;
  scenarios: ShadowSpecScenario[];
};

function isRecordOfStrings(value: unknown): value is Record<string, string> {
  return value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value).every((item) => typeof item === "string");
}

function isJsonValue(value: unknown): boolean {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  if (value !== null && typeof value === "object") {
    return Object.values(value).every(isJsonValue);
  }
  return false;
}

function isValidSnapshotShape(value: unknown): boolean {
  if (!hasValidSnapshot(value as DatabaseSnapshot | undefined)) {
    return false;
  }
  const snapshot = value as DatabaseSnapshot;
  return Object.values(snapshot.tables).every((table) =>
    table !== null &&
    typeof table === "object" &&
    !Array.isArray(table) &&
    Array.isArray(table.rows) &&
    table.rows.every((row) =>
      row !== null &&
      typeof row === "object" &&
      !Array.isArray(row) &&
      isJsonValue(row)
    )
  );
}

function safeMethod(value: unknown): string {
  return typeof value === "string" && value.length > 0
    ? value.slice(0, 16)
    : "UNKNOWN";
}

function safeDisplayPath(
  pathValue: unknown,
  pathParamsValue: unknown
): string {
  if (typeof pathValue !== "string" || !pathValue.startsWith("/")) {
    return "[invalid-path]";
  }
  if (!isRecordOfStrings(pathParamsValue)) {
    return Object.keys(pathParamsValue ?? {}).length === 0
      ? pathValue
      : "[redacted-path]";
  }
  const segments = pathValue.split("/");
  for (const [name, parameterValue] of Object.entries(pathParamsValue)) {
    const matches: number[] = [];
    for (let index = 0; index < segments.length; index++) {
      try {
        if (decodeURIComponent(segments[index]) === parameterValue) {
          matches.push(index);
        }
      } catch {
        return "[redacted-path]";
      }
    }
    if (matches.length !== 1 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      return "[redacted-path]";
    }
    segments[matches[0]] = `:${name}`;
  }
  return segments.join("/");
}

function materialSanitization(value: unknown): boolean {
  return canonicalStringify(value) !== canonicalStringify(sanitizeObject(value));
}

function rejectedDisposition(
  source: PersistedCapture,
  disposition: CaptureDisposition["disposition"],
  reason: string
): CaptureDisposition {
  return {
    captureId: Number(source.id),
    disposition,
    reason,
    method: safeMethod(source.method),
    safePath: safeDisplayPath(source.path, source.pathParams),
    checkCount: 0
  };
}

function validateCapture(source: PersistedCapture): CaptureState {
  const captureId = Number(source.id);
  const base = {
    captureId,
    method: safeMethod(source.method),
    safePath: safeDisplayPath(source.path, source.pathParams),
    checkCount: 0 as const
  };
  if (source.path === REPLAY_TARGET_ENDPOINT) {
    return {
      source,
      disposition: {
        ...base,
        disposition: "EXCLUDED_SHADOWSPEC_INTERNAL",
        reason: "RESERVED_REPLAY_TARGET_ENDPOINT"
      }
    };
  }
  if (source.active === false) {
    return {
      source,
      disposition: {
        ...base,
        disposition: "EXCLUDED_INACTIVE",
        reason: "CAPTURE_INACTIVE"
      }
    };
  }
  if (
    !Number.isSafeInteger(captureId) || captureId < 1 ||
    source.active !== true ||
    typeof source.method !== "string" || source.method.length === 0 ||
    typeof source.path !== "string" || !source.path.startsWith("/") ||
    !isRecordOfStrings(source.pathParams) ||
    !isRecordOfStrings(source.queryParams) ||
    !isJsonValue(source.requestBody) ||
    !isJsonValue(source.responseBody) ||
    !Number.isSafeInteger(source.responseStatus) ||
    Number(source.responseStatus) < 100 || Number(source.responseStatus) > 599 ||
    !(
      source.sessionId === null ||
      source.sessionId === undefined ||
      (typeof source.sessionId === "string" && source.sessionId.length > 0)
    ) ||
    source.snapshots.length !== 1 ||
    !isValidSnapshotShape(source.snapshots[0])
  ) {
    return {
      source,
      disposition: rejectedDisposition(
        source,
        "REJECTED_INVALID_CAPTURE",
        source.snapshots.length === 0
          ? "SNAPSHOT_MISSING"
          : source.snapshots.length > 1
            ? "SNAPSHOT_DUPLICATED"
            : "CAPTURE_SHAPE_INVALID"
      )
    };
  }
  if (
    materialSanitization(source.requestBody) ||
    materialSanitization(source.pathParams) ||
    materialSanitization(source.queryParams) ||
    materialSanitization(source.responseBody) ||
    materialSanitization(source.snapshots[0])
  ) {
    return {
      source,
      disposition: rejectedDisposition(
        source,
        "REJECTED_SANITIZATION",
        "REPLAY_CRITICAL_DATA_REDACTED"
      )
    };
  }
  return {
    source,
    capture: {
      id: captureId,
      active: true,
      sessionId: typeof source.sessionId === "string" ? source.sessionId : undefined,
      method: source.method,
      path: source.path,
      pathParams: source.pathParams,
      queryParams: source.queryParams,
      requestBody: source.requestBody,
      responseBody: source.responseBody,
      responseStatus: Number(source.responseStatus),
      snapshot: source.snapshots[0] as ValidCapture["snapshot"]
    }
  };
}

function invalidateArtifact(
  artifactPath: string,
  fileSystem: ExportFileSystem
): void {
  try {
    fileSystem.unlinkSync(artifactPath);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return;
    }

    throw new ScenarioArtifactError(
      "ARTIFACT_INVALIDATION_FAILED",
      `ShadowSpec could not invalidate the previous export artifact at "${artifactPath}".`,
      { cause: error }
    );
  }
}

export function writeJsonAtomically(
  artifactPath: string,
  value: unknown,
  fileSystem: ExportFileSystem = fs
): void {
  const directory = path.dirname(artifactPath);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(artifactPath)}.${process.pid}.${randomUUID()}.tmp`
  );
  let descriptor: number | undefined;

  try {
    descriptor = fileSystem.openSync(
      temporaryPath,
      "wx"
    );
    fileSystem.writeFileSync(
      descriptor,
      JSON.stringify(value, null, 2)
    );
    fileSystem.fsyncSync(descriptor);
    fileSystem.closeSync(descriptor);
    descriptor = undefined;
    fileSystem.renameSync(
      temporaryPath,
      artifactPath
    );
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        fileSystem.closeSync(descriptor);
      } catch {
        // Preserve the original artifact failure.
      }
    }

    try {
      fileSystem.unlinkSync(temporaryPath);
    } catch {
      // The temp file may not exist or may already have been renamed.
    }

    throw new ScenarioArtifactError(
      "ARTIFACT_WRITE_FAILED",
      `ShadowSpec could not publish the export artifact at "${artifactPath}".`,
      { cause: error }
    );
  }
}

function getSanitizedFields(
  original: unknown,
  sanitized: unknown,
  pointer = ""
): string[] {
  const fields = new Set<string>();

  if (Array.isArray(original)) {
    if (!Array.isArray(sanitized)) {
      return [];
    }

    for (
      let i = 0;
      i < original.length;
      i++
    ) {
      const nestedFields =
        getSanitizedFields(
          original[i],
          sanitized[i],
          `${pointer}/${i}`
        );

      for (const field of nestedFields) {
        fields.add(field);
      }
    }

    return Array.from(fields);
  }

  if (
    original !== null &&
    typeof original === "object" &&
    sanitized !== null &&
    typeof sanitized === "object"
  ) {
    const originalRecord =
      original as Record<string, unknown>;

    const sanitizedRecord =
      sanitized as Record<string, unknown>;

    for (const key of Object.keys(
      originalRecord
    )) {
      if (
        !Object.prototype.hasOwnProperty.call(
          sanitizedRecord,
          key
        )
      ) {
        fields.add(
          `${pointer}/${escapeJsonPointerToken(key)}`
        );
        continue;
      }

      const nestedFields =
        getSanitizedFields(
          originalRecord[key],
          sanitizedRecord[key],
          `${pointer}/${escapeJsonPointerToken(key)}`
        );

      for (const field of nestedFields) {
        fields.add(field);
      }
    }
  }

  return Array.from(fields);
}

export function findBestBaselineResponse(
  responses: ScenarioResponse[]
): ScenarioResponse {
  return (
    responses.find((response) =>
      hasValidSnapshot(response.snapshot)
    ) ??
    responses[0]
  );
}

type GroupedResponses = {
  method: string;
  path: string;
  pathParams: Record<string, string>;
  queryParams: Record<string, string>;
  requestBody: unknown;
  responseStatus: number;
  responses: ScenarioResponse[];
};

function groupResponses(
  scenarioGroups: Awaited<
    ReturnType<typeof getScenarioGroups>
  >
): GroupedResponses[] {
  const grouped = new Map<string, GroupedResponses>();

  for (const group of scenarioGroups) {
    for (const response of group.responses) {
      const key = canonicalStringify([
        group.method,
        group.path,
        group.pathParams,
        group.queryParams,
        group.requestBody,
        response.status
      ]);
      const existing = grouped.get(key);

      if (existing) {
        existing.responses.push(response);
      } else {
        grouped.set(key, {
          method: group.method,
          path: group.path,
          pathParams: group.pathParams,
          queryParams: group.queryParams,
          requestBody: group.requestBody,
          responseStatus: response.status,
          responses: [response]
        });
      }
    }
  }

  return Array.from(grouped.values());
}

export function buildScenarios(
  scenarioGroups: Awaited<
    ReturnType<typeof getScenarioGroups>
  >
) {
  return groupResponses(scenarioGroups).map(
    (group, index) => {
    const baseline =
      findBestBaselineResponse(
        group.responses
      );

    const sanitizedRequestBody =
      sanitizeObject(
        group.requestBody
      );

    const sanitizedResponseBody =
      sanitizeObject(
        baseline.body
      );

    assertNoSanitizedResponseFields(
      baseline.body,
      sanitizedResponseBody
    );

    const outputScenario: ExportedScenario = {
      id: index + 1,

      request: {
        method: group.method,
        path: group.path,
        body: sanitizedRequestBody
      },

      expected: {
        status: baseline.status,
        body: sanitizedResponseBody
      }
    };

    if (
      Object.keys(group.pathParams).length > 0
    ) {
      outputScenario.request.pathParams =
        group.pathParams;
    }

    if (
      Object.keys(group.queryParams).length > 0
    ) {
      outputScenario.request.queryParams =
        group.queryParams;
    }

    if (baseline.snapshot) {
      outputScenario.setup =
        sanitizeObject(
          baseline.snapshot
        );
    }

    return outputScenario;
  });
}

export function buildLifecycleScenarios(
  sequences: ReturnType<
    typeof buildScenarioSequences
  >
) {
  const lifecycleSequences =
    sequences.filter(
      (sequence) =>
        sequence.requests.length > 1
    );

  const scenarios = lifecycleSequences.map(
    (sequence, index) => {
      const firstRequest =
        sequence.requests[0];

      const outputScenario:
        ExportedLifecycleScenario = {
        id: index + 1,
        steps: []
      };

      if (firstRequest.snapshot) {
        outputScenario.setup =
          sanitizeObject(
            firstRequest.snapshot
          );
      }

      for (const request of sequence.requests) {
        const step: ExportedScenarioStep = {
          request: {
            method: request.method,
            path: request.path,
            body: sanitizeObject(
              request.requestBody
            )
          },

          expected: {
            status: request.responseStatus,
            body: sanitizeObject(
              request.responseBody
            )
          }
        };

        assertNoSanitizedResponseFields(
          request.responseBody,
          step.expected.body
        );

        if (
          Object.keys(
            request.pathParams
          ).length > 0
        ) {
          step.request.pathParams =
            request.pathParams;
        }

        if (
          Object.keys(
            request.queryParams
          ).length > 0
        ) {
          step.request.queryParams =
            request.queryParams;
        }

        outputScenario.steps.push(
          step
        );
      }

      return outputScenario;
    }
  );

  return inferLifecycleBindings(
    lifecycleSequences,
    scenarios
  );
}

function assertNoSanitizedResponseFields(
  original: unknown,
  sanitized: unknown
) {
  const pointers = getSanitizedFields(
    original,
    sanitized
  ).sort();

  if (pointers.length > 0) {
    throw new ScenarioExportError(
      "SANITIZED_RESPONSE_FIELD_UNSUPPORTED",
      `ShadowSpec cannot export a response whose required fields were sanitized: ${pointers.join(
        ", "
      )}. Configure an explicit redaction policy before replaying this scenario.`
    );
  }
}

function scenarioKey(
  group: GroupedResponses
): string {
  return createHash("sha256")
    .update(
      canonicalStringify([
        group.method,
        group.path,
        group.pathParams,
        group.queryParams,
        group.requestBody,
        group.responseStatus
      ])
    )
    .digest("hex");
}

export function buildCandidateArtifact(
  scenarioGroups: Awaited<
    ReturnType<typeof getScenarioGroups>
  >
): CandidateArtifact {
  const candidates = groupResponses(
    scenarioGroups
  ).flatMap((group, index) => {
    const baseline = findBestBaselineResponse(
      group.responses
    );
    const key = scenarioKey(group);

    return detectDynamicCandidates(
      group.responses.map(
        (response) => response.body
      )
    ).map<CandidateDiagnostic>((candidate) => {
      const tokens = getJsonPointerTokens(
        candidate.pointer
      );
      const isStateDerived =
        candidate.reason === "value_changed" &&
        tokens.length === 1 &&
        isStateDerivedField(
          tokens[0],
          baseline,
          group.pathParams
        );

      return {
        scenarioId: index + 1,
        scenarioKey: key,
        method: group.method,
        path: group.path,
        ...candidate,
        reason: isStateDerived
          ? "correlated_with_snapshot"
          : candidate.reason
      };
    });
  });

  candidates.sort(
    (left, right) =>
      left.scenarioKey < right.scenarioKey
        ? -1
        : left.scenarioKey > right.scenarioKey
          ? 1
          : left.pointer < right.pointer
            ? -1
            : left.pointer > right.pointer
              ? 1
              : 0
  );

  return {
    version: 1,
    candidates
  };
}

function standaloneScenario(
  capture: ValidCapture,
  id: number
): ShadowSpecScenario {
  return {
    id,
    request: {
      method: capture.method,
      path: capture.path,
      body: sanitizeObject(capture.requestBody),
      ...(Object.keys(capture.pathParams).length > 0
        ? { pathParams: capture.pathParams }
        : {}),
      ...(Object.keys(capture.queryParams).length > 0
        ? { queryParams: capture.queryParams }
        : {})
    },
    expected: {
      status: capture.responseStatus,
      body: sanitizeObject(capture.responseBody)
    },
    setup: sanitizeObject(capture.snapshot) as ShadowSpecScenario["setup"]
  };
}

function scenarioGroupsForCandidates(
  captures: readonly ValidCapture[]
): ScenarioGroup[] {
  return captures.map((capture) => ({
    id: capture.id,
    method: capture.method,
    path: capture.path,
    pathParams: capture.pathParams,
    queryParams: capture.queryParams,
    requestBody: capture.requestBody,
    responses: [{
      body: capture.responseBody,
      status: capture.responseStatus,
      snapshot: capture.snapshot
    }]
  }));
}

function ensureAccounting(
  captureIds: readonly number[],
  coverage: BundleCoverage,
  scenarios: readonly ShadowSpecScenario[]
): void {
  const expectedIds = new Set(captureIds);
  const seenIds = new Set<number>();
  const locations = new Set<string>();
  for (const disposition of coverage.dispositions) {
    if (!expectedIds.has(disposition.captureId)) {
      throw new ScenarioExportError(
        "EXPORT_CAPTURE_UNACCOUNTED",
        "A capture disposition is outside the frozen export input."
      );
    }
    if (seenIds.has(disposition.captureId)) {
      throw new ScenarioExportError(
        "EXPORT_CAPTURE_DUPLICATED",
        "A frozen capture received multiple dispositions."
      );
    }
    seenIds.add(disposition.captureId);
    if (disposition.checkCount === 1) {
      const location = disposition.step === undefined
        ? `${disposition.scenarioId}:standalone`
        : `${disposition.scenarioId}:step:${disposition.step}`;
      if (locations.has(location)) {
        throw new ScenarioExportError(
          "EXPORT_CAPTURE_DUPLICATED",
          "Multiple captures map to one executable check."
        );
      }
      locations.add(location);
    }
  }
  const scenarioChecks = scenarios.reduce(
    (total, scenario) => total + (scenario.steps?.length ?? 1),
    0
  );
  if (
    seenIds.size !== captureIds.length ||
    coverage.executableCaptures + coverage.rejectedCaptures + coverage.excludedCaptures !== captureIds.length ||
    coverage.checkCount !== coverage.executableCaptures ||
    scenarioChecks !== coverage.checkCount ||
    locations.size !== coverage.checkCount
  ) {
    throw new ScenarioExportError(
      "EXPORT_CAPTURE_UNACCOUNTED",
      "Frozen capture accounting did not reconcile."
    );
  }
}

export function buildCoverageExport(
  frozen: FrozenCaptureSet,
  projectId: string
): ExportConstruction {
  const ordered = [...frozen.captures].sort(
    (left, right) => Number(left.id) - Number(right.id)
  );
  const captureIds = ordered.map((capture) => Number(capture.id));
  if (
    new Set(captureIds).size !== captureIds.length ||
    captureIds.some((id) => !Number.isSafeInteger(id) || id < 1)
  ) {
    throw new ScenarioExportError(
      "EXPORT_CAPTURE_DUPLICATED",
      "Frozen capture identities are invalid or duplicated."
    );
  }
  const states = ordered.map(validateCapture);
  const byId = new Map(states.map((state) => [Number(state.source.id), state]));

  const sessionBlocks = new Map<string, number>();
  let previousSession: string | undefined;
  for (const state of states) {
    const session = typeof state.source.sessionId === "string"
      ? state.source.sessionId
      : undefined;
    if (session !== previousSession) {
      if (session !== undefined) {
        sessionBlocks.set(session, (sessionBlocks.get(session) ?? 0) + 1);
      }
      previousSession = session;
    }
  }
  const sessionStates = new Map<string, CaptureState[]>();
  for (const state of states) {
    if (typeof state.source.sessionId !== "string") {
      continue;
    }
    const group = sessionStates.get(state.source.sessionId) ?? [];
    group.push(state);
    sessionStates.set(state.source.sessionId, group);
  }
  for (const [session, members] of sessionStates) {
    const nonExcluded = members.filter((member) =>
      !member.disposition?.disposition.startsWith("EXCLUDED_")
    );
    if ((sessionBlocks.get(session) ?? 0) > 1) {
      for (const member of nonExcluded) {
        member.capture = undefined;
        member.disposition = rejectedDisposition(
          member.source,
          "REJECTED_LIFECYCLE_AMBIGUOUS",
          "SESSION_NON_CONTIGUOUS"
        );
      }
      continue;
    }
    if (
      nonExcluded.length > 1 &&
      nonExcluded.some((member) => member.disposition !== undefined)
    ) {
      for (const member of nonExcluded) {
        if (member.disposition === undefined) {
          member.capture = undefined;
          member.disposition = rejectedDisposition(
            member.source,
            "REJECTED_LIFECYCLE_AMBIGUOUS",
            "LIFECYCLE_MEMBER_REJECTED"
          );
        }
      }
    }
  }

  type Unit = {
    firstId: number;
    captures: ValidCapture[];
  };
  const units: Unit[] = [];
  const includedSessions = new Set<string>();
  for (const state of states) {
    if (!state.capture || state.disposition) {
      continue;
    }
    const session = state.capture.sessionId;
    if (session === undefined) {
      units.push({ firstId: state.capture.id, captures: [state.capture] });
      continue;
    }
    if (includedSessions.has(session)) {
      continue;
    }
    includedSessions.add(session);
    const captures = (sessionStates.get(session) ?? [])
      .map((member) => member.capture)
      .filter((capture): capture is ValidCapture => capture !== undefined)
      .sort((left, right) => left.id - right.id);
    if (captures.length > 0) {
      units.push({ firstId: captures[0].id, captures });
    }
  }
  units.sort((left, right) => left.firstId - right.firstId);

  const scenarios: ShadowSpecScenario[] = [];
  const lifecycleSequences: ScenarioSequence[] = [];
  const lifecycleScenarioIds: number[] = [];
  const mapping = new Map<number, { scenarioId: number; step?: number }>();
  let scenarioId = 1;
  for (const unit of units) {
    if (unit.captures.length === 1) {
      scenarios.push(standaloneScenario(unit.captures[0], scenarioId));
      mapping.set(unit.captures[0].id, { scenarioId });
    } else {
      lifecycleSequences.push({
        sessionId: unit.captures[0].sessionId as string,
        requests: unit.captures
      });
      lifecycleScenarioIds.push(scenarioId);
      unit.captures.forEach((capture, index) => {
        mapping.set(capture.id, { scenarioId, step: index + 1 });
      });
    }
    scenarioId++;
  }
  const lifecycleScenarios = buildLifecycleScenarios(lifecycleSequences)
    .map((scenario, index) => ({
      ...scenario,
      id: lifecycleScenarioIds[index]
    })) as unknown as ShadowSpecScenario[];
  scenarios.push(...lifecycleScenarios);
  scenarios.sort((left, right) => left.id - right.id);

  for (const [captureId, location] of mapping) {
    const state = byId.get(captureId);
    if (!state?.capture || state.disposition) {
      throw new ScenarioExportError(
        "EXPORT_CAPTURE_UNACCOUNTED",
        "Executable capture mapping references an invalid capture."
      );
    }
    state.disposition = {
      captureId,
      disposition: location.step === undefined
        ? "EXECUTABLE_STANDALONE"
        : "EXECUTABLE_LIFECYCLE_STEP",
      method: state.capture.method,
      safePath: safeDisplayPath(state.capture.path, state.capture.pathParams),
      scenarioId: location.scenarioId,
      ...(location.step === undefined ? {} : { step: location.step }),
      checkCount: 1
    };
  }
  const dispositions = states
    .map((state) => state.disposition)
    .filter((disposition): disposition is CaptureDisposition => disposition !== undefined)
    .sort((left, right) => left.captureId - right.captureId);
  const executableCaptures = dispositions.filter((item) => item.checkCount === 1).length;
  const rejectedCaptures = dispositions.filter((item) => item.disposition.startsWith("REJECTED_")).length;
  const excludedCaptures = dispositions.filter((item) => item.disposition.startsWith("EXCLUDED_")).length;
  const coverage: BundleCoverage = {
    complete: rejectedCaptures === 0,
    executableCaptures,
    rejectedCaptures,
    excludedCaptures,
    checkCount: executableCaptures,
    dispositions
  };
  ensureAccounting(captureIds, coverage, scenarios);
  return {
    input: {
      projectId,
      isolation: "repeatable-read",
      maxVisibleCaptureId: frozen.maxVisibleCaptureId,
      captureCount: captureIds.length,
      captureIdsSha256: hashCaptureIds(captureIds)
    },
    coverage,
    scenarios
  };
}

export async function exportScenarios(
  dependencies: ScenarioExportDependencies = {}
): Promise<void> {
  const scenarioPath =
    dependencies.scenarioPath ??
    "shadowspec-scenarios.json";
  const candidatePath =
    dependencies.candidatePath ??
    "shadowspec-candidates.json";
  const diagnosticPath =
    dependencies.diagnosticPath ??
    "shadowspec-export-result.json";
  const fileSystem =
    dependencies.fileSystem ?? fs;
  const loadCaptures =
    dependencies.loadFrozenCaptureSet ??
    loadFrozenCaptureSet;
  const projectId =
    dependencies.projectId ??
    process.env.SHADOWSPEC_PROJECT_ID;
  const log = dependencies.log ?? console.log;

  invalidateArtifact(
    scenarioPath,
    fileSystem
  );
  invalidateArtifact(
    candidatePath,
    fileSystem
  );
  invalidateArtifact(
    diagnosticPath,
    fileSystem
  );
  if (!projectId) {
    throw new ScenarioExportError(
      "EXPORT_CAPTURE_INVALID",
      "SHADOWSPEC_PROJECT_ID is required for correlated scenario export."
    );
  }

  const frozen = await loadCaptures();
  const construction = buildCoverageExport(
    frozen,
    projectId
  );
  if (!construction.coverage.complete) {
    writeJsonAtomically(
      diagnosticPath,
      {
        version: 1,
        kind: "shadowspec-export-result",
        input: construction.input,
        coverage: construction.coverage
      },
      fileSystem
    );
    throw new ScenarioExportError(
      "EXPORT_COVERAGE_INCOMPLETE",
      `ShadowSpec rejected ${construction.coverage.rejectedCaptures} capture(s); no executable bundle was published.`
    );
  }

  const bundle: ScenarioBundle = createScenarioBundle(
    construction.input,
    construction.coverage,
    construction.scenarios
  );
  const executableCaptures = construction.coverage.dispositions
    .filter((item) => item.checkCount === 1)
    .map((item) => frozen.captures.find((capture) => Number(capture.id) === item.captureId))
    .filter((capture): capture is PersistedCapture => capture !== undefined)
    .map((capture) => validateCapture(capture).capture)
    .filter((capture): capture is ValidCapture => capture !== undefined);
  const candidateArtifact = {
    ...buildCandidateArtifact(
      scenarioGroupsForCandidates(executableCaptures)
    ),
    exportId: bundle.exportId
  };
  writeJsonAtomically(candidatePath, candidateArtifact, fileSystem);
  writeJsonAtomically(scenarioPath, bundle, fileSystem);

  if (bundle.scenarios.length === 0) {
    log("No scenarios found.");
    return;
  }

  log(
    `Exported ${bundle.scenarios.length} ShadowSpec scenario(s) covering ${bundle.coverage.executableCaptures} capture(s).`
  );
}

export function runExportCli(): void {
  exportScenarios().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

if (require.main === module) {
  runExportCli();
}
