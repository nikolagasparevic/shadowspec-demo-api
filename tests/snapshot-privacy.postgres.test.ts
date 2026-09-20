import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Fastify from "fastify";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi
} from "vitest";
import { Pool, type PoolClient } from "pg";
import { registerShadowSpec } from "../src/agent";
import { captureDatabaseSnapshot } from "../src/db-snapshot";

const suite = process.env.SHADOWSPEC_REAL_PG === "true"
  ? describe
  : describe.skip;
const databaseName = `ss_privacy_${randomUUID()
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

suite("snapshot privacy with real PostgreSQL", () => {
  let adminPool: Pool;
  let databasePool: Pool;
  let verificationPool: Pool;
  let caseNumber = 0;

  beforeAll(async () => {
    adminPool = new Pool(connection("postgres"));
    await adminPool.query(`CREATE DATABASE "${databaseName}"`);
    databasePool = new Pool(connection(databaseName));
    verificationPool = new Pool(connection(databaseName));
    await databasePool.query(fs.readFileSync(
      path.resolve(__dirname, "..", "sql", "capture-schema.sql"),
      "utf8"
    ));
  }, 30_000);

  beforeEach(async () => {
    await databasePool.query(
      "TRUNCATE api_request_snapshots, api_requests RESTART IDENTITY"
    );
  });

  afterAll(async () => {
    if (verificationPool) await verificationPool.end();
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
    const schema = `privacy_${++caseNumber}`;
    await databasePool.query(`CREATE SCHEMA "${schema}"`);
    try {
      await databasePool.query(ddl(schema));
      await test(schema);
    } finally {
      await databasePool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    }
  }

  async function inject(
    schema: string,
    tables: readonly string[],
    snapshotAllowedColumns: Record<string, readonly string[]>,
    applicationPool: Pool = databasePool,
    loggerInstance?: any
  ) {
    const app = Fastify({
      ...(loggerInstance === undefined ? {} : { loggerInstance })
    });
    registerShadowSpec(app, {
      applicationPool,
      capturePool: databasePool,
      enabled: true,
      schema,
      tables,
      privacy: { snapshotAllowedColumns }
    });
    app.post("/capture", async (_request, reply) =>
      reply.code(201).send({ ok: true })
    );
    try {
      return await app.inject({ method: "POST", url: "/capture" });
    } finally {
      await app.close();
    }
  }

  async function counts() {
    const result = await verificationPool.query<{
      requests: number;
      snapshots: number;
    }>(`SELECT
      (SELECT count(*)::int FROM api_requests) AS requests,
      (SELECT count(*)::int FROM api_request_snapshots) AS snapshots`);
    return result.rows[0];
  }

  async function persistedOccurrences(value: string): Promise<number> {
    const result = await verificationPool.query<{ count: number }>(
      `SELECT count(*)::int AS count
       FROM api_requests r
       LEFT JOIN api_request_snapshots s ON s.api_request_id = r.id
       WHERE strpos(concat_ws(' ',
         r.method, r.path, r.path_params::text, r.query_params::text,
         r.request_body::text, r.response_body::text, r.session_id,
         s.snapshot::text
       ), $1) > 0`,
      [value]
    );
    return result.rows[0].count;
  }

  function logger() {
    const error = vi.fn();
    const instance: any = {
      level: "info",
      fatal: vi.fn(),
      error,
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
      silent: vi.fn(),
      child: vi.fn(() => instance)
    };
    return { instance, error };
  }

  async function injectHttpPrivacy(options: {
    schema: string;
    headers?: Record<string, string>;
    payload?: unknown;
    responseBody?: unknown;
    forbiddenRequestPointers?: readonly string[];
    forbiddenResponsePointers?: readonly string[];
    snapshotAllowedColumns?: readonly string[];
    loggerInstance?: any;
  }) {
    const app = Fastify({
      ...(options.loggerInstance === undefined
        ? {}
        : { loggerInstance: options.loggerInstance })
    });
    let handled = 0;
    registerShadowSpec(app, {
      applicationPool: databasePool,
      capturePool: databasePool,
      enabled: true,
      schema: options.schema,
      tables: ["items"],
      privacy: {
        snapshotAllowedColumns: {
          items: options.snapshotAllowedColumns ?? ["id", "name"]
        },
        forbiddenRequestPointers: options.forbiddenRequestPointers,
        forbiddenResponsePointers: options.forbiddenResponsePointers
      }
    });
    app.post("/items", async (_request, reply) => {
      handled++;
      await databasePool.query(
        `UPDATE "${options.schema}".items SET name = 'mutated' WHERE id = 1`
      );
      reply.header("x-application-result", "unchanged");
      return reply.code(202).send(
        options.responseBody ?? { ok: true }
      );
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/items",
        headers: options.headers,
        payload: options.payload
      });
      return { response, handled };
    } finally {
      await app.close();
    }
  }

  async function trackingPool() {
    const client = await databasePool.connect();
    let selectedRows = false;
    const proxy = new Proxy(client, {
      get(target, property) {
        if (property === "query") {
          return async (...args: Parameters<PoolClient["query"]>) => {
            if (String(args[0]).startsWith("SELECT ")) selectedRows = true;
            return (target.query as Function)(...args);
          };
        }
        const value = target[property as keyof PoolClient];
        return typeof value === "function" ? value.bind(target) : value;
      }
    });
    return {
      pool: { connect: async () => proxy } as unknown as Pool,
      selectedRows: () => selectedRows
    };
  }

  it.each(["Authorization", "Cookie"])(
    "keeps %s credentials out of persistence and diagnostics",
    async (headerName) => {
      const sentinel = "SHADOWSPEC_TEST_SECRET_DO_NOT_PERSIST";
      await withSchema(
        (schema) => `CREATE TABLE "${schema}".items (
          id INTEGER PRIMARY KEY, name TEXT NOT NULL
        ); INSERT INTO "${schema}".items VALUES (1, 'before');`,
        async (schema) => {
          const captureLogger = logger();
          const { response, handled } = await injectHttpPrivacy({
            schema,
            headers: { [headerName]: `Bearer ${sentinel}` },
            loggerInstance: captureLogger.instance
          });

          expect(handled).toBe(1);
          expect(response.statusCode).toBe(202);
          expect(response.json()).toEqual({ ok: true });
          expect(response.headers["x-application-result"]).toBe("unchanged");
          await expect(verificationPool.query(
            `SELECT name FROM "${schema}".items WHERE id = 1`
          )).resolves.toMatchObject({ rows: [{ name: "mutated" }] });
          await expect(counts()).resolves.toEqual({ requests: 0, snapshots: 0 });
          await expect(persistedOccurrences(sentinel)).resolves.toBe(0);
          expect(JSON.stringify(captureLogger.error.mock.calls))
            .not.toContain(sentinel);
        }
      );
    }
  );

  it("keeps an exact forbidden request value out of persistence and diagnostics", async () => {
    const sentinel = "request-pointer-secret-sentinel";
    await withSchema(
      (schema) => `CREATE TABLE "${schema}".items (
        id INTEGER PRIMARY KEY, name TEXT NOT NULL
      ); INSERT INTO "${schema}".items VALUES (1, 'before');`,
      async (schema) => {
        const captureLogger = logger();
        const { response, handled } = await injectHttpPrivacy({
          schema,
          payload: { privateToken: sentinel, publicValue: "kept-by-app" },
          forbiddenRequestPointers: ["/body/privateToken"],
          loggerInstance: captureLogger.instance
        });

        expect(handled).toBe(1);
        expect(response.statusCode).toBe(202);
        expect(response.json()).toEqual({ ok: true });
        expect(response.headers["x-application-result"]).toBe("unchanged");
        await expect(counts()).resolves.toEqual({ requests: 0, snapshots: 0 });
        await expect(persistedOccurrences(sentinel)).resolves.toBe(0);
        expect(JSON.stringify(captureLogger.error.mock.calls))
          .not.toContain(sentinel);
      }
    );
  });

  it("keeps an exact forbidden response value out of persistence and diagnostics", async () => {
    const sentinel = "response-pointer-secret-sentinel";
    await withSchema(
      (schema) => `CREATE TABLE "${schema}".items (
        id INTEGER PRIMARY KEY, name TEXT NOT NULL
      ); INSERT INTO "${schema}".items VALUES (1, 'before');`,
      async (schema) => {
        const captureLogger = logger();
        const body = { ok: true, privateToken: sentinel };
        const { response, handled } = await injectHttpPrivacy({
          schema,
          responseBody: body,
          forbiddenResponsePointers: ["/body/privateToken"],
          loggerInstance: captureLogger.instance
        });

        expect(handled).toBe(1);
        expect(response.statusCode).toBe(202);
        expect(response.json()).toEqual(body);
        expect(response.headers["x-application-result"]).toBe("unchanged");
        await expect(verificationPool.query(
          `SELECT name FROM "${schema}".items WHERE id = 1`
        )).resolves.toMatchObject({ rows: [{ name: "mutated" }] });
        await expect(counts()).resolves.toEqual({ requests: 0, snapshots: 0 });
        await expect(persistedOccurrences(sentinel)).resolves.toBe(0);
        expect(JSON.stringify(captureLogger.error.mock.calls))
          .not.toContain(sentinel);
      }
    );
  });

  it("keeps malformed-policy request material out of persistence and diagnostics", async () => {
    const sentinel = "invalid-policy-secret-sentinel";
    const captureLogger = logger();
    const app = Fastify({ loggerInstance: captureLogger.instance });
    registerShadowSpec(app, {
      applicationPool: databasePool,
      capturePool: databasePool,
      enabled: true,
      tables: ["items"],
      privacy: {
        snapshotAllowedColumns: { items: ["id"] },
        forbiddenRequestPointers: ["/body/bad~escape"]
      }
    });
    let handled = 0;
    app.post("/items", async (_request, reply) => {
      handled++;
      return reply.code(201).send({ ok: true });
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/items",
        payload: { privateToken: sentinel }
      });
      expect(response.statusCode).toBe(201);
      expect(handled).toBe(1);
      await expect(counts()).resolves.toEqual({ requests: 0, snapshots: 0 });
      await expect(persistedOccurrences(sentinel)).resolves.toBe(0);
      expect(JSON.stringify(captureLogger.error.mock.calls))
        .not.toContain(sentinel);
    } finally {
      await app.close();
    }
  });

  it("captures an exact approved schema with a composite primary key", async () => {
    await withSchema(
      (schema) => `CREATE TABLE "${schema}".editions (
        isbn TEXT NOT NULL,
        edition INTEGER NOT NULL,
        title TEXT NOT NULL,
        PRIMARY KEY (isbn, edition)
      ); INSERT INTO "${schema}".editions VALUES ('a', 2, 'two'), ('a', 1, 'one');`,
      async (schema) => {
        const snapshot = await captureDatabaseSnapshot(
          databasePool,
          ["editions"],
          {
            schema,
            snapshotAllowedColumns: {
              editions: ["title", "edition", "isbn"]
            }
          }
        );
        expect(snapshot.tables.editions.rows).toEqual([
          { edition: 1, isbn: "a", title: "one" },
          { edition: 2, isbn: "a", title: "two" }
        ]);
      }
    );
  });

  it("rejects an unauthorized column before selecting rows or persisting capture", async () => {
    const sentinel = "unauthorized-column-sentinel";
    await withSchema(
      (schema) => `CREATE TABLE "${schema}".items (
        id INTEGER PRIMARY KEY, name TEXT NOT NULL, secret TEXT NOT NULL
      ); INSERT INTO "${schema}".items VALUES (1, 'safe', '${sentinel}');`,
      async (schema) => {
        const tracked = await trackingPool();
        const captureLogger = logger();
        const response = await inject(
          schema,
          ["items"],
          { items: ["id", "name"] },
          tracked.pool,
          captureLogger.instance
        );
        expect(response.statusCode).toBe(201);
        expect(tracked.selectedRows()).toBe(false);
        await expect(counts()).resolves.toEqual({ requests: 0, snapshots: 0 });
        const persisted = await databasePool.query<{ data: string }>(
          `SELECT concat_ws(' ', request_body::text, response_body::text,
             (SELECT snapshot::text FROM api_request_snapshots LIMIT 1)) AS data
           FROM api_requests LIMIT 1`
        );
        expect(JSON.stringify(persisted.rows)).not.toContain(sentinel);
        expect(JSON.stringify(captureLogger.error.mock.calls))
          .not.toContain(sentinel);
      }
    );
  });

  it("fails closed on schema drift and resumes after the schema is restored", async () => {
    const sentinel = "schema-drift-sentinel";
    await withSchema(
      (schema) => `CREATE TABLE "${schema}".items (
        id INTEGER PRIMARY KEY, name TEXT NOT NULL
      ); INSERT INTO "${schema}".items VALUES (1, 'safe');`,
      async (schema) => {
        const allowed = { items: ["id", "name"] };
        await expect(inject(schema, ["items"], allowed))
          .resolves.toMatchObject({ statusCode: 201 });
        await expect(counts()).resolves.toEqual({ requests: 1, snapshots: 1 });

        await databasePool.query(
          `ALTER TABLE "${schema}".items
           ADD COLUMN secret TEXT NOT NULL DEFAULT '${sentinel}'`
        );
        await expect(inject(schema, ["items"], allowed))
          .resolves.toMatchObject({ statusCode: 201 });
        await expect(counts()).resolves.toEqual({ requests: 1, snapshots: 1 });
        const persisted = await databasePool.query<{ snapshot: unknown }>(
          "SELECT snapshot FROM api_request_snapshots"
        );
        expect(JSON.stringify(persisted.rows)).not.toContain(sentinel);

        await databasePool.query(
          `ALTER TABLE "${schema}".items DROP COLUMN secret`
        );
        await expect(inject(schema, ["items"], allowed))
          .resolves.toMatchObject({ statusCode: 201 });
        await expect(counts()).resolves.toEqual({ requests: 2, snapshots: 2 });
      }
    );
  });

  it("rejects missing approved columns and an unapproved primary key", async () => {
    await withSchema(
      (schema) => `CREATE TABLE "${schema}".items (
        id INTEGER PRIMARY KEY, name TEXT NOT NULL
      ); INSERT INTO "${schema}".items VALUES (1, 'safe');`,
      async (schema) => {
        await expect(captureDatabaseSnapshot(databasePool, ["items"], {
          schema,
          snapshotAllowedColumns: {
            items: ["id", "name", "expected_but_missing"]
          }
        })).rejects.toMatchObject({
          code: "CAPTURE_SNAPSHOT_COLUMN_FORBIDDEN",
          columnName: "expected_but_missing"
        });
        await expect(captureDatabaseSnapshot(databasePool, ["items"], {
          schema,
          snapshotAllowedColumns: { items: ["name"] }
        })).rejects.toMatchObject({
          code: "CAPTURE_SNAPSHOT_COLUMN_FORBIDDEN",
          columnName: "id"
        });
      }
    );
  });

  it("persists nothing when one of multiple configured tables is unauthorized", async () => {
    await withSchema(
      (schema) => `
        CREATE TABLE "${schema}".authors (
          id INTEGER PRIMARY KEY, name TEXT NOT NULL
        );
        CREATE TABLE "${schema}".books (
          id INTEGER PRIMARY KEY, title TEXT NOT NULL, secret TEXT NOT NULL
        );
        INSERT INTO "${schema}".authors VALUES (1, 'Author');
        INSERT INTO "${schema}".books VALUES (1, 'Book', 'sentinel');`,
      async (schema) => {
        const response = await inject(
          schema,
          ["authors", "books"],
          {
            authors: ["id", "name"],
            books: ["id", "title"]
          }
        );
        expect(response.statusCode).toBe(201);
        await expect(counts()).resolves.toEqual({ requests: 0, snapshots: 0 });
      }
    );
  });
});
