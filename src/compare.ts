function isObject(value: any): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

function getPath(
  currentPath: string,
  key: string | number
): string {
  return currentPath
    ? `${currentPath}.${key}`
    : String(key);
}

function isDynamicField(
  path: string,
  dynamicFields: string[]
): boolean {
  return dynamicFields.some((field) => {
    return (
      field === path ||
      field === path.split(".").pop()
    );
  });
}

function sortObjectKeys(value: any): any {
  if (Array.isArray(value)) {
    return value.map(sortObjectKeys);
  }

  if (isObject(value)) {
    return Object.keys(value)
      .sort()
      .reduce((result, key) => {
        result[key] = sortObjectKeys(value[key]);
        return result;
      }, {} as any);
  }

  return value;
}

function removeDynamicFields(
  value: any,
  dynamicFields: string[],
  currentPath = ""
): any {
  if (Array.isArray(value)) {
    return value.map((item, index) =>
      removeDynamicFields(
        item,
        dynamicFields,
        getPath(currentPath, index)
      )
    );
  }

  if (isObject(value)) {
    return Object.keys(value)
      .filter((key) => {
        const path = getPath(currentPath, key);

        return !isDynamicField(
          path,
          dynamicFields
        );
      })
      .reduce((result, key) => {
        const path = getPath(currentPath, key);

        result[key] = removeDynamicFields(
          value[key],
          dynamicFields,
          path
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
  return sortObjectKeys(
    removeDynamicFields(
      body,
      dynamicFields
    )
  );
}

function findDifferences(
  expected: any,
  actual: any,
  dynamicFields: string[],
  currentPath = ""
): {
  field: string;
  expected: any;
  actual: any;
}[] {
  if (
    isDynamicField(
      currentPath,
      dynamicFields
    )
  ) {
    return [];
  }

  if (
    expected === actual
  ) {
    return [];
  }

  if (
    expected === null ||
    actual === null ||
    typeof expected !== typeof actual
  ) {
    return [
      {
        field: currentPath || "body",
        expected,
        actual
      }
    ];
  }

  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (
      !Array.isArray(expected) ||
      !Array.isArray(actual)
    ) {
      return [
        {
          field: currentPath || "body",
          expected,
          actual
        }
      ];
    }

    const differences: {
      field: string;
      expected: any;
      actual: any;
    }[] = [];

    const maxLength = Math.max(
      expected.length,
      actual.length
    );

    for (let i = 0; i < maxLength; i++) {
      const path = getPath(
        currentPath,
        i
      );

      differences.push(
        ...findDifferences(
          expected[i],
          actual[i],
          dynamicFields,
          path
        )
      );
    }

    return differences;
  }

  if (
    isObject(expected) ||
    isObject(actual)
  ) {
    if (
      !isObject(expected) ||
      !isObject(actual)
    ) {
      return [
        {
          field: currentPath || "body",
          expected,
          actual
        }
      ];
    }

    const differences: {
      field: string;
      expected: any;
      actual: any;
    }[] = [];

    const keys = new Set([
      ...Object.keys(expected),
      ...Object.keys(actual)
    ]);

    for (const key of keys) {
      const path = getPath(
        currentPath,
        key
      );

      differences.push(
        ...findDifferences(
          expected[key],
          actual[key],
          dynamicFields,
          path
        )
      );
    }

    return differences;
  }

  return [
    {
      field: currentPath || "body",
      expected,
      actual
    }
  ];
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

  const differences = findDifferences(
    normalizedOriginal,
    normalizedReplay,
    dynamicFields
  );

  if (
    originalStatus !== replayStatus
  ) {
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