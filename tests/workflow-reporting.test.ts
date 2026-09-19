import fs from "node:fs";
import {
  describe,
  expect,
  it
} from "vitest";

const workflow = fs.readFileSync(
  ".github/workflows/shadowspec.yml",
  "utf8"
);

describe("ShadowSpec workflow reporting", () => {
  it("uses correlated concurrency and cancels older PR work", () => {
    expect(workflow).toContain(
      "group: shadowspec-${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}"
    );
    expect(workflow).toContain("cancel-in-progress: true");
  });

  it("always finalizes and uploads a unique required artifact", () => {
    expect(workflow).toMatch(
      /name: Finalize ShadowSpec run result[\s\S]*?if: always\(\)/
    );
    expect(workflow).toContain(
      "name: shadowspec-run-${{ github.run_id }}-${{ github.run_attempt }}"
    );
    expect(workflow).toContain("if-no-files-found: error");
  });

  it("enforces validated passed status and artifact publication", () => {
    expect(workflow).toContain(
      'if [ "$FINALIZER_OUTCOME" != "success" ]'
    );
    expect(workflow).toContain(
      'if [ "$ARTIFACT_OUTCOME" != "success" ]'
    );
    expect(workflow).toContain(
      'if [ "$TERMINAL_STATUS" != "passed" ]'
    );
  });

  it("keeps comment availability outside exit enforcement", () => {
    const enforcement = workflow.slice(
      workflow.indexOf("- name: Enforce ShadowSpec result")
    );
    expect(enforcement).not.toContain("COMMENT_OUTCOME");
    expect(workflow).toMatch(
      /name: Comment ShadowSpec result on PR[\s\S]*?continue-on-error: true/
    );
  });
});
