import type { PoolClient } from "pg";
import { pool } from "./db";
import {
  parseReplaySafetyConfig,
  runReplayTransaction,
  type ReplayPool
} from "./replay-safety";

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

function getConfiguredTables(
  environment: NodeJS.ProcessEnv = process.env
): string[] {
  const value =
    environment.SHADOWSPEC_TABLES || "";
  const seen = new Set<string>();

  return value
    .split(",")
    .map((table) => table.trim())
    .filter((table) => {
      if (!table || seen.has(table)) {
        return false;
      }

      seen.add(table);
      return true;
    });
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

async function resetReplayDatabase(
  client: PoolClient,
  tables: readonly string[]
) {
  for (const tableName of tables) {
    validateIdentifier(tableName);

    await client.query(
      `TRUNCATE TABLE "${tableName}"
       RESTART IDENTITY CASCADE`
    );
  }
}

export async function applyReplaySetup(
  setup?: ReplaySetup,
  replayPool: ReplayPool = pool,
  environment: NodeJS.ProcessEnv = process.env
) {
  const config = parseReplaySafetyConfig(environment);
  const tables = getConfiguredTables(environment);

  await runReplayTransaction(
    replayPool,
    config,
    false,
    async (client) => {
      await resetReplayDatabase(client, tables);

      if (!setup?.tables) {
        return;
      }

      for (const tableName of tables) {
        const table = setup.tables[tableName];

        if (!table) {
          continue;
        }

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

          await client.query(
            `INSERT INTO "${tableName}"
          (${columns.map(
            (column) => `"${column}"`
          ).join(", ")})
         VALUES (${placeholders.join(", ")})`,
            values
          );
        }

        await client.query(
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
  );
}
