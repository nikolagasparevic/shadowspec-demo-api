import type { ScenarioResponse } from "../src/scenario-types";

import {
  describe,
  expect,
  it
} from "vitest";

import {
  buildCandidateArtifact,
  buildScenarios,
  buildLifecycleScenarios,
  findBestBaselineResponse,
  ScenarioExportError
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
  it("exports observed business variation only as candidate diagnostics", () => {
    const groups = [
      {
        id: 1,
        method: "GET",
        path: "/products/1",
        pathParams: { id: "1" },
        queryParams: {},
        requestBody: null,
        responses: [
          {
            body: {
              status: "pending",
              price: 10,
              updatedAt: "one",
              requestId: "request-one"
            },
            status: 200
          },
          {
            body: {
              status: "approved",
              price: 11,
              updatedAt: "two",
              requestId: "request-two"
            },
            status: 200
          }
        ]
      }
    ];

    const scenarios = buildScenarios(groups);
    const artifact = buildCandidateArtifact(groups);

    expect("dynamicFields" in scenarios[0]).toBe(false);
    expect(
      artifact.candidates.map(
        ({ pointer, reason }) => ({ pointer, reason })
      )
    ).toEqual([
      { pointer: "/price", reason: "value_changed" },
      { pointer: "/requestId", reason: "value_changed" },
      { pointer: "/status", reason: "value_changed" },
      { pointer: "/updatedAt", reason: "value_changed" }
    ]);
    expect(JSON.stringify(artifact)).not.toContain(
      "request-one"
    );
    expect(JSON.stringify(artifact)).not.toContain(
      "request-two"
    );
  });

  it("produces byte-identical deterministic candidate metadata", () => {
    const groups = [
      {
        id: 1,
        method: "GET",
        path: "/values",
        pathParams: {},
        queryParams: {},
        requestBody: null,
        responses: [
          { body: { z: 1, a: 1 }, status: 200 },
          { body: { z: 2, a: 2 }, status: 200 }
        ]
      }
    ];

    expect(
      JSON.stringify(buildCandidateArtifact(groups))
    ).toBe(
      JSON.stringify(buildCandidateArtifact(groups))
    );
    expect(
      buildCandidateArtifact(groups).candidates.map(
        (candidate) => candidate.pointer
      )
    ).toEqual(["/a", "/z"]);
  });

  it("rejects sanitized response fields instead of masking them", () => {
    expect(() =>
      buildScenarios([
        {
          id: 1,
          method: "GET",
          path: "/profile",
          pathParams: {},
          queryParams: {},
          requestBody: null,
          responses: [
            {
              body: {
                name: "Ada",
                token: "secret"
              },
              status: 200
            }
          ]
        }
      ])
    ).toThrowError(
      expect.objectContaining<Partial<ScenarioExportError>>({
        code: "SANITIZED_RESPONSE_FIELD_UNSUPPORTED"
      })
    );
  });

  it("keeps state-derived evidence diagnostic-only", () => {
    const groups = [
      {
        id: 1,
        method: "GET",
        path: "/orders/2",
        pathParams: { id: "2" },
        queryParams: {},
        requestBody: null,
        responses: [
          {
            body: { status: "pending" },
            status: 200,
            snapshot: {
              tables: {
                orders: {
                  rows: [{ id: 2, status: "pending" }]
                }
              }
            }
          },
          {
            body: { status: "approved" },
            status: 200,
            snapshot: {
              tables: {
                orders: {
                  rows: [{ id: 2, status: "approved" }]
                }
              }
            }
          }
        ]
      }
    ];

    expect("dynamicFields" in buildScenarios(groups)[0]).toBe(false);
    expect(buildCandidateArtifact(groups).candidates)
      .toMatchObject([
        {
          pointer: "/status",
          reason: "correlated_with_snapshot"
        }
      ]);
  });

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
            orderId: 123,
            status: "created"
          }
        }
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
      orderId: 1,
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

  it("sanitizes sensitive fields from the database snapshot", () => {
    const result = buildScenarios([
      {
        id: 1,
        method: "GET",
        path: "/users/1",
        pathParams: {
          id: "1"
        },
        queryParams: {},
        requestBody: null,
        responses: [
          {
            body: {
              status: "active"
            },
            status: 200,
            snapshot: {
              tables: {
                users: {
                  rows: [
                    {
                      id: 1,
                      username: "nikola",
                      password: "super-secret",
                      token: "abc123",
                      email: "test@example.com"
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
        users: {
          rows: [
            {
              id: 1,
              username: "nikola",
              email: "test@example.com"
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

    expect("dynamicFields" in result[0]).toBe(false);
  });
});

describe("buildLifecycleScenarios", () => {
  it("rejects sanitized lifecycle response fields instead of masking them", () => {
    expect(() =>
      buildLifecycleScenarios([
        {
          sessionId: "sensitive-response",
          requests: [
            {
              id: 1,
              sessionId: "sensitive-response",
              method: "POST",
              path: "/sessions",
              pathParams: {},
              queryParams: {},
              requestBody: null,
              responseBody: { token: "secret" },
              responseStatus: 201
            },
            {
              id: 2,
              sessionId: "sensitive-response",
              method: "GET",
              path: "/sessions/1",
              pathParams: { id: "1" },
              queryParams: {},
              requestBody: null,
              responseBody: { status: "active" },
              responseStatus: 200
            }
          ]
        }
      ])
    ).toThrowError(
      expect.objectContaining({
        code: "SANITIZED_RESPONSE_FIELD_UNSUPPORTED"
      })
    );
  });

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
              orderId: 3,
              productId: 7777,
              quantity: 1,
              status: "created"
            }
          }
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
              orderId: 3,
              productId: 7777,
              quantity: 1,
              status: "created"
            }
          },
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
