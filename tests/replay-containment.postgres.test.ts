import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it
} from "vitest";
import { Pool } from "pg";
import { applyReplaySetup } from "../src/setup-replay";
import {
  lockReplayRelations,
  parseReplayScope
} from "../src/replay-capabilities";

const runRealPostgres =
  process.env.SHADOWSPEC_REAL_PG === "true";
const TOKEN = "containment-postgres-token-0123456789";
const PROJECT_ID =
  "11111111-1111-4111-8111-111111111111";
const DATABASE_ID =
  "22222222-2222-4222-8222-222222222222";
const databaseName = `ss_contain_${randomUUID()
  .replaceAll("-", "")
  .slice(0, 18)}`;

function connection(database: string) {
  return {
    host: process.env.DB_HOST || "127.0.0.1",
    port: Number(process.env.DB_PORT || 5432),
    user: process.env.DB_USER || "shadowspec",
    password:
      process.env.DB_PASSWORD || "shadowspec123",
    database
  };
}

function environment(schema: string, tables: string) {
  return {
    SHADOWSPEC_REPLAY: "true",
    SHADOWSPEC_PROJECT_ID: PROJECT_ID,
    SHADOWSPEC_REPLAY_DATABASE_ID: DATABASE_ID,
    SHADOWSPEC_REPLAY_TOKEN: TOKEN,
    SHADOWSPEC_REPLAY_DATABASE_NAME: databaseName,
    SHADOWSPEC_SCHEMA: schema,
    SHADOWSPEC_TABLES: tables
  } satisfies NodeJS.ProcessEnv;
}

const suite = runRealPostgres
  ? describe
  : describe.skip;

suite("replay containment with real PostgreSQL", () => {
  let adminPool: Pool;
  let replayPool: Pool;
  let caseNumber = 0;

  beforeAll(async () => {
    adminPool = new Pool(connection("postgres"));
    await adminPool.query(
      `CREATE DATABASE "${databaseName}"`
    );
    replayPool = new Pool(connection(databaseName));
    await replayPool.query(
      fs.readFileSync(
        path.resolve(
          __dirname,
          "..",
          "sql",
          "replay-target-schema.sql"
        ),
        "utf8"
      )
    );
  }, 30_000);

  beforeEach(async () => {
    await replayPool.query(
      "DELETE FROM shadowspec_internal.replay_target"
    );
    await replayPool.query(
      `INSERT INTO shadowspec_internal.replay_target (
         singleton_id, marker_version, project_id, replay_database_id,
         database_name, token_sha256
       ) VALUES ($1, 1, $2, $3, $4, $5)`,
      [
        1,
        PROJECT_ID,
        DATABASE_ID,
        databaseName,
        createHash("sha256").update(TOKEN).digest("hex")
      ]
    );
  });

  afterAll(async () => {
    if (replayPool) {
      await replayPool.end();
    }
    if (adminPool) {
      await adminPool.query(
        `DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`
      );
      await adminPool.end();
    }
  }, 30_000);

  async function withSchema(
    ddl: (schema: string) => string,
    test: (schema: string) => Promise<void>
  ) {
    const schema = `contain_${++caseNumber}`;
    await replayPool.query(`CREATE SCHEMA "${schema}"`);
    try {
      await replayPool.query(ddl(schema));
      await test(schema);
    } finally {
      await replayPool.query(
        `DROP SCHEMA IF EXISTS "${schema}" CASCADE`
      );
    }
  }

  it("restores a standalone SERIAL column with a non-id name", async () => {
    await withSchema(
      (schema) => `CREATE TABLE "${schema}".books (
        book_key SERIAL PRIMARY KEY,
        title TEXT NOT NULL
      )`,
      async (schema) => {
        await applyReplaySetup(
          { tables: { books: { rows: [{ book_key: 7, title: "Seven" }] } } },
          replayPool,
          environment(schema, "books")
        );

        const rows = await replayPool.query(
          `SELECT book_key, title FROM "${schema}".books`
        );
        const next = await replayPool.query(
          `SELECT nextval('"${schema}".books_book_key_seq') AS value`
        );
        expect(rows.rows).toEqual([{ book_key: 7, title: "Seven" }]);
        expect(Number(next.rows[0].value)).toBe(8);
      }
    );
  });

  it("restores configured FK tables parent-first despite opposite configuration order", async () => {
    await withSchema(
      (schema) => `
        CREATE TABLE "${schema}".parents (id SERIAL PRIMARY KEY, name TEXT NOT NULL);
        CREATE TABLE "${schema}".children (
          id SERIAL PRIMARY KEY,
          parent_id INTEGER NOT NULL REFERENCES "${schema}".parents(id),
          name TEXT NOT NULL
        );`,
      async (schema) => {
        await applyReplaySetup(
          { tables: {
            children: { rows: [{ id: 2, parent_id: 1, name: "child" }] },
            parents: { rows: [{ id: 1, name: "parent" }] }
          } },
          replayPool,
          environment(schema, "children,parents")
        );
        const result = await replayPool.query(
          `SELECT c.id FROM "${schema}".children c
           JOIN "${schema}".parents p ON p.id = c.parent_id`
        );
        expect(result.rows).toEqual([{ id: 2 }]);
      }
    );
  });

  it("rejects configured parent with unconfigured child without mutation", async () => {
    await withSchema(
      (schema) => `
        CREATE TABLE "${schema}".parents (id INTEGER PRIMARY KEY);
        CREATE TABLE "${schema}".children (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES "${schema}".parents(id));
        INSERT INTO "${schema}".parents VALUES (9);
        INSERT INTO "${schema}".children VALUES (10, 9);`,
      async (schema) => {
        await expect(applyReplaySetup(
          { tables: { parents: { rows: [{ id: 1 }] } } },
          replayPool,
          environment(schema, "parents")
        )).rejects.toMatchObject({ code: "REPLAY_TABLE_DEPENDENCY_UNCONFIGURED" });
        expect((await replayPool.query(`SELECT id FROM "${schema}".parents`)).rows)
          .toEqual([{ id: 9 }]);
        expect((await replayPool.query(`SELECT id FROM "${schema}".children`)).rows)
          .toEqual([{ id: 10 }]);
      }
    );
  });

  it("rejects configured child with unconfigured parent without mutation", async () => {
    await withSchema(
      (schema) => `
        CREATE TABLE "${schema}".parents (id INTEGER PRIMARY KEY);
        CREATE TABLE "${schema}".children (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES "${schema}".parents(id));
        INSERT INTO "${schema}".parents VALUES (9);
        INSERT INTO "${schema}".children VALUES (10, 9);`,
      async (schema) => {
        await expect(applyReplaySetup(
          { tables: { children: { rows: [{ id: 1, parent_id: 9 }] } } },
          replayPool,
          environment(schema, "children")
        )).rejects.toMatchObject({ code: "REPLAY_TABLE_DEPENDENCY_UNCONFIGURED" });
        expect((await replayPool.query(`SELECT id FROM "${schema}".children`)).rows)
          .toEqual([{ id: 10 }]);
      }
    );
  });

  it("restores a three-table FK chain topologically", async () => {
    await withSchema(
      (schema) => `
        CREATE TABLE "${schema}".a (id INTEGER PRIMARY KEY);
        CREATE TABLE "${schema}".b (id INTEGER PRIMARY KEY, a_id INTEGER REFERENCES "${schema}".a(id));
        CREATE TABLE "${schema}".c (id INTEGER PRIMARY KEY, b_id INTEGER REFERENCES "${schema}".b(id));`,
      async (schema) => {
        await applyReplaySetup(
          { tables: {
            c: { rows: [{ id: 3, b_id: 2 }] },
            b: { rows: [{ id: 2, a_id: 1 }] },
            a: { rows: [{ id: 1 }] }
          } },
          replayPool,
          environment(schema, "c,b,a")
        );
        expect((await replayPool.query(`SELECT id FROM "${schema}".c`)).rows)
          .toEqual([{ id: 3 }]);
      }
    );
  });

  it.each([
    ["cycle", (schema: string) => `
      CREATE TABLE "${schema}".a (id INTEGER PRIMARY KEY, b_id INTEGER);
      CREATE TABLE "${schema}".b (id INTEGER PRIMARY KEY, a_id INTEGER REFERENCES "${schema}".a(id));
      ALTER TABLE "${schema}".a ADD FOREIGN KEY (b_id) REFERENCES "${schema}".b(id);`, "a,b"],
    ["self reference", (schema: string) => `
      CREATE TABLE "${schema}".nodes (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES "${schema}".nodes(id));`, "nodes"]
  ])("rejects an FK %s", async (_name, ddl, tables) => {
    await withSchema(ddl, async (schema) => {
      await expect(applyReplaySetup(
        undefined,
        replayPool,
        environment(schema, tables)
      )).rejects.toMatchObject({ code: "REPLAY_FOREIGN_KEY_GRAPH_UNSUPPORTED" });
    });
  });

  it("resolves the configured schema and leaves a same-named table untouched", async () => {
    await withSchema(
      (schema) => `CREATE TABLE "${schema}".items (id INTEGER PRIMARY KEY); INSERT INTO "${schema}".items VALUES (9);`,
      async (schema) => {
        const other = `${schema}_other`;
        await replayPool.query(`CREATE SCHEMA "${other}"; CREATE TABLE "${other}".items (id INTEGER PRIMARY KEY); INSERT INTO "${other}".items VALUES (77);`);
        try {
          await applyReplaySetup(
            { tables: { items: { rows: [{ id: 1 }] } } },
            replayPool,
            environment(schema, "items")
          );
          expect((await replayPool.query(`SELECT id FROM "${other}".items`)).rows)
            .toEqual([{ id: 77 }]);
        } finally {
          await replayPool.query(`DROP SCHEMA "${other}" CASCADE`);
        }
      }
    );
  });

  it.each([
    ["INSERT trigger", (schema: string) => `
      CREATE TABLE "${schema}".audit (message TEXT);
      CREATE TABLE "${schema}".items (id INTEGER PRIMARY KEY);
      CREATE FUNCTION "${schema}".audit_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO "${schema}".audit VALUES ('insert'); RETURN NEW; END $$;
      CREATE TRIGGER item_audit AFTER INSERT ON "${schema}".items FOR EACH ROW EXECUTE FUNCTION "${schema}".audit_insert();`],
    ["TRUNCATE trigger", (schema: string) => `
      CREATE TABLE "${schema}".audit (message TEXT);
      CREATE TABLE "${schema}".items (id INTEGER PRIMARY KEY);
      CREATE FUNCTION "${schema}".audit_truncate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO "${schema}".audit VALUES ('truncate'); RETURN NULL; END $$;
      CREATE TRIGGER item_audit AFTER TRUNCATE ON "${schema}".items EXECUTE FUNCTION "${schema}".audit_truncate();`],
    ["rewrite rule", (schema: string) => `
      CREATE TABLE "${schema}".audit (message TEXT);
      CREATE TABLE "${schema}".items (id INTEGER PRIMARY KEY);
      CREATE RULE item_audit AS ON INSERT TO "${schema}".items DO ALSO INSERT INTO "${schema}".audit VALUES ('rule');`]
  ])("rejects a user %s before it can mutate audit state", async (_name, ddl) => {
    await withSchema(ddl, async (schema) => {
      await expect(applyReplaySetup(
        { tables: { items: { rows: [{ id: 1 }] } } },
        replayPool,
        environment(schema, "items")
      )).rejects.toMatchObject({ code: "REPLAY_MUTATION_SIDE_EFFECT_UNSUPPORTED" });
      expect((await replayPool.query(`SELECT * FROM "${schema}".audit`)).rows)
        .toEqual([]);
    });
  });

  it("rejects RLS", async () => {
    await withSchema(
      (schema) => `CREATE TABLE "${schema}".items (id INTEGER PRIMARY KEY); ALTER TABLE "${schema}".items ENABLE ROW LEVEL SECURITY;`,
      async (schema) => {
        await expect(applyReplaySetup(undefined, replayPool, environment(schema, "items")))
          .rejects.toMatchObject({ code: "REPLAY_MUTATION_SIDE_EFFECT_UNSUPPORTED" });
      }
    );
  });

  it("allows a built-in declarative CHECK constraint", async () => {
    await withSchema(
      (schema) => `CREATE TABLE "${schema}".items (
        id INTEGER PRIMARY KEY,
        state TEXT NOT NULL CHECK (state IN ('available', 'reserved'))
      );`,
      async (schema) => {
        await applyReplaySetup(
          { tables: { items: { rows: [{ id: 1, state: "available" }] } } },
          replayPool,
          environment(schema, "items")
        );
        expect((await replayPool.query(`SELECT state FROM "${schema}".items`)).rows)
          .toEqual([{ state: "available" }]);
      }
    );
  });

  it("rejects a CHECK constraint that invokes a user function", async () => {
    await withSchema(
      (schema) => `
        CREATE TABLE "${schema}".audit (value INTEGER);
        CREATE FUNCTION "${schema}".audit_check(value INTEGER) RETURNS BOOLEAN LANGUAGE plpgsql VOLATILE AS $$ BEGIN INSERT INTO "${schema}".audit VALUES (value); RETURN true; END $$;
        CREATE TABLE "${schema}".items (
          id INTEGER PRIMARY KEY CHECK ("${schema}".audit_check(id))
        );`,
      async (schema) => {
        await expect(applyReplaySetup(
          { tables: { items: { rows: [{ id: 1 }] } } },
          replayPool,
          environment(schema, "items")
        )).rejects.toMatchObject({ code: "REPLAY_MUTATION_SIDE_EFFECT_UNSUPPORTED" });
        expect((await replayPool.query(`SELECT * FROM "${schema}".audit`)).rows)
          .toEqual([]);
      }
    );
  });

  it.each([
    ["partitioned parent", (schema: string) => `CREATE TABLE "${schema}".events (id INTEGER) PARTITION BY RANGE (id); CREATE TABLE "${schema}".events_1 PARTITION OF "${schema}".events FOR VALUES FROM (0) TO (10);`, "events"],
    ["partition leaf", (schema: string) => `CREATE TABLE "${schema}".events (id INTEGER) PARTITION BY RANGE (id); CREATE TABLE "${schema}".events_1 PARTITION OF "${schema}".events FOR VALUES FROM (0) TO (10);`, "events_1"],
    ["inheritance parent", (schema: string) => `CREATE TABLE "${schema}".base (id INTEGER); CREATE TABLE "${schema}".derived () INHERITS ("${schema}".base);`, "base"],
    ["inheritance child", (schema: string) => `CREATE TABLE "${schema}".base (id INTEGER); CREATE TABLE "${schema}".derived () INHERITS ("${schema}".base);`, "derived"],
    ["view", (schema: string) => `CREATE TABLE "${schema}".base (id INTEGER); CREATE VIEW "${schema}".derived AS SELECT * FROM "${schema}".base;`, "derived"],
    ["materialized view", (schema: string) => `CREATE TABLE "${schema}".base (id INTEGER); CREATE MATERIALIZED VIEW "${schema}".derived AS SELECT * FROM "${schema}".base;`, "derived"]
  ])("rejects a %s", async (_name, ddl, table) => {
    await withSchema(ddl, async (schema) => {
      await expect(applyReplaySetup(undefined, replayPool, environment(schema, table)))
        .rejects.toMatchObject({ code: "REPLAY_RELATION_KIND_UNSUPPORTED" });
    });
  });

  it.each([
    ["IDENTITY", (schema: string) => `CREATE TABLE "${schema}".items (id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY);`],
    ["generated", (schema: string) => `CREATE TABLE "${schema}".items (value INTEGER, doubled INTEGER GENERATED ALWAYS AS (value * 2) STORED);`]
  ])("rejects %s columns", async (_name, ddl) => {
    await withSchema(ddl, async (schema) => {
      await expect(applyReplaySetup(undefined, replayPool, environment(schema, "items")))
        .rejects.toMatchObject({ code: "REPLAY_RELATION_KIND_UNSUPPORTED" });
    });
  });

  it("rejects a shared or unowned sequence", async () => {
    await withSchema(
      (schema) => `CREATE SEQUENCE "${schema}".shared; CREATE TABLE "${schema}".items (id INTEGER DEFAULT nextval('"${schema}".shared'), value TEXT);`,
      async (schema) => {
        await expect(applyReplaySetup(
          { tables: { items: { rows: [{ id: 1, value: "x" }] } } },
          replayPool,
          environment(schema, "items")
        )).rejects.toMatchObject({ code: "REPLAY_SEQUENCE_SCOPE_UNSUPPORTED" });
      }
    );
  });

  it("rejects incomplete snapshot columns before mutation", async () => {
    await withSchema(
      (schema) => `CREATE TABLE "${schema}".items (id SERIAL PRIMARY KEY, value TEXT DEFAULT 'generated'); INSERT INTO "${schema}".items (value) VALUES ('original');`,
      async (schema) => {
        await expect(applyReplaySetup(
          { tables: { items: { rows: [{ id: 9 }] } } },
          replayPool,
          environment(schema, "items")
        )).rejects.toMatchObject({ code: "REPLAY_SNAPSHOT_SHAPE_UNSUPPORTED" });
        expect((await replayPool.query(`SELECT value FROM "${schema}".items`)).rows)
          .toEqual([{ value: "original" }]);
      }
    );
  });

  it("rolls back tables and SERIAL state after a restore failure", async () => {
    await withSchema(
      (schema) => `CREATE TABLE "${schema}".items (id SERIAL PRIMARY KEY, value TEXT NOT NULL); INSERT INTO "${schema}".items VALUES (9, 'original'); SELECT setval('"${schema}".items_id_seq', 9, true);`,
      async (schema) => {
        await expect(applyReplaySetup(
          { tables: { items: { rows: [
            { id: 1, value: "one" },
            { id: 1, value: "duplicate" }
          ] } } },
          replayPool,
          environment(schema, "items")
        )).rejects.toThrow();
        expect((await replayPool.query(`SELECT id, value FROM "${schema}".items`)).rows)
          .toEqual([{ id: 9, value: "original" }]);
        const next = await replayPool.query(`SELECT nextval('"${schema}".items_id_seq') AS value`);
        expect(Number(next.rows[0].value)).toBe(10);
      }
    );
  });

  it("leaves an empty SERIAL table at RESTART IDENTITY state", async () => {
    await withSchema(
      (schema) => `CREATE TABLE "${schema}".items (item_key SERIAL PRIMARY KEY); INSERT INTO "${schema}".items DEFAULT VALUES;`,
      async (schema) => {
        await applyReplaySetup(
          { tables: { items: { rows: [] } } },
          replayPool,
          environment(schema, "items")
        );
        const next = await replayPool.query(`SELECT nextval('"${schema}".items_item_key_seq') AS value`);
        expect(Number(next.rows[0].value)).toBe(1);
      }
    );
  });

  it("detects an FK added between scenarios before the next mutation", async () => {
    await withSchema(
      (schema) => `CREATE TABLE "${schema}".parents (id INTEGER PRIMARY KEY);`,
      async (schema) => {
        await applyReplaySetup(
          { tables: { parents: { rows: [{ id: 1 }] } } },
          replayPool,
          environment(schema, "parents")
        );
        await replayPool.query(`CREATE TABLE "${schema}".children (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES "${schema}".parents(id));`);
        await expect(applyReplaySetup(
          { tables: { parents: { rows: [{ id: 2 }] } } },
          replayPool,
          environment(schema, "parents")
        )).rejects.toMatchObject({ code: "REPLAY_TABLE_DEPENDENCY_UNCONFIGURED" });
        expect((await replayPool.query(`SELECT id FROM "${schema}".parents`)).rows)
          .toEqual([{ id: 1 }]);
      }
    );
  });

  it("holds a lock that prevents concurrent schema alteration", async () => {
    await withSchema(
      (schema) => `CREATE TABLE "${schema}".items (id INTEGER PRIMARY KEY);`,
      async (schema) => {
        const holder = await replayPool.connect();
        const contender = await replayPool.connect();
        try {
          await holder.query("BEGIN");
          await lockReplayRelations(
            holder,
            parseReplayScope(environment(schema, "items"))
          );
          await contender.query("SET lock_timeout = '150ms'");
          await expect(contender.query(
            `ALTER TABLE "${schema}".items ADD COLUMN widened INTEGER`
          )).rejects.toMatchObject({ code: "55P03" });
          await holder.query("ROLLBACK");
        } finally {
          contender.release();
          holder.release();
        }
      }
    );
  });
});
