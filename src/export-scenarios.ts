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
      if (
        !Object.prototype.hasOwnProperty.call(
          sanitized,
          key
        )
      ) {
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

function normalizeDynamicPath(
  path: string
): {
  path: string;
  pathParams: Record<string, string>;
} {
  const segments = path.split("/");

  const pathParams: Record<string, string> = {};

  let dynamicIndex = 0;

  const normalizedSegments = segments.map(
    (segment) => {
      if (/^\d+$/.test(segment)) {
        dynamicIndex++;

        const paramName =
          dynamicIndex === 1
            ? "id"
            : `param${dynamicIndex}`;

        pathParams[paramName] = segment;

        return `:${paramName}`;
      }

      return segment;
    }
  );

  return {
    path: normalizedSegments.join("/"),
    pathParams
  };
}

async function main() {
  const scenarioGroups = await getScenarioGroups();

  if (scenarioGroups.length === 0) {
    console.log("No scenarios found.");
    return;
  }

  const dynamicPathGroups = new Map<
    string,
    {
      method: string;
      path: string;
      pathParams: Record<string, string>;
      requestBody: any;
      responseStatus: number;
      responses: {
        body: any;
        status: number;
      }[];
    }
  >();

  for (const group of scenarioGroups) {
    const normalized = normalizeDynamicPath(
      group.path
    );

    for (const response of group.responses) {
      const key = [
        group.method,
        normalized.path,
        JSON.stringify(group.requestBody),
        response.status
      ].join(":");

      const existing = dynamicPathGroups.get(key);

      if (existing) {
        existing.responses.push(response);
        continue;
      }

      dynamicPathGroups.set(key, {
        method: group.method,
        path: normalized.path,
        pathParams: normalized.pathParams,
        requestBody: group.requestBody,
        responseStatus: response.status,
        responses: [response]
      });
    }
  }

  const output = Array.from(
    dynamicPathGroups.values()
  ).map((group, index) => {
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

    const hasDynamicPath =
      Object.keys(group.pathParams).length > 0;

    if (hasDynamicPath) {
      outputScenario.request.pathParams =
        group.pathParams;
    }

    const detectedDynamicFields =
      hasDynamicPath
        ? []
        : detectDynamicFields(
            group.responses.map(
              (response) => response.body
            )
          );

    const sanitizedDynamicFields =
      getSanitizedFields(
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
      outputScenario.dynamicFields =
        dynamicFields;
    }

    if (
      group.method === "GET" &&
      group.path === "/orders" &&
      Array.isArray(baseline.body)
    ) {
      outputScenario.setup = {
        orders: baseline.body.map(
          (order: any) => ({
            customerId: order.customerId,
            productId: order.productId,
            quantity: order.quantity,
            status: order.status
          })
        )
      };
    }

    if (
      group.method === "GET" &&
      group.path === "/orders/:id" &&
      group.responseStatus === 200 &&
      baseline.body !== null &&
      typeof baseline.body === "object" &&
      !Array.isArray(baseline.body) &&
      group.pathParams.id
    ) {
      outputScenario.setup = {
        orders: [
          {
            id: Number(group.pathParams.id),
            customerId: baseline.body.customerId,
            productId: baseline.body.productId,
            quantity: baseline.body.quantity,
            status: baseline.body.status
          }
        ]
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