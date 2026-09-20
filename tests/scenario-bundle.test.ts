import { describe, expect, it } from "vitest";
import type { ShadowSpecScenario } from "../src/load-scenarios";
import {
  computeExportId,
  createScenarioBundle,
  hashCaptureIds,
  ScenarioBundleError,
  validateScenarioBundle,
  type ScenarioBundle
} from "../src/scenario-bundle";

function scenarios(): ShadowSpecScenario[] {
  return [{
    id: 1,
    request: { method: "GET", path: "/health", body: null },
    expected: { status: 200, body: { status: "ok" } }
  }];
}

function bundle(): ScenarioBundle {
  return createScenarioBundle(
    {
      projectId: "project-one",
      isolation: "repeatable-read",
      maxVisibleCaptureId: 7,
      captureCount: 1,
      captureIdsSha256: hashCaptureIds([7])
    },
    {
      complete: true,
      executableCaptures: 1,
      rejectedCaptures: 0,
      excludedCaptures: 0,
      checkCount: 1,
      dispositions: [{
        captureId: 7,
        disposition: "EXECUTABLE_STANDALONE",
        method: "GET",
        safePath: "/health",
        scenarioId: 1,
        checkCount: 1
      }]
    },
    scenarios()
  );
}

function rehash(value: ScenarioBundle): ScenarioBundle {
  const { exportId: _ignored, ...semantic } = value;
  value.exportId = computeExportId(semantic);
  return value;
}

describe("version-2 scenario bundle validation", () => {
  it("accepts a reconciled content-addressed bundle", () => {
    expect(validateScenarioBundle(bundle(), "project-one"))
      .toEqual(bundle());
  });

  it("rejects raw scenario arrays", () => {
    expect(() => validateScenarioBundle(scenarios()))
      .toThrowError(ScenarioBundleError);
  });

  it("rejects modified semantic content with its old export ID", () => {
    const changed = structuredClone(bundle());
    changed.scenarios[0].expected.body = { status: "changed" };
    expect(() => validateScenarioBundle(changed))
      .toThrow("content hash is invalid");
  });

  it("rejects a malformed executable scenario even with a recomputed hash", () => {
    const changed = structuredClone(bundle());
    delete (changed.scenarios[0] as Partial<ShadowSpecScenario>).request;
    expect(() => validateScenarioBundle(rehash(changed)))
      .toThrow("Standalone scenario schema is invalid");
  });

  it("rejects incomplete coverage even when the content hash is valid", () => {
    const changed = structuredClone(bundle());
    changed.coverage.complete = false;
    expect(() => validateScenarioBundle(rehash(changed)))
      .toThrow("coverage is incomplete");
  });

  it("rejects a duplicate disposition", () => {
    const changed = structuredClone(bundle());
    changed.input.captureCount = 2;
    changed.coverage.executableCaptures = 2;
    changed.coverage.checkCount = 2;
    changed.coverage.dispositions.push({
      ...changed.coverage.dispositions[0]
    });
    expect(() => validateScenarioBundle(rehash(changed)))
      .toThrow("more than one terminal disposition");
  });

  it("rejects an unaccounted input capture", () => {
    const changed = structuredClone(bundle());
    changed.input.captureCount = 2;
    changed.input.captureIdsSha256 = hashCaptureIds([7, 9]);
    expect(() => validateScenarioBundle(rehash(changed)))
      .toThrow("accounting does not reconcile");
  });

  it("rejects a disposition mapped to a nonexistent check", () => {
    const changed = structuredClone(bundle());
    changed.coverage.dispositions[0].scenarioId = 2;
    expect(() => validateScenarioBundle(rehash(changed)))
      .toThrow("mapping does not match its scenario request");
  });

  it("rejects the wrong project identity", () => {
    expect(() => validateScenarioBundle(bundle(), "project-two"))
      .toThrow("different project");
  });

  it("hashes ordered capture identities rather than only count or maximum", () => {
    expect(hashCaptureIds([1, 4])).not.toBe(hashCaptureIds([2, 4]));
  });
});
