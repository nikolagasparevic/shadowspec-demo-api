export class JsonPointerSyntaxError extends Error {
  readonly name = "JsonPointerSyntaxError";

  constructor(message: string) {
    super(message);
  }
}

export function escapeJsonPointerToken(
  token: string
): string {
  return token
    .replace(/~/g, "~0")
    .replace(/\//g, "~1");
}

function decodeJsonPointerToken(
  token: string
): string {
  if (/~(?:[^01]|$)/.test(token)) {
    throw new JsonPointerSyntaxError(
      `Invalid JSON Pointer token: ${token}`
    );
  }

  return token
    .replace(/~1/g, "/")
    .replace(/~0/g, "~");
}

export function getJsonPointerTokens(
  pointer: string
): string[] {
  if (pointer === "") {
    return [];
  }

  if (!pointer.startsWith("/")) {
    throw new JsonPointerSyntaxError(
      `Invalid JSON Pointer: ${pointer}`
    );
  }

  return pointer
    .slice(1)
    .split("/")
    .map(decodeJsonPointerToken);
}

export function extractJsonPointerValue(
  value: unknown,
  pointer: string
): {
  found: boolean;
  value?: unknown;
} {
  let current = value;

  for (const token of getJsonPointerTokens(pointer)) {
    if (
      current === null ||
      typeof current !== "object"
    ) {
      return { found: false };
    }

    if (
      Array.isArray(current) &&
      !/^(0|[1-9][0-9]*)$/.test(token)
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
