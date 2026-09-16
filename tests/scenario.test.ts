import {
  describe,
  expect,
  it
} from "vitest";

import {
  buildScenarioSequences,
  type CapturedRequest
} from "../src/scenario";

describe("buildScenarioSequences", () => {
  it("groups requests by session and preserves capture order", () => {
    const requests: CapturedRequest[] = [
      {
        id: 1,
        sessionId: "session-a",
        method: "POST",
        path: "/orders",
        pathParams: {},
        queryParams: {},
        requestBody: {
          customerId: 1234
        },
        responseBody: {
          orderId: 1
        },
        responseStatus: 201
      },
      {
        id: 2,
        sessionId: "session-b",
        method: "GET",
        path: "/orders/1",
        pathParams: {
          id: "1"
        },
        queryParams: {},
        requestBody: null,
        responseBody: {
          orderId: 1
        },
        responseStatus: 200
      },
      {
        id: 3,
        sessionId: "session-a",
        method: "GET",
        path: "/orders/1",
        pathParams: {
          id: "1"
        },
        queryParams: {},
        requestBody: null,
        responseBody: {
          orderId: 1
        },
        responseStatus: 200
      },
      {
        id: 4,
        method: "GET",
        path: "/orders",
        pathParams: {},
        queryParams: {},
        requestBody: null,
        responseBody: [],
        responseStatus: 200
      }
    ];

    const sequences =
      buildScenarioSequences(requests);

    expect(sequences).toHaveLength(2);

    expect(
      sequences[0].sessionId
    ).toBe("session-a");

    expect(
      sequences[0].requests.map(
        (request) => request.id
      )
    ).toEqual([1, 3]);

    expect(
      sequences[1].sessionId
    ).toBe("session-b");

    expect(
      sequences[1].requests.map(
        (request) => request.id
      )
    ).toEqual([2]);
  });
});