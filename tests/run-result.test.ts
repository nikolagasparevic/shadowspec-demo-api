import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  afterEach,
  describe,
  expect,
  it
} from "vitest";
import {
  classifyRunError,
  createRunResult,
  getRunResultPath,
  invalidateRunResult,
  parseRunIdentity,
  publishRunResultAtomically,
  RunResultError,
  validateRunResult,
  type RunIdentity,
  type RunProgress,
  type RunTerminalStatus
} from "../src/run-result";
import { ReplaySafetyError } from "../src/replay-safety";
import {
  ReplayTargetSafetyError
} from "../src/replay-target-safety";
import {
  ScenarioConfigurationError
} from "../src/scenario-validation";
import { ReplayCapabilityError } from "../src/replay-capabilities";
import { ReplayRequestError } from "../src/replay";

const directories: string[] = [];
const identity: RunIdentity = {
  runId: "123.2.replay",
  repository: "example/shadowspec",
  commitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  sourceHeadSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  workflowRunId: "123",
  runAttempt: 2,
  projectId: "8ef76468-72f9-4df4-a263-a4f88540e877"
};
const emptyProgress = (): RunProgress => ({
  exportId: null,
  coverage: null,
  scenarios: 0,
  scenariosCompleted: 0,
  plannedChecks: 0,
  passedChecks: 0,
  failedChecks: 0,
  failures: []
});

function completeProgress(checks = 1): RunProgress {
  return {
    ...emptyProgress(),
    exportId: "a".repeat(64),
    coverage: {
      inputCaptures: checks,
      executableCaptures: checks,
      rejectedCaptures: 0,
      excludedCaptures: 0,
      complete: true
    },
    scenarios: checks,
    scenariosCompleted: checks,
    plannedChecks: checks,
    passedChecks: checks
  };
}

function directory() {
  const value = fs.mkdtempSync(
    path.join(os.tmpdir(), "shadowspec-run-result-")
  );
  directories.push(value);
  return value;
}

afterEach(() => {
  for (const value of directories.splice(0)) {
    fs.rmSync(value, { recursive: true, force: true });
  }
});

describe("run identity", () => {
  it("parses complete CI identity", () => {
    expect(parseRunIdentity({
      SHADOWSPEC_RUN_ID: identity.runId,
      SHADOWSPEC_REPOSITORY: identity.repository,
      SHADOWSPEC_COMMIT_SHA: identity.commitSha,
      SHADOWSPEC_SOURCE_HEAD_SHA: identity.sourceHeadSha,
      SHADOWSPEC_WORKFLOW_RUN_ID: identity.workflowRunId,
      SHADOWSPEC_RUN_ATTEMPT: "2",
      SHADOWSPEC_PROJECT_ID: identity.projectId
    })).toEqual(identity);
  });

  it("creates a local identity without GitHub fields", () => {
    expect(parseRunIdentity(
      {},
      () => "local-id",
      () => "local-sha"
    )).toEqual({
      runId: "local-id",
      repository: "local",
      commitSha: "local-sha",
      runAttempt: 1
    });
  });

  it("rejects incomplete or path-like identities", () => {
    expect(() => parseRunIdentity({
      SHADOWSPEC_RUN_ID: "../escape"
    })).toThrow();
    expect(() => parseRunIdentity({
      SHADOWSPEC_RUN_ID: "123.1.replay"
    })).toThrow("SHADOWSPEC_RUN_ATTEMPT");
  });
});

describe("terminal run results", () => {
  it.each<RunTerminalStatus>([
    "safety_failed",
    "configuration_failed",
    "infrastructure_failed",
    "internal_failed",
    "interrupted",
    "cancelled"
  ])("validates %s", (terminalStatus) => {
    const result = createRunResult(
      identity,
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:01.000Z",
      terminalStatus,
      emptyProgress(),
      {
        category: terminalStatus === "safety_failed"
          ? "safety"
          : terminalStatus === "configuration_failed"
            ? "configuration"
            : terminalStatus === "internal_failed"
              ? "internal"
              : "infrastructure",
        code: "TEST_FAILURE",
        message: "Safe failure."
      }
    );
    expect(validateRunResult(result, identity).terminalStatus)
      .toBe(terminalStatus);
  });

  it("validates passed and behavioral terminal states", () => {
    const passedProgress = completeProgress();
    expect(createRunResult(
      identity,
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:01.000Z",
      "passed",
      passedProgress,
      null
    ).terminalStatus).toBe("passed");

    const failedProgress = { ...passedProgress };
    failedProgress.passedChecks = 0;
    failedProgress.failedChecks = 1;
    failedProgress.failures = [{
      scenario: 1,
      method: "GET",
      path: "/resource",
      queryParams: {},
      differences: [{ field: "body", expected: 1, actual: 2 }]
    }];
    expect(createRunResult(
      identity,
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:01.000Z",
      "behavioral_failed",
      failedProgress,
      null
    ).terminalStatus).toBe("behavioral_failed");
  });

  it("rejects zero-check success and identity mismatch", () => {
    expect(() => createRunResult(
      identity,
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:01.000Z",
      "passed",
      emptyProgress(),
      null
    )).toThrow("terminal state");

    const result = createRunResult(
      identity,
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:01.000Z",
      "configuration_failed",
      emptyProgress(),
      {
        category: "configuration",
        code: "NO_EXECUTABLE_SCENARIOS",
        message: "No checks."
      }
    );
    expect(() => validateRunResult(result, {
      ...identity,
      commitSha: "cccccccccccccccccccccccccccccccccccccccc"
    })).toThrow("expected execution");
    expect(() => validateRunResult(result, {
      ...identity,
      projectId: "different-project"
    })).toThrow("expected execution");
  });

  it("does not treat version-one or coverage-free results as authoritative", () => {
    const passed = createRunResult(
      identity,
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:01.000Z",
      "passed",
      completeProgress(),
      null
    );
    expect(() => validateRunResult({
      ...passed,
      version: 1,
      reportVersion: 1
    })).toThrow("version or source is unsupported");
    expect(() => validateRunResult({
      ...passed,
      exportId: null,
      coverage: null
    })).toThrow("terminal state");
  });

  it("rejects incomplete success and incomplete behavioral runs", () => {
    const passedProgress = completeProgress();
    const passed = createRunResult(
      identity,
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:01.000Z",
      "passed",
      passedProgress,
      null
    );
    expect(() => validateRunResult({
      ...passed,
      plannedChecks: 2
    })).toThrow("coverage does not match planned checks");

    const behavioral = {
      ...passed,
      terminalStatus: "behavioral_failed",
      passedChecks: 0,
      failedChecks: 1,
      behavioralFailures: 1,
      scenariosCompleted: 0,
      failures: [{
        scenario: 1,
        method: "GET",
        path: "/resource",
        queryParams: {},
        differences: [{ field: "body", expected: 1, actual: 2 }]
      }]
    };
    expect(() => validateRunResult(behavioral))
      .toThrow("terminal state");
  });

  it("rejects malformed failures and mismatched fatal categories", () => {
    const invalidFailure = {
      ...createRunResult(
        identity,
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:01.000Z",
        "behavioral_failed",
        {
          exportId: "a".repeat(64),
          coverage: {
            inputCaptures: 1,
            executableCaptures: 1,
            rejectedCaptures: 0,
            excludedCaptures: 0,
            complete: true
          },
          scenarios: 1,
          scenariosCompleted: 1,
          plannedChecks: 1,
          passedChecks: 0,
          failedChecks: 1,
          failures: [{
            scenario: 1,
            method: "GET",
            path: "/resource",
            queryParams: {},
            differences: [{ field: "body", expected: 1, actual: 2 }]
          }]
        },
        null
      ),
      failures: [{ scenario: 0 }]
    };
    expect(() => validateRunResult(invalidFailure))
      .toThrow("invalid failure");

    const wrongCategory = createRunResult(
      identity,
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:01.000Z",
      "safety_failed",
      emptyProgress(),
      {
        category: "safety",
        code: "TEST_FAILURE",
        message: "Safe failure."
      }
    );
    wrongCategory.fatalError = {
      category: "infrastructure",
      code: "TEST_FAILURE",
      message: "Safe failure."
    };
    expect(() => validateRunResult(wrongCategory))
      .toThrow("inconsistent");
  });

  it("preserves partial counters under a fatal state", () => {
    const progress = emptyProgress();
    progress.scenarios = 3;
    progress.scenariosCompleted = 2;
    progress.plannedChecks = 8;
    progress.passedChecks = 5;
    const result = createRunResult(
      identity,
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:01.000Z",
      "safety_failed",
      progress,
      {
        category: "safety",
        code: "REPLAY_TARGET_PROOF_INVALID",
        message: "Target refused."
      }
    );
    expect(result).toMatchObject({
      terminalStatus: "safety_failed",
      checks: 5,
      passedChecks: 5,
      failedChecks: 0
    });
  });
});

describe("run error classification", () => {
  it.each([
    [new ReplaySafetyError("REPLAY_TOKEN_MISMATCH", "Safe."), "safety_failed"],
    [new ReplaySafetyError("REPLAY_SAFETY_CONFIG_MISSING", "Safe."), "configuration_failed"],
    [new ReplayTargetSafetyError("REPLAY_TARGET_TIMEOUT", "Safe."), "infrastructure_failed"],
    [new ReplayCapabilityError("REPLAY_TABLE_DEPENDENCY_UNCONFIGURED", "Safe."), "safety_failed"],
    [new ScenarioConfigurationError("UNSAFE_LEGACY_DYNAMIC_FIELD", "Safe."), "configuration_failed"],
    [new ReplayRequestError(), "infrastructure_failed"],
    [new RunResultError("RUN_RESULT_WRITE_FAILED", "Safe."), "internal_failed"]
  ])("maps typed errors without losing their code", (error, status) => {
    expect(classifyRunError(error)).toMatchObject({
      terminalStatus: status,
      fatalError: { code: (error as { code: string }).code }
    });
  });

  it("sanitizes unknown errors", () => {
    const classified = classifyRunError(
      new Error("password=secret-token")
    );
    expect(classified).toEqual({
      terminalStatus: "internal_failed",
      fatalError: {
        category: "internal",
        code: "UNEXPECTED_INTERNAL_ERROR",
        message: "ShadowSpec encountered an unexpected internal error."
      }
    });
    expect(JSON.stringify(classified)).not.toContain("secret-token");
  });
});

describe("atomic run-result publication", () => {
  it("invalidates an old same-run file and publishes complete JSON", () => {
    const base = directory();
    const resultPath = getRunResultPath(identity, base);
    fs.mkdirSync(path.dirname(resultPath), { recursive: true });
    fs.writeFileSync(resultPath, "old green");
    invalidateRunResult(resultPath);
    expect(fs.existsSync(resultPath)).toBe(false);

    const result = createRunResult(
      identity,
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:01.000Z",
      "configuration_failed",
      emptyProgress(),
      {
        category: "configuration",
        code: "NO_EXECUTABLE_SCENARIOS",
        message: "No checks."
      }
    );
    publishRunResultAtomically(resultPath, result);
    expect(JSON.parse(fs.readFileSync(resultPath, "utf8")))
      .toEqual(result);
    expect(fs.readdirSync(base).some((name) => name.endsWith(".tmp")))
      .toBe(false);
  });

  it("cleans temporary state and reports publication failure", () => {
    const base = directory();
    const resultPath = getRunResultPath(identity, base);
    const result = createRunResult(
      identity,
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:01.000Z",
      "configuration_failed",
      emptyProgress(),
      {
        category: "configuration",
        code: "NO_EXECUTABLE_SCENARIOS",
        message: "No checks."
      }
    );
    expect(() => publishRunResultAtomically(
      resultPath,
      result,
      {
        mkdirSync: fs.mkdirSync,
        openSync: fs.openSync,
        writeFileSync: fs.writeFileSync,
        fsyncSync: fs.fsyncSync,
        closeSync: fs.closeSync,
        unlinkSync: fs.unlinkSync,
        renameSync: () => {
          throw new Error("rename failed");
        }
      }
    )).toThrow("atomically publish");
    expect(fs.existsSync(resultPath)).toBe(false);
    expect(fs.readdirSync(base).some((name) => name.endsWith(".tmp")))
      .toBe(false);
  });
});
