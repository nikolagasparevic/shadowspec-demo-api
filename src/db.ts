import { Pool } from "pg";

export const pool = new Pool({
  host:
    process.env.DB_HOST ||
    "localhost",

  port: Number(
    process.env.DB_PORT ||
    5432
  ),

  user:
    process.env.DB_USER ||
    "shadowspec",

  password:
    process.env.DB_PASSWORD ||
    "shadowspec123",

  database:
    process.env.DB_NAME ||
    "shadowspec"
});
