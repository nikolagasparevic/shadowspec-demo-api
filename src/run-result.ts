import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import type { ShadowSpecReport } from "./report";
import { LifecycleBindingError } from "./lifecycle-bindings";
import { ReplayCapabilityError } from "./replay-capabilities";
import { ReplaySafetyError } from "./replay-safety";
import { ReplayTargetSafetyError } from "./replay-target-safety";
import { ScenarioConfigurationError } from "./scenario-validation";
import { ScenarioLoadError } from "./load-scenarios";
import { ReplayRequestError } from "./replay";

export const RUN_RESULT_VERSION = 1 as const;
export const RUN_RESULT_SOURCE = "shadowspec-replay" as const;
export const RUN_RESULT_REPORT_VERSION = 1 as const;

export type RunTerminalStatus =
  | "passed"
  | "behavioral_failed"
  | "safety_failed"
  | "configuration_failed"
  | "infrastructure_failed"
  | "internal_failed"
  | "interrupted"
  | "cancelled";

export type RunErrorCategory =
  | "behavioral"
  | "safety"
  | "configuration"
  | "infrastructure"
  | "internal";

export type RunIdentity = Readonly<{
  runId: string;
  repository: string;
  commitSha: string;
  sourceHeadSha?: string;
  workflowRunId?: string;
  runAttempt: number;
  projectId?: string;
}>;

export type RunFatalError = Readonly<{
  category: Exclude<RunErrorCategory, "behavioral">;
  code: string;
  message: string;
}>;

export type ShadowSpecRunResult = {
  version: typeof RUN_RESULT_VERSION;
  reportSource: typeof RUN_RESULT_SOURCE;
  reportVersion: typeof RUN_RESULT_REPORT_VERSION;
  runId: string;
  repository: string;
  commitSha: string;
  sourceHeadSha?: string;
  workflowRunId?: string;
  runAttempt: number;
  projectId?: string;
  startedAt: string;
  finishedAt: string;
  terminalStatus: RunTerminalStatus;
  scenarios: number;
  scenariosCompleted: number;
  plannedChecks: number;
  checks: number;
  passedChecks: number;
  failedChecks: number;
  behavioralFailures: number;
  failures: ShadowSpecReport["failures"];
  fatalError: RunFatalError | null;
};

export type RunProgress = {
  scenarios: number;
  scenariosCompleted: number;
  plannedChecks: number;
  passedChecks: number;
  failedChecks: number;
  failures: ShadowSpecReport["failures"];
};

export class RunResultError extends Error {
  readonly name = "RunResultError";

  constructor(
    readonly code:
      | "RUN_RESULT_INVALID"
      | "RUN_RESULT_IDENTITY_MISMATCH"
      | "RUN_RESULT_WRITE_FAILED",
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
  }
}

type RunResultFileSystem = Pick<
  typeof fs,
  | "mkdirSync"
  | "openSync"
  | "writeFileSync"
  | "fsyncSync"
  | "closeSync"
  | "renameSync"
  | "unlinkSync"
>;

const SAFE_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
const TERMINAL_STATUSES = new Set<RunTerminalStatus>([
  "passed",
  "behavioral_failed",
  "safety_failed",
  "configuration_failed",
  "infrastructure_failed",
  "internal_failed",
  "interrupted",
  "cancelled"
]);
const RUN_RESULT_FIELDS = new Set([
  "version",
  "reportSource",
  "reportVersion",
  "runId",
  "repository",
  "commitSha",
  "sourceHeadSha",
  "workflowRunId",
  "runAttempt",
  "projectId",
  "startedAt",
  "finishedAt",
  "terminalStatus",
  "scenarios",
  "scenariosCompleted",
  "plannedChecks",
  "checks",
  "passedChecks",
  "failedChecks",
  "behavioralFailures",
  "failures",
  "fatalError"
]);
const FATAL_CATEGORIES = new Set([
  "safety",
  "configuration",
  "infrastructure",
  "internal"
]);
const TERMINAL_FATAL_CATEGORIES: Partial<
  Record<RunTerminalStatus, RunFatalError["category"]>
> = {
  safety_failed: "safety",
  configuration_failed: "configuration",
  infrastructure_failed: "infrastructure",
  internal_failed: "internal",
  interrupted: "infrastructure",
  cancelled: "infrastructure"
};

function requiredEnvironmentValue(
  environment: NodeJS.ProcessEnv,
  name: string
): string {
  const value = environment[name];
  if (!value) {
    throw new RunResultError(
      "RUN_RESULT_INVALID",
      `ShadowSpec run identity requires ${name}.`
    );
  }
  return value;
}

function deriveLocalCommit(): string {
  try {
    return execFileSync(
      "git",
      ["rev-parse", "HEAD"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    ).trim() || "local";
  } catch {
    return "local";
  }
}

export function parseRunIdentity(
  environment: NodeJS.ProcessEnv = process.env,
  localRunId: () => string = randomUUID,
  localCommit: () => string = deriveLocalCommit
): RunIdentity {
  const isCiIdentity = [
    "SHADOWSPEC_RUN_ID",
    "SHADOWSPEC_REPOSITORY",
    "SHADOWSPEC_COMMIT_SHA",
    "SHADOWSPEC_WORKFLOW_RUN_ID",
    "SHADOWSPEC_RUN_ATTEMPT"
  ].some((name) => environment[name] !== undefined);

  const runId = isCiIdentity
    ? requiredEnvironmentValue(environment, "SHADOWSPEC_RUN_ID")
    : localRunId();
  if (!SAFE_ID_PATTERN.test(runId)) {
    throw new RunResultError(
      "RUN_RESULT_INVALID",
      "SHADOWSPEC_RUN_ID contains unsupported characters."
    );
  }

  const attemptText = isCiIdentity
    ? requiredEnvironmentValue(environment, "SHADOWSPEC_RUN_ATTEMPT")
    : "1";
  const runAttempt = Number(attemptText);
  if (!Number.isSafeInteger(runAttempt) || runAttempt < 1) {
    throw new RunResultError(
      "RUN_RESULT_INVALID",
      "SHADOWSPEC_RUN_ATTEMPT must be a positive integer."
    );
  }

  const identity: RunIdentity = {
    runId,
    repository: isCiIdentity
      ? requiredEnvironmentValue(environment, "SHADOWSPEC_REPOSITORY")
      : environment.SHADOWSPEC_REPOSITORY ?? "local",
    commitSha: isCiIdentity
      ? requiredEnvironmentValue(environment, "SHADOWSPEC_COMMIT_SHA")
      : environment.SHADOWSPEC_COMMIT_SHA ?? localCommit(),
    sourceHeadSha:
      environment.SHADOWSPEC_SOURCE_HEAD_SHA || undefined,
    workflowRunId: isCiIdentity
      ? requiredEnvironmentValue(environment, "SHADOWSPEC_WORKFLOW_RUN_ID")
      : undefined,
    runAttempt,
    projectId: environment.SHADOWSPEC_PROJECT_ID || undefined
  };

  return Object.freeze(identity);
}

export function getRunResultPath(
  identity: RunIdentity,
  baseDirectory = "shadowspec-results"
): string {
  return path.join(
    baseDirectory,
    `shadowspec-run-${identity.runId}.json`
  );
}

export function invalidateRunResult(
  artifactPath: string,
  fileSystem: RunResultFileSystem = fs
): void {
  try {
    fileSystem.mkdirSync(path.dirname(artifactPath), {
      recursive: true
    });
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
    throw new RunResultError(
      "RUN_RESULT_WRITE_FAILED",
      "ShadowSpec could not invalidate the previous result for this run.",
      { cause: error }
    );
  }
}

export function publishRunResultAtomically(
  artifactPath: string,
  result: ShadowSpecRunResult,
  fileSystem: RunResultFileSystem = fs
): void {
  const temporaryPath = path.join(
    path.dirname(artifactPath),
    `.${path.basename(artifactPath)}.${process.pid}.${randomUUID()}.tmp`
  );
  let descriptor: number | undefined;
  try {
    fileSystem.mkdirSync(path.dirname(artifactPath), {
      recursive: true
    });
    descriptor = fileSystem.openSync(temporaryPath, "wx");
    fileSystem.writeFileSync(
      descriptor,
      JSON.stringify(result, null, 2)
    );
    fileSystem.fsyncSync(descriptor);
    fileSystem.closeSync(descriptor);
    descriptor = undefined;
    fileSystem.renameSync(temporaryPath, artifactPath);
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        fileSystem.closeSync(descriptor);
      } catch {
        // Preserve the original publication failure.
      }
    }
    try {
      fileSystem.unlinkSync(temporaryPath);
    } catch {
      // The temporary file may not exist or may already have moved.
    }
    throw new RunResultError(
      "RUN_RESULT_WRITE_FAILED",
      "ShadowSpec could not atomically publish the current run result.",
      { cause: error }
    );
  }
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new RunResultError(
      "RUN_RESULT_INVALID",
      `ShadowSpec run result field ${field} is invalid.`
    );
  }
  return value;
}

function validateFailures(value: unknown): void {
  if (!Array.isArray(value)) {
    throw new RunResultError(
      "RUN_RESULT_INVALID",
      "ShadowSpec run result failures are invalid."
    );
  }
  for (const failureValue of value) {
    if (
      typeof failureValue !== "object" ||
      failureValue === null ||
      Array.isArray(failureValue)
    ) {
      throw new RunResultError(
        "RUN_RESULT_INVALID",
        "ShadowSpec run result contains an invalid failure."
      );
    }
    const failure = failureValue as Record<string, unknown>;
    if (
      !Number.isSafeInteger(failure.scenario) ||
      Number(failure.scenario) < 1 ||
      (failure.step !== undefined && (
        !Number.isSafeInteger(failure.step) ||
        Number(failure.step) < 1
      )) ||
      typeof failure.method !== "string" ||
      failure.method.length === 0 ||
      typeof failure.path !== "string" ||
      typeof failure.queryParams !== "object" ||
      failure.queryParams === null ||
      Array.isArray(failure.queryParams) ||
      Object.values(failure.queryParams).some(
        (queryValue) => typeof queryValue !== "string"
      ) ||
      (failure.kind !== undefined && failure.kind !== "binding") ||
      (failure.code !== undefined && typeof failure.code !== "string") ||
      (failure.message !== undefined && typeof failure.message !== "string") ||
      !Array.isArray(failure.differences)
    ) {
      throw new RunResultError(
        "RUN_RESULT_INVALID",
        "ShadowSpec run result contains an invalid failure."
      );
    }
    for (const differenceValue of failure.differences) {
      if (
        typeof differenceValue !== "object" ||
        differenceValue === null ||
        Array.isArray(differenceValue) ||
        typeof (differenceValue as Record<string, unknown>).field !== "string"
      ) {
        throw new RunResultError(
          "RUN_RESULT_INVALID",
          "ShadowSpec run result contains an invalid behavioral difference."
        );
      }
    }
  }
}

export function validateRunResult(
  value: unknown,
  expectedIdentity?: RunIdentity
): ShadowSpecRunResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RunResultError(
      "RUN_RESULT_INVALID",
      "ShadowSpec run result must be an object."
    );
  }
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some((field) => !RUN_RESULT_FIELDS.has(field))) {
    throw new RunResultError(
      "RUN_RESULT_INVALID",
      "ShadowSpec run result contains unsupported fields."
    );
  }
  if (
    result.version !== RUN_RESULT_VERSION ||
    result.reportSource !== RUN_RESULT_SOURCE ||
    result.reportVersion !== RUN_RESULT_REPORT_VERSION
  ) {
    throw new RunResultError(
      "RUN_RESULT_INVALID",
      "ShadowSpec run result version or source is unsupported."
    );
  }

  const runId = requireString(result.runId, "runId");
  const repository = requireString(result.repository, "repository");
  const commitSha = requireString(result.commitSha, "commitSha");
  for (const field of [
    "sourceHeadSha",
    "workflowRunId",
    "projectId"
  ]) {
    if (
      result[field] !== undefined &&
      (typeof result[field] !== "string" || result[field] === "")
    ) {
      throw new RunResultError(
        "RUN_RESULT_INVALID",
        `ShadowSpec run result field ${field} is invalid.`
      );
    }
  }
  const runAttempt = result.runAttempt;
  const terminalStatus = result.terminalStatus;
  if (
    !isNonNegativeInteger(runAttempt) ||
    runAttempt < 1 ||
    typeof terminalStatus !== "string" ||
    !TERMINAL_STATUSES.has(terminalStatus as RunTerminalStatus)
  ) {
    throw new RunResultError(
      "RUN_RESULT_INVALID",
      "ShadowSpec run result identity or terminal status is invalid."
    );
  }

  const numericFields = [
    "scenarios",
    "scenariosCompleted",
    "plannedChecks",
    "checks",
    "passedChecks",
    "failedChecks",
    "behavioralFailures"
  ] as const;
  for (const field of numericFields) {
    if (!isNonNegativeInteger(result[field])) {
      throw new RunResultError(
        "RUN_RESULT_INVALID",
        `ShadowSpec run result field ${field} is invalid.`
      );
    }
  }
  if (
    Number(result.scenariosCompleted) > Number(result.scenarios) ||
    Number(result.checks) > Number(result.plannedChecks) ||
    Number(result.passedChecks) + Number(result.failedChecks) !== Number(result.checks) ||
    Number(result.behavioralFailures) !== Number(result.failedChecks) ||
    !Array.isArray(result.failures) ||
    result.failures.length !== Number(result.failedChecks)
  ) {
    throw new RunResultError(
      "RUN_RESULT_INVALID",
      "ShadowSpec run result counters are inconsistent."
    );
  }
  validateFailures(result.failures);

  const startedAt = requireString(result.startedAt, "startedAt");
  const finishedAt = requireString(result.finishedAt, "finishedAt");
  if (
    !Number.isFinite(Date.parse(startedAt)) ||
    !Number.isFinite(Date.parse(finishedAt)) ||
    Date.parse(finishedAt) < Date.parse(startedAt)
  ) {
    throw new RunResultError(
      "RUN_RESULT_INVALID",
      "ShadowSpec run result timestamps are invalid."
    );
  }

  const isPassed = terminalStatus === "passed";
  const isBehavioral = terminalStatus === "behavioral_failed";
  if (
    (isPassed && (
      Number(result.checks) === 0 ||
      Number(result.failedChecks) !== 0 ||
      Number(result.checks) !== Number(result.plannedChecks) ||
      Number(result.scenariosCompleted) !== Number(result.scenarios) ||
      result.fatalError !== null
    )) ||
    (isBehavioral && (
      Number(result.failedChecks) === 0 ||
      Number(result.scenariosCompleted) !== Number(result.scenarios) ||
      result.fatalError !== null
    )) ||
    (!isPassed && !isBehavioral && (
      typeof result.fatalError !== "object" ||
      result.fatalError === null ||
      Array.isArray(result.fatalError)
    ))
  ) {
    throw new RunResultError(
      "RUN_RESULT_INVALID",
      "ShadowSpec run result terminal state is inconsistent."
    );
  }

  if (result.fatalError !== null) {
    const fatal = result.fatalError as Record<string, unknown>;
    const category = requireString(
      fatal.category,
      "fatalError.category"
    );
    if (
      Object.keys(fatal).some((field) =>
        !["category", "code", "message"].includes(field)
      ) ||
      !FATAL_CATEGORIES.has(category)
    ) {
      throw new RunResultError(
        "RUN_RESULT_INVALID",
        "ShadowSpec fatal error metadata is invalid."
      );
    }
    requireString(fatal.code, "fatalError.code");
    requireString(fatal.message, "fatalError.message");
    if (TERMINAL_FATAL_CATEGORIES[terminalStatus as RunTerminalStatus] !== category) {
      throw new RunResultError(
        "RUN_RESULT_INVALID",
        "ShadowSpec terminal status and fatal error category are inconsistent."
      );
    }
  }

  if (expectedIdentity) {
    const pairs: [string, unknown, unknown][] = [
      ["runId", runId, expectedIdentity.runId],
      ["repository", repository, expectedIdentity.repository],
      ["commitSha", commitSha, expectedIdentity.commitSha],
      ["workflowRunId", result.workflowRunId, expectedIdentity.workflowRunId],
      ["runAttempt", runAttempt, expectedIdentity.runAttempt],
      ["sourceHeadSha", result.sourceHeadSha, expectedIdentity.sourceHeadSha],
      ["projectId", result.projectId, expectedIdentity.projectId]
    ];
    if (pairs.some(([, actual, expected]) => actual !== expected)) {
      throw new RunResultError(
        "RUN_RESULT_IDENTITY_MISMATCH",
        "ShadowSpec run result does not belong to the expected execution."
      );
    }
  }

  return value as ShadowSpecRunResult;
}

export function createRunResult(
  identity: RunIdentity,
  startedAt: string,
  finishedAt: string,
  terminalStatus: RunTerminalStatus,
  progress: RunProgress,
  fatalError: RunFatalError | null
): ShadowSpecRunResult {
  const result: ShadowSpecRunResult = {
    version: RUN_RESULT_VERSION,
    reportSource: RUN_RESULT_SOURCE,
    reportVersion: RUN_RESULT_REPORT_VERSION,
    ...identity,
    startedAt,
    finishedAt,
    terminalStatus,
    scenarios: progress.scenarios,
    scenariosCompleted: progress.scenariosCompleted,
    plannedChecks: progress.plannedChecks,
    checks: progress.passedChecks + progress.failedChecks,
    passedChecks: progress.passedChecks,
    failedChecks: progress.failedChecks,
    behavioralFailures: progress.failedChecks,
    failures: progress.failures,
    fatalError
  };
  return validateRunResult(result);
}

const SAFETY_CONFIG_CODES = new Set([
  "REPLAY_OPT_IN_REQUIRED",
  "REPLAY_SAFETY_CONFIG_MISSING",
  "REPLAY_SAFETY_CONFIG_INVALID"
]);
const TARGET_CONFIG_CODES = new Set([
  "REPLAY_TARGET_CONFIG_MISSING",
  "REPLAY_TARGET_CONFIG_INVALID",
  "REPLAY_TARGET_URL_INVALID",
  "REPLAY_TARGET_REQUEST_URL_INVALID"
]);
const TARGET_INFRASTRUCTURE_CODES = new Set([
  "REPLAY_TARGET_UNREACHABLE",
  "REPLAY_TARGET_TIMEOUT"
]);
const CAPABILITY_CONFIGURATION_CODES = new Set([
  "REPLAY_TABLE_NOT_FOUND",
  "REPLAY_TABLE_IDENTITY_AMBIGUOUS",
  "REPLAY_SNAPSHOT_SHAPE_UNSUPPORTED"
]);

export function classifyRunError(error: unknown): {
  terminalStatus: Exclude<RunTerminalStatus, "passed" | "behavioral_failed" | "interrupted" | "cancelled">;
  fatalError: RunFatalError;
} {
  if (error instanceof RunResultError) {
    const configuration = error.code === "RUN_RESULT_INVALID";
    const safety = error.code === "RUN_RESULT_IDENTITY_MISMATCH";
    return {
      terminalStatus: configuration
        ? "configuration_failed"
        : safety
          ? "safety_failed"
          : "internal_failed",
      fatalError: {
        category: configuration
          ? "configuration"
          : safety
            ? "safety"
            : "internal",
        code: error.code,
        message: error.message
      }
    };
  }
  if (error instanceof ReplaySafetyError) {
    const configuration = SAFETY_CONFIG_CODES.has(error.code);
    return {
      terminalStatus: configuration ? "configuration_failed" : "safety_failed",
      fatalError: {
        category: configuration ? "configuration" : "safety",
        code: error.code,
        message: error.message
      }
    };
  }
  if (error instanceof ReplayTargetSafetyError) {
    const configuration = TARGET_CONFIG_CODES.has(error.code);
    const infrastructure = TARGET_INFRASTRUCTURE_CODES.has(error.code);
    return {
      terminalStatus: configuration
        ? "configuration_failed"
        : infrastructure
          ? "infrastructure_failed"
          : "safety_failed",
      fatalError: {
        category: configuration
          ? "configuration"
          : infrastructure
            ? "infrastructure"
            : "safety",
        code: error.code,
        message: error.message
      }
    };
  }
  if (error instanceof ReplayCapabilityError) {
    const infrastructure = error.code === "REPLAY_DATABASE_CAPABILITY_CHECK_FAILED";
    const configuration = CAPABILITY_CONFIGURATION_CODES.has(error.code);
    return {
      terminalStatus: infrastructure
        ? "infrastructure_failed"
        : configuration
          ? "configuration_failed"
          : "safety_failed",
      fatalError: {
        category: infrastructure
          ? "infrastructure"
          : configuration
            ? "configuration"
            : "safety",
        code: error.code,
        message: error.message
      }
    };
  }
  if (error instanceof ScenarioConfigurationError) {
    return {
      terminalStatus: "configuration_failed",
      fatalError: {
        category: "configuration",
        code: error.code,
        message: error.message
      }
    };
  }
  if (error instanceof ScenarioLoadError) {
    return {
      terminalStatus: "configuration_failed",
      fatalError: {
        category: "configuration",
        code: error.code,
        message: error.message
      }
    };
  }
  if (error instanceof ReplayRequestError) {
    return {
      terminalStatus: "infrastructure_failed",
      fatalError: {
        category: "infrastructure",
        code: error.code,
        message: error.message
      }
    };
  }
  if (error instanceof LifecycleBindingError) {
    return {
      terminalStatus: "configuration_failed",
      fatalError: {
        category: "configuration",
        code: error.code,
        message: error.message
      }
    };
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[0-9A-Z]{5}$/.test(error.code)
  ) {
    return {
      terminalStatus: "infrastructure_failed",
      fatalError: {
        category: "infrastructure",
        code: "REPLAY_INFRASTRUCTURE_FAILED",
        message: "ShadowSpec replay infrastructure failed."
      }
    };
  }
  return {
    terminalStatus: "internal_failed",
    fatalError: {
      category: "internal",
      code: "UNEXPECTED_INTERNAL_ERROR",
      message: "ShadowSpec encountered an unexpected internal error."
    }
  };
}

export function createInterruptedResult(
  identity: RunIdentity,
  startedAt: string,
  finishedAt: string,
  progress: RunProgress
): ShadowSpecRunResult {
  return createRunResult(
    identity,
    startedAt,
    finishedAt,
    "interrupted",
    progress,
    {
      category: "infrastructure",
      code: "RUN_INTERRUPTED",
      message: "ShadowSpec replay was interrupted before completion."
    }
  );
}
