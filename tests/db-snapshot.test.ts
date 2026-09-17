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
  captureDatabaseSnapshot
} from "../src/db-snapshot";

describe(
  "captureDatabaseSnapshot",
  () => {
    afterEach(() => {
      vi.clearAllMocks();
      delete process.env.SHADOWSPEC_TABLES;
    });

    it(
      "returns an empty snapshot when no tables are configured",
      async () => {
        const snapshot =
          await captureDatabaseSnapshot();

        expect(snapshot).toEqual({
          tables: {}
        });

        expect(
          queryMock
        ).not.toHaveBeenCalled();
      }
    );

    it(
      "captures only configured tables",
      async () => {
        process.env.SHADOWSPEC_TABLES =
          "orders, customers";

        queryMock
          .mockResolvedValueOnce({
            rows: [
              {
                id: 1,
                status: "created"
              }
            ]
          })
          .mockResolvedValueOnce({
            rows: [
              {
                id: 10,
                name: "Nikola"
              }
            ]
          });

        const snapshot =
          await captureDatabaseSnapshot();

        expect(
          queryMock
        ).toHaveBeenNthCalledWith(
          1,
          'SELECT * FROM "orders"'
        );

        expect(
          queryMock
        ).toHaveBeenNthCalledWith(
          2,
          'SELECT * FROM "customers"'
        );

        expect(snapshot).toEqual({
          tables: {
            orders: {
              rows: [
                {
                  id: 1,
                  status: "created"
                }
              ]
            },
            customers: {
              rows: [
                {
                  id: 10,
                  name: "Nikola"
                }
              ]
            }
          }
        });
      }
    );
  }
);