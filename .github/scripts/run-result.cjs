const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const TERMINAL_STATUSES = new Set([
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
  "version", "reportSource", "reportVersion", "runId", "repository",
  "commitSha", "sourceHeadSha", "workflowRunId", "runAttempt",
  "projectId", "startedAt", "finishedAt", "terminalStatus",
  "scenarios", "scenariosCompleted", "plannedChecks", "checks",
  "passedChecks", "failedChecks", "behavioralFailures", "failures",
  "fatalError"
]);
const FATAL_CATEGORIES = new Set([
  "safety", "configuration", "infrastructure", "internal"
]);
const TERMINAL_FATAL_CATEGORIES = {
  safety_failed: "safety",
  configuration_failed: "configuration",
  infrastructure_failed: "infrastructure",
  internal_failed: "internal",
  interrupted: "infrastructure",
  cancelled: "infrastructure"
};

class RunResultValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RunResultValidationError";
    this.code = code;
  }
}

function expectedIdentityFromEnvironment(environment = process.env) {
  const required = (name) => {
    const value = environment[name];
    if (!value) {
      throw new RunResultValidationError(
        "RUN_RESULT_INVALID",
        `Required run identity ${name} is missing.`
      );
    }
    return value;
  };
  const runAttempt = Number(required("SHADOWSPEC_RUN_ATTEMPT"));
  if (!Number.isSafeInteger(runAttempt) || runAttempt < 1) {
    throw new RunResultValidationError(
      "RUN_RESULT_INVALID",
      "SHADOWSPEC_RUN_ATTEMPT must be a positive integer."
    );
  }
  return {
    runId: required("SHADOWSPEC_RUN_ID"),
    repository: required("SHADOWSPEC_REPOSITORY"),
    commitSha: required("SHADOWSPEC_COMMIT_SHA"),
    sourceHeadSha:
      environment.SHADOWSPEC_SOURCE_HEAD_SHA || undefined,
    workflowRunId: required("SHADOWSPEC_WORKFLOW_RUN_ID"),
    runAttempt,
    projectId: environment.SHADOWSPEC_PROJECT_ID || undefined
  };
}

function getRunResultPath(identity, baseDirectory = "shadowspec-results") {
  if (!/^[A-Za-z0-9._-]+$/.test(identity.runId)) {
    throw new RunResultValidationError(
      "RUN_RESULT_INVALID",
      "Run ID contains unsupported characters."
    );
  }
  return path.join(
    baseDirectory,
    `shadowspec-run-${identity.runId}.json`
  );
}

function failuresAreValid(failures) {
  return Array.isArray(failures) && failures.every((failure) =>
    failure &&
    typeof failure === "object" &&
    !Array.isArray(failure) &&
    Number.isSafeInteger(failure.scenario) &&
    failure.scenario >= 1 &&
    (failure.step === undefined || (
      Number.isSafeInteger(failure.step) && failure.step >= 1
    )) &&
    typeof failure.method === "string" &&
    failure.method.length > 0 &&
    typeof failure.path === "string" &&
    failure.queryParams &&
    typeof failure.queryParams === "object" &&
    !Array.isArray(failure.queryParams) &&
    Object.values(failure.queryParams).every(
      (queryValue) => typeof queryValue === "string"
    ) &&
    (failure.kind === undefined || failure.kind === "binding") &&
    (failure.code === undefined || typeof failure.code === "string") &&
    (failure.message === undefined || typeof failure.message === "string") &&
    Array.isArray(failure.differences) &&
    failure.differences.every((difference) =>
      difference &&
      typeof difference === "object" &&
      !Array.isArray(difference) &&
      typeof difference.field === "string"
    )
  );
}

function validateRunResult(value, expectedIdentity) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RunResultValidationError(
      "RUN_RESULT_INVALID",
      "ShadowSpec run result must be an object."
    );
  }
  if (Object.keys(value).some((field) => !RUN_RESULT_FIELDS.has(field))) {
    throw new RunResultValidationError(
      "RUN_RESULT_INVALID",
      "ShadowSpec run result contains unsupported fields."
    );
  }
  if (
    value.version !== 1 ||
    value.reportSource !== "shadowspec-replay" ||
    value.reportVersion !== 1 ||
    !TERMINAL_STATUSES.has(value.terminalStatus)
  ) {
    throw new RunResultValidationError(
      "RUN_RESULT_INVALID",
      "ShadowSpec run result version, source, or terminal status is invalid."
    );
  }
  const requiredStrings = [
    "runId",
    "repository",
    "commitSha",
    "startedAt",
    "finishedAt"
  ];
  if (requiredStrings.some((field) =>
    typeof value[field] !== "string" || value[field].length === 0
  )) {
    throw new RunResultValidationError(
      "RUN_RESULT_INVALID",
      "ShadowSpec run result contains an invalid required field."
    );
  }
  for (const field of ["sourceHeadSha", "workflowRunId", "projectId"]) {
    if (
      value[field] !== undefined &&
      (typeof value[field] !== "string" || value[field].length === 0)
    ) {
      throw new RunResultValidationError(
        "RUN_RESULT_INVALID",
        `ShadowSpec run result field ${field} is invalid.`
      );
    }
  }
  const numericFields = [
    "runAttempt",
    "scenarios",
    "scenariosCompleted",
    "plannedChecks",
    "checks",
    "passedChecks",
    "failedChecks",
    "behavioralFailures"
  ];
  if (numericFields.some((field) =>
    !Number.isSafeInteger(value[field]) || value[field] < 0
  )) {
    throw new RunResultValidationError(
      "RUN_RESULT_INVALID",
      "ShadowSpec run result contains an invalid numeric field."
    );
  }
  if (
    value.runAttempt < 1 ||
    value.scenariosCompleted > value.scenarios ||
    value.checks > value.plannedChecks ||
    value.passedChecks + value.failedChecks !== value.checks ||
    value.behavioralFailures !== value.failedChecks ||
    !failuresAreValid(value.failures) ||
    value.failures.length !== value.failedChecks ||
    !Number.isFinite(Date.parse(value.startedAt)) ||
    !Number.isFinite(Date.parse(value.finishedAt)) ||
    Date.parse(value.finishedAt) < Date.parse(value.startedAt)
  ) {
    throw new RunResultValidationError(
      "RUN_RESULT_INVALID",
      "ShadowSpec run result counters or timestamps are inconsistent."
    );
  }
  const behavioral = value.terminalStatus === "behavioral_failed";
  const passed = value.terminalStatus === "passed";
  if (
    (passed && (
      value.checks === 0 ||
      value.failedChecks !== 0 ||
      value.checks !== value.plannedChecks ||
      value.scenariosCompleted !== value.scenarios ||
      value.fatalError !== null
    )) ||
    (behavioral && (
      value.failedChecks === 0 ||
      value.scenariosCompleted !== value.scenarios ||
      value.fatalError !== null
    )) ||
    (!passed && !behavioral && (
      !value.fatalError ||
      typeof value.fatalError !== "object" ||
      typeof value.fatalError.category !== "string" ||
      typeof value.fatalError.code !== "string" ||
      typeof value.fatalError.message !== "string" ||
      value.fatalError.code.length === 0 ||
      value.fatalError.message.length === 0 ||
      !FATAL_CATEGORIES.has(value.fatalError.category) ||
      Object.keys(value.fatalError).some((field) =>
        !["category", "code", "message"].includes(field)
      )
    ))
  ) {
    throw new RunResultValidationError(
      "RUN_RESULT_INVALID",
      "ShadowSpec terminal state is inconsistent with its result."
    );
  }
  if (
    value.fatalError !== null &&
    TERMINAL_FATAL_CATEGORIES[value.terminalStatus] !==
      value.fatalError.category
  ) {
    throw new RunResultValidationError(
      "RUN_RESULT_INVALID",
      "ShadowSpec terminal status and fatal error category are inconsistent."
    );
  }
  if (expectedIdentity) {
    const fields = [
      "runId",
      "repository",
      "commitSha",
      "sourceHeadSha",
      "workflowRunId",
      "runAttempt",
      "projectId"
    ];
    if (fields.some((field) => value[field] !== expectedIdentity[field])) {
      throw new RunResultValidationError(
        "RUN_RESULT_IDENTITY_MISMATCH",
        "ShadowSpec run result belongs to a different execution."
      );
    }
  }
  return value;
}

function writeJsonAtomically(filePath, value, fileSystem = fs) {
  fileSystem.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`
  );
  let descriptor;
  try {
    descriptor = fileSystem.openSync(temporaryPath, "wx");
    fileSystem.writeFileSync(descriptor, JSON.stringify(value, null, 2));
    fileSystem.fsyncSync(descriptor);
    fileSystem.closeSync(descriptor);
    descriptor = undefined;
    fileSystem.renameSync(temporaryPath, filePath);
  } catch (error) {
    if (descriptor !== undefined) {
      try { fileSystem.closeSync(descriptor); } catch {}
    }
    try { fileSystem.unlinkSync(temporaryPath); } catch {}
    throw error;
  }
}

function failureResult(identity, code, message, now = new Date()) {
  const timestamp = now.toISOString();
  return {
    version: 1,
    reportSource: "shadowspec-replay",
    reportVersion: 1,
    ...identity,
    startedAt: timestamp,
    finishedAt: timestamp,
    terminalStatus: "infrastructure_failed",
    scenarios: 0,
    scenariosCompleted: 0,
    plannedChecks: 0,
    checks: 0,
    passedChecks: 0,
    failedChecks: 0,
    behavioralFailures: 0,
    failures: [],
    fatalError: {
      category: "infrastructure",
      code,
      message
    }
  };
}

module.exports = {
  RunResultValidationError,
  expectedIdentityFromEnvironment,
  failureResult,
  getRunResultPath,
  validateRunResult,
  writeJsonAtomically
};
