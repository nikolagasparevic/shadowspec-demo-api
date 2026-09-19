import type { Pool, PoolClient } from "pg";
import { CaptureDeadline } from "./capture-deadline";

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

type SnapshotCaptureStage =
  | "snapshot-connect"
  | "snapshot-transaction"
  | "snapshot-read"
  | "snapshot-cleanup";

export class SnapshotCaptureError extends Error {
  readonly name = "SnapshotCaptureError";

  constructor(
    readonly code: SnapshotCaptureErrorCode,
    message: string,
    options?: ErrorOptions,
    readonly stage?: SnapshotCaptureStage
  ) {
    super(message, options);
  }
}

export type SnapshotCaptureOptions = {
  schema?: string;
  statementTimeoutMs?: number;
  snapshotTimeoutMs?: number;
};

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DEFAULT_STATEMENT_TIMEOUT_MS = 5_000;
const DEFAULT_SNAPSHOT_TIMEOUT_MS = 5_000;

type SnapshotDeadline = CaptureDeadline<
  SnapshotCaptureStage,
  SnapshotCaptureError
>;

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

function normalizeTimeout(
  value: number | undefined,
  fallback: number,
  kind: string
): number {
  const timeout = value ?? fallback;
  if (!Number.isSafeInteger(timeout) || timeout < 1) {
    throw new SnapshotCaptureError(
      "SNAPSHOT_CONFIGURATION_INVALID",
      `ShadowSpec snapshot ${kind} timeout configuration is invalid.`
    );
  }
  return timeout;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0
    ? value
    : undefined;
}

function classifySnapshotError(
  error: unknown,
  stage?: SnapshotCaptureStage
): SnapshotCaptureError {
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
      { cause: error },
      stage
    );
  }
  return new SnapshotCaptureError(
    "SNAPSHOT_READ_FAILED",
    "ShadowSpec database snapshot could not be read.",
    { cause: error },
    stage
  );
}

function discardClient(client: PoolClient, error: Error): void {
  try {
    client.release(error);
  } catch {
    // The client is already unusable; preserve the capture failure.
  }
}

async function setStatementTimeout(
  client: PoolClient,
  deadline: SnapshotDeadline,
  configuredTimeoutMs: number,
  stage: SnapshotCaptureStage
): Promise<void> {
  const timeout = Math.min(
    configuredTimeoutMs,
    deadline.remainingMilliseconds()
  );
  if (timeout < 1) throw deadline.timeout(stage);
  await deadline.run(
    () => client.query(
      `SET LOCAL statement_timeout = '${timeout}ms'`
    ).then(() => undefined),
    stage
  );
}

async function resolveRelation(
  client: PoolClient,
  schema: string,
  table: string,
  deadline: SnapshotDeadline
): Promise<string> {
  const result = await deadline.run(
    () => client.query<RelationRow>(
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
    ),
    "snapshot-read"
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
  table: string,
  deadline: SnapshotDeadline
): Promise<{ columns: string[]; primaryKey: string[] }> {
  const columnsResult = await deadline.run(
    () => client.query<ColumnRow>(
      `/* shadowspec:snapshot-columns */
       SELECT a.attname
       FROM pg_catalog.pg_attribute a
       WHERE a.attrelid = $1::oid
         AND a.attnum > 0
         AND NOT a.attisdropped
       ORDER BY a.attname ASC`,
      [oid]
    ),
    "snapshot-read"
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

  const primaryKeyResult = await deadline.run(
    () => client.query<PrimaryKeyRow>(
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
    ),
    "snapshot-read"
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

export async function captureDatabaseSnapshot(
  applicationPool: Pool,
  tables: readonly string[],
  options: SnapshotCaptureOptions = {}
): Promise<DatabaseSnapshot> {
  const schema = normalizeIdentifier(options.schema ?? "public", "schema");
  const normalizedTables = normalizeTables(tables);
  const statementTimeoutMs = normalizeTimeout(
    options.statementTimeoutMs,
    DEFAULT_STATEMENT_TIMEOUT_MS,
    "statement"
  );
  const snapshotTimeoutMs = normalizeTimeout(
    options.snapshotTimeoutMs,
    DEFAULT_SNAPSHOT_TIMEOUT_MS,
    "total"
  );
  const deadline: SnapshotDeadline = new CaptureDeadline(
    snapshotTimeoutMs,
    (stage) => new SnapshotCaptureError(
      "SNAPSHOT_TIMEOUT",
      "ShadowSpec database snapshot timed out.",
      undefined,
      stage
    )
  );
  let client: PoolClient;

  try {
    client = await deadline.run(
      () => applicationPool.connect(),
      "snapshot-connect",
      (lateClient, error) => discardClient(lateClient, error)
    );
  } catch (error) {
    throw classifySnapshotError(error, "snapshot-connect");
  }

  let released = false;
  let stage: SnapshotCaptureStage = "snapshot-transaction";
  try {
    await deadline.run(
      () => client.query(
        "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"
      ).then(() => undefined),
      stage
    );
    await setStatementTimeout(client, deadline, statementTimeoutMs, stage);

    const snapshot: DatabaseSnapshot = { tables: {} };
    for (const table of normalizedTables) {
      stage = "snapshot-read";
      const originalOid = await resolveRelation(
        client, schema, table, deadline
      );
      const qualifiedTable =
        `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
      await deadline.run(
        () => client.query(
          `LOCK TABLE ${qualifiedTable} IN ACCESS SHARE MODE`
        ).then(() => undefined),
        stage
      );
      const lockedOid = await resolveRelation(
        client, schema, table, deadline
      );
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
        table,
        deadline
      );
      await setStatementTimeout(client, deadline, statementTimeoutMs, stage);
      const result = await deadline.run(
        () => client.query<Record<string, unknown>>(
          `SELECT ${descriptor.columns.map(quoteIdentifier).join(", ")}
           FROM ONLY ${qualifiedTable}
           ORDER BY ${descriptor.primaryKey.map(
             (column) => `${quoteIdentifier(column)} ASC`
           ).join(", ")}`
        ),
        stage
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

    if (deadline.expired) throw deadline.timeout(stage);

    stage = "snapshot-transaction";
    await deadline.run(
      () => client.query("COMMIT").then(() => undefined),
      stage
    );
    return snapshot;
  } catch (error) {
    const failure = deadline.expired
      ? deadline.timeout(stage)
      : classifySnapshotError(error, stage);
    if (failure.code === "SNAPSHOT_TIMEOUT") {
      discardClient(client, failure);
      released = true;
      throw failure;
    }

    stage = "snapshot-cleanup";
    try {
      await deadline.run(
        () => client.query("ROLLBACK").then(() => undefined),
        stage
      );
    } catch (rollbackError) {
      const cleanupFailure = deadline.expired
        ? deadline.timeout(stage)
        : classifySnapshotError(rollbackError, stage);
      discardClient(client, cleanupFailure);
      released = true;
      throw cleanupFailure;
    }
    throw failure;
  } finally {
    if (!released) client.release();
  }
}
