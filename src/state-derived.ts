export function hasValidSnapshot(
  snapshot: any
): boolean {
  return (
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
    body: any;
    snapshot?: any;
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

  const value =
    baseline.body?.[field];

  if (value === undefined) {
    return false;
  }

  const tables =
    baseline.snapshot.tables ?? {};

  return Object.values(tables).some(
    (table: any) =>
      Array.isArray(table?.rows) &&
      table.rows.some(
        (row: any) =>
          Number(row?.id) ===
            entityIdNumber &&
          row?.[snakeCaseField] === value
      )
  );
}