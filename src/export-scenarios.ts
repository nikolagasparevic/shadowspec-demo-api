import fs from "fs";
import { canonicalStringify } from "./canonical";
import {
  getScenarioGroups,
  getCapturedRequests,
  buildScenarioSequences
} from "./scenario";
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
function toSnakeCase(field: string): string {
  return field.replace(
    /[A-Z]/g,
    (letter) => `_${letter.toLowerCase()}`
  );
}

function isStateDerivedField(
  field: string,
  baseline: {
    body: any;
    snapshot?: any;
  },
  pathParams: Record<string, string>
): boolean {
  if (!field || field.includes(".")) {
    return false;
  }

  if (
    Object.keys(pathParams).length === 0
  ) {
    return false;
  }

  if (
    !hasValidSnapshot(
      baseline.snapshot
    )
  ) {
    return false;
  }

  const snakeCaseField =
    toSnakeCase(field);

  const entityIdParam =
    Object.entries(pathParams).find(
      ([key, value]) =>
        (
          key.toLowerCase() === "id" ||
          key.toLowerCase().endsWith("id")
        ) &&
        Number.isFinite(Number(value))
    ) ??
    Object.entries(pathParams).find(
      ([, value]) =>
        Number.isFinite(Number(value))
    );

  if (entityIdParam === undefined) {
    return false;
  }

  const entityIdNumber =
    Number(entityIdParam[1]);

  if (!Number.isFinite(entityIdNumber)) {
    return false;
  }

  const value =
    baseline.body?.[field];

  if (value === undefined) {
    return false;
  }

  const tables =
    baseline.snapshot.tables ?? {};

  return Object.values(tables).some(
    (table: any) =>
      Array.isArray(table?.rows) &&
      table.rows.some(
        (row: any) =>
          Number(row?.id) ===
            entityIdNumber &&
          row?.[snakeCaseField] === value
      )
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

const stateDerivedFields =
  detectedDynamicFields.filter(
    (field) =>
      !isStateDerivedField(
        field,
        baseline,
        group.pathParams
      )
  );

const dynamicFields = Array.from(
  new Set([
    ...stateDerivedFields,
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

export function buildLifecycleScenarios(
  sequences: ReturnType<
    typeof buildScenarioSequences
  >
) {
  return sequences
    .filter(
      (sequence) =>
        sequence.requests.length > 1
    )
    .map((sequence, index) => {
      const firstRequest =
        sequence.requests[0];

      const outputScenario: any = {
        id: index + 1,
        steps: []
      };

      if (firstRequest.snapshot) {
        outputScenario.setup =
          sanitizeObject(
            firstRequest.snapshot
          );
      }

      for (const request of sequence.requests) {
        const step: any = {
          request: {
            method: request.method,
            path: request.path,
            body: sanitizeObject(
              request.requestBody
            )
          },

          expected: {
            status: request.responseStatus,
            body: sanitizeObject(
              request.responseBody
            )
          }
        };

        if (
          Object.keys(
            request.pathParams
          ).length > 0
        ) {
          step.request.pathParams =
            request.pathParams;
        }

        if (
          Object.keys(
            request.queryParams
          ).length > 0
        ) {
          step.request.queryParams =
            request.queryParams;
        }

        const dynamicFields =
          getSanitizedFields(
            request.responseBody,
            step.expected.body
          );

        if (
          dynamicFields.length > 0
        ) {
          step.dynamicFields =
            dynamicFields;
        }

        outputScenario.steps.push(
          step
        );
      }

      return outputScenario;
    });
}

async function main() {
  const scenarioGroups =
    await getScenarioGroups();

  const legacyScenarios =
    buildScenarios(scenarioGroups);

  const capturedRequests =
    await getCapturedRequests();

  const sequences =
    buildScenarioSequences(
      capturedRequests
    );

  const lifecycleScenarios =
    buildLifecycleScenarios(
      sequences
    ).map((scenario, index) => ({
      ...scenario,
      id:
        legacyScenarios.length +
        index +
        1
    }));

  const output = [
    ...legacyScenarios,
    ...lifecycleScenarios
  ];

  if (output.length === 0) {
    console.log("No scenarios found.");
    return;
  }

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