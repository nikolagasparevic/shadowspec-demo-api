import fs from "fs";
import { getScenarios } from "./scenario";
import { sanitizeObject } from "./sanitize";

function containsField(value: any, field: string): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => containsField(item, field));
  }

  if (value !== null && typeof value === "object") {
    if (Object.prototype.hasOwnProperty.call(value, field)) {
      return true;
    }

    return Object.values(value).some((item) =>
      containsField(item, field)
    );
  }

  return false;
}

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

    const dynamicFields: string[] = [];

    if (containsField(scenario.response_body, "orderId")) {
      dynamicFields.push("orderId");
    }

    if (dynamicFields.length > 0) {
      outputScenario.dynamicFields = dynamicFields;
    }

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