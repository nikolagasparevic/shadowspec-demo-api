import type { PoolClient } from "pg";
import type { ReplaySetup } from "./setup-replay";

export type ReplayCapabilityErrorCode =
  | "REPLAY_TABLE_NOT_FOUND"
  | "REPLAY_TABLE_IDENTITY_AMBIGUOUS"
  | "REPLAY_RELATION_KIND_UNSUPPORTED"
  | "REPLAY_TABLE_DEPENDENCY_UNCONFIGURED"
  | "REPLAY_FOREIGN_KEY_GRAPH_UNSUPPORTED"
  | "REPLAY_MUTATION_SIDE_EFFECT_UNSUPPORTED"
  | "REPLAY_SEQUENCE_SCOPE_UNSUPPORTED"
  | "REPLAY_SNAPSHOT_SHAPE_UNSUPPORTED"
  | "REPLAY_DATABASE_CAPABILITY_CHECK_FAILED";

export class ReplayCapabilityError extends Error {
  readonly name = "ReplayCapabilityError";

  constructor(
    readonly code: ReplayCapabilityErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
  }
}

export type ReplayScope = Readonly<{
  schema: string;
  tables: readonly string[];
}>;

type ColumnDescriptor = Readonly<{
  number: number;
  name: string;
  hasDefault: boolean;
}>;

export type SequenceDescriptor = Readonly<{
  oid: string;
  schema: string;
  name: string;
  tableOid: string;
  columnNumber: number;
  columnName: string;
}>;

export type RelationDescriptor = Readonly<{
  oid: string;
  schema: string;
  name: string;
  canonicalName: string;
  columns: readonly ColumnDescriptor[];
  sequences: readonly SequenceDescriptor[];
}>;

export type ReplayCapabilityDescriptor = Readonly<{
  relations: readonly RelationDescriptor[];
  restoreOrder: readonly RelationDescriptor[];
  sequences: readonly SequenceDescriptor[];
}>;

type RelationRow = {
  oid: unknown;
  schema_name: unknown;
  table_name: unknown;
  relkind: unknown;
  relpersistence: unknown;
  relrowsecurity: unknown;
  has_inheritance: unknown;
};

type ColumnRow = {
  table_oid: unknown;
  attnum: unknown;
  attname: unknown;
  atthasdef: unknown;
  attgenerated: unknown;
  attidentity: unknown;
  type_schema: unknown;
};

type ConstraintExecutableRow = {
  constraint_name: unknown;
  executable_schema: unknown;
  volatility: unknown;
};

type ForeignKeyRow = {
  child_oid: unknown;
  parent_oid: unknown;
  constraint_name: unknown;
  child_name: unknown;
  parent_name: unknown;
  confdeltype: unknown;
  confupdtype: unknown;
  condeferrable: unknown;
  condeferred: unknown;
};

type TriggerRow = {
  table_oid: unknown;
  trigger_name: unknown;
  tgisinternal: unknown;
  constraint_type: unknown;
};

type RuleRow = {
  table_oid: unknown;
  rule_name: unknown;
};

type SequenceRow = {
  sequence_oid: unknown;
  sequence_schema: unknown;
  sequence_name: unknown;
  table_oid: unknown;
  column_number: unknown;
  dependency_type: unknown;
};

type SequenceReferenceRow = {
  sequence_oid: unknown;
  table_oid: unknown;
  column_number: unknown;
};

const IDENTIFIER_PATTERN =
  /^[A-Za-z_][A-Za-z0-9_]*$/;

function assertIdentifier(
  value: string,
  kind: "schema" | "table"
): void {
  if (!IDENTIFIER_PATTERN.test(value)) {
    throw new ReplayCapabilityError(
      "REPLAY_TABLE_IDENTITY_AMBIGUOUS",
      `Replay ${kind} identifier "${value}" is unsupported.`
    );
  }
}

export function parseReplayScope(
  environment: NodeJS.ProcessEnv = process.env
): ReplayScope {
  const schema = environment.SHADOWSPEC_SCHEMA;

  if (!schema) {
    throw new ReplayCapabilityError(
      "REPLAY_TABLE_IDENTITY_AMBIGUOUS",
      "SHADOWSPEC_SCHEMA must identify one replay schema."
    );
  }

  assertIdentifier(schema, "schema");

  const rawTables = (
    environment.SHADOWSPEC_TABLES ?? ""
  ).split(",");
  const seen = new Set<string>();
  const tables: string[] = [];

  for (const rawTable of rawTables) {
    const table = rawTable.trim();

    if (!table) {
      throw new ReplayCapabilityError(
        "REPLAY_TABLE_IDENTITY_AMBIGUOUS",
        "SHADOWSPEC_TABLES contains an empty table identifier."
      );
    }

    assertIdentifier(table, "table");

    if (!seen.has(table)) {
      seen.add(table);
      tables.push(table);
    }
  }

  if (tables.length === 0) {
    throw new ReplayCapabilityError(
      "REPLAY_TABLE_IDENTITY_AMBIGUOUS",
      "SHADOWSPEC_TABLES must contain at least one replay table."
    );
  }

  return Object.freeze({
    schema,
    tables: Object.freeze(tables)
  });
}

export function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function canonicalName(schema: string, table: string) {
  return `${schema}.${table}`;
}

function asString(value: unknown, label: string): string {
  if (
    typeof value !== "string" &&
    typeof value !== "number"
  ) {
    throw new ReplayCapabilityError(
      "REPLAY_DATABASE_CAPABILITY_CHECK_FAILED",
      `PostgreSQL returned invalid ${label} capability metadata.`
    );
  }

  return String(value);
}

function asBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new ReplayCapabilityError(
      "REPLAY_DATABASE_CAPABILITY_CHECK_FAILED",
      `PostgreSQL returned invalid ${label} capability metadata.`
    );
  }

  return value;
}

function asNumber(value: unknown, label: string): number {
  const number = Number(value);

  if (!Number.isInteger(number)) {
    throw new ReplayCapabilityError(
      "REPLAY_DATABASE_CAPABILITY_CHECK_FAILED",
      `PostgreSQL returned invalid ${label} capability metadata.`
    );
  }

  return number;
}

async function resolveRelations(
  client: PoolClient,
  scope: ReplayScope
): Promise<RelationRow[]> {
  const result = await client.query<RelationRow>(
    `/* shadowspec:relations */
     SELECT c.oid::text AS oid,
            n.nspname AS schema_name,
            c.relname AS table_name,
            c.relkind,
            c.relpersistence,
            c.relrowsecurity,
            EXISTS (
              SELECT 1 FROM pg_catalog.pg_inherits i
              WHERE i.inhrelid = c.oid OR i.inhparent = c.oid
            ) AS has_inheritance
     FROM pg_catalog.pg_class c
     JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1
       AND c.relname = ANY($2::text[])
     ORDER BY n.nspname, c.relname`,
    [scope.schema, scope.tables]
  );

  return result.rows;
}

function assertResolvedRelations(
  scope: ReplayScope,
  rows: RelationRow[]
): Map<string, RelationRow> {
  const byName = new Map<string, RelationRow>();

  for (const row of rows) {
    const name = asString(row.table_name, "table name");

    if (byName.has(name)) {
      throw new ReplayCapabilityError(
        "REPLAY_TABLE_IDENTITY_AMBIGUOUS",
        `Replay table ${canonicalName(scope.schema, name)} resolved ambiguously.`
      );
    }

    byName.set(name, row);
  }

  for (const table of scope.tables) {
    if (!byName.has(table)) {
      throw new ReplayCapabilityError(
        "REPLAY_TABLE_NOT_FOUND",
        `Replay table ${canonicalName(scope.schema, table)} was not found.`
      );
    }
  }

  return byName;
}

function assertSupportedRelationKinds(
  scope: ReplayScope,
  resolved: Map<string, RelationRow>
): void {
  for (const table of scope.tables) {
    const row = resolved.get(table)!;
    const name = canonicalName(scope.schema, table);

    if (
      row.relkind !== "r" ||
      row.relpersistence !== "p" ||
      asBoolean(row.has_inheritance, "inheritance")
    ) {
      throw new ReplayCapabilityError(
        "REPLAY_RELATION_KIND_UNSUPPORTED",
        `Replay table ${name} is not a supported ordinary persistent table.`
      );
    }
  }
}

function relationSql(scope: ReplayScope): string {
  return scope.tables.map(
    (table) =>
      `ONLY ${quoteIdentifier(scope.schema)}.${quoteIdentifier(table)}`
  ).join(", ");
}

export async function lockReplayRelations(
  client: PoolClient,
  scope: ReplayScope
): Promise<void> {
  try {
    const initial = assertResolvedRelations(
      scope,
      await resolveRelations(client, scope)
    );
    assertSupportedRelationKinds(scope, initial);

    await client.query(
      `LOCK TABLE ${relationSql(scope)} IN ACCESS EXCLUSIVE MODE`
    );

    const locked = assertResolvedRelations(
      scope,
      await resolveRelations(client, scope)
    );
    assertSupportedRelationKinds(scope, locked);

    for (const table of scope.tables) {
      if (
        asString(initial.get(table)?.oid, "relation OID") !==
        asString(locked.get(table)?.oid, "relation OID")
      ) {
        throw new ReplayCapabilityError(
          "REPLAY_TABLE_IDENTITY_AMBIGUOUS",
          `Replay table ${canonicalName(scope.schema, table)} changed identity while acquiring its lock.`
        );
      }
    }
  } catch (error) {
    if (error instanceof ReplayCapabilityError) {
      throw error;
    }

    throw new ReplayCapabilityError(
      "REPLAY_DATABASE_CAPABILITY_CHECK_FAILED",
      "Replay database relation locking failed.",
      { cause: error }
    );
  }
}

function topologicalOrder(
  relations: readonly RelationDescriptor[],
  edges: readonly { parent: string; child: string }[]
): RelationDescriptor[] {
  const byOid = new Map(
    relations.map((relation) => [relation.oid, relation])
  );
  const indegree = new Map(
    relations.map((relation) => [relation.oid, 0])
  );
  const children = new Map<string, Set<string>>();

  for (const edge of edges) {
    const targets = children.get(edge.parent) ?? new Set<string>();
    if (!targets.has(edge.child)) {
      targets.add(edge.child);
      children.set(edge.parent, targets);
      indegree.set(edge.child, (indegree.get(edge.child) ?? 0) + 1);
    }
  }

  const ready = relations
    .filter((relation) => indegree.get(relation.oid) === 0)
    .sort((a, b) => a.canonicalName.localeCompare(b.canonicalName));
  const output: RelationDescriptor[] = [];

  while (ready.length > 0) {
    const relation = ready.shift()!;
    output.push(relation);

    for (const child of children.get(relation.oid) ?? []) {
      const next = (indegree.get(child) ?? 0) - 1;
      indegree.set(child, next);
      if (next === 0) {
        ready.push(byOid.get(child)!);
        ready.sort((a, b) =>
          a.canonicalName.localeCompare(b.canonicalName)
        );
      }
    }
  }

  if (output.length !== relations.length) {
    throw new ReplayCapabilityError(
      "REPLAY_FOREIGN_KEY_GRAPH_UNSUPPORTED",
      "Configured replay tables contain an unsupported foreign-key cycle."
    );
  }

  return output;
}

export function validateSnapshotShape(
  setup: ReplaySetup | undefined,
  relations: readonly RelationDescriptor[]
): void {
  if (!setup?.tables) {
    return;
  }

  for (const relation of relations) {
    const snapshot = setup.tables[relation.name];
    if (!snapshot) {
      continue;
    }

    if (!Array.isArray(snapshot.rows)) {
      throw new ReplayCapabilityError(
        "REPLAY_SNAPSHOT_SHAPE_UNSUPPORTED",
        `Replay snapshot for ${relation.canonicalName} must contain a rows array.`
      );
    }

    const expected = new Set(
      relation.columns.map((column) => column.name)
    );

    for (const row of snapshot.rows) {
      if (
        typeof row !== "object" ||
        row === null ||
        Array.isArray(row)
      ) {
        throw new ReplayCapabilityError(
          "REPLAY_SNAPSHOT_SHAPE_UNSUPPORTED",
          `Replay snapshot for ${relation.canonicalName} contains an unsupported row shape.`
        );
      }

      const actual = Object.keys(row);
      if (
        actual.length !== expected.size ||
        actual.some((column) => !expected.has(column))
      ) {
        throw new ReplayCapabilityError(
          "REPLAY_SNAPSHOT_SHAPE_UNSUPPORTED",
          `Replay snapshot rows for ${relation.canonicalName} must explicitly contain every writable ordinary column.`
        );
      }
    }
  }
}

export async function inspectReplayCapabilities(
  client: PoolClient,
  scope: ReplayScope,
  setup?: ReplaySetup
): Promise<ReplayCapabilityDescriptor> {
  try {
    const relationRows = await resolveRelations(client, scope);
    const resolved = assertResolvedRelations(scope, relationRows);
    const oids = scope.tables.map((table) =>
      asString(resolved.get(table)!.oid, "relation OID")
    );

    assertSupportedRelationKinds(scope, resolved);

    for (const table of scope.tables) {
      const row = resolved.get(table)!;
      const name = canonicalName(scope.schema, table);
      if (asBoolean(row.relrowsecurity, "row security")) {
        throw new ReplayCapabilityError(
          "REPLAY_MUTATION_SIDE_EFFECT_UNSUPPORTED",
          `Replay table ${name} has row-level security enabled.`
        );
      }
    }

    const columnsResult = await client.query<ColumnRow>(
      `/* shadowspec:columns */
       SELECT a.attrelid::text AS table_oid,
              a.attnum,
              a.attname,
              a.atthasdef,
              a.attgenerated,
              a.attidentity,
              type_ns.nspname AS type_schema
       FROM pg_catalog.pg_attribute a
       JOIN pg_catalog.pg_type typ ON typ.oid = a.atttypid
       JOIN pg_catalog.pg_namespace type_ns ON type_ns.oid = typ.typnamespace
       WHERE a.attrelid = ANY($1::oid[])
         AND a.attnum > 0
         AND NOT a.attisdropped
       ORDER BY a.attrelid, a.attnum`,
      [oids]
    );
    const columnsByTable = new Map<string, ColumnDescriptor[]>();

    for (const row of columnsResult.rows) {
      const tableOid = asString(row.table_oid, "column table OID");
      const relationRow = relationRows.find(
        (candidate) => asString(candidate.oid, "relation OID") === tableOid
      )!;
      const tableName = canonicalName(
        asString(relationRow.schema_name, "schema name"),
        asString(relationRow.table_name, "table name")
      );
      if (row.attgenerated !== "") {
        throw new ReplayCapabilityError(
          "REPLAY_RELATION_KIND_UNSUPPORTED",
          `Replay table ${tableName} contains a generated column.`
        );
      }
      if (row.attidentity !== "") {
        throw new ReplayCapabilityError(
          "REPLAY_RELATION_KIND_UNSUPPORTED",
          `Replay table ${tableName} contains an unsupported IDENTITY column.`
        );
      }
      if (row.type_schema !== "pg_catalog") {
        throw new ReplayCapabilityError(
          "REPLAY_MUTATION_SIDE_EFFECT_UNSUPPORTED",
          `Replay table ${tableName} contains a user-defined column type.`
        );
      }
      const columns = columnsByTable.get(tableOid) ?? [];
      columns.push(Object.freeze({
        number: asNumber(row.attnum, "column number"),
        name: asString(row.attname, "column name"),
        hasDefault: asBoolean(row.atthasdef, "column default")
      }));
      columnsByTable.set(tableOid, columns);
    }

    const fkResult = await client.query<ForeignKeyRow>(
      `/* shadowspec:foreign-keys */
       SELECT con.conrelid::text AS child_oid,
              con.confrelid::text AS parent_oid,
              con.conname AS constraint_name,
              child_ns.nspname || '.' || child.relname AS child_name,
              parent_ns.nspname || '.' || parent.relname AS parent_name,
              con.confdeltype,
              con.confupdtype,
              con.condeferrable,
              con.condeferred
       FROM pg_catalog.pg_constraint con
       JOIN pg_catalog.pg_class child ON child.oid = con.conrelid
       JOIN pg_catalog.pg_namespace child_ns ON child_ns.oid = child.relnamespace
       JOIN pg_catalog.pg_class parent ON parent.oid = con.confrelid
       JOIN pg_catalog.pg_namespace parent_ns ON parent_ns.oid = parent.relnamespace
       WHERE con.contype = 'f'
         AND (con.conrelid = ANY($1::oid[]) OR con.confrelid = ANY($1::oid[]))
       ORDER BY child_ns.nspname, child.relname, con.conname`,
      [oids]
    );
    const configured = new Set(oids);
    const edges: { parent: string; child: string }[] = [];

    for (const fk of fkResult.rows) {
      const child = asString(fk.child_oid, "foreign-key child OID");
      const parent = asString(fk.parent_oid, "foreign-key parent OID");
      const constraint = asString(fk.constraint_name, "constraint name");
      if (!configured.has(child) || !configured.has(parent)) {
        throw new ReplayCapabilityError(
          "REPLAY_TABLE_DEPENDENCY_UNCONFIGURED",
          `Foreign key ${constraint} crosses the configured replay boundary between ${asString(fk.child_name, "child name")} and ${asString(fk.parent_name, "parent name")}.`
        );
      }
      if (child === parent) {
        throw new ReplayCapabilityError(
          "REPLAY_FOREIGN_KEY_GRAPH_UNSUPPORTED",
          `Foreign key ${constraint} is a self-reference, which replay does not support.`
        );
      }
      edges.push({ parent, child });
    }

    const executableResult =
      await client.query<ConstraintExecutableRow>(
        `/* shadowspec:constraint-executables */
         SELECT con.conname AS constraint_name,
                proc_ns.nspname AS executable_schema,
                proc.provolatile AS volatility
         FROM pg_catalog.pg_constraint con
         JOIN pg_catalog.pg_depend dep
           ON dep.classid = 'pg_catalog.pg_constraint'::regclass
          AND dep.objid = con.oid
         LEFT JOIN pg_catalog.pg_proc direct_proc
           ON dep.refclassid = 'pg_catalog.pg_proc'::regclass
          AND direct_proc.oid = dep.refobjid
         LEFT JOIN pg_catalog.pg_operator op
           ON dep.refclassid = 'pg_catalog.pg_operator'::regclass
          AND op.oid = dep.refobjid
         JOIN pg_catalog.pg_proc proc
           ON proc.oid = COALESCE(direct_proc.oid, op.oprcode)
         JOIN pg_catalog.pg_namespace proc_ns ON proc_ns.oid = proc.pronamespace
         WHERE con.conrelid = ANY($1::oid[])
           AND con.contype IN ('c', 'x')
         ORDER BY con.conrelid, con.conname, proc_ns.nspname, proc.proname`,
        [oids]
      );

    for (const executable of executableResult.rows) {
      if (
        executable.executable_schema !== "pg_catalog" ||
        executable.volatility === "v"
      ) {
        throw new ReplayCapabilityError(
          "REPLAY_MUTATION_SIDE_EFFECT_UNSUPPORTED",
          `Replay constraint ${asString(executable.constraint_name, "constraint name")} invokes an unsupported executable expression.`
        );
      }
    }

    const triggerResult = await client.query<TriggerRow>(
      `/* shadowspec:triggers */
       SELECT t.tgrelid::text AS table_oid,
              t.tgname AS trigger_name,
              t.tgisinternal,
              con.contype AS constraint_type
       FROM pg_catalog.pg_trigger t
       LEFT JOIN pg_catalog.pg_constraint con ON con.oid = t.tgconstraint
       WHERE t.tgrelid = ANY($1::oid[])
       ORDER BY t.tgrelid, t.tgname`,
      [oids]
    );
    for (const trigger of triggerResult.rows) {
      if (
        trigger.tgisinternal !== true ||
        trigger.constraint_type !== "f"
      ) {
        throw new ReplayCapabilityError(
          "REPLAY_MUTATION_SIDE_EFFECT_UNSUPPORTED",
          `Replay table trigger ${asString(trigger.trigger_name, "trigger name")} is not an internal foreign-key trigger.`
        );
      }
    }

    const ruleResult = await client.query<RuleRow>(
      `/* shadowspec:rules */
       SELECT r.ev_class::text AS table_oid, r.rulename AS rule_name
       FROM pg_catalog.pg_rewrite r
       WHERE r.ev_class = ANY($1::oid[])
         AND r.rulename <> '_RETURN'
       ORDER BY r.ev_class, r.rulename`,
      [oids]
    );
    if (ruleResult.rows.length > 0) {
      throw new ReplayCapabilityError(
        "REPLAY_MUTATION_SIDE_EFFECT_UNSUPPORTED",
        `Replay table rewrite rule ${asString(ruleResult.rows[0].rule_name, "rule name")} is unsupported.`
      );
    }

    const sequenceResult = await client.query<SequenceRow>(
      `/* shadowspec:owned-sequences */
       SELECT seq.oid::text AS sequence_oid,
              seq_ns.nspname AS sequence_schema,
              seq.relname AS sequence_name,
              dep.refobjid::text AS table_oid,
              dep.refobjsubid AS column_number,
              dep.deptype AS dependency_type
       FROM pg_catalog.pg_depend dep
       JOIN pg_catalog.pg_class seq ON seq.oid = dep.objid AND seq.relkind = 'S'
       JOIN pg_catalog.pg_namespace seq_ns ON seq_ns.oid = seq.relnamespace
       WHERE dep.classid = 'pg_catalog.pg_class'::regclass
         AND dep.refclassid = 'pg_catalog.pg_class'::regclass
         AND dep.refobjid = ANY($1::oid[])
         AND dep.deptype IN ('a', 'i')
       ORDER BY dep.refobjid, dep.refobjsubid, seq.oid`,
      [oids]
    );
    const sequences: SequenceDescriptor[] = [];
    const sequencesByTable = new Map<string, SequenceDescriptor[]>();
    const ownedSequenceOids = new Set<string>();
    const ownedColumns = new Set<string>();

    for (const row of sequenceResult.rows) {
      if (row.dependency_type !== "a") {
        throw new ReplayCapabilityError(
          "REPLAY_SEQUENCE_SCOPE_UNSUPPORTED",
          "Replay supports SERIAL-owned sequences but not IDENTITY sequence ownership."
        );
      }
      const tableOid = asString(row.table_oid, "sequence table OID");
      const columnNumber = asNumber(row.column_number, "sequence column number");
      const sequenceOid = asString(row.sequence_oid, "sequence OID");
      const ownedColumn = `${tableOid}:${columnNumber}`;

      if (
        ownedSequenceOids.has(sequenceOid) ||
        ownedColumns.has(ownedColumn)
      ) {
        throw new ReplayCapabilityError(
          "REPLAY_SEQUENCE_SCOPE_UNSUPPORTED",
          "A replay sequence does not have exclusive single-column ownership."
        );
      }

      ownedSequenceOids.add(sequenceOid);
      ownedColumns.add(ownedColumn);
      const column = columnsByTable.get(tableOid)?.find(
        (candidate) => candidate.number === columnNumber
      );
      if (!column) {
        throw new ReplayCapabilityError(
          "REPLAY_SEQUENCE_SCOPE_UNSUPPORTED",
          "An owned replay sequence does not resolve to a configured table column."
        );
      }
      const sequence = Object.freeze({
        oid: sequenceOid,
        schema: asString(row.sequence_schema, "sequence schema"),
        name: asString(row.sequence_name, "sequence name"),
        tableOid,
        columnNumber,
        columnName: column.name
      });
      sequences.push(sequence);
      const tableSequences = sequencesByTable.get(tableOid) ?? [];
      tableSequences.push(sequence);
      sequencesByTable.set(tableOid, tableSequences);
    }

    const sequenceOids = sequences.map((sequence) => sequence.oid);
    const references = await client.query<SequenceReferenceRow>(
      `/* shadowspec:sequence-references */
       SELECT dep.refobjid::text AS sequence_oid,
              ad.adrelid::text AS table_oid,
              ad.adnum AS column_number
       FROM pg_catalog.pg_depend dep
       JOIN pg_catalog.pg_attrdef ad
         ON dep.classid = 'pg_catalog.pg_attrdef'::regclass
        AND dep.objid = ad.oid
       JOIN pg_catalog.pg_class seq ON seq.oid = dep.refobjid AND seq.relkind = 'S'
       WHERE dep.refclassid = 'pg_catalog.pg_class'::regclass
         AND (ad.adrelid = ANY($1::oid[]) OR dep.refobjid = ANY($2::oid[]))
       ORDER BY dep.refobjid, ad.adrelid, ad.adnum`,
      [oids, sequenceOids]
    );
    const ownedByOid = new Map(sequences.map((sequence) => [sequence.oid, sequence]));

    for (const reference of references.rows) {
      const sequenceOid = asString(reference.sequence_oid, "referenced sequence OID");
      const tableOid = asString(reference.table_oid, "sequence reference table OID");
      const columnNumber = asNumber(reference.column_number, "sequence reference column number");
      const owned = ownedByOid.get(sequenceOid);
      if (
        !owned ||
        owned.tableOid !== tableOid ||
        owned.columnNumber !== columnNumber ||
        !configured.has(tableOid)
      ) {
        throw new ReplayCapabilityError(
          "REPLAY_SEQUENCE_SCOPE_UNSUPPORTED",
          "A replay table uses a shared, unowned, or cross-scope sequence."
        );
      }
    }

    const relations = scope.tables.map((table) => {
      const row = resolved.get(table)!;
      const oid = asString(row.oid, "relation OID");
      return Object.freeze({
        oid,
        schema: scope.schema,
        name: table,
        canonicalName: canonicalName(scope.schema, table),
        columns: Object.freeze(columnsByTable.get(oid) ?? []),
        sequences: Object.freeze(sequencesByTable.get(oid) ?? [])
      });
    });
    const restoreOrder = topologicalOrder(relations, edges);
    validateSnapshotShape(setup, relations);

    return Object.freeze({
      relations: Object.freeze(relations),
      restoreOrder: Object.freeze(restoreOrder),
      sequences: Object.freeze(sequences)
    });
  } catch (error) {
    if (error instanceof ReplayCapabilityError) {
      throw error;
    }

    throw new ReplayCapabilityError(
      "REPLAY_DATABASE_CAPABILITY_CHECK_FAILED",
      "Replay database capability inspection failed.",
      { cause: error }
    );
  }
}

export function buildTruncateStatement(
  relations: readonly RelationDescriptor[]
): string {
  return `TRUNCATE TABLE ${relations.map(
    (relation) =>
      `ONLY ${quoteIdentifier(relation.schema)}.${quoteIdentifier(relation.name)}`
  ).join(", ")} RESTART IDENTITY RESTRICT`;
}
