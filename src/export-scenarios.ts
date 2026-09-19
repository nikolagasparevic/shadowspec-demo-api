import fs from "fs";
import {
  createHash,
  randomUUID
} from "node:crypto";
import path from "node:path";
import { canonicalStringify } from "./canonical";
import {
  getScenarioGroups,
  getCapturedRequests,
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
import type { ScenarioResponse } from "./scenario-types";
import type { ShadowSpecScenario } from "./load-scenarios";
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
  candidates: CandidateDiagnostic[];
};

export class ScenarioExportError extends Error {
  readonly name = "ScenarioExportError";

  constructor(
    readonly code:
      "SANITIZED_RESPONSE_FIELD_UNSUPPORTED",
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
  fileSystem?: ExportFileSystem;
  getScenarioGroups?: typeof getScenarioGroups;
  getCapturedRequests?: typeof getCapturedRequests;
  log?: (message: string) => void;
};

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

export async function exportScenarios(
  dependencies: ScenarioExportDependencies = {}
): Promise<void> {
  const scenarioPath =
    dependencies.scenarioPath ??
    "shadowspec-scenarios.json";
  const candidatePath =
    dependencies.candidatePath ??
    "shadowspec-candidates.json";
  const fileSystem =
    dependencies.fileSystem ?? fs;
  const loadScenarioGroups =
    dependencies.getScenarioGroups ??
    getScenarioGroups;
  const loadCapturedRequests =
    dependencies.getCapturedRequests ??
    getCapturedRequests;
  const log = dependencies.log ?? console.log;

  invalidateArtifact(
    scenarioPath,
    fileSystem
  );
  invalidateArtifact(
    candidatePath,
    fileSystem
  );

  const scenarioGroups =
    await loadScenarioGroups();

  const legacyScenarios =
    buildScenarios(
      scenarioGroups
    );
  const candidateArtifact =
    buildCandidateArtifact(
      scenarioGroups
    );

  const capturedRequests =
    await loadCapturedRequests();

  const sequences =
    buildScenarioSequences(
      capturedRequests
    );

  const lifecycleScenarios =
    buildLifecycleScenarios(
      sequences
    ).map((scenario, index) => ({
      ...scenario,
      id:
        legacyScenarios.length +
        index +
        1
    }));

  const output = [
    ...legacyScenarios,
    ...lifecycleScenarios
  ];

  validateScenarios(
    output as unknown as ShadowSpecScenario[]
  );

  writeJsonAtomically(
    candidatePath,
    candidateArtifact,
    fileSystem
  );
  writeJsonAtomically(
    scenarioPath,
    output,
    fileSystem
  );

  if (output.length === 0) {
    log("No scenarios found.");
    return;
  }

  log(
    `Exported ${output.length} ShadowSpec scenario(s).`
  );
}

if (require.main === module) {
  exportScenarios().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
