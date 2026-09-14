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
    differences: any[];
  }[] = [];

  const scenarios = loadScenarios();

  if (scenarios.length === 0) {
    console.log("No scenarios found.");
    return;
  }

  for (const [index, scenario] of scenarios.entries()) {
    console.log(`\n=== Scenario ${index + 1} ===`);

    console.log("Original:");
    console.log(scenario);

    await applyReplaySetup(scenario.setup);

    const result = await replayRequest(
      scenario.request.method,
      scenario.request.path,
      scenario.request.body
    );

    console.log("Replay:");
    console.log(result);

    const comparison = compareResponses(
      scenario.expected.body,
      result.body,
      scenario.expected.status,
      result.status
    );

    console.log("Comparison:");
    console.log(comparison);

    if (comparison.passed) {
      passed++;
    } else {
      failed++;

      failures.push({
        scenario: index + 1,
        differences: comparison.differences
      });
    }
  }

  console.log("\n================================");
  console.log("ShadowSpec Replay Summary");
  console.log("================================");
  console.log(`Scenarios: ${scenarios.length}`);
  console.log(`Passed:    ${passed}`);
  console.log(`Failed:    ${failed}`);

  if (failures.length > 0) {
    console.log("\nFailures:");

    for (const failure of failures) {
      console.log(`\n❌ Scenario ${failure.scenario}`);

      for (const difference of failure.differences) {
        console.log(
          `   ${difference.field}: ${JSON.stringify(difference.expected)} → ${JSON.stringify(difference.actual)}`
        );
      }
    }
  }

  console.log("================================");

  const report = createReport(
    scenarios.length,
    passed,
    failed,
    failures
  );

  fs.writeFileSync(
    "shadowspec-report.json",
    JSON.stringify(report, null, 2)
  );

  console.log("\nShadowSpec Report:");
  console.log(JSON.stringify(report, null, 2));

  if (failed > 0) {
    throw new Error(`ShadowSpec detected ${failed} regression(s).`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});