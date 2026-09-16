import { describe, expect, it } from "vitest";
import { detectDynamicFields } from "../src/dynamic-fields";

describe("detectDynamicFields", () => {
  it("returns no fields when there is only one response", () => {
    expect(
      detectDynamicFields([
        {
          orderId: 1,
          status: "created"
        }
      ])
    ).toEqual([]);
  });

  it("returns no fields when responses are identical", () => {
    expect(
      detectDynamicFields([
        {
          orderId: 1,
          status: "created"
        },
        {
          orderId: 1,
          status: "created"
        }
      ])
    ).toEqual([]);
  });

  it("detects a changing top-level field", () => {
    expect(
      detectDynamicFields([
        {
          orderId: 1,
          status: "created"
        },
        {
          orderId: 2,
          status: "created"
        }
      ])
    ).toEqual(["orderId"]);
  });

  it("detects a changing nested field", () => {
    expect(
      detectDynamicFields([
        {
          order: {
            id: 1,
            status: "created"
          }
        },
        {
          order: {
            id: 2,
            status: "created"
          }
        }
      ])
    ).toEqual(["order.id"]);
  });

it("detects when an array field changes", () => {
  expect(
    detectDynamicFields([
      {
        items: [
          { id: 1 },
          { id: 2 }
        ]
      },
      {
        items: [
          { id: 3 },
          { id: 4 }
        ]
      }
    ])
  ).toEqual(["items"]);
});

  it("detects multiple changing fields", () => {
    expect(
      detectDynamicFields([
        {
          orderId: 1,
          status: "created",
          quantity: 5
        },
        {
          orderId: 2,
          status: "shipped",
          quantity: 10
        }
      ])
    ).toEqual([
      "orderId",
      "status",
      "quantity"
    ]);
  });
});