const MARKER = "<!-- shadowspec-report -->";

function parseMarkerMetadata(body) {
  const match = String(body ?? "").match(
    /<!-- shadowspec-run id=([^\s]+) head=([^\s]+) workflow-run=([^\s]+) attempt=(\d+) -->/
  );
  return match
    ? {
        runId: match[1],
        head: match[2],
        workflowRunId: match[3],
        runAttempt: Number(match[4])
      }
    : undefined;
}

async function currentRunMayUpdate({ github, context, identity }) {
  const pull = await github.rest.pulls.get({
    owner: context.repo.owner,
    repo: context.repo.repo,
    pull_number: context.issue.number
  });
  if (pull.data.head.sha !== identity.sourceHeadSha) {
    return false;
  }

  if (!identity.workflowRunId) {
    return true;
  }

  const runs = await github.rest.actions.listWorkflowRunsForRepo({
    owner: context.repo.owner,
    repo: context.repo.repo,
    event: "pull_request",
    per_page: 100
  });
  const matching = runs.data.workflow_runs
    .filter((run) =>
      run.name === context.workflow &&
      (
        run.head_sha === identity.sourceHeadSha ||
        run.pull_requests?.some(
          (pullRequest) =>
            pullRequest.head?.sha === identity.sourceHeadSha
        )
      )
    )
    .sort((left, right) =>
      Date.parse(right.run_started_at ?? right.created_at) -
      Date.parse(left.run_started_at ?? left.created_at)
    );
  return matching.length === 0 ||
    String(matching[0].id) === String(identity.workflowRunId);
}

async function updateShadowSpecComment({
  github,
  context,
  identity,
  body,
  logger = console
}) {
  if (!identity.sourceHeadSha) {
    logger.log("ShadowSpec comment skipped because no PR head identity is available.");
    return { updated: false, reason: "missing_head" };
  }
  if (!(await currentRunMayUpdate({ github, context, identity }))) {
    logger.log("ShadowSpec comment skipped because this is not the current PR run.");
    return { updated: false, reason: "stale_run" };
  }

  const comments = github.paginate
    ? await github.paginate(github.rest.issues.listComments, {
        owner: context.repo.owner,
        repo: context.repo.repo,
        issue_number: context.issue.number,
        per_page: 100
      })
    : (await github.rest.issues.listComments({
        owner: context.repo.owner,
        repo: context.repo.repo,
        issue_number: context.issue.number,
        per_page: 100
      })).data;
  const existing = comments.find((comment) =>
    comment.user?.type === "Bot" && comment.body?.includes(MARKER)
  );
  const existingMetadata = parseMarkerMetadata(existing?.body);

  if (
    existingMetadata &&
    existingMetadata.head === identity.sourceHeadSha &&
    existingMetadata.workflowRunId !== String(identity.workflowRunId) &&
    !(await currentRunMayUpdate({ github, context, identity }))
  ) {
    logger.log("ShadowSpec comment skipped because a newer run already owns it.");
    return { updated: false, reason: "newer_comment" };
  }

  // Recheck immediately before the write. GitHub issue comments do not offer
  // a compare-and-swap update, so the authoritative merge signal remains the job.
  if (!(await currentRunMayUpdate({ github, context, identity }))) {
    logger.log("ShadowSpec comment skipped after the final PR-head/run recheck.");
    return { updated: false, reason: "stale_recheck" };
  }

  if (existing) {
    await github.rest.issues.updateComment({
      owner: context.repo.owner,
      repo: context.repo.repo,
      comment_id: existing.id,
      body
    });
  } else {
    await github.rest.issues.createComment({
      owner: context.repo.owner,
      repo: context.repo.repo,
      issue_number: context.issue.number,
      body
    });
  }
  return { updated: true };
}

module.exports = {
  parseMarkerMetadata,
  updateShadowSpecComment
};
