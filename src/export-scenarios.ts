import fs from "fs";
import { getScenarios } from "./scenario";
import { sanitizeObject } from "./sanitize";

async function main() {
  const scenarios = await getScenarios();

  if (scenarios.length === 0) {
    console.log("No scenarios found.");
    return;
  }

  const output = scenarios.map((scenario, index) => {
    const outputScenario: any = {
      id: index + 1,

      request: {
        method: scenario.method,
        path: scenario.path,
        body: sanitizeObject(scenario.request_body)
      },

      expected: {
        status: scenario.response_status,
        body: sanitizeObject(scenario.response_body)
      }
    };

    if (
      scenario.method === "GET" &&
      scenario.path === "/orders" &&
      Array.isArray(scenario.response_body)
    ) {
      outputScenario.setup = {
        orders: scenario.response_body.map((order: any) => ({
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