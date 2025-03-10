// @ts-ignore
import pg from "pg";
import { DBClient } from "./types";
import { PREFIX, SHADOW_TABLE, WORK_QUEUE_TABLE } from "./utils/constants";
import { sql } from "./utils/utils";

/**
 * Interface representing a tracker's configuration
 */
export interface TrackerConfig {
  trackerName: string;
  documentsTable: string;
  embeddingDimension: number;
  shadowTable: string;
  chunksTable: string;
  docIdType: string;
  createdAt?: Date;
}

/**
 * Get the configuration of a tracker
 */
export async function getTrackerConfig(
  connectionStringOrClient: string | DBClient,
  trackerName: string,
): Promise<TrackerConfig> {
  const client =
    typeof connectionStringOrClient === "string"
      ? (new pg.Client({
          connectionString: connectionStringOrClient,
        }) as DBClient)
      : connectionStringOrClient;
  const ownClient = typeof connectionStringOrClient === "string";

  try {
    if (ownClient) {
      await client.connect();
    }

    // Sanitize tracker name for SQL injection prevention
    const sanitizedTrackerName = trackerName.replaceAll(/[^a-zA-Z0-9_]/g, "_");
    const schemaName = `${PREFIX}${sanitizedTrackerName}`;

    // Check if the schema exists using non-parameterized query
    // This is safe since we sanitized the input
    const schemaQuery = `
      SELECT schema_name
      FROM information_schema.schemata
      WHERE schema_name = '${schemaName}';
    `;
    const schemaCheckResult = await client.query(schemaQuery);

    if (schemaCheckResult.rows.length === 0) {
      throw new Error(`Tracker "${trackerName}" not found`);
    }

    // Query the config table using non-parameterized query for the schema
    const configQuery = `
      SELECT key, value
      FROM "${schemaName}".config;
    `;
    const configResult = await client.query(configQuery);

    if (configResult.rows.length === 0) {
      throw new Error(`Configuration for tracker "${trackerName}" not found`);
    }

    // Create config object from results
    const config: Record<string, string> = {};
    configResult.rows.forEach((row: { key: string; value: string }) => {
      config[row.key] = row.value;
    });

    return {
      trackerName: sanitizedTrackerName,
      documentsTable: config.documentsTable || "",
      embeddingDimension: parseInt(config.embeddingDimension || "0", 10),
      shadowTable: config.shadowTable || "",
      chunksTable: config.chunksTable || "",
      docIdType: config.docIdType || "INT",
    };
  } catch (error) {
    throw error;
  } finally {
    if (ownClient) {
      await client.end();
    }
  }
}

/**
 * Count the number of documents that still need to be processed
 */
export async function countRemainingDocuments(
  connectionStringOrClient: string | DBClient,
  trackerName: string,
): Promise<number> {
  const client =
    typeof connectionStringOrClient === "string"
      ? (new pg.Client({
          connectionString: connectionStringOrClient,
        }) as DBClient)
      : connectionStringOrClient;
  const ownClient = typeof connectionStringOrClient === "string";

  try {
    if (ownClient) {
      await client.connect();
    }

    // Sanitize tracker name for SQL injection prevention
    const sanitizedTrackerName = trackerName.replaceAll(/[^a-zA-Z0-9_]/g, "_");
    const schemaName = `${PREFIX}${sanitizedTrackerName}`;

    // Check if the schema exists
    const schemaQuery = `
      SELECT schema_name
      FROM information_schema.schemata
      WHERE schema_name = '${schemaName}';
    `;
    const schemaCheckResult = await client.query(schemaQuery);

    if (schemaCheckResult.rows.length === 0) {
      throw new Error(`Tracker "${trackerName}" not found`);
    }

    // Count pending jobs in the work queue
    const countPendingJobsQuery = `
      SELECT COUNT(*) as count
      FROM ${schemaName}.${WORK_QUEUE_TABLE}
      WHERE status = 'pending';
    `;
    const countWorkQueueResult = await client.query(countPendingJobsQuery);

    // Get counts from work queue and return total
    return parseInt(countWorkQueueResult.rows[0].count, 10);
  } catch (error) {
    throw error;
  } finally {
    if (ownClient) {
      await client.end();
    }
  }
}

/**
 * Mark all documents in a tracker for reprocessing
 */
export async function reprocessDocuments(
  connectionStringOrClient: string | DBClient,
  trackerName: string,
): Promise<void> {
  const client =
    typeof connectionStringOrClient === "string"
      ? (new pg.Client({
          connectionString: connectionStringOrClient,
        }) as DBClient)
      : connectionStringOrClient;
  const ownClient = typeof connectionStringOrClient === "string";

  try {
    if (ownClient) {
      await client.connect();
    }

    // Sanitize tracker name for SQL injection prevention
    const sanitizedTrackerName = trackerName.replaceAll(/[^a-zA-Z0-9_]/g, "_");
    const schemaName = `${PREFIX}${sanitizedTrackerName}`;

    // Check if the schema exists
    const schemaQuery = `
      SELECT schema_name
      FROM information_schema.schemata
      WHERE schema_name = '${schemaName}';
    `;
    const schemaCheckResult = await client.query(schemaQuery);

    if (schemaCheckResult.rows.length === 0) {
      throw new Error(`Tracker "${trackerName}" not found`);
    }

    // Get the configuration
    const config = await getTrackerConfig(client, trackerName);
    const documentsTable = config.documentsTable;

    await client.query("BEGIN");

    // Get the shadow table name
    const shadowTable = config.shadowTable;

    // Get all document IDs
    const docIdsQuery = `
      SELECT id FROM ${documentsTable}
    `;
    const docIdsResult = await client.query(docIdsQuery);

    // Increment vector clock for all documents
    for (const doc of docIdsResult.rows) {
      const incQuery = `
        UPDATE ${shadowTable}
        SET vector_clock = vector_clock + 1
        WHERE doc_id = ${doc.id};
      `;
      await client.query(incQuery);
    }

    // Make sure all documents are in the shadow table with incremented vector clock
    const insertQuery = `
      INSERT INTO ${shadowTable} (doc_id, vector_clock)
      SELECT id, 1
      FROM ${documentsTable} d
      WHERE NOT EXISTS (
        SELECT 1
        FROM ${shadowTable} s
        WHERE s.doc_id = d.id
      );
    `;
    await client.query(insertQuery);

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    if (ownClient) {
      await client.end();
    }
  }
}

/**
 * Destroy a tracker (drops the schema)
 */
export async function destroyTracker(
  connectionStringOrClient: string | DBClient,
  trackerName: string,
): Promise<void> {
  const client =
    typeof connectionStringOrClient === "string"
      ? (new pg.Client({
          connectionString: connectionStringOrClient,
        }) as DBClient)
      : connectionStringOrClient;
  const ownClient = typeof connectionStringOrClient === "string";

  try {
    if (ownClient) {
      await client.connect();
    }

    // Sanitize tracker name for SQL injection prevention
    const sanitizedTrackerName = trackerName.replaceAll(/[^a-zA-Z0-9_]/g, "_");
    const schemaName = `${PREFIX}${sanitizedTrackerName}`;

    // Check if the schema exists
    const schemaQuery = `
      SELECT schema_name
      FROM information_schema.schemata
      WHERE schema_name = '${schemaName}';
    `;
    const schemaCheckResult = await client.query(schemaQuery);

    if (schemaCheckResult.rows.length === 0) {
      throw new Error(`Tracker "${trackerName}" not found`);
    }

    // Get the document table name
    const configQuery = `
      SELECT value
      FROM "${schemaName}".config
      WHERE key = 'documentsTable';
    `;
    const configResult = await client.query(configQuery);

    if (configResult.rows.length === 0) {
      throw new Error(
        `Documents table configuration for tracker "${trackerName}" not found`,
      );
    }

    const documentsTable = configResult.rows[0].value;

    await client.query("BEGIN");

    // Drop the trigger on the documents table
    const dropTriggerQuery = `
      DROP TRIGGER IF EXISTS sync_${schemaName}_to_shadow ON ${documentsTable};
    `;
    await client.query(dropTriggerQuery);

    // Drop the schema (cascades to all tables and functions)
    const dropSchemaQuery = `
      DROP SCHEMA "${schemaName}" CASCADE;
    `;
    await client.query(dropSchemaQuery);

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    if (ownClient) {
      await client.end();
    }
  }
}
