import {
  describe,
  expect,
  it
} from "vitest";
import {
  buildLifecycleScenarios,
  buildScenarios
} from "../src/export-scenarios";
import type {
  CapturedRequest,
  ScenarioSequence
} from "../src/scenario-types";
import type { DatabaseSnapshot } from "../src/db-snapshot";

type SequenceOptions = {
  requestBody?: unknown;
  producerExtra?: Record<string, unknown>;
  consumerValue?: unknown;
  consumerMethod?: string;
  beforeRows?: Record<string, unknown>[];
  afterRows?: Record<string, unknown>[];
  path?: string;
  pathParams?: Record<string, string>;
  snapshotMode?: "valid" | "missing" | "invalid";
};

function snapshot(
  rows: Record<string, unknown>[]
): DatabaseSnapshot {
  return {
    tables: {
      resources: {
        rows
      }
    }
  };
}

function makeSequence(
  sessionId: string,
  value: unknown,
  options: SequenceOptions = {}
): ScenarioSequence {
  const beforeRows =
    options.beforeRows ?? [
      {
        key: "existing"
      }
    ];
  const afterRows =
    options.afterRows ?? [
      ...beforeRows,
      {
        generated_value: value
      }
    ];
  const snapshotMode =
    options.snapshotMode ?? "valid";
  const beforeSnapshot =
    snapshotMode === "missing"
      ? undefined
      : snapshotMode === "invalid"
        ? { tables: {} }
        : snapshot(beforeRows);
  const afterSnapshot =
    snapshotMode === "missing"
      ? undefined
      : snapshotMode === "invalid"
        ? { tables: {} }
        : snapshot(afterRows);
  const path =
    options.path ??
    `/resources/${String(value)}`;
  const pathParams =
    options.pathParams ?? {
      resource: String(value)
    };

  const requests: CapturedRequest[] = [
    {
      id: 1,
      sessionId,
      method: "POST",
      path: "/resources",
      pathParams: {},
      queryParams: {},
      requestBody:
        options.requestBody ?? {
          name: "same"
        },
      responseBody: {
        result: {
          value
        },
        status: "created",
        ...(options.producerExtra ?? {})
      },
      responseStatus: 201,
      snapshot: beforeSnapshot
    },
    {
      id: 2,
      sessionId,
      method:
        options.consumerMethod ?? "GET",
      path,
      pathParams,
      queryParams: {},
      requestBody: null,
      responseBody: {
        result: {
          value:
            options.consumerValue ?? value
        },
        status: "created"
      },
      responseStatus: 200,
      snapshot: afterSnapshot
    }
  ];

  return {
    sessionId,
    requests
  };
}

function expectLiteral(
  sequences: ScenarioSequence[]
) {
  const scenarios =
    buildLifecycleScenarios(sequences);

  for (
    let index = 0;
    index < scenarios.length;
    index++
  ) {
    const producerBody =
      sequences[index].requests[0]
        .responseBody as {
          result: {
            value: unknown;
          };
        };
    const consumerBody =
      sequences[index].requests[1]
        .responseBody as {
          result: {
            value: unknown;
          };
        };

    expect(
      scenarios[index].steps[0].capture
    ).toBeUndefined();

    expect(
      scenarios[index].steps[1].request
        .pathParams
    ).toEqual(
      sequences[index].requests[1]
        .pathParams
    );

    expect(
      (
        scenarios[index].steps[1]
          .expected.body as {
            result: {
              value: unknown;
            };
          }
      ).result.value
    ).toEqual(
      consumerBody.result.value
    );

    expect(
      (
        scenarios[index].steps[0]
          .expected.body as {
            result: {
              value: unknown;
            };
          }
      ).result.value
    ).toEqual(
      producerBody.result.value
    );
  }

  return scenarios;
}

describe("lifecycle binding inference", () => {
  it("infers numeric generated values across equivalent sessions", () => {
    const scenarios = buildLifecycleScenarios([
      makeSequence("numeric-a", 101),
      makeSequence("numeric-b", 202)
    ]);

    expect(scenarios).toHaveLength(2);

    for (const scenario of scenarios) {
      expect(
        scenario.steps[0].capture
      ).toEqual({
        step1Value1: {
          from: "response.body",
          pointer: "/result/value",
          type: "number"
        }
      });

      expect(
        scenario.steps[1].request.path
      ).toBe("/resources/:resource");

      expect(
        scenario.steps[1].request
          .pathParams
      ).toEqual({
        resource: {
          $ref: "step1Value1"
        }
      });

      expect(
        scenario.steps[1].expected.body
      ).toEqual({
        result: {
          value: {
            $ref: "step1Value1"
          }
        },
        status: "created"
      });
    }
  });

  it("infers string generated values with a deterministic binding name", () => {
    const scenarios = buildLifecycleScenarios([
      makeSequence("string-a", "ref-alpha"),
      makeSequence("string-b", "ref-beta")
    ]);

    expect(
      scenarios[0].steps[0].capture
    ).toEqual({
      step1Value1: {
        from: "response.body",
        pointer: "/result/value",
        type: "string"
      }
    });

    expect(
      scenarios[1].steps[1].request
        .pathParams
    ).toEqual({
      resource: {
        $ref: "step1Value1"
      }
    });
  });

  it("rewrites exactly the proven path segment", () => {
    const scenarios = buildLifecycleScenarios([
      makeSequence("segment-a", 101, {
        path: "/tenants/fixed/resources/101"
      }),
      makeSequence("segment-b", 202, {
        path: "/tenants/fixed/resources/202"
      })
    ]);

    expect(
      scenarios[0].steps[1].request.path
    ).toBe(
      "/tenants/fixed/resources/:resource"
    );
  });

  it("rejects a path with an existing selected placeholder", () => {
    const sequences = [
      makeSequence("placeholder-a", 101, {
        path: "/tenants/:resource/orders/101"
      }),
      makeSequence("placeholder-b", 202, {
        path: "/tenants/:resource/orders/202"
      })
    ];

    const scenarios = expectLiteral(sequences);

    expect(
      scenarios[0].steps[1].request.path
    ).toBe(
      "/tenants/:resource/orders/101"
    );
  });

  it("does not create a duplicate placeholder when the token already occurs", () => {
    const sequences = [
      makeSequence("placeholder-token-a", 101, {
        path:
          "/tenants/:resource-history/orders/101"
      }),
      makeSequence("placeholder-token-b", 202, {
        path:
          "/tenants/:resource-history/orders/202"
      })
    ];

    const scenarios = expectLiteral(sequences);

    expect(
      scenarios[0].steps[1].request.path
    ).not.toBe(
      "/tenants/:resource-history/orders/:resource"
    );
  });

  it("rewrites a simple path to one selected placeholder", () => {
    const scenarios = buildLifecycleScenarios([
      makeSequence("simple-path-a", 101, {
        path: "/orders/101",
        pathParams: {
          id: "101"
        }
      }),
      makeSequence("simple-path-b", 202, {
        path: "/orders/202",
        pathParams: {
          id: "202"
        }
      })
    ]);

    expect(
      scenarios[0].steps[1].request.path
    ).toBe("/orders/:id");
  });

  it("keeps paths with multiple matching concrete segments literal", () => {
    const sequences = [
      makeSequence("concrete-segments-a", 101, {
        path: "/orders/101/related/101",
        pathParams: {
          id: "101"
        }
      }),
      makeSequence("concrete-segments-b", 202, {
        path: "/orders/202/related/202",
        pathParams: {
          id: "202"
        }
      })
    ];

    const scenarios = expectLiteral(sequences);

    expect(
      scenarios[0].steps[1].request.path
    ).toBe(
      "/orders/101/related/101"
    );
  });

  it("leaves a single lifecycle literal", () => {
    const sequence =
      makeSequence("single", 101);
    const scenarios = expectLiteral([
      sequence
    ]);

    expect(
      scenarios[0].steps[1].request.path
    ).toBe("/resources/101");
  });

  it("leaves repeated identical candidate values literal", () => {
    expectLiteral([
      makeSequence("same-a", 101),
      makeSequence("same-b", 101)
    ]);
  });

  it("leaves candidates present in the POST request literal", () => {
    const requestBody = {
      reservedValues: [101, 202]
    };

    expectLiteral([
      makeSequence("request-a", 101, {
        requestBody
      }),
      makeSequence("request-b", 202, {
        requestBody
      })
    ]);
  });

  it("leaves candidates present in the initial snapshot literal", () => {
    const beforeRows = [
      {
        reserved: 101
      },
      {
        reserved: 202
      }
    ];

    expectLiteral([
      makeSequence("snapshot-a", 101, {
        beforeRows
      }),
      makeSequence("snapshot-b", 202, {
        beforeRows
      })
    ]);
  });

  it("does not group differing producer requests", () => {
    expectLiteral([
      makeSequence("request-diff-a", 101, {
        requestBody: {
          name: "alpha"
        }
      }),
      makeSequence("request-diff-b", 202, {
        requestBody: {
          name: "beta"
        }
      })
    ]);
  });

  it("does not group unrelated response differences", () => {
    expectLiteral([
      makeSequence("response-diff-a", 101, {
        producerExtra: {
          unrelated: "alpha"
        }
      }),
      makeSequence("response-diff-b", 202, {
        producerExtra: {
          unrelated: "beta"
        }
      })
    ]);
  });

  it("requires the consumer to echo the same pointer", () => {
    expectLiteral([
      makeSequence("echo-a", 101, {
        consumerValue: 999
      }),
      makeSequence("echo-b", 202, {
        consumerValue: 999
      })
    ]);
  });

  it("requires a newly added snapshot row containing the candidate", () => {
    const unchangedRows = [
      {
        key: "existing"
      }
    ];

    expectLiteral([
      makeSequence("row-a", 101, {
        afterRows: unchangedRows
      }),
      makeSequence("row-b", 202, {
        afterRows: unchangedRows
      })
    ]);
  });

  it.each([
    "missing",
    "invalid"
  ] as const)(
    "requires %s snapshots to remain uninferred",
    (snapshotMode) => {
      expectLiteral([
        makeSequence("snapshot-mode-a", 101, {
          snapshotMode
        }),
        makeSequence("snapshot-mode-b", 202, {
          snapshotMode
        })
      ]);
    }
  );

  it("rejects duplicate candidate values in the producer response", () => {
    expectLiteral([
      makeSequence("duplicate-a", 101, {
        producerExtra: {
          duplicate: 101
        }
      }),
      makeSequence("duplicate-b", 202, {
        producerExtra: {
          duplicate: 202
        }
      })
    ]);
  });

  it("rejects values appearing in multiple path segments", () => {
    expectLiteral([
      makeSequence("segments-a", 101, {
        path: "/resources/101/copies/101"
      }),
      makeSequence("segments-b", 202, {
        path: "/resources/202/copies/202"
      })
    ]);
  });

  it("rejects multiple path parameters sharing the candidate", () => {
    expectLiteral([
      makeSequence("params-a", 101, {
        pathParams: {
          resource: "101",
          alias: "101"
        }
      }),
      makeSequence("params-b", 202, {
        pathParams: {
          resource: "202",
          alias: "202"
        }
      })
    ]);
  });

  it("rejects boolean and null candidates", () => {
    expectLiteral([
      makeSequence("boolean-a", true),
      makeSequence("boolean-b", false)
    ]);

    expectLiteral([
      makeSequence("null-a", null),
      makeSequence("null-b", null)
    ]);
  });

  it("requires the consumer to be a GET", () => {
    expectLiteral([
      makeSequence("method-a", 101, {
        consumerMethod: "PATCH"
      }),
      makeSequence("method-b", 202, {
        consumerMethod: "PATCH"
      })
    ]);
  });

  it("leaves standalone export behavior unchanged", () => {
    expect(
      buildScenarios([
        {
          id: 1,
          method: "GET",
          path: "/resources/1",
          pathParams: {
            id: "1"
          },
          queryParams: {},
          requestBody: null,
          responses: [
            {
              status: 200,
              body: {
                id: 1,
                status: "ok"
              }
            }
          ]
        }
      ])
    ).toEqual([
      {
        id: 1,
        request: {
          method: "GET",
          path: "/resources/1",
          body: null,
          pathParams: {
            id: "1"
          }
        },
        expected: {
          status: 200,
          body: {
            id: 1,
            status: "ok"
          }
        }
      }
    ]);
  });

  it("preserves a nonqualifying lifecycle export exactly", () => {
    const sequence = makeSequence(
      "nonqualifying",
      101
    );

    expect(
      buildLifecycleScenarios([sequence])
    ).toEqual([
      {
        id: 1,
        setup: sequence.requests[0].snapshot,
        steps: [
          {
            request: {
              method: "POST",
              path: "/resources",
              body: {
                name: "same"
              }
            },
            expected: {
              status: 201,
              body: {
                result: {
                  value: 101
                },
                status: "created"
              }
            }
          },
          {
            request: {
              method: "GET",
              path: "/resources/101",
              body: null,
              pathParams: {
                resource: "101"
              }
            },
            expected: {
              status: 200,
              body: {
                result: {
                  value: 101
                },
                status: "created"
              }
            }
          }
        ]
      }
    ]);
  });
});
