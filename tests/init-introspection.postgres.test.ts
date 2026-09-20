import { randomUUID } from "node:crypto";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it
} from "vitest";
import { Pool } from "pg";
import {
  introspectSchema
} from "../src/init-introspection";

const runRealPostgres =
  process.env.SHADOWSPEC_REAL_PG === "true";

const databaseName = `ss_init_${randomUUID()
  .replaceAll("-", "")
  .slice(0, 20)}`;

function connection(database: string) {
  return {
    host: process.env.DB_HOST || "127.0.0.1",
    port: Number(process.env.DB_PORT || 5432),
    user: process.env.DB_USER || "shadowspec",
    password:
      process.env.DB_PASSWORD ||
      "shadowspec123",
    database
  };
}

const suite = runRealPostgres
  ? describe
  : describe.skip;

suite(
  "init database introspection with real PostgreSQL",
  () => {
    let adminPool: Pool;
    let databasePool: Pool;

    beforeAll(async () => {
      adminPool =
        new Pool(connection("postgres"));

      await adminPool.query(
        `CREATE DATABASE "${databaseName}"`
      );

      databasePool =
        new Pool(connection(databaseName));

      await databasePool.query(`
        CREATE TABLE orders (
          id SERIAL PRIMARY KEY,
          customer_id INTEGER NOT NULL,
          status TEXT NOT NULL,
          created_at TIMESTAMP
        );

        CREATE TABLE customers (
          id SERIAL PRIMARY KEY,
          email TEXT NOT NULL
        );

        CREATE TABLE api_requests (
          id SERIAL PRIMARY KEY,
          method TEXT NOT NULL
        );

        CREATE TABLE api_request_snapshots (
          id SERIAL PRIMARY KEY,
          api_request_id INTEGER NOT NULL,
          snapshot JSONB NOT NULL
        );

        CREATE VIEW order_statuses AS
        SELECT id, status
        FROM orders;

        CREATE SCHEMA internal_test;

        CREATE TABLE internal_test.hidden_table (
          id SERIAL PRIMARY KEY
        );
      `);
    }, 30_000);

    afterAll(async () => {
      if (databasePool) {
        await databasePool.end();
      }

      if (adminPool) {
        await adminPool.query(
          `DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`
        );

        await adminPool.end();
      }
    }, 30_000);

    it("discovers base tables and columns in deterministic order", async () => {
      const tables =
        await introspectSchema(
          databasePool,
          "public"
        );

      expect(tables).toEqual([
        {
          name: "customers",
          columns: [
            "id",
            "email"
          ]
        },
        {
          name: "orders",
          columns: [
            "id",
            "customer_id",
            "status",
            "created_at"
          ]
        }
      ]);
    });

    it("excludes ShadowSpec capture tables", async () => {
      const tables =
        await introspectSchema(
          databasePool,
          "public"
        );

      expect(
        tables.some(
          (table) =>
            table.name ===
            "api_requests"
        )
      ).toBe(false);

      expect(
        tables.some(
          (table) =>
            table.name ===
            "api_request_snapshots"
        )
      ).toBe(false);
    });

    it("excludes views", async () => {
      const tables =
        await introspectSchema(
          databasePool,
          "public"
        );

      expect(
        tables.some(
          (table) =>
            table.name ===
            "order_statuses"
        )
      ).toBe(false);
    });

    it("only inspects the requested schema", async () => {
      const publicTables =
        await introspectSchema(
          databasePool,
          "public"
        );

      expect(
        publicTables.some(
          (table) =>
            table.name ===
            "hidden_table"
        )
      ).toBe(false);

      const internalTables =
        await introspectSchema(
          databasePool,
          "internal_test"
        );

      expect(internalTables).toEqual([
        {
          name: "hidden_table",
          columns: ["id"]
        }
      ]);
    });

    it("returns an empty list for a schema without tables", async () => {
      await databasePool.query(
        "CREATE SCHEMA empty_schema"
      );

      expect(
        await introspectSchema(
          databasePool,
          "empty_schema"
        )
      ).toEqual([]);
    });
  }
);
