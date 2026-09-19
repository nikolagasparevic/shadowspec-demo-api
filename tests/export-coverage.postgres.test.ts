import { randomUUID } from "node:crypto";
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
import { Pool, type PoolClient } from "pg";
import { loadFrozenCaptureSet } from "../src/export-captures";
import { buildCoverageExport } from "../src/export-scenarios";

const suite = process.env.SHADOWSPEC_REAL_PG === "true"
  ? describe
  : describe.skip;
const databaseName = `ss_export_${randomUUID()
  .replaceAll("-", "")
  .slice(0, 20)}`;

function connection(database: string) {
  return {
    host: process.env.DB_HOST || "127.0.0.1",
    port: Number(process.env.DB_PORT || 5432),
    user: process.env.DB_USER || "shadowspec",
    password: process.env.DB_PASSWORD || "shadowspec123",
    database
  };
}

suite("coverage export with real PostgreSQL", () => {
  let adminPool: Pool;
  let capturePool: Pool;

  beforeAll(async () => {
    adminPool = new Pool(connection("postgres"));
    await adminPool.query(`CREATE DATABASE "${databaseName}"`);
    capturePool = new Pool(connection(databaseName));
    await capturePool.query(fs.readFileSync(
      path.resolve(__dirname, "..", "sql", "capture-schema.sql"),
      "utf8"
    ));
  }, 30_000);

  beforeEach(async () => {
    await capturePool.query(
      "TRUNCATE api_request_snapshots, api_requests RESTART IDENTITY"
    );
  });

  afterAll(async () => {
    if (capturePool) await capturePool.end();
    if (adminPool) {
      await adminPool.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1",
        [databaseName]
      );
      await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
      await adminPool.end();
    }
  }, 30_000);

  async function insertCapture(
    active = true,
    withSnapshot = true
  ): Promise<number> {
    const inserted = await capturePool.query<{ id: number }>(
      `INSERT INTO api_requests (
         method, path, path_params, query_params, request_body,
         response_status, response_body, active
       ) VALUES ('GET', '/health', '{}', '{}', 'null', 200,
         '{"status":"ok"}', $1)
       RETURNING id`,
      [active]
    );
    const id = inserted.rows[0].id;
    if (withSnapshot) {
      await capturePool.query(
        `INSERT INTO api_request_snapshots (api_request_id, snapshot)
         VALUES ($1, '{"tables":{"resources":{"rows":[]}}}')`,
        [id]
      );
    }
    return id;
  }

  it("freezes concurrent inserts and active changes until the next export", async () => {
    const firstId = await insertCapture(true);
    const realClient = await capturePool.connect();
    let changed = false;
    const proxy = new Proxy(realClient, {
      get(target, property) {
        if (property === "query") {
          return async (...args: Parameters<PoolClient["query"]>) => {
            const result = await (target.query as Function)(...args);
            if (!changed && String(args[0]).includes("MAX(id)")) {
              changed = true;
              await capturePool.query(
                "UPDATE api_requests SET active = FALSE WHERE id = $1",
                [firstId]
              );
              await insertCapture(true);
            }
            return result;
          };
        }
        const value = target[property as keyof PoolClient];
        return typeof value === "function" ? value.bind(target) : value;
      }
    });
    const current = await loadFrozenCaptureSet({
      connect: async () => proxy
    } as never);
    expect(current.captures).toHaveLength(1);
    expect(current.captures[0]).toMatchObject({ id: firstId, active: true });

    const next = await loadFrozenCaptureSet(capturePool);
    expect(next.captures).toHaveLength(2);
    expect(next.captures[0].active).toBe(false);
  });

  it("retains missing snapshots for explicit rejection and tolerates ID gaps", async () => {
    const missingId = await insertCapture(true, false);
    await insertCapture();
    await capturePool.query("DELETE FROM api_requests WHERE id = 2");
    await capturePool.query("SELECT setval('api_requests_id_seq', 20, true)");
    const lastId = await insertCapture();
    const frozen = await loadFrozenCaptureSet(capturePool);
    expect(frozen.captures.map(({ id }) => id)).toEqual([missingId, lastId]);
    expect(frozen.captures[0].snapshots).toEqual([]);
    expect(buildCoverageExport(frozen, "project-one").coverage)
      .toMatchObject({ complete: false, rejectedCaptures: 1 });
  });

  it("enforces one persisted snapshot per request", async () => {
    const id = await insertCapture();
    await expect(capturePool.query(
      `INSERT INTO api_request_snapshots (api_request_id, snapshot)
       VALUES ($1, '{"tables":{"resources":{"rows":[]}}}')`,
      [id]
    )).rejects.toMatchObject({ code: "23505" });
  });
});
