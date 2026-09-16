const DEFAULT_SENSITIVE_FIELDS = [
  "password",
  "passwd",
  "secret",
  "token",
  "accessToken",
  "refreshToken",
  "authorization",
  "cookie",
  "set-cookie",
  "apiKey",
  "api_key",
  "privateKey",
  "private_key",
  "creditCard",
  "credit_card",
  "cvv",
  "ssn",
  "orderId"
];

function getSensitiveFields(): Set<string> {
  const configuredFields =
    process.env.SHADOWSPEC_REDACT_FIELDS
      ?.split(",")
      .map((field) => field.trim())
      .filter(Boolean) ?? [];

  return new Set(
    [
      ...DEFAULT_SENSITIVE_FIELDS,
      ...configuredFields
    ].map((field) => field.toLowerCase())
  );
}

export function sanitizeObject(
  value: any,
  sensitiveFields = getSensitiveFields()
): any {
  if (Array.isArray(value)) {
    return value.map((item) =>
      sanitizeObject(item, sensitiveFields)
    );
  }

  if (
    value !== null &&
    typeof value === "object"
  ) {
    return Object.keys(value).reduce(
      (result, key) => {
        if (
          sensitiveFields.has(
            key.toLowerCase()
          )
        ) {
          return result;
        }

        result[key] = sanitizeObject(
          value[key],
          sensitiveFields
        );

        return result;
      },
      {} as any
    );
  }

  return value;
}