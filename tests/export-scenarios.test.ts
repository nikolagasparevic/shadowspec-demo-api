import type { ScenarioResponse } from "../src/scenario-types";

import {
  describe,
  expect,
  it
} from "vitest";

import {
  buildScenarios,
  buildLifecycleScenarios,
  findBestBaselineResponse
} from "../src/export-scenarios";

describe("findBestBaselineResponse", () => {
  it("prefers a response with a valid snapshot", () => {
    const responses: ScenarioResponse[] = [
      {
        body: {
          orderId: 1
        },
        status: 201,
        snapshot: {
          tables: {}
        }
      },
      {
        body: {
          orderId: 2
        },
        status: 201,
        snapshot: {
          tables: {
            orders: {
              rows: [
                {
                  id: 1
                }
              ]
            }
          }
        }
      }
    ];

    expect(
      findBestBaselineResponse(
        responses
      )
    ).toBe(responses[1]);
  });
});

  it("falls back to the first response when no valid snapshot exists", () => {
    const responses = [
      {
        body: {
          orderId: 1
        },
        status: 201,
        snapshot: {
          tables: {}
        }
      },
      {
        body: {
          orderId: 2
        },
        status: 201,
        snapshot: {
          tables: {}
        }
      }
    ];

    expect(
      findBestBaselineResponse(
        responses
      )
    ).toBe(responses[0]);
  });

  it("prefers the first valid snapshot", () => {
    const responses = [
      {
        body: {
          orderId: 1
        },
        status: 201
      },
      {
        body: {
          orderId: 2
        },
        status: 201,
        snapshot: {
          tables: {
            orders: {
              rows: []
            }
          }
        }
      },
      {
        body: {
          orderId: 3
        },
        status: 201,
        snapshot: {
          tables: {
            orders: {
              rows: [
                {
                  id: 3
                }
              ]
            }
          }
        }
      }
    ];

    expect(
      findBestBaselineResponse(
        responses
      )
    ).toBe(responses[1]);
  });

describe("buildScenarios", () => {
  it("builds a scenario from a grouped response", () => {
    const result = buildScenarios([
      {
        id: 1,
        method: "GET",
        path: "/orders/1",
        pathParams: {
          id: "1"
        },
        queryParams: {},
        requestBody: null,
        responses: [
          {
            body: {
              orderId: 123,
              status: "created"
            },
            status: 200
          }
        ]
      }
    ]);

    expect(result).toEqual([
      {
        id: 1,
        request: {
          method: "GET",
          path: "/orders/1",
          body: null,
          pathParams: {
            id: "1"
          }
        },
        expected: {
          status: 200,
          body: {
            status: "created"
          }
        },
        dynamicFields: [
          "orderId"
        ]
      }
    ]);
  });

  it("preserves the baseline response and snapshot", () => {
    const result = buildScenarios([
      {
        id: 1,
        method: "PATCH",
        path: "/orders/1",
        pathParams: {
          id: "1"
        },
        queryParams: {},
        requestBody: {
          quantity: 10
        },
        responses: [
          {
            body: {
              orderId: 1,
              quantity: 10,
              status: "shipped"
            },
            status: 200,
            snapshot: {
              tables: {
                orders: {
                  rows: [
                    {
                      id: 1,
                      quantity: 3,
                      status: "created"
                    }
                  ]
                }
              }
            }
          }
        ]
      }
    ]);

    expect(
      result[0].expected.body
    ).toEqual({
      quantity: 10,
      status: "shipped"
    });

    expect(
      result[0].setup
    ).toEqual({
      tables: {
        orders: {
          rows: [
            {
              id: 1,
              quantity: 3,
              status: "created"
            }
          ]
        }
      }
    });
  });

  it("uses the response with a valid snapshot as baseline", () => {
    const result = buildScenarios([
      {
        id: 1,
        method: "POST",
        path: "/orders",
        pathParams: {},
        queryParams: {},
        requestBody: {
          customerId: 1234
        },
        responses: [
          {
            body: {
              orderId: 1,
              status: "created"
            },
            status: 201,
            snapshot: {
              tables: {}
            }
          },
          {
            body: {
              orderId: 2,
              status: "created"
            },
            status: 201,
            snapshot: {
              tables: {
                orders: {
                  rows: [
                    {
                      id: 1,
                      customer_id: 1234
                    }
                  ]
                }
              }
            }
          }
        ]
      }
    ]);

    expect(
      result[0].setup
    ).toEqual({
      tables: {
        orders: {
          rows: [
            {
              id: 1,
              customer_id: 1234
            }
          ]
        }
      }
    });
  });
    it("does not mark state-dependent fields as dynamic across different database snapshots", () => {
    const result = buildScenarios([
      {
        id: 1,
        method: "GET",
        path: "/orders/2",
        pathParams: {
          id: "2"
        },
        queryParams: {},
        requestBody: null,
        responses: [
          {
            body: {
              orderId: 2,
              customerId: 1234,
              productId: 9999,
              quantity: 2,
              status: "created"
            },
            status: 200,
            snapshot: {
              tables: {
                orders: {
                  rows: [
                    {
                      id: 2,
                      customer_id: 1234,
                      product_id: 9999,
                      quantity: 2,
                      status: "created"
                    }
                  ]
                }
              }
            }
          },
          {
            body: {
              orderId: 2,
              customerId: 1234,
              productId: 12345,
              quantity: 2,
              status: "created"
            },
            status: 200,
            snapshot: {
              tables: {
                orders: {
                  rows: [
                    {
                      id: 2,
                      customer_id: 1234,
                      product_id: 12345,
                      quantity: 2,
                      status: "created"
                    }
                  ]
                }
              }
            }
          }
        ]
      }
    ]);

    expect(result[0].dynamicFields).toEqual([
      "orderId"
    ]);
  });
});

describe("buildLifecycleScenarios", () => {
  it("builds a multi-step scenario from a session sequence", () => {
    const result =
      buildLifecycleScenarios([
        {
          sessionId: "workflow-test-001",
          requests: [
            {
              id: 21,
              sessionId: "workflow-test-001",
              method: "POST",
              path: "/orders",
              pathParams: {},
              queryParams: {},
              requestBody: {
                customerId: 1234,
                productId: 7777,
                quantity: 1
              },
              responseBody: {
                orderId: 3,
                customerId: 1234,
                productId: 7777,
                quantity: 1,
                status: "created"
              },
              responseStatus: 201,
              snapshot: {
                tables: {
                  orders: {
                    rows: [
                      {
                        id: 1,
                        customer_id: 1234,
                        product_id: 5678,
                        quantity: 3,
                        status: "created"
                      }
                    ]
                  }
                }
              }
            },
            {
              id: 22,
              sessionId: "workflow-test-001",
              method: "GET",
              path: "/orders/3",
              pathParams: {
                id: "3"
              },
              queryParams: {},
              requestBody: null,
              responseBody: {
                orderId: 3,
                customerId: 1234,
                productId: 7777,
                quantity: 1,
                status: "created"
              },
              responseStatus: 200,
              snapshot: {
                tables: {
                  orders: {
                    rows: [
                      {
                        id: 1,
                        customer_id: 1234,
                        product_id: 5678,
                        quantity: 3,
                        status: "created"
                      },
                      {
                        id: 3,
                        customer_id: 1234,
                        product_id: 7777,
                        quantity: 1,
                        status: "created"
                      }
                    ]
                  }
                }
              }
            }
          ]
        }
      ]);

    expect(result).toHaveLength(1);

    expect(result[0]).toEqual({
      id: 1,
      setup: {
        tables: {
          orders: {
            rows: [
              {
                id: 1,
                customer_id: 1234,
                product_id: 5678,
                quantity: 3,
                status: "created"
              }
            ]
          }
        }
      },
      steps: [
        {
          request: {
            method: "POST",
            path: "/orders",
            body: {
              customerId: 1234,
              productId: 7777,
              quantity: 1
            }
          },
          expected: {
            status: 201,
            body: {
              customerId: 1234,
              productId: 7777,
              quantity: 1,
              status: "created"
            }
          },
          dynamicFields: [
            "orderId"
          ]
        },
        {
          request: {
            method: "GET",
            path: "/orders/3",
            body: null,
            pathParams: {
              id: "3"
            }
          },
          expected: {
            status: 200,
            body: {
              customerId: 1234,
              productId: 7777,
              quantity: 1,
              status: "created"
            }
          },
          dynamicFields: [
            "orderId"
          ]
        }
      ]
    });
  });

  it("ignores single-request sessions", () => {
    const result =
      buildLifecycleScenarios([
        {
          sessionId: "single-request",
          requests: [
            {
              id: 20,
              sessionId: "single-request",
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
            }
          ]
        }
      ]);

    expect(result).toEqual([]);
  });
});