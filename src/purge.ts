import { pool } from "./db";

type PurgePreview = {
    captures: number;
    snapshots: number;
};

export class PurgeError extends Error {
    readonly name = "PurgeError";

    constructor(
        readonly code:
            | "PURGE_ARGUMENT_INVALID"
            | "PURGE_QUERY_FAILED",
        message: string
    ) {
        super(message);
    }
}

function assertPositiveInteger(value: number): void {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new PurgeError(
            "PURGE_ARGUMENT_INVALID",
            "--older-than-days must be a positive integer."
        );
    }
}

function eligibilityCte(): string {
    return `
    WITH eligible AS (
      SELECT r.id
      FROM api_requests r
      WHERE r.created_at <
        LOCALTIMESTAMP - ($1::integer * INTERVAL '1 day')
        AND (
          r.session_id IS NULL
          OR NOT EXISTS (
            SELECT 1
            FROM api_requests newer
            WHERE newer.session_id = r.session_id
              AND newer.created_at >=
                LOCALTIMESTAMP - ($1::integer * INTERVAL '1 day')
          )
        )
    )
  `;
}

export async function previewPurge(
    olderThanDays: number
): Promise<PurgePreview> {
    assertPositiveInteger(olderThanDays);

    try {
        const result = await pool.query<{
            captures: string;
            snapshots: string;
        }>(
            `${eligibilityCte()}
       SELECT
         COUNT(*)::text AS captures,
         (
           SELECT COUNT(*)::text
           FROM api_request_snapshots s
           WHERE s.api_request_id IN (
             SELECT id FROM eligible
           )
         ) AS snapshots
       FROM eligible`,
            [olderThanDays]
        );

        return {
            captures: Number(result.rows[0]?.captures ?? 0),
            snapshots: Number(result.rows[0]?.snapshots ?? 0)
        };
    } catch {
        throw new PurgeError(
            "PURGE_QUERY_FAILED",
            "ShadowSpec could not calculate purge eligibility."
        );
    }
}

export async function executePurge(
    olderThanDays: number
): Promise<number> {
    assertPositiveInteger(olderThanDays);

    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        await client.query(
            "LOCK TABLE api_requests IN SHARE ROW EXCLUSIVE MODE"
        );

        const result = await client.query(
            `${eligibilityCte()}
       DELETE FROM api_requests r
       USING eligible e
       WHERE r.id = e.id`,
            [olderThanDays]
        );

        await client.query("COMMIT");

        return result.rowCount ?? 0;
    } catch {
        try {
            await client.query("ROLLBACK");
        } catch {
            // Preserve the original purge failure.
        }

        throw new PurgeError(
            "PURGE_QUERY_FAILED",
            "ShadowSpec purge failed."
        );
    } finally {
        client.release();
    }
}

export async function runPurgeCli(
    args: readonly string[] = process.argv.slice(3)
): Promise<void> {
    const olderThanIndex = args.indexOf("--older-than-days");

    if (
        olderThanIndex === -1 ||
        olderThanIndex + 1 >= args.length
    ) {
        throw new PurgeError(
            "PURGE_ARGUMENT_INVALID",
            "Usage: shadowspec purge --older-than-days <days> [--yes]"
        );
    }

    const olderThanDays = Number(
        args[olderThanIndex + 1]
    );

    assertPositiveInteger(olderThanDays);

    const confirm = args.includes("--yes");

    const preview = await previewPurge(
        olderThanDays
    );

    console.log("ShadowSpec Purge");
    console.log("================");
    console.log(`Captures eligible:  ${preview.captures}`);
    console.log(`Snapshots eligible: ${preview.snapshots}`);

    if (!confirm) {
        console.log("");
        console.log("Dry run only. No data was deleted.");
        console.log(
            "Run again with --yes to delete the eligible captures."
        );
        return;
    }

    const deleted = await executePurge(
        olderThanDays
    );

    console.log("");
    console.log(`Deleted captures: ${deleted}`);
}