import { pool } from "./db";

export type ReplayRow = Record<string, unknown>;

export type ReplayTable = {
  rows: ReplayRow[];
};

export type ReplaySetup = {
  tables?: Record<
    string,
    ReplayTable
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

export async function resetReplayDatabase() {
  const tables =
    getConfiguredTables();

  for (const tableName of tables) {
    validateIdentifier(tableName);

    await pool.query(
      `TRUNCATE TABLE "${tableName}"
       RESTART IDENTITY CASCADE`
    );
  }
}

export async function applyReplaySetup(
  setup?: ReplaySetup
) {
  await resetReplayDatabase();

  if (!setup?.tables) {
    return;
  }

  for (const [
    tableName,
    table
  ] of Object.entries(setup.tables)) {
    validateIdentifier(tableName);

    for (const row of table.rows) {
      const columns = Object.keys(row);

      if (columns.length === 0) {
        continue;
      }

      const values = columns.map(
        (column) => row[column]
      );

      const placeholders = columns.map(
        (_, index) => `$${index + 1}`
      );

      await pool.query(
        `INSERT INTO "${tableName}"
          (${columns.map(
            (column) => `"${column}"`
          ).join(", ")})
         VALUES (${placeholders.join(", ")})`,
        values
      );
    }

    await pool.query(
      `DO $$
       DECLARE
         sequence_name text;
         max_id bigint;
       BEGIN
         SELECT pg_get_serial_sequence(
           '${tableName}',
           'id'
         )
         INTO sequence_name;

         IF sequence_name IS NOT NULL THEN
           SELECT MAX(id)
           INTO max_id
           FROM "${tableName}";

           IF max_id IS NOT NULL THEN
             PERFORM setval(
               sequence_name,
               max_id,
               true
             );
           END IF;
         END IF;
       END $$;`
    );
  }
}