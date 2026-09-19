import { createHash } from "node:crypto";
import {
  describe,
  expect,
  it,
  vi
} from "vitest";
import type { PoolClient } from "pg";
import { applyReplaySetup } from "../src/setup-replay";
import type { ReplayPool } from "../src/replay-safety";

const TOKEN = "0123456789abcdef0123456789abcdef";
const PROJECT_ID =
  "11111111-1111-4111-8111-111111111111";
const DATABASE_ID =
  "22222222-2222-4222-8222-222222222222";
const DATABASE_NAME = "shadowspec_test_replay";

function environment(
  tables = "parents,children"
): NodeJS.ProcessEnv {
  return {
    SHADOWSPEC_REPLAY: "true",
    SHADOWSPEC_PROJECT_ID: PROJECT_ID,
    SHADOWSPEC_REPLAY_DATABASE_ID: DATABASE_ID,
    SHADOWSPEC_REPLAY_TOKEN: TOKEN,
    SHADOWSPEC_REPLAY_DATABASE_NAME:
      DATABASE_NAME,
    SHADOWSPEC_SCHEMA: "public",
    SHADOWSPEC_TABLES: tables
  };
}

function marker() {
  return {
    marker_version: 1,
    project_id: PROJECT_ID,
    replay_database_id: DATABASE_ID,
    database_name: DATABASE_NAME,
    token_sha256: createHash("sha256")
      .update(TOKEN)
      .digest("hex")
  };
}

function harness(
  failWhen?: (sql: string) => boolean
) {
  const tableOids: Record<string, string> = {
    parents: "101",
    children: "102",
    orders: "103"
  };
  const insertedMaximum = new Map<string, unknown>();
  const queryImplementation =
    async (sql: string, parameters?: unknown[]) => {
      if (failWhen?.(sql)) {
        throw new Error("injected setup failure");
      }

      if (sql.includes("current_database()")) {
        return {
          rows: [{ database_name: DATABASE_NAME }]
        };
      }

      if (
        sql.includes(
          "shadowspec_internal.replay_target"
        )
      ) {
        return { rows: [marker()] };
      }

      if (sql.includes("shadowspec:relations")) {
        const tables = parameters?.[1] as string[];
        return {
          rows: tables.map((table) => ({
            oid: tableOids[table] ?? "999",
            schema_name: "public",
            table_name: table,
            relkind: "r",
            relpersistence: "p",
            relrowsecurity: false,
            has_inheritance: false
          }))
        };
      }

      if (sql.includes("shadowspec:columns")) {
        const oids = parameters?.[0] as string[];
        return {
          rows: oids.flatMap((oid) => [
            {
              table_oid: oid,
              attnum: 1,
              attname: "id",
              atthasdef: true,
              attgenerated: "",
              attidentity: "",
              type_schema: "pg_catalog"
            },
            ...(oid === tableOids.children
              ? [{
                  table_oid: oid,
                  attnum: 2,
                  attname: "parent_id",
                  atthasdef: false,
                  attgenerated: "",
                  attidentity: "",
                  type_schema: "pg_catalog"
                }]
              : [])
          ])
        };
      }

      if (sql.includes("shadowspec:foreign-keys")) {
        const oids = new Set(parameters?.[0] as string[]);
        return {
          rows:
            oids.has(tableOids.parents) &&
            oids.has(tableOids.children)
              ? [{
                  child_oid: tableOids.children,
                  parent_oid: tableOids.parents,
                  constraint_name: "children_parent_id_fkey",
                  child_name: "public.children",
                  parent_name: "public.parents",
                  confdeltype: "a",
                  confupdtype: "a",
                  condeferrable: false,
                  condeferred: false
                }]
              : []
        };
      }

      if (
        sql.includes("shadowspec:triggers") ||
        sql.includes("shadowspec:rules") ||
        sql.includes("shadowspec:constraint-executables")
      ) {
        return { rows: [] };
      }

      if (sql.includes("shadowspec:owned-sequences")) {
        const oids = parameters?.[0] as string[];
        return {
          rows: oids.map((oid) => ({
            sequence_oid: String(Number(oid) + 1000),
            sequence_schema: "public",
            sequence_name: `table_${oid}_id_seq`,
            table_oid: oid,
            column_number: 1,
            dependency_type: "a"
          }))
        };
      }

      if (sql.includes("shadowspec:sequence-references")) {
        const oids = parameters?.[0] as string[];
        return {
          rows: oids.map((oid) => ({
            sequence_oid: String(Number(oid) + 1000),
            table_oid: oid,
            column_number: 1
          }))
        };
      }

      if (sql.startsWith("INSERT")) {
        const match = sql.match(/INSERT INTO "public"\."([^"]+)"/);
        if (match) {
          insertedMaximum.set(match[1], parameters?.[0]);
        }
        return { rows: [] };
      }

      if (sql.includes("SELECT MAX(")) {
        const match = sql.match(/FROM ONLY "public"\."([^"]+)"/);
        return {
          rows: [{
            max_value: match
              ? insertedMaximum.get(match[1]) ?? null
              : null
          }]
        };
      }

      return { rows: [] };
    };
  const query = vi.fn(queryImplementation);
  const release = vi.fn();
  const client = {
    query,
    release
  } as unknown as PoolClient;
  const connect = vi.fn(async () => client);
  const pool = {
    connect
  } as unknown as ReplayPool;

  return {
    pool,
    connect,
    query,
    release,
    queryImplementation
  };
}

function sqlCalls(query: ReturnType<typeof vi.fn>) {
  return query.mock.calls.map(
    ([sql]) => sql as string
  );
}

describe("guarded replay setup", () => {
  it("uses FK order even when snapshot keys are reversed", async () => {
    const test = harness();

    await applyReplaySetup(
      {
        tables: {
          children: {
            rows: [{ id: 2, parent_id: 1 }]
          },
          parents: { rows: [{ id: 1 }] }
        }
      },
      test.pool,
      environment()
    );

    const inserts = sqlCalls(test.query).filter(
      (sql) => sql.startsWith("INSERT")
    );
    expect(inserts).toEqual([
      expect.stringContaining(
        'INSERT INTO "public"."parents"'
      ),
      expect.stringContaining(
        'INSERT INTO "public"."children"'
      )
    ]);
  });

  it("ignores unconfigured setup tables", async () => {
    const test = harness();

    await applyReplaySetup(
      {
        tables: {
          parents: { rows: [{ id: 1 }] },
          unrelated: { rows: [{ id: 99 }] }
        }
      },
      test.pool,
      environment("parents")
    );

    expect(
      sqlCalls(test.query).some((sql) =>
        sql.includes("unrelated")
      )
    ).toBe(false);
  });

  it("deduplicates configured table names", async () => {
    const test = harness();

    await applyReplaySetup(
      { tables: {} },
      test.pool,
      environment("parents, children, parents, children")
    );

    const truncates = sqlCalls(test.query).filter(
      (sql) => sql.startsWith("TRUNCATE")
    );
    expect(truncates).toHaveLength(1);
    expect(truncates[0]).toContain(
      'ONLY "public"."parents", ONLY "public"."children"'
    );
    expect(truncates[0]).toContain(
      "RESTART IDENTITY RESTRICT"
    );
  });

  it("skips missing snapshots and leaves empty-table sequences restarted", async () => {
    const test = harness();

    await applyReplaySetup(
      {
        tables: {
          parents: { rows: [] }
        }
      },
      test.pool,
      environment()
    );

    const calls = sqlCalls(test.query);
    expect(
      calls.filter((sql) => sql.includes("setval"))
    ).toHaveLength(0);
    expect(
      calls.some((sql) =>
        sql.includes("'children'")
      )
    ).toBe(false);
  });

  it("preserves single-table reset, insert, and sequence repair", async () => {
    const test = harness();

    await applyReplaySetup(
      {
        tables: {
          orders: { rows: [{ id: 1 }] }
        }
      },
      test.pool,
      environment("orders")
    );

    const calls = sqlCalls(test.query);
    expect(calls.filter((sql) =>
      sql.startsWith("TRUNCATE")
    )).toHaveLength(1);
    expect(calls.filter((sql) =>
      sql.startsWith("INSERT")
    )).toHaveLength(1);
    expect(calls.filter((sql) =>
      sql.includes("setval")
    )).toHaveLength(1);
  });

  it("verifies and mutates through one client in transaction order", async () => {
    const test = harness();
    const poolQuery = vi.fn();
    const guardedPool = {
      connect: test.connect,
      query: poolQuery
    } as unknown as ReplayPool;

    await applyReplaySetup(
      {
        tables: {
          parents: { rows: [{ id: 1 }] }
        }
      },
      guardedPool,
      environment("parents")
    );

    const calls = sqlCalls(test.query);
    expect(calls[0]).toBe("BEGIN");
    expect(calls[1]).toContain(
      "current_database()"
    );
    expect(calls[2]).toContain("FOR SHARE");
    expect(
      calls.findIndex((sql) => sql.startsWith("TRUNCATE"))
    ).toBeGreaterThan(2);
    expect(calls.at(-1)).toBe("COMMIT");
    expect(poolQuery).not.toHaveBeenCalled();
    expect(test.connect).toHaveBeenCalledOnce();
    expect(test.release).toHaveBeenCalledWith(false);
  });

  it("rolls back a second-table failure and releases the client", async () => {
    const test = harness((sql) =>
      sql.startsWith('INSERT INTO "public"."children"')
    );

    await expect(
      applyReplaySetup(
        {
          tables: {
            parents: { rows: [{ id: 1 }] },
            children: {
              rows: [{ id: 2, parent_id: 1 }]
            }
          }
        },
        test.pool,
        environment()
      )
    ).rejects.toThrow("injected setup failure");

    const calls = sqlCalls(test.query);
    expect(calls).toContain("ROLLBACK");
    expect(calls).not.toContain("COMMIT");
    expect(test.release).toHaveBeenCalledWith(false);
  });

  it("rolls back sequence repair failure", async () => {
    const test = harness((sql) =>
      sql.includes("setval")
    );

    await expect(
      applyReplaySetup(
        {
          tables: {
            parents: { rows: [{ id: 1 }] }
          }
        },
        test.pool,
        environment("parents")
      )
    ).rejects.toThrow("injected setup failure");

    expect(sqlCalls(test.query)).toContain(
      "ROLLBACK"
    );
  });

  it("detects marker removal between scenarios before another mutation", async () => {
    const test = harness();
    let markerReads = 0;
    test.query.mockImplementation(
      async (sql: string, parameters?: unknown[]) => {
        if (sql.includes("current_database()")) {
          return {
            rows: [{ database_name: DATABASE_NAME }]
          };
        }
        if (
          sql.includes(
            "shadowspec_internal.replay_target"
          )
        ) {
          markerReads++;
          return {
            rows: markerReads === 1
              ? [marker()]
              : []
          };
        }
        return test.queryImplementation(
          sql,
          parameters
        );
      }
    );

    await applyReplaySetup(
      undefined,
      test.pool,
      environment("parents")
    );
    await expect(
      applyReplaySetup(
        undefined,
        test.pool,
        environment("parents")
      )
    ).rejects.toMatchObject({
      code: "REPLAY_MARKER_ROW_MISSING"
    });

    expect(
      sqlCalls(test.query).filter((sql) =>
        sql.startsWith("TRUNCATE")
      )
    ).toHaveLength(1);
  });
});
