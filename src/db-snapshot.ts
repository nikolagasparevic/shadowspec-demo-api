import type { Pool, PoolClient } from "pg";

export type DatabaseSnapshot = {
  tables: Record<
    string,
    {
      rows: Record<string, unknown>[];
    }
  >;
};

export type SnapshotCaptureErrorCode =
  | "SNAPSHOT_CONFIGURATION_INVALID"
  | "SNAPSHOT_TABLE_UNSUPPORTED"
  | "SNAPSHOT_PRIMARY_KEY_REQUIRED"
  | "SNAPSHOT_READ_FAILED"
  | "SNAPSHOT_TIMEOUT"
  | "SNAPSHOT_SERIALIZATION_FAILED";

export class SnapshotCaptureError extends Error {
  readonly name = "SnapshotCaptureError";

  constructor(
    readonly code: SnapshotCaptureErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
  }
}

export type SnapshotCaptureOptions = {
  schema?: string;
  statementTimeoutMs?: number;
};

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DEFAULT_STATEMENT_TIMEOUT_MS = 5_000;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

type RelationRow = {
  oid: unknown;
  relkind: unknown;
  relpersistence: unknown;
  has_inheritance: unknown;
};

type ColumnRow = { attname: unknown };
type PrimaryKeyRow = { attname: unknown; position: unknown };

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function normalizeIdentifier(value: string, kind: string): string {
  const normalized = value.trim();
  if (!IDENTIFIER.test(normalized)) {
    throw new SnapshotCaptureError(
      "SNAPSHOT_CONFIGURATION_INVALID",
      `ShadowSpec snapshot ${kind} configuration is invalid.`
    );
  }
  return normalized;
}

function normalizeTables(tables: readonly string[]): string[] {
  return [...new Set(
    tables.map((table) => table.trim()).filter(Boolean)
  )]
    .map((table) => normalizeIdentifier(table, "table"))
    .sort(compareText);
}

function normalizeTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_STATEMENT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 1) {
    throw new SnapshotCaptureError(
      "SNAPSHOT_CONFIGURATION_INVALID",
      "ShadowSpec snapshot statement timeout configuration is invalid."
    );
  }
  return timeout;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0
    ? value
    : undefined;
}

function classifySnapshotError(error: unknown): SnapshotCaptureError {
  if (error instanceof SnapshotCaptureError) return error;
  if (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "57014"
  ) {
    return new SnapshotCaptureError(
      "SNAPSHOT_TIMEOUT",
      "ShadowSpec database snapshot timed out.",
      { cause: error }
    );
  }
  return new SnapshotCaptureError(
    "SNAPSHOT_READ_FAILED",
    "ShadowSpec database snapshot could not be read.",
    { cause: error }
  );
}

async function resolveRelation(
  client: PoolClient,
  schema: string,
  table: string
): Promise<string> {
  const result = await client.query<RelationRow>(
    `/* shadowspec:snapshot-relation */
     SELECT c.oid::text AS oid,
            c.relkind,
            c.relpersistence,
            EXISTS (
              SELECT 1
              FROM pg_catalog.pg_inherits i
              WHERE i.inhrelid = c.oid OR i.inhparent = c.oid
            ) AS has_inheritance
     FROM pg_catalog.pg_class c
     JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND c.relname = $2`,
    [schema, table]
  );
  const relation = result.rows[0];
  const oid = asString(relation?.oid);
  if (
    result.rows.length !== 1 ||
    oid === undefined ||
    relation.relkind !== "r" ||
    relation.relpersistence !== "p" ||
    relation.has_inheritance !== false
  ) {
    throw new SnapshotCaptureError(
      "SNAPSHOT_TABLE_UNSUPPORTED",
      `ShadowSpec cannot snapshot configured table ${schema}.${table}.`
    );
  }
  return oid;
}

async function describeTable(
  client: PoolClient,
  oid: string,
  schema: string,
  table: string
): Promise<{ columns: string[]; primaryKey: string[] }> {
  const columnsResult = await client.query<ColumnRow>(
    `/* shadowspec:snapshot-columns */
     SELECT a.attname
     FROM pg_catalog.pg_attribute a
     WHERE a.attrelid = $1::oid
       AND a.attnum > 0
       AND NOT a.attisdropped
     ORDER BY a.attname ASC`,
    [oid]
  );
  const columns = columnsResult.rows
    .map(({ attname }) => asString(attname))
    .sort((left, right) => compareText(left ?? "", right ?? ""));
  if (columns.length === 0 || columns.some((column) => column === undefined)) {
    throw new SnapshotCaptureError(
      "SNAPSHOT_TABLE_UNSUPPORTED",
      `ShadowSpec cannot snapshot configured table ${schema}.${table}.`
    );
  }

  const primaryKeyResult = await client.query<PrimaryKeyRow>(
    `/* shadowspec:snapshot-primary-key */
     SELECT a.attname,
            pk_key.position
     FROM pg_catalog.pg_index i
     CROSS JOIN LATERAL unnest(i.indkey)
       WITH ORDINALITY AS pk_key(attnum, position)
     JOIN pg_catalog.pg_attribute a
       ON a.attrelid = i.indrelid AND a.attnum = pk_key.attnum
     WHERE i.indrelid = $1::oid
       AND i.indisprimary
       AND pk_key.position <= i.indnkeyatts
     ORDER BY pk_key.position ASC`,
    [oid]
  );
  const primaryKey = primaryKeyResult.rows.map(({ attname }) => asString(attname));
  if (
    primaryKey.length === 0 ||
    primaryKey.some((column) =>
      column === undefined || !columns.includes(column)
    )
  ) {
    throw new SnapshotCaptureError(
      "SNAPSHOT_PRIMARY_KEY_REQUIRED",
      `ShadowSpec snapshot table ${schema}.${table} requires a primary key.`
    );
  }

  return {
    columns: columns as string[],
    primaryKey: primaryKey as string[]
  };
}

async function rollback(client: PoolClient): Promise<unknown> {
  try {
    await client.query("ROLLBACK");
    return undefined;
  } catch (error) {
    return error;
  }
}

export async function captureDatabaseSnapshot(
  applicationPool: Pool,
  tables: readonly string[],
  options: SnapshotCaptureOptions = {}
): Promise<DatabaseSnapshot> {
  const schema = normalizeIdentifier(options.schema ?? "public", "schema");
  const normalizedTables = normalizeTables(tables);
  const statementTimeoutMs = normalizeTimeout(options.statementTimeoutMs);
  let client: PoolClient;

  try {
    client = await applicationPool.connect();
  } catch (error) {
    throw classifySnapshotError(error);
  }

  let released = false;
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await client.query(
      `SET LOCAL statement_timeout = '${statementTimeoutMs}ms'`
    );

    const snapshot: DatabaseSnapshot = { tables: {} };
    for (const table of normalizedTables) {
      const originalOid = await resolveRelation(client, schema, table);
      const qualifiedTable =
        `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
      await client.query(
        `LOCK TABLE ${qualifiedTable} IN ACCESS SHARE MODE`
      );
      const lockedOid = await resolveRelation(client, schema, table);
      if (lockedOid !== originalOid) {
        throw new SnapshotCaptureError(
          "SNAPSHOT_TABLE_UNSUPPORTED",
          `ShadowSpec snapshot table ${schema}.${table} changed during capture.`
        );
      }

      const descriptor = await describeTable(
        client,
        originalOid,
        schema,
        table
      );
      const result = await client.query<Record<string, unknown>>(
        `SELECT ${descriptor.columns.map(quoteIdentifier).join(", ")}
         FROM ONLY ${qualifiedTable}
         ORDER BY ${descriptor.primaryKey.map(
           (column) => `${quoteIdentifier(column)} ASC`
         ).join(", ")}`
      );
      snapshot.tables[table] = { rows: result.rows };
    }

    try {
      JSON.stringify(snapshot);
    } catch (error) {
      throw new SnapshotCaptureError(
        "SNAPSHOT_SERIALIZATION_FAILED",
        "ShadowSpec database snapshot could not be serialized.",
        { cause: error }
      );
    }

    await client.query("COMMIT");
    return snapshot;
  } catch (error) {
    const rollbackError = await rollback(client);
    if (rollbackError !== undefined) {
      client.release(rollbackError as Error);
      released = true;
    }
    throw classifySnapshotError(error);
  } finally {
    if (!released) client.release();
  }
}
