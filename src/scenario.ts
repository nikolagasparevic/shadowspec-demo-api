import { pool } from "./db";
import { canonicalStringify } from "./canonical";
import type {
  CapturedRequest,
  ScenarioGroup,
  ScenarioSequence
} from "./scenario-types";

export type {
  CapturedRequest,
  ScenarioGroup,
  ScenarioSequence
} from "./scenario-types";

export async function getScenarioGroups(): Promise<
  ScenarioGroup[]
> {
  const result = await pool.query(
    `SELECT
       r.id,
       r.method,
       r.path,
       r.path_params,
       r.query_params,
       r.request_body,
       r.response_body,
       r.response_status,
       s.snapshot
     FROM api_requests r
     LEFT JOIN api_request_snapshots s
       ON s.api_request_id = r.id
     WHERE r.active = TRUE
       AND r.session_id IS NULL
     ORDER BY r.id ASC`
  );

  const groups = new Map<
    string,
    ScenarioGroup
  >();

  for (const row of result.rows) {
    const pathParams =
      row.path_params ?? {};

    const queryParams =
      row.query_params ?? {};

    const key = [
      row.method,
      row.path,
      canonicalStringify(pathParams),
      canonicalStringify(queryParams),
      canonicalStringify(row.request_body)
    ].join(":");

    const existing = groups.get(key);

    if (existing) {
      existing.responses.push({
        body: row.response_body,
        status: row.response_status,
        snapshot: row.snapshot
      });

      continue;
    }

    groups.set(key, {
      id: row.id,
      method: row.method,
      path: row.path,
      pathParams,
      queryParams,
      requestBody: row.request_body,
      responses: [
        {
          body: row.response_body,
          status: row.response_status,
          snapshot: row.snapshot
        }
      ]
    });
  }

  return Array.from(groups.values());
}

export async function getCapturedRequests(): Promise<
  CapturedRequest[]
> {
  const result = await pool.query(
    `SELECT
       r.id,
       r.session_id,
       r.method,
       r.path,
       r.path_params,
       r.query_params,
       r.request_body,
       r.response_body,
       r.response_status,
       s.snapshot
     FROM api_requests r
     LEFT JOIN api_request_snapshots s
       ON s.api_request_id = r.id
     WHERE r.active = TRUE
     ORDER BY r.id ASC`
  );

  return result.rows.map((row) => ({
    id: row.id,
    sessionId:
      row.session_id ?? undefined,
    method: row.method,
    path: row.path,
    pathParams:
      row.path_params ?? {},
    queryParams:
      row.query_params ?? {},
    requestBody:
      row.request_body,
    responseBody:
      row.response_body,
    responseStatus:
      row.response_status,
    snapshot:
      row.snapshot
  }));
}

export function buildScenarioSequences(
  requests: CapturedRequest[]
): ScenarioSequence[] {
  const sequences = new Map<
    string,
    CapturedRequest[]
  >();

  for (const request of requests) {
    if (!request.sessionId) {
      continue;
    }

    const existing =
      sequences.get(request.sessionId) ?? [];

    existing.push(request);

    sequences.set(
      request.sessionId,
      existing
    );
  }

  return Array.from(
    sequences.entries()
  ).map(
    ([sessionId, requests]) => ({
      sessionId,
      requests
    })
  );
}