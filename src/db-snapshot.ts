import type { Pool } from "pg";

export type DatabaseSnapshot = {
  tables: Record<
    string,
    {
      rows: Record<string, unknown>[];
    }
  >;
};

function validateIdentifier(
  value: string
) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(
      `Invalid PostgreSQL identifier: ${value}`
    );
  }
}

export async function captureDatabaseSnapshot(
  applicationPool: Pool,
  tables: readonly string[]
): Promise<DatabaseSnapshot> {
  const snapshot: DatabaseSnapshot = {
    tables: {}
  };

  for (const tableName of tables) {
    validateIdentifier(tableName);

    const result = await applicationPool.query(
      `SELECT * FROM "${tableName}"`
    );

    snapshot.tables[tableName] = {
      rows: result.rows
    };
  }

  return snapshot;
}
