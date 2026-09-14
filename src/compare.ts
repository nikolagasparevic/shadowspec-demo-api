import { orderContract } from "./contract";

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

function removeDynamicFields(value: any): any {
  if (Array.isArray(value)) {
    return value.map(removeDynamicFields);
  }

  if (value !== null && typeof value === "object") {
    return Object.keys(value)
      .filter((key) => !orderContract.dynamicFields.includes(key))
      .reduce((result, key) => {
        result[key] = removeDynamicFields(value[key]);
        return result;
      }, {} as any);
  }

  return value;
}

export function normalizeResponse(body: any) {
  const withoutDynamicFields = removeDynamicFields(body);

  return sortObjectKeys(withoutDynamicFields);
}

export function compareResponses(
  original: any,
  replay: any,
  originalStatus: number,
  replayStatus: number
) {
  const normalizedOriginal = normalizeResponse(original);
  const normalizedReplay = normalizeResponse(replay);

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