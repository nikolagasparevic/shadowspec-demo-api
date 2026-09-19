import type { ShadowSpecScenario } from "../../src/load-scenarios";
import {
  createScenarioBundle,
  hashCaptureIds,
  type CaptureDisposition
} from "../../src/scenario-bundle";

export function scenarioBundle(
  scenarios: ShadowSpecScenario[],
  projectId = "test-project"
) {
  let captureId = 0;
  const dispositions: CaptureDisposition[] = [];

  for (const scenario of scenarios) {
    if (scenario.steps) {
      scenario.steps.forEach((_, index) => {
        captureId++;
        dispositions.push({
          captureId,
          disposition: "EXECUTABLE_LIFECYCLE_STEP",
          method: scenario.steps![index].request.method,
          safePath: scenario.steps![index].request.path,
          scenarioId: scenario.id,
          step: index + 1,
          checkCount: 1
        });
      });
    } else {
      captureId++;
      dispositions.push({
        captureId,
        disposition: "EXECUTABLE_STANDALONE",
        method: scenario.request.method,
        safePath: scenario.request.path,
        scenarioId: scenario.id,
        checkCount: 1
      });
    }
  }

  const captureIds = dispositions.map(({ captureId: id }) => id);
  return createScenarioBundle(
    {
      projectId,
      isolation: "repeatable-read",
      maxVisibleCaptureId: captureIds.at(-1) ?? null,
      captureCount: captureIds.length,
      captureIdsSha256: hashCaptureIds(captureIds)
    },
    {
      complete: true,
      executableCaptures: captureIds.length,
      rejectedCaptures: 0,
      excludedCaptures: 0,
      checkCount: captureIds.length,
      dispositions
    },
    scenarios
  );
}
