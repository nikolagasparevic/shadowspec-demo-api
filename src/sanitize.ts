const SENSITIVE_FIELDS = [
  "orderId"
];

export function sanitizeObject(value: any): any {
  if (Array.isArray(value)) {
    return value.map(sanitizeObject);
  }

  if (value !== null && typeof value === "object") {
    return Object.keys(value).reduce((result, key) => {
      if (SENSITIVE_FIELDS.includes(key)) {
        return result;
      }

      result[key] = sanitizeObject(value[key]);
      return result;
    }, {} as any);
  }

  return value;
}