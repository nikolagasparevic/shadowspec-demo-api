export type ShadowSpecReport = {
  passed: boolean;
  scenarios: number;
  passedScenarios: number;
  failedScenarios: number;
  failures: {
    scenario: number;
    method: string;
    path: string;
    differences: {
      field: string;
      expected: any;
      actual: any;
    }[];
  }[];
};

export function createReport(
  scenarios: number,
  passedScenarios: number,
  failedScenarios: number,
  failures: ShadowSpecReport["failures"]
): ShadowSpecReport {
  return {
    passed: failedScenarios === 0,
    scenarios,
    passedScenarios,
    failedScenarios,
    failures
  };
}