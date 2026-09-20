import { randomUUID } from "node:crypto";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi
} from "vitest";
import { Pool } from "pg";

const runRealPostgres =
  process.env.SHADOWSPEC_REAL_PG === "true";

const databaseName = `ss_purge_${randomUUID()
  .replaceAll("-", "")
  .slice(0, 20)}`;

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

const suite = runRealPostgres
  ? describe
  : describe.skip;

suite("capture retention purge with real PostgreSQL", () => {
  let adminPool: Pool;
  let testPool: Pool;
  let purgePool: Pool;

  let previewPurge: (
    olderThanDays: number
  ) => Promise<{
    captures: number;
    snapshots: number;
  }>;

  let executePurge: (
    olderThanDays: number
  ) => Promise<number>;

  const originalDbName = process.env.DB_NAME;

  beforeAll(async () => {
    adminPool = new Pool(
      connection("postgres")
    );

    await adminPool.query(
      `CREATE DATABASE "${databaseName}"`
    );

    testPool = new Pool(
      connection(databaseName)
    );

    await testPool.query(`
      CREATE TABLE api_requests (
        id SERIAL PRIMARY KEY,
        method VARCHAR(10) NOT NULL,
        path VARCHAR(255) NOT NULL,
        path_params JSONB,
        query_params JSONB,
        request_body JSONB,
        response_status INTEGER NOT NULL,
        response_body JSONB,
        session_id VARCHAR(100),
        active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE api_request_snapshots (
        id SERIAL PRIMARY KEY,
        api_request_id INTEGER NOT NULL
          REFERENCES api_requests(id)
          ON DELETE CASCADE,
        snapshot JSONB NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE UNIQUE INDEX
        api_request_snapshots_request_id_idx
      ON api_request_snapshots(api_request_id);
    `);

    /*
     * db.ts creates its Pool at import time.
     * Point it at this isolated database before
     * importing purge.ts.
     */
    process.env.DB_NAME = databaseName;

    vi.resetModules();

    const purgeModule =
      await import("../src/purge");

    previewPurge =
      purgeModule.previewPurge;

    executePurge =
      purgeModule.executePurge;

    /*
     * Same module graph as purge.ts, so this is
     * the singleton pool that purge actually uses.
     */
    const dbModule =
      await import("../src/db");

    purgePool = dbModule.pool;
  }, 30_000);

  beforeEach(async () => {
    await testPool.query(`
      DROP TRIGGER IF EXISTS
        shadowspec_purge_test_block
        ON api_requests;

      DROP FUNCTION IF EXISTS
        shadowspec_purge_test_block();

      TRUNCATE
        api_request_snapshots,
        api_requests
      RESTART IDENTITY CASCADE;
    `);
  });

  afterAll(async () => {
    if (purgePool) {
      await purgePool.end();
    }

    if (testPool) {
      await testPool.end();
    }

    if (adminPool) {
      await adminPool.query(
        `DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`
      );

      await adminPool.end();
    }

    if (originalDbName === undefined) {
      delete process.env.DB_NAME;
    } else {
      process.env.DB_NAME =
        originalDbName;
    }

    vi.resetModules();
  }, 30_000);

  async function insertCapture(
    path: string,
    ageDays: number,
    sessionId: string | null = null,
    active = true
  ): Promise<number> {
    const result =
      await testPool.query<{ id: number }>(
        `
          INSERT INTO api_requests (
            method,
            path,
            request_body,
            response_status,
            response_body,
            session_id,
            active,
            created_at
          )
          VALUES (
            'GET',
            $1,
            '{}'::jsonb,
            200,
            '{}'::jsonb,
            $2,
            $3,
            LOCALTIMESTAMP -
              ($4::integer * INTERVAL '1 day')
          )
          RETURNING id
        `,
        [
          path,
          sessionId,
          active,
          ageDays
        ]
      );

    return result.rows[0].id;
  }

  async function insertSnapshot(
    requestId: number
  ): Promise<void> {
    await testPool.query(
      `
        INSERT INTO api_request_snapshots (
          api_request_id,
          snapshot
        )
        VALUES (
          $1,
          '{"purgeTest":true}'::jsonb
        )
      `,
      [requestId]
    );
  }

  async function storedPaths(): Promise<
    string[]
  > {
    const result =
      await testPool.query<{
        path: string;
      }>(
        `
          SELECT path
          FROM api_requests
          ORDER BY id
        `
      );

    return result.rows.map(
      (row) => row.path
    );
  }

  it("purges old standalone captures and whole old sessions without splitting mixed-age sessions", async () => {
    const oldStandalone =
      await insertCapture(
        "/old-standalone",
        40
      );

    const newStandalone =
      await insertCapture(
        "/new-standalone",
        10
      );

    const oldSessionA =
      await insertCapture(
        "/old-session-a",
        40,
        "old-session"
      );

    const oldSessionB =
      await insertCapture(
        "/old-session-b",
        39,
        "old-session"
      );

    const mixedSessionA =
      await insertCapture(
        "/mixed-session-a",
        40,
        "mixed-session"
      );

    const mixedSessionB =
      await insertCapture(
        "/mixed-session-b",
        10,
        "mixed-session"
      );

    for (const id of [
      oldStandalone,
      newStandalone,
      oldSessionA,
      oldSessionB,
      mixedSessionA,
      mixedSessionB
    ]) {
      await insertSnapshot(id);
    }

    const preview =
      await previewPurge(30);

    expect(preview).toEqual({
      captures: 3,
      snapshots: 3
    });

    const deleted =
      await executePurge(30);

    expect(deleted).toBe(3);

    expect(
      await storedPaths()
    ).toEqual([
      "/new-standalone",
      "/mixed-session-a",
      "/mixed-session-b"
    ]);

    const snapshots =
      await testPool.query(
        `
          SELECT COUNT(*)::integer AS count
          FROM api_request_snapshots
        `
      );

    expect(
      snapshots.rows[0].count
    ).toBe(3);

    const orphans =
      await testPool.query(
        `
          SELECT COUNT(*)::integer AS count
          FROM api_request_snapshots s
          LEFT JOIN api_requests r
            ON r.id = s.api_request_id
          WHERE r.id IS NULL
        `
      );

    expect(
      orphans.rows[0].count
    ).toBe(0);
  });

  it("applies the same retention rule to inactive captures", async () => {
    const oldInactive =
      await insertCapture(
        "/old-inactive",
        40,
        null,
        false
      );

    const newInactive =
      await insertCapture(
        "/new-inactive",
        10,
        null,
        false
      );

    await insertSnapshot(
      oldInactive
    );

    await insertSnapshot(
      newInactive
    );

    expect(
      await previewPurge(30)
    ).toEqual({
      captures: 1,
      snapshots: 1
    });

    expect(
      await executePurge(30)
    ).toBe(1);

    expect(
      await storedPaths()
    ).toEqual([
      "/new-inactive"
    ]);
  });

  it("preview is dry-run only", async () => {
    const id =
      await insertCapture(
        "/preview-only",
        40
      );

    await insertSnapshot(id);

    expect(
      await previewPurge(30)
    ).toEqual({
      captures: 1,
      snapshots: 1
    });

    expect(
      await storedPaths()
    ).toEqual([
      "/preview-only"
    ]);

    const snapshots =
      await testPool.query(
        `
          SELECT COUNT(*)::integer AS count
          FROM api_request_snapshots
        `
      );

    expect(
      snapshots.rows[0].count
    ).toBe(1);
  });

  it("rejects invalid retention periods", async () => {
    await expect(
      previewPurge(0)
    ).rejects.toMatchObject({
      code: "PURGE_ARGUMENT_INVALID"
    });

    await expect(
      previewPurge(-1)
    ).rejects.toMatchObject({
      code: "PURGE_ARGUMENT_INVALID"
    });

    await expect(
      previewPurge(1.5)
    ).rejects.toMatchObject({
      code: "PURGE_ARGUMENT_INVALID"
    });

    await expect(
      executePurge(Number.NaN)
    ).rejects.toMatchObject({
      code: "PURGE_ARGUMENT_INVALID"
    });
  });

  it("blocks concurrent session mutation while destructive purge is running", async () => {
    await insertCapture(
      "/concurrency-old",
      40,
      "concurrency-session"
    );

    /*
     * The trigger deliberately blocks DELETE on
     * an advisory lock. executePurge() has already
     * acquired SHARE ROW EXCLUSIVE on api_requests
     * before reaching this trigger.
     */
    await testPool.query(`
      CREATE FUNCTION
        shadowspec_purge_test_block()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        PERFORM pg_advisory_xact_lock(
          73190421
        );

        RETURN OLD;
      END;
      $$;

      CREATE TRIGGER
        shadowspec_purge_test_block
      BEFORE DELETE
      ON api_requests
      FOR EACH ROW
      EXECUTE FUNCTION
        shadowspec_purge_test_block();
    `);

    const contender =
      await testPool.connect();

    try {
      /*
       * Hold the advisory lock first. Purge will
       * acquire its table lock and then block in
       * the DELETE trigger.
       */
      await contender.query(
        "SELECT pg_advisory_lock(73190421)"
      );

      const purgePromise =
        executePurge(30);

      /*
       * Wait until executePurge has actually
       * acquired SHARE ROW EXCLUSIVE.
       */
      const deadline =
        Date.now() + 5_000;

      while (true) {
        const locks =
          await testPool.query<{
            count: number;
          }>(
            `
              SELECT COUNT(*)::integer AS count
              FROM pg_locks
              WHERE relation =
                'api_requests'::regclass
                AND mode =
                  'ShareRowExclusiveLock'
                AND granted = TRUE
            `
          );

        if (
          locks.rows[0].count > 0
        ) {
          break;
        }

        if (
          Date.now() > deadline
        ) {
          throw new Error(
            "Timed out waiting for purge table lock."
          );
        }

        await new Promise(
          (resolve) =>
            setTimeout(resolve, 25)
        );
      }

      await contender.query(
        "SET lock_timeout = '150ms'"
      );

      await expect(
        contender.query(
          `
            INSERT INTO api_requests (
              method,
              path,
              request_body,
              response_status,
              response_body,
              session_id,
              active
            )
            VALUES (
              'GET',
              '/concurrency-new',
              '{}'::jsonb,
              200,
              '{}'::jsonb,
              'concurrency-session',
              TRUE
            )
          `
        )
      ).rejects.toMatchObject({
        code: "55P03"
      });

      await contender.query(
        "SELECT pg_advisory_unlock(73190421)"
      );

      expect(
        await purgePromise
      ).toBe(1);

      expect(
        await storedPaths()
      ).toEqual([]);
    } finally {
      try {
        await contender.query(
          "SELECT pg_advisory_unlock(73190421)"
        );
      } catch {
        // Best-effort cleanup.
      }

      contender.release();
    }
  });
});