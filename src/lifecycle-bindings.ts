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

function decodePointerToken(
  token: string
): string {
  if (/~(?:[^01]|$)/.test(token)) {
    throw new Error(
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
    throw new Error(
      `Invalid JSON Pointer: ${pointer}`
    );
  }

  return pointer
    .slice(1)
    .split("/")
    .map(decodePointerToken);
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
    if (
      definition.from !== "response.body"
    ) {
      throw new Error(
        `ShadowSpec capture "${name}" has unsupported source "${definition.from}".`
      );
    }

    if (bindings.has(name)) {
      throw new Error(
        `ShadowSpec binding "${name}" is already defined.`
      );
    }

    const extracted = extractJsonPointer(
      responseBody,
      definition.pointer
    );

    if (!extracted.found) {
      throw new Error(
        `ShadowSpec capture "${name}" could not find response body pointer "${definition.pointer}".`
      );
    }

    if (
      typeof extracted.value !==
      definition.type
    ) {
      throw new Error(
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

export function resolveBindingReferences(
  value: unknown,
  bindings: BindingStore
): unknown {
  if (isBindingReference(value)) {
    if (!bindings.has(value.$ref)) {
      throw new Error(
        `Unresolved ShadowSpec binding: "${value.$ref}".`
      );
    }

    return bindings.get(value.$ref);
  }

  if (Array.isArray(value)) {
    return value.map((item) =>
      resolveBindingReferences(
        item,
        bindings
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
          resolveBindingReferences(
            childValue,
            bindings
          )
        ]
      )
    );
  }

  return value;
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
          throw new Error(
            `ShadowSpec path parameter "${key}" must resolve to a scalar value.`
          );
        }

        return [key, String(resolved)];
      }
    )
  );
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
