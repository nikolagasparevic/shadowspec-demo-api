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
  parseReplaySafetyConfig,
  runReplayTransaction
} from "../src/replay-safety";

const runRealPostgres =
  process.env.SHADOWSPEC_REAL_PG === "true";
const TOKEN = "real-postgres-safety-token-0123456789";
const PROJECT_ID =
  "11111111-1111-4111-8111-111111111111";
const DATABASE_ID =
  "22222222-2222-4222-8222-222222222222";
const databaseName = `ss_guard_${randomUUID()
  .replaceAll("-", "")
  .slice(0, 20)}`;
const roleName = `ss_reader_${randomUUID()
  .replaceAll("-", "")
  .slice(0, 16)}`;

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

function environment(
  tables = "orders"
): NodeJS.ProcessEnv {
  return {
    SHADOWSPEC_REPLAY: "true",
    SHADOWSPEC_PROJECT_ID: PROJECT_ID,
    SHADOWSPEC_REPLAY_DATABASE_ID: DATABASE_ID,
    SHADOWSPEC_REPLAY_TOKEN: TOKEN,
    SHADOWSPEC_REPLAY_DATABASE_NAME: databaseName,
    SHADOWSPEC_TABLES: tables
  };
}

const suite = runRealPostgres
  ? describe
  : describe.skip;

suite("replay safety with real PostgreSQL", () => {
  let adminPool: Pool;
  let replayPool: Pool;

  beforeAll(async () => {
    adminPool = new Pool(connection("postgres"));
    await adminPool.query(
      `CREATE DATABASE "${databaseName}"`
    );
    replayPool = new Pool(connection(databaseName));
    await replayPool.query(`
      CREATE TABLE orders (
        id SERIAL PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE children (
        id SERIAL PRIMARY KEY,
        required_value TEXT NOT NULL
      );
    `);
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
      "TRUNCATE orders, children RESTART IDENTITY"
    );
    await replayPool.query(
      "INSERT INTO orders (id, value) VALUES (900, 'original')"
    );
    await replayPool.query(
      "INSERT INTO children (id, required_value) VALUES (901, 'original')"
    );
    await replayPool.query(
      "DELETE FROM shadowspec_internal.replay_target"
    );
    await replayPool.query(
      `INSERT INTO shadowspec_internal.replay_target (
         singleton_id,
         marker_version,
         project_id,
         replay_database_id,
         database_name,
         token_sha256
       ) VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        1,
        1,
        PROJECT_ID,
        DATABASE_ID,
        databaseName,
        createHash("sha256")
          .update(TOKEN)
          .digest("hex")
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
      await adminPool.query(
        `DROP ROLE IF EXISTS "${roleName}"`
      );
      await adminPool.end();
    }
  }, 30_000);

  async function storedOrders() {
    const result = await replayPool.query(
      "SELECT id, value FROM orders ORDER BY id"
    );
    return result.rows;
  }

  it("missing marker causes zero application-table mutation", async () => {
    await replayPool.query(
      "DELETE FROM shadowspec_internal.replay_target"
    );

    await expect(
      applyReplaySetup(
        {
          tables: {
            orders: { rows: [{ id: 1, value: "new" }] }
          }
        },
        replayPool,
        environment()
      )
    ).rejects.toMatchObject({
      code: "REPLAY_MARKER_ROW_MISSING"
    });
    expect(await storedOrders()).toEqual([
      { id: 900, value: "original" }
    ]);
  });

  it("missing marker table causes zero application-table mutation", async () => {
    await replayPool.query(
      `ALTER TABLE shadowspec_internal.replay_target
       RENAME TO replay_target_hidden`
    );

    try {
      await expect(
        applyReplaySetup(
          {
            tables: {
              orders: { rows: [{ id: 1, value: "new" }] }
            }
          },
          replayPool,
          environment()
        )
      ).rejects.toMatchObject({
        code: "REPLAY_MARKER_TABLE_MISSING"
      });
      expect(await storedOrders()).toEqual([
        { id: 900, value: "original" }
      ]);
    } finally {
      await replayPool.query(
        `ALTER TABLE shadowspec_internal.replay_target_hidden
         RENAME TO replay_target`
      );
    }
  });

  it("wrong marker causes zero application-table mutation", async () => {
    await replayPool.query(
      `UPDATE shadowspec_internal.replay_target
       SET token_sha256 = $1`,
      ["0".repeat(64)]
    );

    await expect(
      applyReplaySetup(
        {
          tables: {
            orders: { rows: [{ id: 1, value: "new" }] }
          }
        },
        replayPool,
        environment()
      )
    ).rejects.toMatchObject({
      code: "REPLAY_TOKEN_MISMATCH"
    });
    expect(await storedOrders()).toEqual([
      { id: 900, value: "original" }
    ]);
  });

  it("valid marker permits guarded setup", async () => {
    await applyReplaySetup(
      {
        tables: {
          orders: { rows: [{ id: 7, value: "restored" }] }
        }
      },
      replayPool,
      environment()
    );

    expect(await storedOrders()).toEqual([
      { id: 7, value: "restored" }
    ]);
  });

  it("rolls back all setup mutations after a later table failure", async () => {
    await expect(
      applyReplaySetup(
        {
          tables: {
            orders: { rows: [{ id: 1, value: "new" }] },
            children: { rows: [{ id: 2 }] }
          }
        },
        replayPool,
        environment("orders,children")
      )
    ).rejects.toThrow();

    expect(await storedOrders()).toEqual([
      { id: 900, value: "original" }
    ]);
    const children = await replayPool.query(
      "SELECT id, required_value FROM children ORDER BY id"
    );
    expect(children.rows).toEqual([
      { id: 901, required_value: "original" }
    ]);
  });

  it("holds the marker row against modification during setup", async () => {
    const config = parseReplaySafetyConfig(
      environment()
    );
    let allowCommit!: () => void;
    let verificationComplete!: () => void;
    const waitForCommit = new Promise<void>(
      (resolve) => {
        allowCommit = resolve;
      }
    );
    const verified = new Promise<void>(
      (resolve) => {
        verificationComplete = resolve;
      }
    );
    const guarded = runReplayTransaction(
      replayPool,
      config,
      false,
      async () => {
        verificationComplete();
        await waitForCommit;
      }
    );

    await verified;
    const contender = await replayPool.connect();
    try {
      await contender.query("SET lock_timeout = '150ms'");
      await expect(
        contender.query(
          `UPDATE shadowspec_internal.replay_target
           SET authorized_at = CURRENT_TIMESTAMP
           WHERE singleton_id = 1`
        )
      ).rejects.toMatchObject({ code: "55P03" });
    } finally {
      contender.release();
      allowCommit();
      await guarded;
    }
  });

  it("supports a marker-reader role that cannot modify authorization", async () => {
    await adminPool.query(
      `CREATE ROLE "${roleName}"`
    );
    await replayPool.query(
      `GRANT USAGE ON SCHEMA shadowspec_internal TO "${roleName}"`
    );
    await replayPool.query(
      `GRANT SELECT ON shadowspec_internal.replay_target TO "${roleName}"`
    );

    const client = await replayPool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `SET LOCAL ROLE "${roleName}"`
      );
      const read = await client.query(
        "SELECT singleton_id FROM shadowspec_internal.replay_target"
      );
      expect(read.rows).toHaveLength(1);
      await expect(
        client.query(
          `UPDATE shadowspec_internal.replay_target
           SET authorized_at = CURRENT_TIMESTAMP`
        )
      ).rejects.toMatchObject({ code: "42501" });
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });

  it("does not let a marker identity authorize a different database", async () => {
    const env = environment();
    env.SHADOWSPEC_REPLAY_DATABASE_NAME =
      "different_replay_database";

    await expect(
      applyReplaySetup(
        undefined,
        replayPool,
        env
      )
    ).rejects.toMatchObject({
      code: "REPLAY_DATABASE_NAME_MISMATCH"
    });
    expect(await storedOrders()).toEqual([
      { id: 900, value: "original" }
    ]);
  });
});
