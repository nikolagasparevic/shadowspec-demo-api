import type {
  BindingReference,
  CaptureDefinition
} from "./load-scenarios";

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

function decodePointerToken(
  token: string
): string {
  if (/~(?:[^01]|$)/.test(token)) {
    throw new LifecycleBindingError(
      "INVALID_JSON_POINTER",
      `Invalid JSON Pointer token: ${token}`
    );
  }

  return token
    .replace(/~1/g, "/")
    .replace(/~0/g, "~");
}

function getPointerTokens(
  pointer: string
): string[] {
  if (pointer === "") {
    return [];
  }

  if (!pointer.startsWith("/")) {
    throw new LifecycleBindingError(
      "INVALID_JSON_POINTER",
      `Invalid JSON Pointer: ${pointer}`
    );
  }

  return pointer
    .slice(1)
    .split("/")
    .map(decodePointerToken);
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

export function extractJsonPointer(
  value: unknown,
  pointer: string
): {
  found: boolean;
  value?: unknown;
} {
  let current = value;

  for (const token of getPointerTokens(pointer)) {
    if (
      current === null ||
      typeof current !== "object"
    ) {
      return { found: false };
    }

    if (
      !Object.prototype.hasOwnProperty.call(
        current,
        token
      )
    ) {
      return { found: false };
    }

    current = (
      current as Record<string, unknown>
    )[token];
  }

  return {
    found: true,
    value: current
  };
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

function omitJsonPointer(
  value: unknown,
  pointer: string
): unknown {
  const tokens = getPointerTokens(pointer);

  if (tokens.length === 0) {
    return undefined;
  }

  const clone = structuredClone(value);
  let current = clone;

  for (
    let index = 0;
    index < tokens.length - 1;
    index++
  ) {
    if (
      current === null ||
      typeof current !== "object"
    ) {
      return clone;
    }

    current = (
      current as Record<string, unknown>
    )[tokens[index]];
  }

  if (
    current !== null &&
    typeof current === "object"
  ) {
    delete (
      current as Record<string, unknown>
    )[tokens[tokens.length - 1]];
  }

  return clone;
}

export function omitJsonPointers(
  value: unknown,
  pointers: string[]
): unknown {
  return pointers.reduce(
    (result, pointer) =>
      omitJsonPointer(result, pointer),
    value
  );
}
