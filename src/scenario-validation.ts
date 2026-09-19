import type {
  CapturePrimitiveType,
  IgnoredValueDefinition,
  ShadowSpecScenario
} from "./load-scenarios";
import {
  extractJsonPointerValue,
  getJsonPointerTokens,
  JsonPointerSyntaxError
} from "./json-pointer";

export type ScenarioConfigurationErrorCode =
  | "UNSAFE_LEGACY_DYNAMIC_FIELD"
  | "INVALID_IGNORED_VALUE_POINTER"
  | "INVALID_IGNORED_VALUE_TYPE"
  | "IGNORED_VALUE_TARGET_MISSING"
  | "IGNORED_VALUE_TARGET_INVALID"
  | "OVERLAPPING_IGNORED_VALUES";

export class ScenarioConfigurationError extends Error {
  readonly name = "ScenarioConfigurationError";

  constructor(
    readonly code: ScenarioConfigurationErrorCode,
    message: string
  ) {
    super(message);
  }
}

function isSupportedPrimitiveType(
  value: unknown
): value is CapturePrimitiveType {
  return (
    value === "string" ||
    value === "number" ||
    value === "boolean"
  );
}

function isPrefix(
  possibleAncestor: string[],
  pointer: string[]
): boolean {
  return (
    possibleAncestor.length < pointer.length &&
    possibleAncestor.every(
      (token, index) => pointer[index] === token
    )
  );
}

export function validateIgnoredValues(
  expectedBody: unknown,
  ignoredValues: readonly IgnoredValueDefinition[]
): void {
  const parsed: {
    definition: IgnoredValueDefinition;
    tokens: string[];
  }[] = [];

  for (const definition of ignoredValues) {
    if (
      typeof definition !== "object" ||
      definition === null ||
      typeof definition.pointer !== "string"
    ) {
      throw new ScenarioConfigurationError(
        "INVALID_IGNORED_VALUE_POINTER",
        "ShadowSpec ignored-value pointers must be valid RFC 6901 JSON Pointers."
      );
    }

    if (definition.pointer === "") {
      throw new ScenarioConfigurationError(
        "INVALID_IGNORED_VALUE_POINTER",
        "ShadowSpec cannot ignore the response body root value."
      );
    }

    let tokens: string[];

    try {
      tokens = getJsonPointerTokens(
        definition.pointer
      );
    } catch (error) {
      if (!(error instanceof JsonPointerSyntaxError)) {
        throw error;
      }

      throw new ScenarioConfigurationError(
        "INVALID_IGNORED_VALUE_POINTER",
        error.message
      );
    }

    if (!isSupportedPrimitiveType(definition.type)) {
      throw new ScenarioConfigurationError(
        "INVALID_IGNORED_VALUE_TYPE",
        `ShadowSpec ignored value "${definition.pointer}" has an unsupported primitive type.`
      );
    }

    parsed.push({ definition, tokens });
  }

  for (let left = 0; left < parsed.length; left++) {
    for (
      let right = left + 1;
      right < parsed.length;
      right++
    ) {
      const leftTokens = parsed[left].tokens;
      const rightTokens = parsed[right].tokens;

      if (
        leftTokens.length === rightTokens.length &&
        leftTokens.every(
          (token, index) =>
            rightTokens[index] === token
        )
      ) {
        throw new ScenarioConfigurationError(
          "OVERLAPPING_IGNORED_VALUES",
          "ShadowSpec ignored-value pointers must be unique and non-overlapping."
        );
      }

      if (
        isPrefix(leftTokens, rightTokens) ||
        isPrefix(rightTokens, leftTokens)
      ) {
        throw new ScenarioConfigurationError(
          "OVERLAPPING_IGNORED_VALUES",
          "ShadowSpec ignored-value pointers must be unique and non-overlapping."
        );
      }
    }
  }

  for (const { definition } of parsed) {
    const extracted = extractJsonPointerValue(
      expectedBody,
      definition.pointer
    );

    if (!extracted.found) {
      throw new ScenarioConfigurationError(
        "IGNORED_VALUE_TARGET_MISSING",
        `ShadowSpec ignored value pointer "${definition.pointer}" is missing from the expected response body.`
      );
    }

    if (
      extracted.value === null ||
      typeof extracted.value !== definition.type
    ) {
      throw new ScenarioConfigurationError(
        "IGNORED_VALUE_TARGET_INVALID",
        `ShadowSpec ignored value pointer "${definition.pointer}" must target an expected ${definition.type} primitive.`
      );
    }
  }
}

function validateLegacyDynamicFields(
  dynamicFields: string[] | undefined
): void {
  if (
    dynamicFields !== undefined &&
    (!Array.isArray(dynamicFields) ||
      dynamicFields.length > 0)
  ) {
    throw new ScenarioConfigurationError(
      "UNSAFE_LEGACY_DYNAMIC_FIELD",
      "Nonempty legacy dynamicFields are unsafe and must be re-exported or explicitly migrated."
    );
  }
}

export function validateScenarios(
  scenarios: readonly ShadowSpecScenario[]
): void {
  for (const scenario of scenarios) {
    validateLegacyDynamicFields(
      scenario.dynamicFields
    );

    validateIgnoredValues(
      scenario.expected?.body,
      scenario.comparison?.ignoredValues ?? []
    );

    for (const step of scenario.steps ?? []) {
      validateLegacyDynamicFields(
        step.dynamicFields
      );

      validateIgnoredValues(
        step.expected.body,
        step.comparison?.ignoredValues ?? []
      );
    }
  }
}
