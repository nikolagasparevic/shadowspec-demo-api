import { describe, expect, it } from "vitest";
import {
  compareResponses,
  normalizeResponse
} from "../src/compare";

describe("normalizeResponse", () => {
  it("sorts object keys recursively", () => {
    const result = normalizeResponse({
      z: 1,
      nested: {
        b: 2,
        a: 1
      },
      a: 3
    });

    expect(result).toEqual({
      a: 3,
      nested: {
        a: 1,
        b: 2
      },
      z: 1
    });
  });

  it("removes dynamic fields", () => {
    const result = normalizeResponse(
      {
        orderId: 123,
        customerId: 456,
        status: "created"
      },
      ["orderId"]
    );

    expect(result).toEqual({
      customerId: 456,
      status: "created"
    });
  });

  it("removes dynamic fields from nested objects", () => {
    const result = normalizeResponse(
      {
        order: {
          id: 123,
          status: "created"
        }
      },
      ["id"]
    );

    expect(result).toEqual({
      order: {
        status: "created"
      }
    });
  });
});

describe("compareResponses", () => {
  it("passes identical responses", () => {
    const result = compareResponses(
      {
        orderId: 1,
        quantity: 10,
        status: "shipped"
      },
      {
        orderId: 1,
        quantity: 10,
        status: "shipped"
      },
      200,
      200
    );

    expect(result.passed).toBe(true);
    expect(result.differences).toEqual([]);
  });

  it("ignores dynamic fields", () => {
    const result = compareResponses(
      {
        orderId: 1,
        quantity: 10
      },
      {
        orderId: 999,
        quantity: 10
      },
      200,
      200,
      ["orderId"]
    );

    expect(result.passed).toBe(true);
    expect(result.differences).toEqual([]);
  });

  it("detects response body differences", () => {
    const result = compareResponses(
      {
        quantity: 10,
        status: "shipped"
      },
      {
        quantity: 5,
        status: "shipped"
      },
      200,
      200
    );

    expect(result.passed).toBe(false);
    expect(result.differences).toEqual([
      {
        field: "body",
        expected: {
          quantity: 10,
          status: "shipped"
        },
        actual: {
          quantity: 5,
          status: "shipped"
        }
      }
    ]);
  });

  it("detects HTTP status differences", () => {
    const result = compareResponses(
      {
        message: "ok"
      },
      {
        message: "ok"
      },
      200,
      404
    );

    expect(result.passed).toBe(false);
    expect(result.differences).toContainEqual({
      field: "httpStatus",
      expected: 200,
      actual: 404
    });
  });

  it("detects both body and status differences", () => {
    const result = compareResponses(
      {
        status: "created"
      },
      {
        status: "deleted"
      },
      201,
      200
    );

    expect(result.passed).toBe(false);
    expect(result.differences).toHaveLength(2);
  });
});