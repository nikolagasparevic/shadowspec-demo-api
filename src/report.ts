export type ShadowSpecReport = {
  passed: boolean;
  scenarios: number;
  checks: number;
  passedChecks: number;
  failedChecks: number;
  failures: {
    scenario: number;
    step?: number;
    method: string;
    path: string;
    queryParams: Record<string, string>;
    differences: {
      field: string;
      expected: any;
      actual: any;
    }[];
  }[];
};

export function createReport(
  scenarios: number,
  checks: number,
  passedChecks: number,
  failedChecks: number,
  failures: ShadowSpecReport["failures"]
): ShadowSpecReport {
  return {
    passed: failedChecks === 0,
    scenarios,
    checks,
    passedChecks,
    failedChecks,
    failures
  };
}