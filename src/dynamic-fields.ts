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
        const nested = getFieldValues(childValue, path);

        for (const [nestedPath, values] of nested) {
          const existing = result.get(nestedPath) ?? [];

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

function getArrayDynamicFields(
  responses: any[]
): string[] {
  const arrays = responses.filter(
    (response) => Array.isArray(response)
  );

  if (arrays.length < 2) {
    return [];
  }

  const dynamicFields = new Set<string>();

  for (const array of arrays) {
    if (array.length === 0) {
      continue;
    }

    const fieldValues = new Map<string, any[]>();

    for (const item of array) {
      if (
        item === null ||
        typeof item !== "object" ||
        Array.isArray(item)
      ) {
        continue;
      }

      const fields = getFieldValues(item);

      for (const [field, values] of fields) {
        const existing = fieldValues.get(field) ?? [];

        fieldValues.set(field, [
          ...existing,
          ...values
        ]);
      }
    }

    for (const [field, values] of fieldValues) {
      const uniqueValues = new Set(
        values.map((value) => JSON.stringify(value))
      );

      if (
        values.length === array.length &&
        uniqueValues.size === values.length
      ) {
        dynamicFields.add(field);
      }
    }
  }

  return Array.from(dynamicFields);
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
    return getArrayDynamicFields(responses);
  }

  const fieldValues = new Map<string, any[]>();

  for (const response of responses) {
    const fields = getFieldValues(response);

    for (const [field, values] of fields) {
      const existing = fieldValues.get(field) ?? [];

      fieldValues.set(field, [
        ...existing,
        ...values
      ]);
    }
  }

  const dynamicFields: string[] = [];

  for (const [field, values] of fieldValues) {
    const uniqueValues = new Set(
      values.map((value) => JSON.stringify(value))
    );

    if (uniqueValues.size > 1) {
      dynamicFields.push(field);
    }
  }

  return dynamicFields;
}