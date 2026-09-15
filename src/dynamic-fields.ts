function getFieldValues(
  value: any,
  currentPath = ""
): Map<string, any[]> {
  const result = new Map<string, any[]>();

  if (Array.isArray(value)) {
    return result;
  }

  if (value !== null && typeof value === "object") {
    for (const [key, childValue] of Object.entries(value)) {
      const path = currentPath
        ? `${currentPath}.${key}`
        : key;

      if (
        childValue !== null &&
        typeof childValue === "object" &&
        !Array.isArray(childValue)
      ) {
        const nested = getFieldValues(
          childValue,
          path
        );

        for (const [nestedPath, values] of nested) {
          const existing =
            result.get(nestedPath) ?? [];

          result.set(nestedPath, [
            ...existing,
            ...values
          ]);
        }

        continue;
      }

      const existing = result.get(path) ?? [];

      result.set(path, [
        ...existing,
        childValue
      ]);
    }
  }

  return result;
}

export function detectDynamicFields(
  responses: any[]
): string[] {
  if (responses.length < 2) {
    return [];
  }

  const hasArrayResponses = responses.some(
    (response) => Array.isArray(response)
  );

  if (hasArrayResponses) {
    return [];
  }

  const fieldValues = new Map<string, any[]>();

  for (const response of responses) {
    const fields = getFieldValues(response);

    for (const [field, values] of fields) {
      const existing =
        fieldValues.get(field) ?? [];

      fieldValues.set(field, [
        ...existing,
        ...values
      ]);
    }
  }

  const dynamicFields: string[] = [];

  for (const [field, values] of fieldValues) {
    const uniqueValues = new Set(
      values.map((value) =>
        JSON.stringify(value)
      )
    );

    if (uniqueValues.size > 1) {
      dynamicFields.push(field);
    }
  }

  return dynamicFields;
}