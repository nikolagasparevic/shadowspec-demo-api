import type { DatabaseSnapshot } from "./db-snapshot";

export function hasValidSnapshot(
  snapshot: DatabaseSnapshot | undefined
): snapshot is DatabaseSnapshot {
  return (
    snapshot !== undefined &&
    snapshot !== null &&
    typeof snapshot === "object" &&
    snapshot.tables !== null &&
    typeof snapshot.tables === "object" &&
    !Array.isArray(snapshot.tables) &&
    Object.keys(snapshot.tables).length > 0
  );
}

function toSnakeCase(field: string): string {
  return field.replace(
    /[A-Z]/g,
    (letter) => `_${letter.toLowerCase()}`
  );
}

export function isStateDerivedField(
  field: string,
  baseline: {
    body: unknown;
    snapshot?: DatabaseSnapshot;
  },
  pathParams: Record<string, string>
): boolean {
  if (!field || field.includes(".")) {
    return false;
  }

  if (
    Object.keys(pathParams).length === 0
  ) {
    return false;
  }

  if (
    !hasValidSnapshot(
      baseline.snapshot
    )
  ) {
    return false;
  }

  const snakeCaseField =
    toSnakeCase(field);

  const entityIdParam =
    Object.entries(pathParams).find(
      ([key, value]) =>
        (
          key.toLowerCase() === "id" ||
          key.toLowerCase().endsWith("id")
        ) &&
        Number.isFinite(Number(value))
    ) ??
    Object.entries(pathParams).find(
      ([, value]) =>
        Number.isFinite(Number(value))
    );

  if (entityIdParam === undefined) {
    return false;
  }

  const entityIdNumber =
    Number(entityIdParam[1]);

  if (!Number.isFinite(entityIdNumber)) {
    return false;
  }

  if (
    baseline.body === null ||
    typeof baseline.body !== "object" ||
    Array.isArray(baseline.body)
  ) {
    return false;
  }

  const value =
    (baseline.body as Record<string, unknown>)[
      field
    ];

  if (value === undefined) {
    return false;
  }

  const tables =
    baseline.snapshot.tables;

  return Object.values(tables).some(
    (table) =>
      table.rows.some(
        (row) =>
          Number(row.id) ===
            entityIdNumber &&
          row[snakeCaseField] === value
      )
  );
}