import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import Fastify from "fastify";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it
} from "vitest";
import { Pool, type PoolClient } from "pg";
import { registerShadowSpec } from "../src/agent";
import { captureDatabaseSnapshot } from "../src/db-snapshot";

const suite = process.env.SHADOWSPEC_REAL_PG === "true"
  ? describe
  : describe.skip;
const databaseName = `ss_deadline_${randomUUID()
  .replaceAll("-", "")
  .slice(0, 18)}`;

function connection(database: string, max = 10) {
  return {
    host: process.env.DB_HOST || "127.0.0.1",
    port: Number(process.env.DB_PORT || 5432),
    user: process.env.DB_USER || "shadowspec",
    password: process.env.DB_PASSWORD || "shadowspec123",
    database,
    max,
    connectionTimeoutMillis: 1_000,
    statement_timeout: 1_000
  };
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("PostgreSQL deadline test timed out.")),
          3_000
        );
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

suite("capture deadlines with real PostgreSQL", () => {
  let adminPool: Pool;
  let databasePool: Pool;
  let caseNumber = 0;

  beforeAll(async () => {
    adminPool = new Pool(connection("postgres"));
    await adminPool.query(`CREATE DATABASE "${databaseName}"`);
    databasePool = new Pool(connection(databaseName));
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
    if (databasePool) await databasePool.end();
    if (adminPool) {
      await adminPool.query(
        `DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`
      );
      await adminPool.end();
    }
  }, 30_000);

  async function withSchema(test: (schema: string) => Promise<void>) {
    const schema = `deadline_${++caseNumber}`;
    await databasePool.query(`
      CREATE SCHEMA "${schema}";
      CREATE TABLE "${schema}".items (
        item_key INTEGER PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT INTO "${schema}".items VALUES (1, 'stable');`);
    try {
      await test(schema);
    } finally {
      await databasePool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    }
  }

  async function inject(
    applicationPool: Pool,
    capturePool: Pool,
    schema: string,
    snapshotTimeoutMs = 500,
    recorderTimeoutMs = 500
  ) {
    const app = Fastify();
    let handled = 0;
    registerShadowSpec(app, {
      applicationPool,
      capturePool,
      enabled: true,
      tables: ["items"],
      schema,
      snapshotTimeoutMs,
      recorderTimeoutMs
    });
    app.post("/items", async (_request, reply) => {
      handled++;
      return reply.code(201).send({ ok: true, value: "unchanged" });
    });
    try {
      const response = await app.inject({ method: "POST", url: "/items" });
      return { response, handled };
    } finally {
      await app.close();
    }
  }

  async function counts() {
    const result = await databasePool.query<{
      requests: number;
      snapshots: number;
    }>(`SELECT
      (SELECT count(*)::int FROM api_requests) AS requests,
      (SELECT count(*)::int FROM api_request_snapshots) AS snapshots`);
    return result.rows[0];
  }

  async function expectNormalCapture(
    applicationPool: Pool,
    capturePool: Pool,
    schema: string
  ) {
    const { response } = await inject(
      applicationPool,
      capturePool,
      schema
    );
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ ok: true, value: "unchanged" });
    await expect(counts()).resolves.toEqual({ requests: 1, snapshots: 1 });
  }

  async function trackingPool(pool: Pool) {
    let backendPid: number | undefined;
    const wrapper = {
      connect: async () => {
        const client = await pool.connect();
        backendPid = (await client.query<{ pid: number }>(
          "SELECT pg_backend_pid() AS pid"
        )).rows[0].pid;
        return client;
      }
    } as unknown as Pool;
    return { wrapper, backendPid: () => backendPid };
  }

  async function expectBackendGone(pid: number) {
    const expiresAt = performance.now() + 2_000;
    while (performance.now() < expiresAt) {
      const result = await databasePool.query<{ present: boolean }>(
        "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid = $1) AS present",
        [pid]
      );
      if (!result.rows[0].present) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("Timed-out recorder backend remained active.");
  }

  it("fails open under snapshot pool exhaustion and discards late checkout", async () => {
    await withSchema(async (schema) => {
      const applicationPool = new Pool(connection(databaseName, 1));
      const held = await applicationPool.connect();
      let heldReleased = false;
      const removed = bounded(once(applicationPool, "remove").then(() => undefined));
      try {
        const { response, handled } = await inject(
          applicationPool,
          databasePool,
          schema,
          50
        );
        expect(handled).toBe(1);
        expect(response.statusCode).toBe(201);
        expect(response.json()).toEqual({ ok: true, value: "unchanged" });
        await expect(counts()).resolves.toEqual({ requests: 0, snapshots: 0 });

        held.release();
        heldReleased = true;
        await removed;
        await expect(applicationPool.query("SELECT 1 AS ok"))
          .resolves.toMatchObject({ rows: [{ ok: 1 }] });
        await expect(captureDatabaseSnapshot(
          applicationPool,
          ["items"],
          { schema, snapshotTimeoutMs: 500 }
        )).resolves.toMatchObject({ tables: { items: { rows: [{ item_key: 1 }] } } });
      } finally {
        if (!heldReleased) held.release();
        await applicationPool.end();
      }
    });
  });

  it("fails open on a lock-blocked snapshot and leaves its pool usable", async () => {
    await withSchema(async (schema) => {
      const applicationPool = new Pool(connection(databaseName, 1));
      const blocker = await databasePool.connect();
      try {
        await blocker.query("BEGIN");
        await blocker.query(
          `LOCK TABLE "${schema}".items IN ACCESS EXCLUSIVE MODE`
        );
        const { response, handled } = await inject(
          applicationPool,
          databasePool,
          schema,
          50
        );
        expect(handled).toBe(1);
        expect(response.statusCode).toBe(201);
        expect(response.json()).toEqual({ ok: true, value: "unchanged" });
        await expect(counts()).resolves.toEqual({ requests: 0, snapshots: 0 });
      } finally {
        await blocker.query("ROLLBACK");
        blocker.release();
      }
      await expect(applicationPool.query("SELECT 1 AS ok"))
        .resolves.toMatchObject({ rows: [{ ok: 1 }] });
      await expect(captureDatabaseSnapshot(
        applicationPool,
        ["items"],
        { schema, snapshotTimeoutMs: 500 }
      )).resolves.toBeDefined();
      await applicationPool.end();
    });
  });

  it("fails open under recorder pool exhaustion and recovers", async () => {
    await withSchema(async (schema) => {
      const capturePool = new Pool(connection(databaseName, 1));
      const held = await capturePool.connect();
      let heldReleased = false;
      const removed = bounded(once(capturePool, "remove").then(() => undefined));
      try {
        const { response, handled } = await inject(
          databasePool,
          capturePool,
          schema,
          500,
          50
        );
        expect(handled).toBe(1);
        expect(response.statusCode).toBe(201);
        expect(response.json()).toEqual({ ok: true, value: "unchanged" });
        await expect(counts()).resolves.toEqual({ requests: 0, snapshots: 0 });

        held.release();
        heldReleased = true;
        await removed;
        await expect(capturePool.query("SELECT 1 AS ok"))
          .resolves.toMatchObject({ rows: [{ ok: 1 }] });
        await expectNormalCapture(databasePool, capturePool, schema);
      } finally {
        if (!heldReleased) held.release();
        await capturePool.end();
      }
    });
  });

  it.each([
    ["api_requests", false],
    ["api_request_snapshots", true]
  ] as const)(
    "rolls back atomically when %s INSERT is blocked",
    async (lockedTable, firstInsertRuns) => {
      await withSchema(async (schema) => {
        const capturePool = new Pool(connection(databaseName, 1));
        const tracked = await trackingPool(capturePool);
        const blocker = await databasePool.connect();
        try {
          await blocker.query("BEGIN");
          await blocker.query(
            `LOCK TABLE ${lockedTable} IN ACCESS EXCLUSIVE MODE`
          );
          const { response, handled } = await inject(
            databasePool,
            tracked.wrapper,
            schema,
            500,
            75
          );
          expect(handled).toBe(1);
          expect(response.statusCode).toBe(201);
          expect(response.json()).toEqual({ ok: true, value: "unchanged" });
          if (firstInsertRuns) {
            const visibleOutside = await databasePool.query(
              "SELECT count(*)::int AS count FROM api_requests"
            );
            expect(visibleOutside.rows[0].count).toBe(0);
          }
        } finally {
          await blocker.query("ROLLBACK");
          blocker.release();
        }

        await expect(counts()).resolves.toEqual({ requests: 0, snapshots: 0 });
        const pid = tracked.backendPid();
        expect(pid).toBeDefined();
        await expectBackendGone(pid!);
        await expect(capturePool.query("SELECT 1 AS ok"))
          .resolves.toMatchObject({ rows: [{ ok: 1 }] });
        await expectNormalCapture(databasePool, capturePool, schema);
        await capturePool.end();
      });
    }
  );
});
