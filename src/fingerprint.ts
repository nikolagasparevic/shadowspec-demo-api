export function fingerprint(value: any): string {
  if (Array.isArray(value)) {
    return `[${value.map(fingerprint).join(",")}]`;
  }

  if (value !== null && typeof value === "object") {
    return Object.keys(value)
      .sort()
      .map((key) => `${key}:${fingerprint(value[key])}`)
      .join("|");
  }

  return typeof value;
}