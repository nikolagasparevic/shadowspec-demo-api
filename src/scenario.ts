import { pool } from "./db";

export type ScenarioGroup = {
  method: string;
  path: string;
  requestBody: any;
  responses: {
    body: any;
    status: number;
  }[];
};

export async function getScenarioGroups(): Promise<ScenarioGroup[]> {
  const result = await pool.query(
    `SELECT
       method,
       path,
       request_body,
       response_body,
       response_status
     FROM api_requests
     WHERE active = TRUE
     ORDER BY id ASC`
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
        status: row.response_status
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
          status: row.response_status
        }
      ]
    });
  }

  return Array.from(groups.values());
}