import fs from "fs";
import { getScenarioGroups } from "./scenario";
import { sanitizeObject } from "./sanitize";
import { detectDynamicFields } from "./dynamic-fields";

function getSanitizedFields(
  original: any,
  sanitized: any
): string[] {
  const fields = new Set<string>();

  if (Array.isArray(original)) {
    if (!Array.isArray(sanitized)) {
      return [];
    }

    for (let i = 0; i < original.length; i++) {
      const nestedFields = getSanitizedFields(
        original[i],
        sanitized[i]
      );

      for (const field of nestedFields) {
        fields.add(field);
      }
    }

    return Array.from(fields);
  }

  if (
    original !== null &&
    typeof original === "object" &&
    sanitized !== null &&
    typeof sanitized === "object"
  ) {
    for (const key of Object.keys(original)) {
      if (!Object.prototype.hasOwnProperty.call(sanitized, key)) {
        fields.add(key);
        continue;
      }

      const nestedFields = getSanitizedFields(
        original[key],
        sanitized[key]
      );

      for (const field of nestedFields) {
        fields.add(field);
      }
    }
  }

  return Array.from(fields);
}

async function main() {
  const scenarioGroups = await getScenarioGroups();

  if (scenarioGroups.length === 0) {
    console.log("No scenarios found.");
    return;
  }

  const output = scenarioGroups.map((group, index) => {
    const baseline = group.responses[0];

    const sanitizedRequestBody = sanitizeObject(
      group.requestBody
    );

    const sanitizedResponseBody = sanitizeObject(
      baseline.body
    );

    const outputScenario: any = {
      id: index + 1,

      request: {
        method: group.method,
        path: group.path,
        body: sanitizedRequestBody
      },

      expected: {
        status: baseline.status,
        body: sanitizedResponseBody
      }
    };

    const detectedDynamicFields = detectDynamicFields(
      group.responses.map((response) => response.body)
    );

    const sanitizedDynamicFields = getSanitizedFields(
      baseline.body,
      sanitizedResponseBody
    );

    const dynamicFields = Array.from(
      new Set([
        ...detectedDynamicFields,
        ...sanitizedDynamicFields
      ])
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