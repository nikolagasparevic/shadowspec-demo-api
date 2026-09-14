import { pool } from "./db";
import { fingerprint } from "./fingerprint";

export async function getScenarios() {
  const result = await pool.query(
    `SELECT method, path, request_body, response_body, response_status
     FROM api_requests
     WHERE active = TRUE
     ORDER BY id ASC`
  );

  const uniqueScenarios = new Map();

  for (const scenario of result.rows) {
    const key = `${scenario.method}:${scenario.path}:${JSON.stringify(
      scenario.request_body
    )}`;

    if (!uniqueScenarios.has(key)) {
      uniqueScenarios.set(key, scenario);
    }
  }

  return Array.from(uniqueScenarios.values());
}