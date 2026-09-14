import fs from "fs";
import { getScenarioGroups } from "./scenario";
import { sanitizeObject } from "./sanitize";
import { detectDynamicFields } from "./dynamic-fields";


async function main() {
  const scenarioGroups = await getScenarioGroups();

  if (scenarioGroups.length === 0) {
    console.log("No scenarios found.");
    return;
  }

  const output = scenarioGroups.map((group, index) => {
    const baseline = group.responses[0];

    const outputScenario: any = {
      id: index + 1,

      request: {
        method: group.method,
        path: group.path,
        body: sanitizeObject(group.requestBody)
      },

      expected: {
        status: baseline.status,
        body: sanitizeObject(baseline.body)
      }
    };

    const dynamicFields = detectDynamicFields(
      group.responses.map((response) => response.body)
    );

    if (dynamicFields.length > 0) {
      outputScenario.dynamicFields = dynamicFields;
    }

    if (
      group.method === "GET" &&
      group.path === "/orders" &&
      Array.isArray(baseline.body)
    ) {
      outputScenario.setup = {
        orders: baseline.body.map((order: any) => ({
          customerId: order.customerId,
          productId: order.productId,
          quantity: order.quantity,
          status: order.status
        }))
      };
    }

    return outputScenario;
  });

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