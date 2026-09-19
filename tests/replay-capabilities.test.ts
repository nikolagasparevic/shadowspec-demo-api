import {
  describe,
  expect,
  it
} from "vitest";
import type { PoolClient } from "pg";
import {
  buildTruncateStatement,
  inspectReplayCapabilities,
  parseReplayScope,
  type RelationDescriptor
} from "../src/replay-capabilities";

type Catalog = {
  relations?: Record<string, unknown>[];
  columns?: Record<string, unknown>[];
  foreignKeys?: Record<string, unknown>[];
  triggers?: Record<string, unknown>[];
  rules?: Record<string, unknown>[];
  sequences?: Record<string, unknown>[];
  sequenceReferences?: Record<string, unknown>[];
};

function relation(
  oid: string,
  name: string,
  overrides: Record<string, unknown> = {}
) {
  return {
    oid,
    schema_name: "public",
    table_name: name,
    relkind: "r",
    relpersistence: "p",
    relrowsecurity: false,
    has_inheritance: false,
    ...overrides
  };
}

function column(oid: string, name = "id") {
  return {
    table_oid: oid,
    attnum: 1,
    attname: name,
    atthasdef: false,
    attgenerated: "",
    attidentity: "",
    type_schema: "pg_catalog"
  };
}

function client(catalog: Catalog): PoolClient {
  return {
    query: async (sql: string) => {
      if (sql.includes("shadowspec:relations")) {
        return { rows: catalog.relations ?? [] };
      }
      if (sql.includes("shadowspec:columns")) {
        return { rows: catalog.columns ?? [] };
      }
      if (sql.includes("shadowspec:foreign-keys")) {
        return { rows: catalog.foreignKeys ?? [] };
      }
      if (sql.includes("shadowspec:constraint-executables")) {
        return { rows: [] };
      }
      if (sql.includes("shadowspec:triggers")) {
        return { rows: catalog.triggers ?? [] };
      }
      if (sql.includes("shadowspec:rules")) {
        return { rows: catalog.rules ?? [] };
      }
      if (sql.includes("shadowspec:owned-sequences")) {
        return { rows: catalog.sequences ?? [] };
      }
      if (sql.includes("shadowspec:sequence-references")) {
        return { rows: catalog.sequenceReferences ?? [] };
      }
      return { rows: [] };
    }
  } as unknown as PoolClient;
}

function scope(tables: string[]) {
  return { schema: "public", tables } as const;
}

describe("replay capability configuration", () => {
  it("normalizes duplicate table names while preserving first occurrence", () => {
    expect(parseReplayScope({
      SHADOWSPEC_SCHEMA: "public",
      SHADOWSPEC_TABLES: "parents,children,parents"
    })).toEqual({
      schema: "public",
      tables: ["parents", "children"]
    });
  });

  it.each([
    ["orders,", "empty"],
    ["public.orders", "qualified"],
    ['"orders"', "quoted"],
    ["ord*", "wildcard"]
  ])("rejects %s configured table syntax", (tables) => {
    expect(() => parseReplayScope({
      SHADOWSPEC_SCHEMA: "public",
      SHADOWSPEC_TABLES: tables
    })).toThrowError(expect.objectContaining({
      code: "REPLAY_TABLE_IDENTITY_AMBIGUOUS"
    }));
  });

  it("builds one explicit schema-qualified RESTRICT truncate", () => {
    const relations = ["parents", "children"].map(
      (name, index): RelationDescriptor => ({
        oid: String(index + 1),
        schema: "public",
        name,
        canonicalName: `public.${name}`,
        columns: [],
        sequences: []
      })
    );

    expect(buildTruncateStatement(relations)).toBe(
      'TRUNCATE TABLE ONLY "public"."parents", ONLY "public"."children" RESTART IDENTITY RESTRICT'
    );
  });
});

describe("replay capability graph", () => {
  const fk = {
    child_oid: "2",
    parent_oid: "1",
    constraint_name: "children_parent_fkey",
    child_name: "public.children",
    parent_name: "public.parents",
    confdeltype: "a",
    confupdtype: "a",
    condeferrable: false,
    condeferred: false
  };

  it("derives deterministic parent-before-child restore order", async () => {
    const result = await inspectReplayCapabilities(
      client({
        relations: [relation("2", "children"), relation("1", "parents")],
        columns: [column("2"), column("1")],
        foreignKeys: [fk]
      }),
      scope(["children", "parents"]),
      {
        tables: {
          children: { rows: [{ id: 2 }] },
          parents: { rows: [{ id: 1 }] }
        }
      }
    );

    expect(result.restoreOrder.map((item) => item.name))
      .toEqual(["parents", "children"]);
  });

  it.each([
    [{ ...fk, child_oid: "9" }, "unconfigured child"],
    [{ ...fk, parent_oid: "9" }, "unconfigured parent"]
  ])("rejects an %s FK boundary", async (foreignKey) => {
    await expect(inspectReplayCapabilities(
      client({
        relations: [relation("1", "parents"), relation("2", "children")],
        columns: [column("1"), column("2")],
        foreignKeys: [foreignKey]
      }),
      scope(["parents", "children"])
    )).rejects.toMatchObject({
      code: "REPLAY_TABLE_DEPENDENCY_UNCONFIGURED"
    });
  });

  it("rejects self references", async () => {
    await expect(inspectReplayCapabilities(
      client({
        relations: [relation("1", "nodes")],
        columns: [column("1")],
        foreignKeys: [{
          ...fk,
          child_oid: "1",
          parent_oid: "1",
          constraint_name: "nodes_parent_fkey",
          child_name: "public.nodes",
          parent_name: "public.nodes"
        }]
      }),
      scope(["nodes"])
    )).rejects.toMatchObject({
      code: "REPLAY_FOREIGN_KEY_GRAPH_UNSUPPORTED"
    });
  });

  it("rejects multi-table cycles", async () => {
    await expect(inspectReplayCapabilities(
      client({
        relations: [relation("1", "a"), relation("2", "b")],
        columns: [column("1"), column("2")],
        foreignKeys: [
          { ...fk, child_oid: "2", parent_oid: "1" },
          {
            ...fk,
            child_oid: "1",
            parent_oid: "2",
            constraint_name: "a_b_fkey",
            child_name: "public.a",
            parent_name: "public.b"
          }
        ]
      }),
      scope(["a", "b"])
    )).rejects.toMatchObject({
      code: "REPLAY_FOREIGN_KEY_GRAPH_UNSUPPORTED"
    });
  });
});

describe("replay capability restrictions", () => {
  it.each([
    [{ relkind: "p" }, "partition"],
    [{ relkind: "v" }, "view"],
    [{ relkind: "m" }, "materialized view"],
    [{ relkind: "f" }, "foreign table"],
    [{ relpersistence: "t" }, "temporary table"],
    [{ has_inheritance: true }, "inheritance"],
  ])("rejects unsupported %s relations", async (overrides) => {
    await expect(inspectReplayCapabilities(
      client({ relations: [relation("1", "items", overrides)] }),
      scope(["items"])
    )).rejects.toMatchObject({
      code: "REPLAY_RELATION_KIND_UNSUPPORTED"
    });
  });

  it("rejects RLS, user triggers, and rewrite rules", async () => {
    const base = {
      relations: [relation("1", "items")],
      columns: [column("1")]
    };

    await expect(inspectReplayCapabilities(
      client({ relations: [relation("1", "items", { relrowsecurity: true })] }),
      scope(["items"])
    )).rejects.toMatchObject({ code: "REPLAY_MUTATION_SIDE_EFFECT_UNSUPPORTED" });
    await expect(inspectReplayCapabilities(
      client({ ...base, triggers: [{ table_oid: "1", trigger_name: "audit", tgisinternal: false, constraint_type: null }] }),
      scope(["items"])
    )).rejects.toMatchObject({ code: "REPLAY_MUTATION_SIDE_EFFECT_UNSUPPORTED" });
    await expect(inspectReplayCapabilities(
      client({ ...base, rules: [{ table_oid: "1", rule_name: "audit" }] }),
      scope(["items"])
    )).rejects.toMatchObject({ code: "REPLAY_MUTATION_SIDE_EFFECT_UNSUPPORTED" });
  });

  it.each([
    [{ attgenerated: "s" }, "generated"],
    [{ attidentity: "a" }, "identity"]
  ])("rejects %s columns", async (overrides) => {
    await expect(inspectReplayCapabilities(
      client({
        relations: [relation("1", "items")],
        columns: [{ ...column("1"), ...overrides }]
      }),
      scope(["items"])
    )).rejects.toMatchObject({
      code: "REPLAY_RELATION_KIND_UNSUPPORTED"
    });
  });

  it("rejects incomplete snapshot rows before mutation", async () => {
    await expect(inspectReplayCapabilities(
      client({
        relations: [relation("1", "items")],
        columns: [column("1"), { ...column("1", "title"), attnum: 2 }]
      }),
      scope(["items"]),
      { tables: { items: { rows: [{ id: 1 }] } } }
    )).rejects.toMatchObject({
      code: "REPLAY_SNAPSHOT_SHAPE_UNSUPPORTED"
    });
  });

  it("rejects configured defaults that reference an unowned sequence", async () => {
    await expect(inspectReplayCapabilities(
      client({
        relations: [relation("1", "items")],
        columns: [column("1")],
        sequenceReferences: [{
          sequence_oid: "9",
          table_oid: "1",
          column_number: 1
        }]
      }),
      scope(["items"])
    )).rejects.toMatchObject({
      code: "REPLAY_SEQUENCE_SCOPE_UNSUPPORTED"
    });
  });
});
