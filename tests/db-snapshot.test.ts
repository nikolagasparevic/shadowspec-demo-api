import {
  afterEach,
  describe,
  expect,
  it,
  vi
} from "vitest";
import type { Pool } from "pg";

const { queryMock } =
  vi.hoisted(() => ({
    queryMock: vi.fn()
  }));

import {
  captureDatabaseSnapshot
} from "../src/db-snapshot";

const applicationPool = {
  query: queryMock
} as unknown as Pool;

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
          await captureDatabaseSnapshot(
            applicationPool,
            []
          );

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
          await captureDatabaseSnapshot(
            applicationPool,
            ["orders", "customers"]
          );

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
