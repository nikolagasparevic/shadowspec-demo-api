export function canonicalize(
  value: any
): any {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }

  if (
    value !== null &&
    typeof value === "object"
  ) {
    return Object.keys(value)
      .sort()
      .reduce(
        (result, key) => {
          result[key] = canonicalize(
            value[key]
          );

          return result;
        },
        {} as Record<string, any>
      );
  }

  return value;
}

export function canonicalStringify(
  value: any
): string {
  return JSON.stringify(
    canonicalize(value)
  );
}