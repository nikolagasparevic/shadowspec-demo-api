import { pool } from "./db";

export type ReplayRow = Record<
  string,
  unknown
>;

export type ReplayTable = {
  rows: ReplayRow[];
};

export type ReplaySetup = {
  tables?: Record<
    string,
    ReplayTable
  >;
};

export async function resetReplayDatabase() {
  await pool.query(`
    DO $$
    DECLARE
      table_name text;
    BEGIN
      FOR table_name IN
        SELECT tablename
        FROM pg_tables
        WHERE schemaname = 'public'
      LOOP
        EXECUTE format(
          'TRUNCATE TABLE %I RESTART IDENTITY CASCADE',
          table_name
        );
      END LOOP;
    END
    $$;
  `);
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
  }
}