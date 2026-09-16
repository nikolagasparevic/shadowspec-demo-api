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
  await pool.query(`
    DO $$
    DECLARE
      table_name text;
    BEGIN
      FOR table_name IN
        SELECT tablename
        FROM pg_tables
        WHERE schemaname = 'public'
          AND tablename NOT IN (
            'api_requests',
            'api_request_snapshots'
          )
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