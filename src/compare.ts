function sortObjectKeys(obj: any): any {
  if (Array.isArray(obj)) {
    return obj.map(sortObjectKeys);
  }

  if (obj !== null && typeof obj === "object") {
    return Object.keys(obj)
      .sort()
      .reduce((sorted, key) => {
        sorted[key] = sortObjectKeys(obj[key]);
        return sorted;
      }, {} as any);
  }

  return obj;
}

function removeDynamicFields(
  value: any,
  dynamicFields: string[]
): any {
  if (Array.isArray(value)) {
    return value.map((item) =>
      removeDynamicFields(item, dynamicFields)
    );
  }

  if (value !== null && typeof value === "object") {
    return Object.keys(value)
      .filter((key) => !dynamicFields.includes(key))
      .reduce((result, key) => {
        result[key] = removeDynamicFields(
          value[key],
          dynamicFields
        );
        return result;
      }, {} as any);
  }

  return value;
}

export function normalizeResponse(
  body: any,
  dynamicFields: string[] = []
) {
  const withoutDynamicFields = removeDynamicFields(
    body,
    dynamicFields
  );

  return sortObjectKeys(withoutDynamicFields);
}

export function compareResponses(
  original: any,
  replay: any,
  originalStatus: number,
  replayStatus: number,
  dynamicFields: string[] = []
) {
  const normalizedOriginal = normalizeResponse(
    original,
    dynamicFields
  );

  const normalizedReplay = normalizeResponse(
    replay,
    dynamicFields
  );

  const differences: {
    field: string;
    expected: any;
    actual: any;
  }[] = [];

  if (
    JSON.stringify(normalizedOriginal) !==
    JSON.stringify(normalizedReplay)
  ) {
    differences.push({
      field: "body",
      expected: normalizedOriginal,
      actual: normalizedReplay
    });
  }

  if (originalStatus !== replayStatus) {
    differences.push({
      field: "httpStatus",
      expected: originalStatus,
      actual: replayStatus
    });
  }

  return {
    passed: differences.length === 0,
    differences,
    original: normalizedOriginal,
    replay: normalizedReplay
  };
}