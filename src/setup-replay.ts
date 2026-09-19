import { pool } from "./db";
import {
  parseReplaySafetyConfig,
  runReplayTransaction,
  type ReplayPool
} from "./replay-safety";
import {
  buildTruncateStatement,
  inspectReplayCapabilities,
  lockReplayRelations,
  parseReplayScope,
  quoteIdentifier
} from "./replay-capabilities";

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

export async function applyReplaySetup(
  setup?: ReplaySetup,
  replayPool: ReplayPool = pool,
  environment: NodeJS.ProcessEnv = process.env
) {
  const config = parseReplaySafetyConfig(environment);
  const scope = parseReplayScope(environment);

  await runReplayTransaction(
    replayPool,
    config,
    false,
    async (client) => {
      await lockReplayRelations(client, scope);
      const capabilities =
        await inspectReplayCapabilities(
          client,
          scope,
          setup
        );

      await client.query(
        buildTruncateStatement(
          capabilities.relations
        )
      );

      if (!setup?.tables) {
        return;
      }

      for (const relation of capabilities.restoreOrder) {
        const table = setup.tables[relation.name];

        if (!table) {
          continue;
        }

        for (const row of table.rows) {
          const columns = relation.columns.map(
            (column) => column.name
          );

          const values = columns.map(
            (column) => row[column]
          );

          const placeholders = columns.map(
            (_, index) => `$${index + 1}`
          );

          await client.query(
            `INSERT INTO ${quoteIdentifier(relation.schema)}.${quoteIdentifier(relation.name)}
          (${columns.map(
            (column) => quoteIdentifier(column)
          ).join(", ")})
         VALUES (${placeholders.join(", ")})`,
            values
          );
        }

        for (const sequence of relation.sequences) {
          const maximum = await client.query<{
            max_value: string | number | null;
          }>(
            `SELECT MAX(${quoteIdentifier(sequence.columnName)}) AS max_value
             FROM ONLY ${quoteIdentifier(relation.schema)}.${quoteIdentifier(relation.name)}`
          );
          const maxValue = maximum.rows[0]?.max_value;

          if (maxValue !== null && maxValue !== undefined) {
            await client.query(
              "SELECT pg_catalog.setval($1::oid::regclass, $2, true)",
              [sequence.oid, maxValue]
            );
          }
        }
      }
    }
  );
}
