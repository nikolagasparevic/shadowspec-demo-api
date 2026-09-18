import {
  afterEach,
  describe,
  expect,
  it,
  vi
} from "vitest";

const { queryMock } =
  vi.hoisted(() => ({
    queryMock: vi.fn()
  }));

vi.mock("../src/db", () => ({
  pool: {
    query: queryMock
  }
}));

import {
  applyReplaySetup,
  resetReplayDatabase
} from "../src/setup-replay";

describe(
  "resetReplayDatabase",
  () => {
    afterEach(() => {
      vi.clearAllMocks();
      delete process.env.SHADOWSPEC_TABLES;
    });

    it(
      "does nothing when no tables are configured",
      async () => {
        await resetReplayDatabase();

        expect(
          queryMock
        ).not.toHaveBeenCalled();
      }
    );

    it(
      "resets only configured tables",
      async () => {
        process.env.SHADOWSPEC_TABLES =
          "orders, customers";

        await resetReplayDatabase();

        expect(
          queryMock
        ).toHaveBeenNthCalledWith(
          1,
          `TRUNCATE TABLE "orders"
       RESTART IDENTITY CASCADE`
        );

        expect(
          queryMock
        ).toHaveBeenNthCalledWith(
          2,
          `TRUNCATE TABLE "customers"
       RESTART IDENTITY CASCADE`
        );

        expect(
          queryMock
        ).toHaveBeenCalledTimes(2);
      }
    );
  }
);

describe("applyReplaySetup", () => {
  afterEach(() => {
    vi.clearAllMocks();
    delete process.env.SHADOWSPEC_TABLES;
  });

  it(
    "restores tables in configured order",
    async () => {
      process.env.SHADOWSPEC_TABLES =
        "parents,children";

      await applyReplaySetup({
        tables: {
          children: {
            rows: [{ id: 2, parent_id: 1 }]
          },
          parents: {
            rows: [{ id: 1 }]
          }
        }
      });

      const insertQueries = queryMock.mock.calls
        .map(([sql]) => sql as string)
        .filter((sql) => sql.startsWith("INSERT"));

      expect(insertQueries).toEqual([
        expect.stringContaining(
          'INSERT INTO "parents"'
        ),
        expect.stringContaining(
          'INSERT INTO "children"'
        )
      ]);
    }
  );

  it(
    "ignores unconfigured setup tables",
    async () => {
      process.env.SHADOWSPEC_TABLES = "parents";

      await applyReplaySetup({
        tables: {
          parents: { rows: [{ id: 1 }] },
          unrelated: { rows: [{ id: 99 }] }
        }
      });

      const queries = queryMock.mock.calls.map(
        ([sql]) => sql as string
      );

      expect(
        queries.some((sql) =>
          sql.includes("unrelated")
        )
      ).toBe(false);
    }
  );

  it(
    "deduplicates configured tables in first occurrence order",
    async () => {
      process.env.SHADOWSPEC_TABLES =
        "parents, children, parents, , children";

      await applyReplaySetup({
        tables: {
          children: { rows: [{ id: 2 }] },
          parents: { rows: [{ id: 1 }] }
        }
      });

      const queries = queryMock.mock.calls.map(
        ([sql]) => sql as string
      );
      const resetQueries = queries.filter((sql) =>
        sql.startsWith("TRUNCATE")
      );
      const insertQueries = queries.filter((sql) =>
        sql.startsWith("INSERT")
      );

      expect(resetQueries).toEqual([
        expect.stringContaining(
          'TRUNCATE TABLE "parents"'
        ),
        expect.stringContaining(
          'TRUNCATE TABLE "children"'
        )
      ]);
      expect(insertQueries).toEqual([
        expect.stringContaining(
          'INSERT INTO "parents"'
        ),
        expect.stringContaining(
          'INSERT INTO "children"'
        )
      ]);
      expect(
        queries.filter((sql) =>
          sql.startsWith("DO $$")
        )
      ).toHaveLength(2);
    }
  );

  it(
    "ignores whitespace and empty configuration entries",
    async () => {
      process.env.SHADOWSPEC_TABLES =
        " , parents, , children, ";

      await applyReplaySetup({ tables: {} });

      const resetQueries = queryMock.mock.calls
        .map(([sql]) => sql as string)
        .filter((sql) => sql.startsWith("TRUNCATE"));

      expect(resetQueries).toEqual([
        expect.stringContaining(
          'TRUNCATE TABLE "parents"'
        ),
        expect.stringContaining(
          'TRUNCATE TABLE "children"'
        )
      ]);
    }
  );

  it(
    "skips a configured table missing from setup",
    async () => {
      process.env.SHADOWSPEC_TABLES =
        "parents,children";

      await applyReplaySetup({
        tables: {
          children: { rows: [{ id: 2 }] }
        }
      });

      const restoreQueries = queryMock.mock.calls
        .map(([sql]) => sql as string)
        .filter((sql) =>
          !sql.startsWith("TRUNCATE")
        );

      expect(restoreQueries).toHaveLength(2);
      expect(restoreQueries[0]).toContain(
        'INSERT INTO "children"'
      );
      expect(restoreQueries[1]).toContain(
        "'children'"
      );
    }
  );

  it(
    "repairs the sequence for a configured empty table",
    async () => {
      process.env.SHADOWSPEC_TABLES = "parents";

      await applyReplaySetup({
        tables: {
          parents: { rows: [] }
        }
      });

      const queries = queryMock.mock.calls.map(
        ([sql]) => sql as string
      );

      expect(queries).toHaveLength(2);
      expect(queries[0]).toContain(
        'TRUNCATE TABLE "parents"'
      );
      expect(queries[1]).toContain("'parents'");
      expect(queries[1]).toContain("pg_get_serial_sequence");
    }
  );

  it(
    "repairs a configured table sequence after its inserts",
    async () => {
      process.env.SHADOWSPEC_TABLES = "parents";

      await applyReplaySetup({
        tables: {
          parents: {
            rows: [{ id: 1 }, { id: 2 }]
          }
        }
      });

      const restoreQueries = queryMock.mock.calls
        .map(([sql]) => sql as string)
        .filter((sql) =>
          !sql.startsWith("TRUNCATE")
        );

      expect(restoreQueries).toHaveLength(3);
      expect(restoreQueries[0]).toContain(
        'INSERT INTO "parents"'
      );
      expect(restoreQueries[1]).toContain(
        'INSERT INTO "parents"'
      );
      expect(restoreQueries[2]).toContain(
        "pg_get_serial_sequence"
      );
    }
  );

  it(
    "preserves single-table replay setup behavior",
    async () => {
      process.env.SHADOWSPEC_TABLES = "orders";

      await applyReplaySetup({
        tables: {
          orders: { rows: [{ id: 1 }] }
        }
      });

      const queries = queryMock.mock.calls.map(
        ([sql]) => sql as string
      );

      expect(queries).toHaveLength(3);
      expect(queries[0]).toContain(
        'TRUNCATE TABLE "orders"'
      );
      expect(queries[1]).toContain(
        'INSERT INTO "orders"'
      );
      expect(queries[2]).toContain("'orders'");
    }
  );
});
