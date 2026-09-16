import { pool } from "./db";

export type DatabaseSnapshot = {
  tables: Record<
    string,
    {
      rows: Record<string, unknown>[];
    }
  >;
};

function getConfiguredTables(): string[] {
  const value =
    process.env.SHADOWSPEC_TABLES || "";

  return value
    .split(",")
    .map((table) => table.trim())
    .filter(Boolean);
}

function validateIdentifier(
  value: string
) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(
      `Invalid PostgreSQL identifier: ${value}`
    );
  }
}

export async function captureDatabaseSnapshot(): Promise<DatabaseSnapshot> {
  const tables = getConfiguredTables();

  const snapshot: DatabaseSnapshot = {
    tables: {}
  };

  for (const tableName of tables) {
    validateIdentifier(tableName);

    const result = await pool.query(
      `SELECT * FROM "${tableName}"`
    );

    snapshot.tables[tableName] = {
      rows: result.rows
    };
  }

  return snapshot;
}