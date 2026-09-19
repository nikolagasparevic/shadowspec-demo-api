import { randomUUID } from "node:crypto";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it
} from "vitest";
import { Pool, type PoolClient } from "pg";
import Fastify from "fastify";
import { registerShadowSpec } from "../src/agent";
import {
  captureDatabaseSnapshot,
  type DatabaseSnapshot
} from "../src/db-snapshot";

const suite = process.env.SHADOWSPEC_REAL_PG === "true"
  ? describe
  : describe.skip;
const databaseName = `ss_snapshot_${randomUUID()
  .replaceAll("-", "")
  .slice(0, 18)}`;

function connection(database: string) {
  return {
    host: process.env.DB_HOST || "127.0.0.1",
    port: Number(process.env.DB_PORT || 5432),
    user: process.env.DB_USER || "shadowspec",
    password: process.env.DB_PASSWORD || "shadowspec123",
    database
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function bounded(promise: Promise<void>): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Snapshot test synchronization timed out.")),
          3_000
        );
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function interceptedPool(
  client: PoolClient,
  afterQuery: (sql: string) => Promise<void>
): Pool {
  const proxy = new Proxy(client, {
    get(target, property) {
      if (property === "query") {
        return async (...args: Parameters<PoolClient["query"]>) => {
          const result = await (target.query as Function)(...args);
          await afterQuery(String(args[0]));
          return result;
        };
      }
      const value = target[property as keyof PoolClient];
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
  return { connect: async () => proxy } as unknown as Pool;
}

suite("database snapshots with real PostgreSQL", () => {
  let adminPool: Pool;
  let databasePool: Pool;
  let caseNumber = 0;

  beforeAll(async () => {
    adminPool = new Pool(connection("postgres"));
    await adminPool.query(`CREATE DATABASE "${databaseName}"`);
    databasePool = new Pool(connection(databaseName));
  }, 30_000);

  afterAll(async () => {
    if (databasePool) await databasePool.end();
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
    const schema = `snapshot_${++caseNumber}`;
    await databasePool.query(`CREATE SCHEMA "${schema}"`);
    try {
      await databasePool.query(ddl(schema));
      await test(schema);
    } finally {
      await databasePool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    }
  }

  async function snapshot(
    schema: string,
    tables: string[],
    pool: Pool = databasePool,
    statementTimeoutMs?: number
  ): Promise<DatabaseSnapshot> {
    return captureDatabaseSnapshot(pool, tables, {
      schema,
      statementTimeoutMs
    });
  }

  it("reads multiple tables from one repeatable-read, read-only snapshot", async () => {
    await withSchema(
      (schema) => `
        CREATE TABLE "${schema}".a_records (
          key INTEGER PRIMARY KEY, value TEXT NOT NULL
        );
        CREATE TABLE "${schema}".b_records (
          key INTEGER PRIMARY KEY, value TEXT NOT NULL
        );
        INSERT INTO "${schema}".a_records VALUES (1, 'old_A');
        INSERT INTO "${schema}".b_records VALUES (1, 'old_B');`,
      async (schema) => {
        const paused = deferred();
        const resume = deferred();
        const client = await databasePool.connect();
        let isolation = "";
        let readOnly = "";
        const pool = interceptedPool(client, async (sql) => {
          if (sql.startsWith("SET LOCAL")) {
            isolation = (await client.query(
              "SHOW transaction_isolation"
            )).rows[0].transaction_isolation;
            readOnly = (await client.query(
              "SHOW transaction_read_only"
            )).rows[0].transaction_read_only;
          }
          if (sql.includes(`FROM ONLY "${schema}"."a_records"`)) {
            paused.resolve();
            await resume.promise;
          }
        });
        const current = snapshot(schema, ["b_records", "a_records"], pool);
        await bounded(paused.promise);
        await databasePool.query(`
          UPDATE "${schema}".a_records SET value = 'new_A';
          UPDATE "${schema}".b_records SET value = 'new_B';`);
        resume.resolve();

        await expect(current).resolves.toEqual({
          tables: {
            a_records: { rows: [{ key: 1, value: "old_A" }] },
            b_records: { rows: [{ key: 1, value: "old_B" }] }
          }
        });
        expect(isolation).toBe("repeatable read");
        expect(readOnly).toBe("on");
      }
    );
  });

  it("hides concurrent inserts until the next snapshot", async () => {
    await withSchema(
      (schema) => `CREATE TABLE "${schema}".items (
        item_key INTEGER PRIMARY KEY, value TEXT NOT NULL
      ); INSERT INTO "${schema}".items VALUES (1, 'old');`,
      async (schema) => {
        const paused = deferred();
        const resume = deferred();
        const client = await databasePool.connect();
        const pool = interceptedPool(client, async (sql) => {
          if (sql === `LOCK TABLE "${schema}"."items" IN ACCESS SHARE MODE`) {
            paused.resolve();
            await resume.promise;
          }
        });
        const current = snapshot(schema, ["items"], pool);
        await bounded(paused.promise);
        await databasePool.query(
          `INSERT INTO "${schema}".items VALUES (2, 'new')`
        );
        resume.resolve();

        expect((await current).tables.items.rows).toHaveLength(1);
        expect((await snapshot(schema, ["items"])).tables.items.rows)
          .toHaveLength(2);
      }
    );
  });

  it("produces equal snapshots for different physical insertion orders", async () => {
    await withSchema(
      (schema) => `CREATE TABLE "${schema}".items (
        item_key INTEGER PRIMARY KEY, value TEXT NOT NULL
      ); INSERT INTO "${schema}".items VALUES (3, 'c'), (1, 'a'), (2, 'b');`,
      async (schema) => {
        const first = await snapshot(schema, ["items"]);
        await databasePool.query(`TRUNCATE "${schema}".items`);
        await databasePool.query(
          `INSERT INTO "${schema}".items VALUES (2, 'b'), (3, 'c'), (1, 'a')`
        );
        await expect(snapshot(schema, ["items"])).resolves.toEqual(first);
      }
    );
  });

  it("orders a numeric primary key not named id", async () => {
    await withSchema(
      (schema) => `CREATE TABLE "${schema}".books (
        book_key INTEGER PRIMARY KEY, title TEXT NOT NULL
      ); INSERT INTO "${schema}".books VALUES (9, 'c'), (2, 'a'), (5, 'b');`,
      async (schema) => {
        const result = await snapshot(schema, ["books"]);
        expect(result.tables.books.rows.map((row) => row.book_key))
          .toEqual([2, 5, 9]);
      }
    );
  });

  it("orders text primary keys", async () => {
    await withSchema(
      (schema) => `CREATE TABLE "${schema}".items (
        item_key TEXT PRIMARY KEY
      ); INSERT INTO "${schema}".items VALUES ('zeta'), ('alpha'), ('beta');`,
      async (schema) => {
        const result = await snapshot(schema, ["items"]);
        expect(result.tables.items.rows.map((row) => row.item_key))
          .toEqual(["alpha", "beta", "zeta"]);
      }
    );
  });

  it("orders UUID primary keys", async () => {
    await withSchema(
      (schema) => `CREATE TABLE "${schema}".items (
        item_key UUID PRIMARY KEY
      ); INSERT INTO "${schema}".items VALUES
        ('ffffffff-ffff-4fff-8fff-ffffffffffff'),
        ('11111111-1111-4111-8111-111111111111'),
        ('88888888-8888-4888-8888-888888888888');`,
      async (schema) => {
        const result = await snapshot(schema, ["items"]);
        expect(result.tables.items.rows.map((row) => row.item_key)).toEqual([
          "11111111-1111-4111-8111-111111111111",
          "88888888-8888-4888-8888-888888888888",
          "ffffffff-ffff-4fff-8fff-ffffffffffff"
        ]);
      }
    );
  });

  it("orders composite keys in declared key-column order", async () => {
    await withSchema(
      (schema) => `CREATE TABLE "${schema}".editions (
        edition INTEGER NOT NULL,
        isbn TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (isbn, edition)
      ); INSERT INTO "${schema}".editions VALUES
        (2, 'b', 'b2'), (2, 'a', 'a2'), (1, 'b', 'b1'), (1, 'a', 'a1');`,
      async (schema) => {
        const result = await snapshot(schema, ["editions"]);
        expect(result.tables.editions.rows.map(({ isbn, edition }) =>
          [isbn, edition]
        )).toEqual([["a", 1], ["a", 2], ["b", 1], ["b", 2]]);
      }
    );
  });

  it("rejects a real table without a primary key and returns no partial snapshot", async () => {
    await withSchema(
      (schema) => `
        CREATE TABLE "${schema}".a_valid (key INTEGER PRIMARY KEY);
        CREATE TABLE "${schema}".b_invalid (value TEXT);
        INSERT INTO "${schema}".a_valid VALUES (1);
        INSERT INTO "${schema}".b_invalid VALUES ('x');`,
      async (schema) => {
        await expect(snapshot(schema, ["a_valid", "b_invalid"]))
          .rejects.toMatchObject({ code: "SNAPSHOT_PRIMARY_KEY_REQUIRED" });
        await expect(databasePool.query("SELECT 1 AS ok"))
          .resolves.toMatchObject({ rows: [{ ok: 1 }] });
      }
    );
  });

  it("returns row object columns in lexical order", async () => {
    await withSchema(
      (schema) => `CREATE TABLE "${schema}".items (
        z_value TEXT, item_key INTEGER PRIMARY KEY, a_value TEXT
      ); INSERT INTO "${schema}".items VALUES ('z', 1, 'a');`,
      async (schema) => {
        const result = await snapshot(schema, ["items"]);
        expect(Object.keys(result.tables.items.rows[0]))
          .toEqual(["a_value", "item_key", "z_value"]);
      }
    );
  });

  it("captures only the explicitly configured schema", async () => {
    const first = `snapshot_${++caseNumber}`;
    const second = `snapshot_${++caseNumber}`;
    await databasePool.query(`CREATE SCHEMA "${first}"; CREATE SCHEMA "${second}"`);
    try {
      await databasePool.query(`
        CREATE TABLE "${first}".items (key INTEGER PRIMARY KEY, value TEXT);
        CREATE TABLE "${second}".items (key INTEGER PRIMARY KEY, value TEXT);
        INSERT INTO "${first}".items VALUES (1, 'first');
        INSERT INTO "${second}".items VALUES (1, 'second');`);
      const result = await snapshot(second, ["items"]);
      expect(result.tables.items.rows).toEqual([{ key: 1, value: "second" }]);
    } finally {
      await databasePool.query(`
        DROP SCHEMA IF EXISTS "${first}" CASCADE;
        DROP SCHEMA IF EXISTS "${second}" CASCADE;`);
    }
  });

  it("holds an ACCESS SHARE lock through descriptor validation and reading", async () => {
    await withSchema(
      (schema) => `CREATE TABLE "${schema}".items (
        key INTEGER PRIMARY KEY, value TEXT
      ); INSERT INTO "${schema}".items VALUES (1, 'old');`,
      async (schema) => {
        const locked = deferred();
        const resume = deferred();
        const snapshotClient = await databasePool.connect();
        const pool = interceptedPool(snapshotClient, async (sql) => {
          if (sql === `LOCK TABLE "${schema}"."items" IN ACCESS SHARE MODE`) {
            locked.resolve();
            await resume.promise;
          }
        });
        const current = snapshot(schema, ["items"], pool);
        await bounded(locked.promise);

        const ddlClient = await databasePool.connect();
        try {
          await ddlClient.query("SET lock_timeout = '200ms'");
          await expect(ddlClient.query(
            `ALTER TABLE "${schema}".items ADD COLUMN changed TEXT`
          )).rejects.toMatchObject({ code: "55P03" });
        } finally {
          ddlClient.release();
          resume.resolve();
        }
        await expect(current).resolves.toMatchObject({
          tables: { items: { rows: [{ key: 1, value: "old" }] } }
        });
      }
    );
  });

  it("classifies a lock-induced statement timeout, rolls back, and remains usable", async () => {
    await withSchema(
      (schema) => `CREATE TABLE "${schema}".items (
        key INTEGER PRIMARY KEY, value TEXT
      ); INSERT INTO "${schema}".items VALUES (1, 'old');`,
      async (schema) => {
        const locker = await databasePool.connect();
        const snapshotPool = new Pool({ ...connection(databaseName), max: 1 });
        try {
          await locker.query("BEGIN");
          await locker.query(
            `LOCK TABLE "${schema}".items IN ACCESS EXCLUSIVE MODE`
          );
          await expect(snapshot(schema, ["items"], snapshotPool, 100))
            .rejects.toMatchObject({ code: "SNAPSHOT_TIMEOUT" });
          const check = await snapshotPool.connect();
          try {
            await expect(check.query("SELECT 1 AS ok"))
              .resolves.toMatchObject({ rows: [{ ok: 1 }] });
          } finally {
            check.release();
          }

          const app = Fastify();
          registerShadowSpec(app, {
            applicationPool: snapshotPool,
            enabled: true,
            tables: ["items"],
            schema,
            snapshotStatementTimeoutMs: 100
          });
          app.get("/healthy", async () => ({ ok: true }));
          try {
            const response = await app.inject({
              method: "GET",
              url: "/healthy"
            });
            expect(response.statusCode).toBe(200);
            expect(response.json()).toEqual({ ok: true });
          } finally {
            await app.close();
          }
        } finally {
          await locker.query("ROLLBACK");
          locker.release();
          await snapshotPool.end();
        }
        await expect(snapshot(schema, ["items"]))
          .resolves.toMatchObject({ tables: { items: { rows: [{ key: 1 }] } } });
      }
    );
  });

  it("rolls back after a second-table failure without returning the first table", async () => {
    await withSchema(
      (schema) => `
        CREATE TABLE "${schema}".a_valid (key INTEGER PRIMARY KEY);
        CREATE TABLE "${schema}".b_invalid (value TEXT);
        INSERT INTO "${schema}".a_valid VALUES (1);`,
      async (schema) => {
        const dedicatedPool = new Pool({ ...connection(databaseName), max: 1 });
        try {
          await expect(snapshot(
            schema, ["a_valid", "b_invalid"], dedicatedPool
          )).rejects.toMatchObject({ code: "SNAPSHOT_PRIMARY_KEY_REQUIRED" });
          const client = await dedicatedPool.connect();
          try {
            await expect(client.query("SELECT 1 AS ok"))
              .resolves.toMatchObject({ rows: [{ ok: 1 }] });
          } finally {
            client.release();
          }
        } finally {
          await dedicatedPool.end();
        }
      }
    );
  });

  it("returns deeply equal snapshots across repeated captures", async () => {
    await withSchema(
      (schema) => `CREATE TABLE "${schema}".items (
        key INTEGER PRIMARY KEY, value TEXT
      ); INSERT INTO "${schema}".items VALUES (2, 'b'), (1, 'a');`,
      async (schema) => {
        const expected = await snapshot(schema, ["items"]);
        for (let index = 0; index < 3; index++) {
          await expect(snapshot(schema, ["items"])).resolves.toEqual(expected);
        }
      }
    );
  });
});
