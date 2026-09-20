import type {
  BindingReference,
  CaptureDefinition
} from "./load-scenarios";
import {
  extractJsonPointerValue,
  getJsonPointerTokens,
  JsonPointerSyntaxError
} from "./json-pointer";

export type BindingValue =
  | string
  | number
  | boolean;

export type BindingStore = Map<
  string,
  BindingValue
>;

export type BindingFailureCode =
  | "UNRESOLVED_BINDING"
  | "INVALID_PATH_PARAMETER_VALUE"
  | "UNSUPPORTED_CAPTURE_SOURCE"
  | "DUPLICATE_BINDING"
  | "INVALID_JSON_POINTER"
  | "CAPTURE_SOURCE_MISSING"
  | "CAPTURE_TYPE_MISMATCH";

export class LifecycleBindingError extends Error {
  readonly name = "LifecycleBindingError";

  constructor(
    readonly code: BindingFailureCode,
    message: string
  ) {
    super(message);
  }
}

function getPointerTokens(
  pointer: string
): string[] {
  try {
    return getJsonPointerTokens(pointer);
  } catch (error) {
    if (!(error instanceof JsonPointerSyntaxError)) {
      throw error;
    }

    throw new LifecycleBindingError(
      "INVALID_JSON_POINTER",
      error.message
    );
  }
}

function validateCaptureDefinition(
  name: string,
  definition: CaptureDefinition,
  bindings: BindingStore
) {
  if (
    definition.from !== "response.body"
  ) {
    throw new LifecycleBindingError(
      "UNSUPPORTED_CAPTURE_SOURCE",
      `ShadowSpec capture "${name}" has unsupported source "${definition.from}".`
    );
  }

  if (bindings.has(name)) {
    throw new LifecycleBindingError(
      "DUPLICATE_BINDING",
      `ShadowSpec binding "${name}" is already defined.`
    );
  }

  getPointerTokens(definition.pointer);
}

function validateExpectedCaptureSource(
  name: string,
  definition: CaptureDefinition,
  expectedBody: unknown
) {
  const extracted = extractJsonPointer(
    expectedBody,
    definition.pointer
  );

  if (!extracted.found) {
    throw new LifecycleBindingError(
      "CAPTURE_SOURCE_MISSING",
      `ShadowSpec capture "${name}" could not find expected response body pointer "${definition.pointer}".`
    );
  }

  if (
    isBindingReference(extracted.value) &&
    extracted.value.$ref === name
  ) {
    return;
  }

  if (
    typeof extracted.value !== definition.type
  ) {
    throw new LifecycleBindingError(
      "CAPTURE_TYPE_MISMATCH",
      `ShadowSpec capture "${name}" expected the production response to contain ${definition.type} at "${definition.pointer}", but received ${typeof extracted.value}.`
    );
  }
}

export function extractJsonPointer(
  value: unknown,
  pointer: string
): {
  found: boolean;
  value?: unknown;
} {
  try {
    return extractJsonPointerValue(
      value,
      pointer
    );
  } catch (error) {
    if (!(error instanceof JsonPointerSyntaxError)) {
      throw error;
    }

    throw new LifecycleBindingError(
      "INVALID_JSON_POINTER",
      error.message
    );
  }
}

export function captureBindings(
  definitions: Record<
    string,
    CaptureDefinition
  >,
  responseBody: unknown,
  bindings: BindingStore
): string[] {
  const pointers: string[] = [];

  for (const [
    name,
    definition
  ] of Object.entries(definitions)) {
    validateCaptureDefinition(
      name,
      definition,
      bindings
    );

    const extracted = extractJsonPointer(
      responseBody,
      definition.pointer
    );

    if (!extracted.found) {
      throw new LifecycleBindingError(
        "CAPTURE_SOURCE_MISSING",
        `ShadowSpec capture "${name}" could not find response body pointer "${definition.pointer}".`
      );
    }

    if (
      typeof extracted.value !==
      definition.type
    ) {
      throw new LifecycleBindingError(
        "CAPTURE_TYPE_MISMATCH",
        `ShadowSpec capture "${name}" expected ${definition.type} at "${definition.pointer}", but received ${typeof extracted.value}.`
      );
    }

    bindings.set(
      name,
      extracted.value as BindingValue
    );

    pointers.push(definition.pointer);
  }

  return pointers;
}

function isBindingReference(
  value: unknown
): value is BindingReference {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    typeof (
      value as Record<string, unknown>
    ).$ref === "string"
  );
}

function unresolvedBinding(
  name: string
): never {
  throw new LifecycleBindingError(
    "UNRESOLVED_BINDING",
    `Unresolved ShadowSpec binding: "${name}".`
  );
}

function transformBindingReferences(
  value: unknown,
  transform: (
    reference: BindingReference
  ) => unknown
): unknown {
  if (isBindingReference(value)) {
    return transform(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) =>
      transformBindingReferences(
        item,
        transform
      )
    );
  }

  if (
    value !== null &&
    typeof value === "object"
  ) {
    return Object.fromEntries(
      Object.entries(value).map(
        ([key, childValue]) => [
          key,
          transformBindingReferences(
            childValue,
            transform
          )
        ]
      )
    );
  }

  return value;
}

export function resolveBindingReferences(
  value: unknown,
  bindings: BindingStore
): unknown {
  return transformBindingReferences(
    value,
    (reference) => {
      if (!bindings.has(reference.$ref)) {
        return unresolvedBinding(
          reference.$ref
        );
      }

      return bindings.get(reference.$ref);
    }
  );
}

export function resolvePathParams(
  pathParams: Record<
    string,
    string | BindingReference
  >,
  bindings: BindingStore
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(pathParams).map(
      ([key, value]) => {
        const resolved =
          resolveBindingReferences(
            value,
            bindings
          );

        if (
          typeof resolved !== "string" &&
          typeof resolved !== "number" &&
          typeof resolved !== "boolean"
        ) {
          throw new LifecycleBindingError(
            "INVALID_PATH_PARAMETER_VALUE",
            `ShadowSpec path parameter "${key}" must resolve to a scalar value.`
          );
        }

        return [key, String(resolved)];
      }
    )
  );
}

export function preflightLifecycleBindings(
  pathParams: Record<
    string,
    string | BindingReference
  >,
  expectedBody: unknown,
  captureDefinitions: Record<
    string,
    CaptureDefinition
  > | undefined,
  bindings: BindingStore
): Record<string, string> {
  const resolvedPathParams =
    resolvePathParams(
      pathParams,
      bindings
    );
  const definitions =
    captureDefinitions ?? {};

  for (const [
    name,
    definition
  ] of Object.entries(definitions)) {
    validateCaptureDefinition(
      name,
      definition,
      bindings
    );

    validateExpectedCaptureSource(
      name,
      definition,
      expectedBody
    );
  }

  const availableBindings = new Set([
    ...bindings.keys(),
    ...Object.keys(definitions)
  ]);

  transformBindingReferences(
    expectedBody,
    (reference) => {
      if (
        !availableBindings.has(
          reference.$ref
        )
      ) {
        return unresolvedBinding(
          reference.$ref
        );
      }

      return reference;
    }
  );

  return resolvedPathParams;
}
