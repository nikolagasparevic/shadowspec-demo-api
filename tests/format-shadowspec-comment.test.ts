import {
  describe,
  expect,
  it
} from "vitest";
import type {
  ShadowSpecReport
} from "../src/report";

const {
  formatShadowSpecComment
}: {
  formatShadowSpecComment: (
    report: ShadowSpecReport
  ) => string;
} = require(
  "../.github/scripts/format-shadowspec-comment.cjs"
);

function behavioralFailure(
  overrides: Partial<
    ShadowSpecReport["failures"][number]
  > = {}
): ShadowSpecReport["failures"][number] {
  return {
    scenario: 1,
    method: "GET",
    path: "/orders/2",
    queryParams: {},
    differences: [
      {
        field: "body",
        expected: { productId: 9999 },
        actual: { productId: 12345 }
      }
    ],
    ...overrides
  };
}

function failedReport(
  failures: ShadowSpecReport["failures"]
): ShadowSpecReport {
  return {
    passed: false,
    scenarios: failures.length,
    checks: failures.length,
    passedChecks: 0,
    failedChecks: failures.length,
    failures
  };
}

describe("formatShadowSpecComment", () => {
  it("formats a successful report", () => {
    const comment = formatShadowSpecComment({
      passed: true,
      scenarios: 7,
      checks: 8,
      passedChecks: 8,
      failedChecks: 0,
      failures: []
    });

    expect(comment).toContain(
      "## 🟢 ShadowSpec passed"
    );
    expect(comment).toContain(
      "**8 of 8 checks passed** across **7 scenarios**."
    );
    expect(comment).toContain(
      "No behavioral regressions detected."
    );
  });

  it("formats a standalone behavioral failure", () => {
    const comment = formatShadowSpecComment(
      failedReport([behavioralFailure()])
    );

    expect(comment).toContain("### Scenario 1");
    expect(comment).not.toContain(
      "Scenario 1 / Step"
    );
    expect(comment).toContain(
      "`GET /orders/2`"
    );
    expect(comment).toContain(
      "**Behavioral regression**"
    );
  });

  it("formats a lifecycle failure with its step", () => {
    const comment = formatShadowSpecComment(
      failedReport([
        behavioralFailure({
          scenario: 3,
          step: 2
        })
      ])
    );

    expect(comment).toContain(
      "### Scenario 3 / Step 2"
    );
  });

  it("formats a binding failure with code and message", () => {
    const comment = formatShadowSpecComment(
      failedReport([
        behavioralFailure({
          step: 2,
          kind: "binding",
          code: "UNRESOLVED_BINDING",
          message:
            'Unresolved ShadowSpec binding: "orderId".',
          differences: []
        })
      ])
    );

    expect(comment).toContain(
      "**Binding failure — `UNRESOLVED_BINDING`**"
    );
    expect(comment).toContain(
      'Unresolved ShadowSpec binding: "orderId".'
    );
  });

  it("represents binding-only reports as failures", () => {
    const comment = formatShadowSpecComment(
      failedReport([
        behavioralFailure({
          kind: "binding",
          code: "DUPLICATE_BINDING",
          message: "Binding already exists.",
          differences: []
        })
      ])
    );

    expect(comment).toContain(
      "ShadowSpec failed — 1 of 1 checks failed"
    );
    expect(comment).not.toContain(
      "0 behavioral regressions"
    );
  });

  it("formats mixed behavioral and binding failures", () => {
    const comment = formatShadowSpecComment(
      failedReport([
        behavioralFailure(),
        behavioralFailure({
          scenario: 2,
          step: 3,
          kind: "binding",
          code: "CAPTURE_SOURCE_MISSING",
          message: "Capture source was missing.",
          differences: []
        })
      ])
    );

    expect(comment).toContain(
      "**Behavioral regression**"
    );
    expect(comment).toContain(
      "**Binding failure — `CAPTURE_SOURCE_MISSING`**"
    );
  });

  it("formats HTTP status differences", () => {
    const comment = formatShadowSpecComment(
      failedReport([
        behavioralFailure({
          differences: [
            {
              field: "httpStatus",
              expected: 200,
              actual: 500
            }
          ]
        })
      ])
    );

    expect(comment).toContain(
      "- `httpStatus`: expected `200`, received `500`"
    );
  });

  it("formats nested body scalar differences", () => {
    const comment = formatShadowSpecComment(
      failedReport([
        behavioralFailure({
          differences: [
            {
              field: "body",
              expected: {
                order: { productId: 9999 }
              },
              actual: {
                order: { productId: 12345 }
              }
            }
          ]
        })
      ])
    );

    expect(comment).toContain(
      "- `body.order.productId`: expected `9999`, received `12345`"
    );
  });

  it("formats added fields", () => {
    const comment = formatShadowSpecComment(
      failedReport([
        behavioralFailure({
          differences: [
            {
              field: "body",
              expected: {},
              actual: { added: true }
            }
          ]
        })
      ])
    );

    expect(comment).toContain(
      "- `body.added`: expected missing, received `true`"
    );
  });

  it("formats removed fields", () => {
    const comment = formatShadowSpecComment(
      failedReport([
        behavioralFailure({
          differences: [
            {
              field: "body",
              expected: { removed: true },
              actual: {}
            }
          ]
        })
      ])
    );

    expect(comment).toContain(
      "- `body.removed`: expected `true`, received missing"
    );
  });

  it("formats simple array index differences", () => {
    const comment = formatShadowSpecComment(
      failedReport([
        behavioralFailure({
          differences: [
            {
              field: "body",
              expected: { items: [1, 2] },
              actual: { items: [1, 3] }
            }
          ]
        })
      ])
    );

    expect(comment).toContain(
      "- `body.items[1]`: expected `2`, received `3`"
    );
  });

  it("truncates long displayed values", () => {
    const longValue = "x".repeat(300);
    const comment = formatShadowSpecComment(
      failedReport([
        behavioralFailure({
          differences: [
            {
              field: "body",
              expected: { value: "short" },
              actual: { value: longValue }
            }
          ]
        })
      ])
    );

    expect(comment).toContain("…");
    expect(comment).not.toContain(longValue);
  });

  it("limits displayed differences", () => {
    const expected: Record<string, number> = {};
    const actual: Record<string, number> = {};

    for (let index = 0; index < 12; index++) {
      expected[`field${index}`] = index;
      actual[`field${index}`] = index + 100;
    }

    const comment = formatShadowSpecComment(
      failedReport([
        behavioralFailure({
          differences: [
            {
              field: "body",
              expected,
              actual
            }
          ]
        })
      ])
    );

    expect(
      comment.match(/^- `body\.field/gm)
    ).toHaveLength(10);
    expect(comment).toContain(
      "2 additional differences omitted"
    );
  });

  it("hides raw query parameter values", () => {
    const comment = formatShadowSpecComment(
      failedReport([
        behavioralFailure({
          path: "/search",
          queryParams: {
            status: "private-status",
            token: "secret-token"
          }
        })
      ])
    );

    expect(comment).toContain(
      "`GET /search?status=…&token=…`"
    );
    expect(comment).not.toContain(
      "private-status"
    );
    expect(comment).not.toContain(
      "secret-token"
    );
  });

  it("contains Markdown-sensitive values inside safe code spans", () => {
    const comment = formatShadowSpecComment(
      failedReport([
        behavioralFailure({
          differences: [
            {
              field: "body",
              expected: { value: "plain" },
              actual: {
                value:
                  "**bold** `code`\n# heading"
              }
            }
          ]
        })
      ])
    );

    expect(comment).toContain(
      '``"**bold** `code`\\n# heading"``'
    );
    expect(comment).not.toContain(
      "\n# heading\n"
    );
  });

  it("supports legacy behavioral failure reports", () => {
    const failure = behavioralFailure();
    delete failure.kind;
    delete failure.code;
    delete failure.message;

    const comment = formatShadowSpecComment(
      failedReport([failure])
    );

    expect(comment).toContain(
      "**Behavioral regression**"
    );
    expect(comment).toContain(
      "`body.productId`"
    );
  });

  it("preserves the ShadowSpec marker", () => {
    const comment = formatShadowSpecComment({
      passed: true,
      scenarios: 1,
      checks: 1,
      passedChecks: 1,
      failedChecks: 0,
      failures: []
    });

    expect(comment.startsWith(
      "<!-- shadowspec-report -->\n"
    )).toBe(true);
  });
});
