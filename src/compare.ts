import type {
  IgnoredValueDefinition
} from "./load-scenarios";
import { escapeJsonPointerToken } from "./json-pointer";
import { validateIgnoredValues } from "./scenario-validation";

function sortObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortObjectKeys);
  }

  if (
    value !== null &&
    typeof value === "object"
  ) {
    return Object.keys(value)
      .sort()
      .reduce<Record<string, unknown>>(
        (sorted, key) => {
          sorted[key] = sortObjectKeys(
            (value as Record<string, unknown>)[key]
          );
          return sorted;
        },
        {}
      );
  }

  return value;
}

export function normalizeResponse(
  body: unknown
) {
  return sortObjectKeys(body);
}

function childPointer(
  pointer: string,
  token: string
): string {
  return `${pointer}/${escapeJsonPointerToken(token)}`;
}

function valuesMatch(
  expected: unknown,
  actual: unknown,
  pointer: string,
  ignoredValues: ReadonlyMap<
    string,
    IgnoredValueDefinition
  >,
  capturePointers: ReadonlySet<string>
): boolean {
  if (capturePointers.has(pointer)) {
    return true;
  }

  const ignored = ignoredValues.get(pointer);

  if (ignored) {
    const typesMatch = (
      expected !== null &&
      actual !== null &&
      typeof expected === ignored.type &&
      typeof actual === ignored.type
    );

    return (
      typesMatch &&
      (ignored.type !== "number" ||
        (Number.isFinite(expected) &&
          Number.isFinite(actual)))
    );
  }

  if (Object.is(expected, actual)) {
    return true;
  }

  if (
    Array.isArray(expected) ||
    Array.isArray(actual)
  ) {
    if (
      !Array.isArray(expected) ||
      !Array.isArray(actual) ||
      expected.length !== actual.length
    ) {
      return false;
    }

    return expected.every((value, index) =>
      valuesMatch(
        value,
        actual[index],
        childPointer(pointer, String(index)),
        ignoredValues,
        capturePointers
      )
    );
  }

  if (
    expected === null ||
    actual === null ||
    typeof expected !== "object" ||
    typeof actual !== "object"
  ) {
    return false;
  }

  const expectedRecord =
    expected as Record<string, unknown>;
  const actualRecord =
    actual as Record<string, unknown>;
  const expectedKeys = Object.keys(expectedRecord)
    .sort();
  const actualKeys = Object.keys(actualRecord)
    .sort();

  if (
    expectedKeys.length !== actualKeys.length ||
    expectedKeys.some(
      (key, index) => key !== actualKeys[index]
    )
  ) {
    return false;
  }

  return expectedKeys.every((key) =>
    valuesMatch(
      expectedRecord[key],
      actualRecord[key],
      childPointer(pointer, key),
      ignoredValues,
      capturePointers
    )
  );
}

export function compareResponses(
  expected: unknown,
  actual: unknown,
  expectedStatus: number,
  actualStatus: number,
  ignoredValues: IgnoredValueDefinition[] = [],
  capturePointers: string[] = []
) {
  validateIgnoredValues(expected, ignoredValues);

  const normalizedExpected =
    normalizeResponse(expected);
  const normalizedActual =
    normalizeResponse(actual);
  const ignoredByPointer = new Map(
    ignoredValues.map((definition) => [
      definition.pointer,
      definition
    ])
  );
  const captures = new Set(capturePointers);
  const differences: {
    field: string;
    expected: unknown;
    actual: unknown;
  }[] = [];

  if (
    !valuesMatch(
      expected,
      actual,
      "",
      ignoredByPointer,
      captures
    )
  ) {
    differences.push({
      field: "body",
      expected: normalizedExpected,
      actual: normalizedActual
    });
  }

  if (expectedStatus !== actualStatus) {
    differences.push({
      field: "httpStatus",
      expected: expectedStatus,
      actual: actualStatus
    });
  }

  return {
    passed: differences.length === 0,
    differences,
    original: normalizedExpected,
    replay: normalizedActual
  };
}
