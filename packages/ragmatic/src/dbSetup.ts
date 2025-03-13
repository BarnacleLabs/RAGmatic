// @ts-ignore
import pg from "pg";
import { Config, DBClient } from "./types";
import {
  PREFIX,
  SHADOW_TABLE,
  CHUNK_TABLE,
  WORK_QUEUE_TABLE,
  RAGMATIC_SCHEMA_VERSION,
} from "./utils/constants";
import { sql } from "./utils/utils";
import { createLogger } from "./utils/logger";

/**
 * Sets up the database schema:
 * - Creates an isolated schema for this tracker instance
 * - Creates the shadow table with cascading deletes
 * - Creates the chunks table with cascading deletes
 * - Creates the work queue table
 * - Creates trigger functions and attaches triggers on the documents table
 * Expects 'id' in documents table to be the primary key.
 * Does idempotent schema and trigger setup.
 * Will not throw an error if the schema already exists.
 * Will not remove pre-processed chunks or shadows that should still exists (aka. if documents table has them).
 */
export async function setup(config: Config): Promise<void> {
  // Initialize logger
  const logger = createLogger({
    ...config.logger,
    service: "ragmatic-setup",
    trackerName: config.trackerName,
  });

  logger.info("Starting database setup", { trackerName: config.trackerName });

  const client =
    config.dbClient ||
    (new pg.Client({ connectionString: config.connectionString }) as DBClient);
  if (!config.dbClient && !config.connectionString) {
    const error = new Error(
      "Either dbClient or connectionString must be provided",
    );
    logger.error("Setup failed", { error: error.message });
    throw error;
  }

  // required config
  let documentsSchema = "public";
  let documentsTable = config.documentsTable;
  if (config.documentsTable.includes(".")) {
    documentsSchema = config.documentsTable.split(".")[0];
    documentsTable = config.documentsTable.split(".")[1];
  }
  documentsSchema = documentsSchema.replaceAll(/[^a-zA-Z0-9_]/g, "_");
  documentsTable = documentsTable.replaceAll(/[^a-zA-Z0-9_]/g, "_");
  const trackerName = config.trackerName.replaceAll(/[^a-zA-Z0-9_]/g, "_");
  const embeddingDimension = config.embeddingDimension
    .toString()
    .replaceAll(/[^0-9]/g, "");
  const schemaName = `${PREFIX}${trackerName}`;

  // optional overrides
  const shadowTable = `${schemaName}.${(config.shadowTable || SHADOW_TABLE).replaceAll(/[^a-zA-Z0-9_]/g, "_")}`;
  const chunksTable = `${schemaName}.${(config.chunksTable || CHUNK_TABLE).replaceAll(/[^a-zA-Z0-9_]/g, "_")}`;
  const docIdType = (config.docIdType || "INT").replaceAll(
    /[^a-zA-Z0-9_]/g,
    "_",
  );
  const skipEmbeddingIndexSetup = config.skipEmbeddingIndexSetup || false;

  logger.debug("Configuration prepared", {
    trackerName,
    documentsTable,
    schemaName,
    shadowTable,
    chunksTable,
    embeddingDimension,
    skipEmbeddingIndexSetup,
  });

  try {
    logger.debug("Connecting to database");
    await client.connect?.();

    await client.query(sql`BEGIN`);

    // Create vector extension in public schema
    logger.debug("Creating vector extension if not exists");
    await client.query(sql`CREATE EXTENSION IF NOT EXISTS vector`);

    // Create and use our isolated schema
    logger.debug("Creating schema", { schema: schemaName });
    await client.query(sql`CREATE SCHEMA IF NOT EXISTS ${schemaName}`);

    // Create config table
    await client.query(sql`
      CREATE TABLE IF NOT EXISTS ${schemaName}.config (
        id SERIAL PRIMARY KEY,
        key TEXT NOT NULL UNIQUE,
        value TEXT NOT NULL
      );
    `);

    // Save config for workers to use later
    await client.query(sql`
      INSERT INTO
        ${schemaName}.config (key, value)
      VALUES
        (
          'documentsSchema',
          '${documentsSchema}'
        ),
        (
          'documentsTable',
          '${documentsTable}'
        ),
        ('docIdType', '${docIdType}'),
        (
          'embeddingDimension',
          '${embeddingDimension}'
        ),
        (
          'shadowTable',
          '${shadowTable}'
        ),
        (
          'chunksTable',
          '${chunksTable}'
        ),
        (
          'ragmaticSchemaVersion',
          '${RAGMATIC_SCHEMA_VERSION}'
        )
      ON CONFLICT (key) DO UPDATE
      SET
        value = EXCLUDED.value;
    `);

    // Create shadow table in our schema
    // 1:1 with documents table
    await client.query(sql`
      CREATE TABLE IF NOT EXISTS ${shadowTable} (
        id SERIAL PRIMARY KEY,
        doc_id ${docIdType} NOT NULL,
        vector_clock BIGINT NOT NULL DEFAULT 1, -- At 1 billion increments per second, BIGINT lasts about 292 years.
        UNIQUE (doc_id),
        CONSTRAINT fk_documents_sync FOREIGN KEY (doc_id) REFERENCES ${documentsSchema}.${documentsTable} (id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
      );
    `);

    // Create indexes on shadow table for efficient polling
    await client.query(sql`
      CREATE INDEX IF NOT EXISTS idx_${schemaName}_${config.shadowTable ||
      SHADOW_TABLE}_vector_clock ON ${shadowTable} (vector_clock);
    `);

    // Create sync trigger function in our schema
    await client.query(sql`
      CREATE OR REPLACE FUNCTION ${schemaName}.sync_documents_to_shadow () RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'INSERT' THEN
          INSERT INTO ${shadowTable} (doc_id, vector_clock)
          VALUES (NEW.id, 1);

        -- Keep in mind this locks the document row for the duration of the update to the shadow table,
        -- so avoid locking the shadow table for too long otherwise this will cause a bottleneck!
        -- also do not update the shadow table outside of the library if you want to avoid deadlocks
        ELSIF TG_OP = 'UPDATE' THEN
          UPDATE ${shadowTable} SET vector_clock = vector_clock + 1 WHERE doc_id = NEW.id;
        END IF;

        RETURN NULL;
      END;
      $$;
    `);

    // Create sync trigger
    await client.query(sql`
      DROP TRIGGER IF EXISTS sync_${schemaName}_to_shadow ON ${documentsSchema}.${documentsTable};

      CREATE TRIGGER sync_${schemaName}_to_shadow
      AFTER INSERT
      OR
      UPDATE ON ${documentsSchema}.${documentsTable} FOR EACH ROW
      EXECUTE FUNCTION ${schemaName}.sync_documents_to_shadow ();
    `);

    // Create chunks table in our schema
    await client.query(sql`
      CREATE TABLE IF NOT EXISTS ${chunksTable} (
        id SERIAL PRIMARY KEY,
        doc_id ${docIdType} NOT NULL,
        vector_clock BIGINT NOT NULL DEFAULT 0,
        index INT NOT NULL,
        chunk_hash TEXT NOT NULL,
        chunk_text TEXT,
        chunk_blob BYTEA,
        chunk_json JSONB,
        embedding VECTOR (${embeddingDimension}) NOT NULL,
        CONSTRAINT fk_doc_chunks FOREIGN KEY (doc_id) REFERENCES ${documentsSchema}.${documentsTable} (id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
      );
    `);

    // Create indexes on chunks table for efficient polling
    await client.query(sql`
      CREATE INDEX IF NOT EXISTS idx_${schemaName}_${config.chunksTable ||
      CHUNK_TABLE}_doc_id ON ${chunksTable} (doc_id);
    `);

    await client.query(sql`
      CREATE INDEX IF NOT EXISTS idx_${schemaName}_${config.chunksTable ||
      CHUNK_TABLE}_chunk_hash ON ${chunksTable} (chunk_hash);
    `);

    await client.query(sql`
      CREATE INDEX IF NOT EXISTS idx_${schemaName}_${config.chunksTable ||
      CHUNK_TABLE}_vector_clock ON ${chunksTable} (vector_clock);
    `);

    // Create index on chunks table for efficient vector search
    // for options see: https://github.com/pgvector/pgvector?tab=readme-ov-file#indexing
    if (!skipEmbeddingIndexSetup) {
      logger.info("Creating HNSW index for vector similarity search", {
        table: chunksTable,
        embeddingDimension,
      });
      try {
        await client.query(sql`
          CREATE INDEX IF NOT EXISTS idx_${schemaName}_${config.chunksTable ||
          CHUNK_TABLE}_embedding ON ${chunksTable} USING hnsw (embedding vector_cosine_ops);
        `);
        logger.info("HNSW index created successfully");
      } catch (indexError) {
        logger.warn("Failed to create HNSW index", {
          error:
            indexError instanceof Error
              ? indexError.message
              : String(indexError),
          note: "This may be expected on certain PostgreSQL configurations. You can create the index manually later.",
        });
      }
    }

    // Create a work queue table
    await client.query(sql`
      CREATE TABLE IF NOT EXISTS ${schemaName}.${WORK_QUEUE_TABLE} (
        id SERIAL PRIMARY KEY,
        doc_id ${docIdType} NOT NULL,
        vector_clock BIGINT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', -- pending, processing, completed, failed, skipped
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        processing_started_at TIMESTAMP,
        completed_at TIMESTAMP,
        worker_id TEXT DEFAULT NULL,
        error TEXT DEFAULT NULL,
        retry_count INT NOT NULL DEFAULT 0,
        UNIQUE (doc_id, vector_clock)
        -- NOTE: deletes are not cascaded from documents table to the work queue, but we need to keep the constraint:
        -- UNIQUE (doc_id, vector_clock) and the monotonicity of the vector_clock at all times
        -- even if eg.: you drop the docs table, recreate the table, run setup again, and then re-insert the doc_id with a smaller vector_clock the second time
        -- will only work if queue rows are cleaned up first
      );
    `);

    // Create indexes on work queue table
    await client.query(sql`
      CREATE INDEX IF NOT EXISTS idx_${schemaName}_${WORK_QUEUE_TABLE}_status ON ${schemaName}.${WORK_QUEUE_TABLE} (status);
    `);

    await client.query(sql`
      CREATE INDEX IF NOT EXISTS idx_${schemaName}_${WORK_QUEUE_TABLE}_doc_id ON ${schemaName}.${WORK_QUEUE_TABLE} (doc_id);
    `);

    await client.query(sql`
      CREATE INDEX IF NOT EXISTS idx_${schemaName}_${WORK_QUEUE_TABLE}_vector_clock ON ${schemaName}.${WORK_QUEUE_TABLE} (vector_clock);
    `);

    // Index for stalled job detection
    await client.query(sql`
      CREATE INDEX IF NOT EXISTS idx_${schemaName}_${WORK_QUEUE_TABLE}_stalled_jobs ON ${schemaName}.${WORK_QUEUE_TABLE} (status, processing_started_at);
    `);

    // Composite index for vector clock updates on chunks
    await client.query(sql`
      CREATE INDEX IF NOT EXISTS idx_${schemaName}_${config.chunksTable ||
      CHUNK_TABLE}_doc_id_vector_clock ON ${chunksTable} (doc_id, vector_clock);
    `);

    // Index for finding latest jobs
    await client.query(sql`
      CREATE INDEX IF NOT EXISTS idx_${schemaName}_${WORK_QUEUE_TABLE}_doc_id_vector_clock ON ${schemaName}.${WORK_QUEUE_TABLE} (doc_id, vector_clock DESC);
    `);

    // Index for chunk ordering by index (frequently used for retrieving chunks in order)
    await client.query(sql`
      CREATE INDEX IF NOT EXISTS idx_${schemaName}_${config.chunksTable ||
      CHUNK_TABLE}_doc_id_index ON ${chunksTable} (doc_id, index);
    `);

    // House keeping, keep these last so triggers and cascades take effect:

    // Clean up orphaned rows if documents table was previously dropped and recreated:
    // The shadows, chunks rows are deleted by cascade delete on documents table rows
    // HOWEVER if the documents table was DROPped, these won't be deleted
    // so we need to clean up the orphaned rows here
    await client.query(sql`
      DELETE FROM ${chunksTable}
      WHERE
        doc_id NOT IN (
          SELECT
            id
          FROM
            ${documentsSchema}.${documentsTable}
        );
    `);
    await client.query(sql`
      DELETE FROM ${shadowTable}
      WHERE
        doc_id NOT IN (
          SELECT
            id
          FROM
            ${documentsSchema}.${documentsTable}
        );
    `);
    // also work queue rows need to be cleaned so that UNIQUE (doc_id, vector_clock) constraint is satisfied and vector_clock is monotonically increasing
    await client.query(sql` DELETE FROM ${schemaName}.${WORK_QUEUE_TABLE} `);

    // Backfill shadow table with existing documents
    await client.query(sql`
      INSERT INTO
        ${shadowTable} (doc_id)
      SELECT
        id
      FROM
        ${documentsSchema}.${documentsTable} d
      WHERE
        NOT EXISTS (
          SELECT
            1
          FROM
            ${shadowTable} s
          WHERE
            s.doc_id = d.id
        );
    `);

    await client.query(sql`COMMIT`);

    logger.info("Database setup complete", {
      trackerName,
      documentsTable,
      schemaName,
      shadowTable,
      chunksTable,
      embeddingDimension,
      chunkIndexesCreated: !skipEmbeddingIndexSetup,
    });

    // Return a sample search query for logs/debugging
    logger.debug("Sample search query", {
      query: `
        SELECT *, 1 - (embedding <=> '[0.1, 0.2, ...]'::vector) as similarity
        FROM ${chunksTable}
        ORDER BY similarity
        LIMIT 5;
      `,
    });
  } catch (err) {
    logger.error("Error during database setup", {
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
      trackerName,
      documentsTable,
      schemaName,
    });

    await client.query(sql`ROLLBACK`);
    throw err;
  } finally {
    logger.debug("Closing database connection");
    await client.end?.();
  }
}
