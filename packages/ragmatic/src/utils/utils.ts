// @ts-ignore
import pg from "pg";
import { PREFIX } from "./constants";

export async function cleanupDatabase(client: pg.Client): Promise<void> {
  try {
    // find all schemas starting with prefix
    const schemas = await client.query(`
      SELECT nspname FROM pg_namespace WHERE nspname LIKE '${PREFIX}%'
    `);

    // find all public tables
    const tables = await client.query(`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public';
    `);

    // Drop all schemas
    for (const schema of schemas.rows) {
      await client.query(`DROP SCHEMA IF EXISTS ${schema.nspname} CASCADE;`);
    }

    // Drop all tables
    for (const table of tables.rows) {
      await client.query(`DROP TABLE IF EXISTS ${table.tablename} CASCADE;`);
    }
  } catch (error) {
    console.error("Error during database cleanup:", error);
    throw error;
  }
}

export async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// No-op function to make prettier happy
export const sql = (strings: TemplateStringsArray, ...values: any[]): string =>
  strings.reduce((acc, str, i) => acc + str + (values[i] ?? ""), "");
