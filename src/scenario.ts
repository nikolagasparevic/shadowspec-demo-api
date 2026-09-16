import { pool } from "./db";

export type ScenarioGroup = {
  method: string;
  path: string;
  requestBody: any;
  responses: {
    body: any;
    status: number;
    snapshot?: any;
  }[];
};

export async function getScenarioGroups(): Promise<ScenarioGroup[]> {
  const result = await pool.query(
    `SELECT
       r.method,
       r.path,
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

  const groups = new Map<string, ScenarioGroup>();

  for (const row of result.rows) {
    const key = `${row.method}:${row.path}:${JSON.stringify(
      row.request_body
    )}`;

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
      method: row.method,
      path: row.path,
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