import fs from "fs";
import { canonicalStringify } from "./canonical";
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

    for (
      let i = 0;
      i < original.length;
      i++
    ) {
      const nestedFields =
        getSanitizedFields(
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

      const nestedFields =
        getSanitizedFields(
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

function hasValidSnapshot(
  snapshot: any
): boolean {
  return (
    snapshot !== null &&
    typeof snapshot === "object" &&
    snapshot.tables !== null &&
    typeof snapshot.tables === "object" &&
    !Array.isArray(snapshot.tables) &&
    Object.keys(snapshot.tables).length > 0
  );
}

export function findBestBaselineResponse(
  responses: {
    body: any;
    status: number;
    snapshot?: any;
  }[]
) {
  return (
    responses.find((response) =>
      hasValidSnapshot(response.snapshot)
    ) ??
    responses[0]
  );
}

export function buildScenarios(
  scenarioGroups: Awaited<
    ReturnType<typeof getScenarioGroups>
  >
) {
  const dynamicPathGroups = new Map<
    string,
    {
      method: string;
      path: string;
      pathParams: Record<string, string>;
      queryParams: Record<string, string>;
      requestBody: any;
      responseStatus: number;
      responses: {
        body: any;
        status: number;
        snapshot?: any;
      }[];
    }
  >();

  for (const group of scenarioGroups) {
    for (const response of group.responses) {
      const key = [
        group.method,
        group.path,
        canonicalStringify(
          group.pathParams
        ),
        canonicalStringify(
          group.queryParams
        ),
        canonicalStringify(
          group.requestBody
        ),
        response.status
      ].join(":");

      const existing =
        dynamicPathGroups.get(key);

      if (existing) {
        existing.responses.push(
          response
        );
        continue;
      }

      dynamicPathGroups.set(key, {
        method: group.method,
        path: group.path,
        pathParams: group.pathParams,
        queryParams: group.queryParams,
        requestBody: group.requestBody,
        responseStatus: response.status,
        responses: [response]
      });
    }
  }

  return Array.from(
    dynamicPathGroups.values()
  ).map((group, index) => {
    const baseline =
      findBestBaselineResponse(
        group.responses
      );

    const sanitizedRequestBody =
      sanitizeObject(
        group.requestBody
      );

    const sanitizedResponseBody =
      sanitizeObject(baseline.body);

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

    if (
      Object.keys(group.pathParams).length > 0
    ) {
      outputScenario.request.pathParams =
        group.pathParams;
    }

    if (
      Object.keys(group.queryParams).length > 0
    ) {
      outputScenario.request.queryParams =
        group.queryParams;
    }

    const detectedDynamicFields =
      detectDynamicFields(
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

    if (baseline.snapshot) {
      outputScenario.setup =
        sanitizeObject(
          baseline.snapshot
        );
    }

    return outputScenario;
  });
}

async function main() {
  const scenarioGroups =
    await getScenarioGroups();

  if (scenarioGroups.length === 0) {
    console.log("No scenarios found.");
    return;
  }

  const output =
    buildScenarios(scenarioGroups);

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