import { loadScenarios } from "./load-scenarios";
import { replayRequest } from "./replay";
import { compareResponses } from "./compare";
import { applyReplaySetup } from "./setup-replay";
import { preflightReplaySafety } from "./replay-safety";
import { verifyReplayTarget } from "./replay-target-safety";
import { validateScenarios } from "./scenario-validation";
import { validateScenarioBundle } from "./scenario-bundle";
import {
  captureBindings,
  LifecycleBindingError,
  preflightLifecycleBindings,
  resolveBindingReferences,
  type BindingStore
} from "./lifecycle-bindings";
import {
  classifyRunError,
  createInterruptedResult,
  createRunResult,
  getRunResultPath,
  invalidateRunResult,
  parseRunIdentity,
  publishRunResultAtomically,
  type RunIdentity,
  type RunProgress,
  type ShadowSpecRunResult
} from "./run-result";

export type ReplayDependencies = {
  loadScenarios: typeof loadScenarios;
  replayRequest: typeof replayRequest;
  applyReplaySetup: typeof applyReplaySetup;
  preflightReplaySafety: typeof preflightReplaySafety;
  verifyReplayTarget: typeof verifyReplayTarget;
  environment: NodeJS.ProcessEnv;
  identity?: RunIdentity;
  now: () => Date;
  invalidateReportFile: (path: string) => void;
  writeReportFile: (
    path: string,
    contents: string
  ) => void;
  log: (...values: unknown[]) => void;
};

const defaultDependencies:
  ReplayDependencies = {
  loadScenarios,
  replayRequest,
  applyReplaySetup,
  preflightReplaySafety,
  verifyReplayTarget,
  environment: process.env,
  now: () => new Date(),
  invalidateReportFile: invalidateRunResult,
  writeReportFile: (path, contents) => {
    publishRunResultAtomically(
      path,
      JSON.parse(contents) as ShadowSpecRunResult
    );
  },
  log: (...values) => {
    console.log(...values);
  }
};

export async function runReplay(
  overrides: Partial<ReplayDependencies> = {}
): Promise<ShadowSpecRunResult> {
  const dependencies: ReplayDependencies = {
    ...defaultDependencies,
    ...overrides
  };
  const identity = dependencies.identity ??
    parseRunIdentity(dependencies.environment);
  const resultPath = getRunResultPath(identity);
  const startedAt = dependencies.now().toISOString();
  const progress: RunProgress = {
    exportId: null,
    coverage: null,
    scenarios: 0,
    scenariosCompleted: 0,
    plannedChecks: 0,
    passedChecks: 0,
    failedChecks: 0,
    failures: []
  };
  let caughtError: unknown;
  let terminalStatus: ShadowSpecRunResult["terminalStatus"] =
    "passed";
  let fatalError: ShadowSpecRunResult["fatalError"] = null;

  dependencies.invalidateReportFile(resultPath);

  try {
    await dependencies.preflightReplaySafety();

    const bundle = validateScenarioBundle(
      dependencies.loadScenarios(
        dependencies.environment
      ),
      dependencies.environment.SHADOWSPEC_PROJECT_ID
    );
    const scenarios = bundle.scenarios;
    progress.exportId = bundle.exportId;
    progress.coverage = {
      inputCaptures: bundle.input.captureCount,
      executableCaptures: bundle.coverage.executableCaptures,
      rejectedCaptures: bundle.coverage.rejectedCaptures,
      excludedCaptures: bundle.coverage.excludedCaptures,
      complete: bundle.coverage.complete
    };
    progress.scenarios = scenarios.length;
    progress.plannedChecks = scenarios.reduce(
      (total, scenario) =>
        total + (scenario.steps?.length ?? 1),
      0
    );

    validateScenarios(scenarios);
    await dependencies.verifyReplayTarget();

    for (const [index, scenario] of scenarios.entries()) {
      dependencies.log(
        `\n=== Scenario ${index + 1} ===`
      );

      await dependencies.verifyReplayTarget();
      await dependencies.applyReplaySetup(scenario.setup);

      const steps = scenario.steps ?? [
        {
          request: scenario.request,
          expected: scenario.expected,
          comparison: scenario.comparison
        }
      ];
      const bindings: BindingStore = new Map();

      for (const [stepIndex, step] of steps.entries()) {
        const isLifecycle = scenario.steps !== undefined;

        if (isLifecycle) {
          dependencies.log(
            `\n--- Step ${stepIndex + 1} ---`
          );
        }

        dependencies.log("Original:");
        dependencies.log(step);

        try {
          const resolvedPathParams = isLifecycle
            ? preflightLifecycleBindings(
                step.request.pathParams ?? {},
                step.expected.body,
                step.capture,
                bindings
              )
            : (step.request.pathParams as
                | Record<string, string>
                | undefined) ?? {};

          const result = await dependencies.replayRequest(
            step.request.method,
            step.request.path,
            step.request.body,
            resolvedPathParams,
            step.request.queryParams ?? {}
          );

          dependencies.log("Replay:");
          dependencies.log(result);

          const capturePointers =
            isLifecycle && step.capture
              ? captureBindings(
                  step.capture,
                  result.body,
                  bindings
                )
              : [];
          const expectedBody = isLifecycle
            ? resolveBindingReferences(
                step.expected.body,
                bindings
              )
            : step.expected.body;
          const comparison = compareResponses(
            expectedBody,
            result.body,
            step.expected.status,
            result.status,
            step.comparison?.ignoredValues ?? [],
            capturePointers
          );

          dependencies.log("Comparison:");
          dependencies.log(comparison);

          if (comparison.passed) {
            progress.passedChecks++;
          } else {
            progress.failedChecks++;
            progress.failures.push({
              scenario: index + 1,
              step: isLifecycle
                ? stepIndex + 1
                : undefined,
              method: step.request.method,
              path: step.request.path,
              queryParams:
                step.request.queryParams ?? {},
              differences: comparison.differences
            });
          }
        } catch (error) {
          if (
            !isLifecycle ||
            !(error instanceof LifecycleBindingError)
          ) {
            throw error;
          }

          progress.failedChecks++;
          progress.failures.push({
            scenario: index + 1,
            step: stepIndex + 1,
            method: step.request.method,
            path: step.request.path,
            queryParams:
              step.request.queryParams ?? {},
            kind: "binding",
            code: error.code,
            message: error.message,
            differences: []
          });
          break;
        }
      }

      progress.scenariosCompleted++;
    }

    if (progress.passedChecks + progress.failedChecks === 0) {
      terminalStatus = "configuration_failed";
      fatalError = {
        category: "configuration",
        code: "NO_EXECUTABLE_SCENARIOS",
        message: "ShadowSpec found no executable behavioral checks."
      };
    } else if (progress.failedChecks > 0) {
      terminalStatus = "behavioral_failed";
    }
  } catch (error) {
    caughtError = error;
    const classified = classifyRunError(error);
    terminalStatus = classified.terminalStatus;
    fatalError = classified.fatalError;
  }

  dependencies.log(
    "\n================================"
  );
  dependencies.log(
    "ShadowSpec Replay Summary"
  );
  dependencies.log(
    "================================"
  );
  dependencies.log(
    `Checks:    ${progress.passedChecks + progress.failedChecks}`
  );
  dependencies.log(`Passed:    ${progress.passedChecks}`);
  dependencies.log(`Failed:    ${progress.failedChecks}`);

  if (progress.failures.length > 0) {
    dependencies.log("\nFailures:");

    for (const failure of progress.failures) {
      const queryString = new URLSearchParams(
        failure.queryParams
      ).toString();

      const fullPath = queryString
        ? `${failure.path}?${queryString}`
        : failure.path;

      const stepLabel =
        failure.step !== undefined
          ? ` / Step ${failure.step}`
          : "";

      dependencies.log(
        `\n❌ Scenario ${failure.scenario}${stepLabel}`
      );

      dependencies.log(
        `   ${failure.method} ${fullPath}`
      );

      if (failure.kind === "binding") {
        dependencies.log(
          `\n   Binding ${failure.code}: ${failure.message}`
        );
        continue;
      }

      for (const difference of failure.differences) {
        dependencies.log(
          `\n   ${difference.field}:`
        );
        dependencies.log(
          `   Expected: ${JSON.stringify(
            difference.expected
          )}`
        );
        dependencies.log(
          `   Actual:   ${JSON.stringify(
            difference.actual
          )}`
        );
      }
    }
  }

  dependencies.log("================================");

  const result = createRunResult(
    identity,
    startedAt,
    dependencies.now().toISOString(),
    terminalStatus,
    progress,
    fatalError
  );

  dependencies.writeReportFile(
    resultPath,
    JSON.stringify(result, null, 2)
  );

  dependencies.log("\nShadowSpec Run Result:");
  dependencies.log(
    JSON.stringify(result, null, 2)
  );

  if (terminalStatus !== "passed") {
    if (caughtError !== undefined) {
      throw caughtError;
    }
    throw new Error(
      fatalError?.code === "NO_EXECUTABLE_SCENARIOS"
        ? fatalError.message
        : `ShadowSpec detected ${progress.failedChecks} regression(s).`
    );
  }

  return result;
}

if (require.main === module) {
  try {
    const identity = parseRunIdentity(process.env);
    const startedAt = new Date().toISOString();
    let interrupted = false;
    const handleSignal = (signal: NodeJS.Signals) => {
      if (interrupted) {
        return;
      }
      interrupted = true;
      try {
        const result = createInterruptedResult(
          identity,
          startedAt,
          new Date().toISOString(),
          {
            exportId: null,
            coverage: null,
            scenarios: 0,
            scenariosCompleted: 0,
            plannedChecks: 0,
            passedChecks: 0,
            failedChecks: 0,
            failures: []
          }
        );
        publishRunResultAtomically(
          getRunResultPath(identity),
          result
        );
      } catch {
        console.error(
          "RUN_RESULT_WRITE_FAILED: ShadowSpec could not publish an interrupted run result."
        );
      }
      process.exit(signal === "SIGINT" ? 130 : 143);
    };

    process.once("SIGINT", handleSignal);
    process.once("SIGTERM", handleSignal);

    runReplay({ identity }).catch((error) => {
      if (
        error instanceof Error &&
        (error.message.startsWith("ShadowSpec detected ") ||
          error.message ===
            "ShadowSpec found no executable behavioral checks.")
      ) {
        console.error(error.message);
        process.exitCode = 1;
        return;
      }
      const classified = classifyRunError(error);
      console.error(
        `${classified.fatalError.code}: ${classified.fatalError.message}`
      );
      process.exitCode = 1;
    });
  } catch (error) {
    const classified = classifyRunError(error);
    console.error(
      `${classified.fatalError.code}: ${classified.fatalError.message}`
    );
    process.exitCode = 1;
  }
}
