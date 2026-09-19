import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  afterEach,
  describe,
  expect,
  it
} from "vitest";
import type { ShadowSpecRunResult } from "../src/run-result";

const {
  finalizeShadowSpecRun
}: {
  finalizeShadowSpecRun: (options?: {
    environment?: NodeJS.ProcessEnv;
  }) => {
    resultPath: string;
    result: ShadowSpecRunResult;
  };
} = require(
  "../.github/scripts/finalize-shadowspec-run.cjs"
);

const directories: string[] = [];

function temporaryDirectory() {
  const value = fs.mkdtempSync(
    path.join(os.tmpdir(), "shadowspec-finalizer-")
  );
  directories.push(value);
  return value;
}

function environment(directory: string): NodeJS.ProcessEnv {
  return {
    SHADOWSPEC_RUN_ID: "321.1.replay",
    SHADOWSPEC_REPOSITORY: "example/shadowspec",
    SHADOWSPEC_COMMIT_SHA:
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    SHADOWSPEC_SOURCE_HEAD_SHA:
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    SHADOWSPEC_WORKFLOW_RUN_ID: "321",
    SHADOWSPEC_RUN_ATTEMPT: "1",
    SHADOWSPEC_RESULTS_DIRECTORY: directory
  };
}

function validResult(
  overrides: Partial<ShadowSpecRunResult> = {}
): ShadowSpecRunResult {
  return {
    version: 2,
    reportSource: "shadowspec-replay",
    reportVersion: 2,
    runId: "321.1.replay",
    repository: "example/shadowspec",
    commitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    sourceHeadSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    workflowRunId: "321",
    runAttempt: 1,
    exportId: "a".repeat(64),
    coverage: {
      inputCaptures: 1,
      executableCaptures: 1,
      rejectedCaptures: 0,
      excludedCaptures: 0,
      complete: true
    },
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:01.000Z",
    terminalStatus: "passed",
    scenarios: 1,
    scenariosCompleted: 1,
    plannedChecks: 1,
    checks: 1,
    passedChecks: 1,
    failedChecks: 0,
    behavioralFailures: 0,
    failures: [],
    fatalError: null,
    ...overrides
  };
}

function resultPath(directory: string) {
  return path.join(
    directory,
    "shadowspec-run-321.1.replay.json"
  );
}

afterEach(() => {
  for (const value of directories.splice(0)) {
    fs.rmSync(value, { recursive: true, force: true });
  }
});

describe("workflow run finalizer", () => {
  it("accepts a valid current-run result", () => {
    const directory = temporaryDirectory();
    fs.writeFileSync(
      resultPath(directory),
      JSON.stringify(validResult())
    );
    const finalized = finalizeShadowSpecRun({
      environment: {
        ...environment(directory),
        SHADOWSPEC_REPLAY_EXIT_CODE: "0"
      }
    });
    expect(finalized.result.terminalStatus).toBe("passed");
  });

  it("preserves a valid behavioral failure after replay exits nonzero", () => {
    const directory = temporaryDirectory();
    fs.writeFileSync(
      resultPath(directory),
      JSON.stringify(validResult({
        terminalStatus: "behavioral_failed",
        passedChecks: 0,
        failedChecks: 1,
        behavioralFailures: 1,
        failures: [{
          scenario: 1,
          method: "GET",
          path: "/resource",
          queryParams: {},
          differences: [{ field: "body", expected: 1, actual: 2 }]
        }]
      }))
    );
    const finalized = finalizeShadowSpecRun({
      environment: {
        ...environment(directory),
        SHADOWSPEC_REPLAY_EXIT_CODE: "1"
      }
    });
    expect(finalized.result.terminalStatus)
      .toBe("behavioral_failed");
  });

  it("synthesizes a current-run failure when output is missing", () => {
    const directory = temporaryDirectory();
    const finalized = finalizeShadowSpecRun({
      environment: environment(directory)
    });
    expect(finalized.result).toMatchObject({
      runId: "321.1.replay",
      commitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      terminalStatus: "infrastructure_failed",
      fatalError: { code: "RUN_RESULT_MISSING" }
    });
  });

  it("preserves the specific missing-result code despite a zero replay exit", () => {
    const directory = temporaryDirectory();
    const finalized = finalizeShadowSpecRun({
      environment: {
        ...environment(directory),
        SHADOWSPEC_REPLAY_EXIT_CODE: "0"
      }
    });
    expect(finalized.result.fatalError?.code)
      .toBe("RUN_RESULT_MISSING");
  });

  it("replaces malformed output with a current-run failure", () => {
    const directory = temporaryDirectory();
    fs.writeFileSync(resultPath(directory), "not json");
    const finalized = finalizeShadowSpecRun({
      environment: environment(directory)
    });
    expect(finalized.result.fatalError?.code)
      .toBe("RUN_RESULT_INVALID");
    expect(() => JSON.parse(
      fs.readFileSync(resultPath(directory), "utf8")
    )).not.toThrow();
  });

  it("replaces mismatched identity instead of accepting stale green", () => {
    const directory = temporaryDirectory();
    fs.writeFileSync(
      resultPath(directory),
      JSON.stringify(validResult({ commitSha: "stale-sha" }))
    );
    const finalized = finalizeShadowSpecRun({
      environment: environment(directory)
    });
    expect(finalized.result).toMatchObject({
      commitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      terminalStatus: "infrastructure_failed",
      fatalError: { code: "RUN_RESULT_IDENTITY_MISMATCH" }
    });
  });

  it("preserves identity-mismatch attribution despite a zero replay exit", () => {
    const directory = temporaryDirectory();
    fs.writeFileSync(
      resultPath(directory),
      JSON.stringify(validResult({ commitSha: "stale-sha" }))
    );
    const finalized = finalizeShadowSpecRun({
      environment: {
        ...environment(directory),
        SHADOWSPEC_REPLAY_EXIT_CODE: "0"
      }
    });
    expect(finalized.result.fatalError?.code)
      .toBe("RUN_RESULT_IDENTITY_MISMATCH");
  });

  it("represents prerequisite failure before replay", () => {
    const directory = temporaryDirectory();
    const finalized = finalizeShadowSpecRun({
      environment: {
        ...environment(directory),
        SHADOWSPEC_PREREQUISITE_FAILED: "true"
      }
    });
    expect(finalized.result.fatalError?.code)
      .toBe("WORKFLOW_PREREQUISITE_FAILED");
  });

  it("fails closed when replay exit and terminal status disagree", () => {
    const directory = temporaryDirectory();
    fs.writeFileSync(
      resultPath(directory),
      JSON.stringify(validResult())
    );
    const finalized = finalizeShadowSpecRun({
      environment: {
        ...environment(directory),
        SHADOWSPEC_REPLAY_EXIT_CODE: "1"
      }
    });
    expect(finalized.result.fatalError?.code)
      .toBe("RUN_RESULT_INVALID");
  });
});
