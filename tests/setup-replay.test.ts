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