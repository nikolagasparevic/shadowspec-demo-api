import {
  describe,
  expect,
  it,
  vi
} from "vitest";

const {
  parseMarkerMetadata,
  updateShadowSpecComment
}: {
  parseMarkerMetadata: (body: string) => {
    runId: string;
    head: string;
    workflowRunId: string;
    runAttempt: number;
  } | undefined;
  updateShadowSpecComment: (options: any) => Promise<{
    updated: boolean;
    reason?: string;
  }>;
} = require(
  "../.github/scripts/update-shadowspec-comment.cjs"
);

const identity = {
  runId: "123.1.replay",
  repository: "example/shadowspec",
  commitSha: "merge-sha",
  sourceHeadSha: "head-sha",
  workflowRunId: "123",
  runAttempt: 1
};
const context = {
  repo: { owner: "example", repo: "shadowspec" },
  issue: { number: 4 },
  workflow: "ShadowSpec"
};

function github(options: {
  head?: string;
  latestRun?: string;
  comments?: any[];
  updateFails?: boolean;
} = {}) {
  const updateComment = vi.fn(async () => {
    if (options.updateFails) {
      throw new Error("GitHub unavailable");
    }
  });
  const createComment = vi.fn(async () => undefined);
  return {
    rest: {
      pulls: {
        get: vi.fn(async () => ({
          data: { head: { sha: options.head ?? "head-sha" } }
        }))
      },
      actions: {
        listWorkflowRunsForRepo: vi.fn(async () => ({
          data: {
            workflow_runs: [{
              id: Number(options.latestRun ?? "123"),
              name: "ShadowSpec",
              head_sha: "synthetic-merge-sha",
              pull_requests: [{
                head: { sha: "head-sha" }
              }],
              run_started_at: "2026-01-01T00:00:00Z",
              created_at: "2026-01-01T00:00:00Z"
            }]
          }
        }))
      },
      issues: {
        listComments: vi.fn(),
        updateComment,
        createComment
      }
    },
    paginate: vi.fn(async () => options.comments ?? []),
    updateComment,
    createComment
  };
}

describe("ShadowSpec PR comment race guard", () => {
  it("parses correlated marker metadata", () => {
    expect(parseMarkerMetadata(
      "<!-- shadowspec-run id=123.1.replay head=head-sha workflow-run=123 attempt=1 -->"
    )).toEqual({
      runId: "123.1.replay",
      head: "head-sha",
      workflowRunId: "123",
      runAttempt: 1
    });
  });

  it("refuses an update after the PR head changes", async () => {
    const api = github({ head: "newer-head" });
    const result = await updateShadowSpecComment({
      github: api,
      context,
      identity,
      body: "current"
    });
    expect(result).toEqual({
      updated: false,
      reason: "stale_run"
    });
    expect(api.updateComment).not.toHaveBeenCalled();
    expect(api.createComment).not.toHaveBeenCalled();
  });

  it("refuses an older run for the same head", async () => {
    const api = github({ latestRun: "124" });
    const result = await updateShadowSpecComment({
      github: api,
      context,
      identity,
      body: "old"
    });
    expect(result.updated).toBe(false);
    expect(api.updateComment).not.toHaveBeenCalled();
  });

  it("orders PR runs by source head even when their head_sha is synthetic", async () => {
    const api = github({ latestRun: "124" });
    await updateShadowSpecComment({
      github: api,
      context,
      identity,
      body: "old"
    });
    expect(
      api.rest.actions.listWorkflowRunsForRepo
    ).toHaveBeenCalledWith(expect.not.objectContaining({
      head_sha: expect.anything()
    }));
    expect(api.updateComment).not.toHaveBeenCalled();
  });

  it("updates the marker comment for the current authoritative run", async () => {
    const api = github({
      comments: [{
        id: 9,
        user: { type: "Bot" },
        body: "<!-- shadowspec-report -->\nold"
      }]
    });
    const result = await updateShadowSpecComment({
      github: api,
      context,
      identity,
      body: "current"
    });
    expect(result.updated).toBe(true);
    expect(api.updateComment).toHaveBeenCalledWith(
      expect.objectContaining({ comment_id: 9, body: "current" })
    );
  });

  it("leaves comment API failure visible to the caller", async () => {
    const api = github({
      updateFails: true,
      comments: [{
        id: 9,
        user: { type: "Bot" },
        body: "<!-- shadowspec-report -->\nold"
      }]
    });
    await expect(updateShadowSpecComment({
      github: api,
      context,
      identity,
      body: "current"
    })).rejects.toThrow("GitHub unavailable");
  });
});
