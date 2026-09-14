import { sanitizeObject } from "./sanitize";
import fs from "fs";
import { getScenarios } from "./scenario";

async function main() {
  const scenarios = await getScenarios();

  if (scenarios.length === 0) {
    console.log("No scenarios found.");
    return;
  }

  const output = scenarios.map((scenario, index) => ({
    id: index + 1,
    method: scenario.method,
    path: scenario.path,
    requestBody: scenario.request_body,
    expectedStatus: scenario.response_status,
    expectedBody: sanitizeObject(scenario.response_body)
  }));

  fs.writeFileSync(
    "shadowspec-scenarios.json",
    JSON.stringify(output, null, 2)
  );

  console.log(
    `Exported ${output.length} ShadowSpec scenario(s).`
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});