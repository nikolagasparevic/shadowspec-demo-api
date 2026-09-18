import fs from "fs";
import { loadScenarios } from "./load-scenarios";
import { replayRequest } from "./replay";
import { compareResponses } from "./compare";
import {
  createReport,
  type ShadowSpecReport
} from "./report";
import { applyReplaySetup } from "./setup-replay";
import { preflightReplaySafety } from "./replay-safety";
import { verifyReplayTarget } from "./replay-target-safety";
import {
  captureBindings,
  LifecycleBindingError,
  preflightLifecycleBindings,
  resolveBindingReferences,
  type BindingStore
} from "./lifecycle-bindings";

export type ReplayDependencies = {
  loadScenarios: typeof loadScenarios;
  replayRequest: typeof replayRequest;
  applyReplaySetup: typeof applyReplaySetup;
  preflightReplaySafety: typeof preflightReplaySafety;
  verifyReplayTarget: typeof verifyReplayTarget;
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
  writeReportFile: (path, contents) => {
    fs.writeFileSync(path, contents);
  },
  log: (...values) => {
    console.log(...values);
  }
};

export async function runReplay(
  overrides: Partial<ReplayDependencies> = {}
) {
  const dependencies: ReplayDependencies = {
    ...defaultDependencies,
    ...overrides
  };
  let passed = 0;
  let failed = 0;

  const failures:
    ShadowSpecReport["failures"] = [];

  await dependencies.preflightReplaySafety();
  await dependencies.verifyReplayTarget();

  const scenarios =
    dependencies.loadScenarios();

  if (scenarios.length === 0) {
    dependencies.log("No scenarios found.");
    return;
  }

  for (const [index, scenario] of scenarios.entries()) {
    dependencies.log(
      `\n=== Scenario ${index + 1} ===`
    );

    await dependencies.verifyReplayTarget();

    await dependencies.applyReplaySetup(
      scenario.setup
    );

    const steps = scenario.steps ?? [
      {
        request: scenario.request,
        expected: scenario.expected,
        dynamicFields:
          scenario.dynamicFields ?? []
      }
    ];

    const bindings: BindingStore =
      new Map();

    for (const [stepIndex, step] of steps.entries()) {
      const isLifecycle =
        scenario.steps !== undefined;

      if (isLifecycle) {
        dependencies.log(
          `\n--- Step ${stepIndex + 1} ---`
        );
      }

      dependencies.log("Original:");
      dependencies.log(step);

      try {
        const resolvedPathParams =
          isLifecycle
            ? preflightLifecycleBindings(
                step.request.pathParams ?? {},
                step.expected.body,
                step.capture,
                bindings
              )
            : (step.request.pathParams as
                | Record<string, string>
                | undefined) ?? {};

        const result =
          await dependencies.replayRequest(
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
          step.dynamicFields ?? [],
          capturePointers
        );

        dependencies.log("Comparison:");
        dependencies.log(comparison);

        if (comparison.passed) {
          passed++;
        } else {
          failed++;

          failures.push({
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

        failed++;

        failures.push({
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
    `Checks:    ${passed + failed}`
  );
  dependencies.log(`Passed:    ${passed}`);
  dependencies.log(`Failed:    ${failed}`);

  if (failures.length > 0) {
    dependencies.log("\nFailures:");

    for (const failure of failures) {
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

  const report = createReport(
    scenarios.length,
    passed + failed,
    passed,
    failed,
    failures
  );

  dependencies.writeReportFile(
    "shadowspec-report.json",
    JSON.stringify(report, null, 2)
  );

  dependencies.log("\nShadowSpec Report:");
  dependencies.log(
    JSON.stringify(report, null, 2)
  );

  if (failed > 0) {
    throw new Error(
      `ShadowSpec detected ${failed} regression(s).`
    );
  }
}

if (require.main === module) {
  runReplay().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
