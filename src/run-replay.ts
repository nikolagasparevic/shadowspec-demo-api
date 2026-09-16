import fs from "fs";
import { loadScenarios } from "./load-scenarios";
import { replayRequest } from "./replay";
import { compareResponses } from "./compare";
import { createReport } from "./report";
import { applyReplaySetup } from "./setup-replay";

async function main() {
  let passed = 0;
  let failed = 0;

  const failures: {
    scenario: number;
    step?: number;
    method: string;
    path: string;
    queryParams: Record<string, string>;
    differences: any[];
  }[] = [];

  const scenarios = loadScenarios();

  if (scenarios.length === 0) {
    console.log("No scenarios found.");
    return;
  }

  for (const [index, scenario] of scenarios.entries()) {
    console.log(`\n=== Scenario ${index + 1} ===`);

    await applyReplaySetup(scenario.setup);

    const steps = scenario.steps ?? [
      {
        request: scenario.request,
        expected: scenario.expected,
        dynamicFields:
          scenario.dynamicFields ?? []
      }
    ];

    for (const [stepIndex, step] of steps.entries()) {
      const isLifecycle =
        scenario.steps !== undefined;

      if (isLifecycle) {
        console.log(
          `\n--- Step ${stepIndex + 1} ---`
        );
      }

      console.log("Original:");
      console.log(step);

      const result = await replayRequest(
        step.request.method,
        step.request.path,
        step.request.body,
        step.request.pathParams ?? {},
        step.request.queryParams ?? {}
      );

      console.log("Replay:");
      console.log(result);

      const comparison = compareResponses(
        step.expected.body,
        result.body,
        step.expected.status,
        result.status,
        step.dynamicFields ?? []
      );

      console.log("Comparison:");
      console.log(comparison);

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
    }
  }

  console.log("\n================================");
  console.log("ShadowSpec Replay Summary");
  console.log("================================");
  console.log(`Checks:    ${passed + failed}`);
  console.log(`Passed:    ${passed}`);
  console.log(`Failed:    ${failed}`);

  if (failures.length > 0) {
    console.log("\nFailures:");

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

      console.log(
        `\n❌ Scenario ${failure.scenario}${stepLabel}`
      );

      console.log(
        `   ${failure.method} ${fullPath}`
      );

      for (const difference of failure.differences) {
        console.log(`\n   ${difference.field}:`);
        console.log(
          `   Expected: ${JSON.stringify(
            difference.expected
          )}`
        );
        console.log(
          `   Actual:   ${JSON.stringify(
            difference.actual
          )}`
        );
      }
    }
  }

  console.log("================================");

const report = createReport(
  scenarios.length,
  passed + failed,
  passed,
  failed,
  failures
);

  fs.writeFileSync(
    "shadowspec-report.json",
    JSON.stringify(report, null, 2)
  );

  console.log("\nShadowSpec Report:");
  console.log(
    JSON.stringify(report, null, 2)
  );

  if (failed > 0) {
    throw new Error(
      `ShadowSpec detected ${failed} regression(s).`
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});