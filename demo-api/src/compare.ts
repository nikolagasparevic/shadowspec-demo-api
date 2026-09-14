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

export function normalizeResponse(body: any) {
  const normalized = { ...body };

  for (const field of orderContract.dynamicFields) {
    delete normalized[field];
  }

  return sortObjectKeys(normalized);
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

  const allKeys = new Set([
    ...Object.keys(normalizedOriginal),
    ...Object.keys(normalizedReplay)
  ]);

  for (const key of allKeys) {
    if (
      JSON.stringify(normalizedOriginal[key]) !==
      JSON.stringify(normalizedReplay[key])
    ) {
      differences.push({
        field: key,
        expected: normalizedOriginal[key],
        actual: normalizedReplay[key]
      });
    }
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