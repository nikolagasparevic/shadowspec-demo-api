import type { Pool } from "pg";

export type IntrospectedTable = {
  name: string;
  columns: string[];
};

const SHADOWSPEC_CAPTURE_TABLES =
  new Set([
    "api_requests",
    "api_request_snapshots"
  ]);

export async function introspectSchema(
  pool: Pool,
  schema = "public"
): Promise<IntrospectedTable[]> {
  const result = await pool.query<{
    table_name: string;
    column_name: string;
    ordinal_position: number;
  }>(
    `
      SELECT
        c.table_name,
        c.column_name,
        c.ordinal_position
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema
       AND t.table_name = c.table_name
      WHERE c.table_schema = $1
        AND t.table_type = 'BASE TABLE'
      ORDER BY
        c.table_name ASC,
        c.ordinal_position ASC
    `,
    [schema]
  );

  const tables =
    new Map<string, string[]>();

  for (const row of result.rows) {
    if (
      SHADOWSPEC_CAPTURE_TABLES.has(
        row.table_name
      )
    ) {
      continue;
    }

    const columns =
      tables.get(row.table_name) ?? [];

    columns.push(row.column_name);

    tables.set(
      row.table_name,
      columns
    );
  }

  return Array.from(
    tables.entries()
  ).map(([name, columns]) => ({
    name,
    columns
  }));
}