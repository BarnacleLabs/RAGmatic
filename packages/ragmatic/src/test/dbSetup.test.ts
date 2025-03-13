import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from "vitest";
// @ts-ignore
import pg from "pg";
import { setup } from "../dbSetup";
import { Config } from "../types";
import { PREFIX } from "../utils/constants";
import { cleanupDatabase } from "../utils/utils";

interface QueryRow {
  column_name: string;
  id?: number;
  content?: string;
  vector_clock?: string;
  doc_id?: number;
  index?: number;
  updated_at?: Date;
  indexname?: string;
}

interface ConfigRow {
  key: string;
  value: string;
}

const config: Config = {
  connectionString: "postgresql://test:test@localhost:5432/ragmatic_test",
  documentsTable: "documents",
  trackerName: "test",
  embeddingDimension: 1536,
};

let client: pg.Client;
const schemaName = `${PREFIX}${config.trackerName}`;

describe("Development Environment Setup", () => {
  let client: pg.Client;

  beforeEach(async () => {
    client = new pg.Client({ connectionString: config.connectionString });
    await client.connect();
  });

  afterEach(async () => {
    await client.end();
  });

  it("database connection works", async () => {
    try {
      const result = await client.query("SELECT 1 as one");
      expect(result.rows[0].one).toBe(1);
    } finally {
      await client.end();
    }
  });

  it("pgvector extension can be created", async () => {
    try {
      await client.query("CREATE EXTENSION IF NOT EXISTS vector");
      const result = await client.query(`
        SELECT EXISTS (
          SELECT 1 
          FROM pg_extension 
          WHERE extname = 'vector'
        );
      `);
      expect(result.rows[0].exists).toBe(true);
    } finally {
      await client.end();
    }
  });

  it("database cleanupDatabase works", async () => {
    try {
      // Create a test table
      await client.query(`
        CREATE TABLE IF NOT EXISTS test_table (
          id serial PRIMARY KEY,
          name text
        );
      `);

      // Verify table exists
      let result = await client.query(`
        SELECT EXISTS (
          SELECT 1 
          FROM pg_tables 
          WHERE tablename = 'test_table'
        );
      `);
      expect(result.rows[0].exists).toBe(true);

      // Clean up database
      await cleanupDatabase(client);

      // verify database has no new tables
      result = await client.query(`
        SELECT COUNT(*) FROM pg_tables;
      `);
      expect(Number(result.rows[0].count)).toBe(68); // 68 tables in the database by default
    } finally {
      await client.end();
    }
  });
});

describe("Database Setup Module", () => {
  beforeAll(async () => {
    client = new pg.Client({ connectionString: config.connectionString });
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
  });

  beforeEach(async () => {
    // Create a minimal "documents" table required by our triggers.
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${config.documentsTable} (
        id SERIAL PRIMARY KEY,
        content TEXT NOT NULL,
        updated_at TIMESTAMP NOT NULL
      );
    `);

    // Run our setup function to create shadow & chunks tables and triggers.
    await setup(config);
  });

  afterEach(async () => {
    await cleanupDatabase(client);
  });

  it("should be idempotent", async () => {
    await setup(config);
    await setup(config);
  });

  it("should be able to track a table in a non-public schema", async () => {
    try {
      await client.query(`CREATE SCHEMA IF NOT EXISTS private;`);
      await client.query(`
        CREATE TABLE IF NOT EXISTS private.documents_b (
          id SERIAL PRIMARY KEY,
          content TEXT NOT NULL,
          updated_at TIMESTAMP NOT NULL
        );
      `);
      await client.query(`
        INSERT INTO private.documents_b (id, content, updated_at)
        VALUES (1, 'test content', NOW());
      `);
      await setup({
        ...config,
        documentsTable: "private.documents_b",
        trackerName: "private",
      });
      const res = await client.query<QueryRow>(`
        SELECT * FROM ragmatic_private.shadows;
      `);
      expect(res.rows.length).toBe(1);
      expect(res.rows[0].doc_id).toBe(1);
    } finally {
      await client.query(`DROP SCHEMA IF EXISTS private CASCADE;`);
    }
  });

  it("should create the shadow table with the correct columns and indexes and ON DELETE CASCADE", async () => {
    const res = await client.query<QueryRow>(
      `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2;
    `,
      [schemaName, "shadows"],
    );

    const columns = res.rows.map((row: QueryRow) => row.column_name);
    expect(columns).toEqual(
      expect.arrayContaining(["id", "doc_id", "vector_clock"]),
    );

    // check indexes
    const indexes = await client.query<QueryRow>(
      `
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = $1 AND tablename = $2;
    `,
      [schemaName, "shadows"],
    );
    expect(indexes.rows.length).toBe(3);
    expect(indexes.rows.map((row: QueryRow) => row.indexname)).toEqual(
      expect.arrayContaining([
        "shadows_pkey",
        "shadows_doc_id_key",
        `idx_${schemaName}_shadows_vector_clock`,
      ]),
    );

    // test delete is cascading
    // insert a document
    const now = new Date();
    await client.query(
      `
      INSERT INTO ${config.documentsTable} (content, updated_at)
    VALUES('test content', $1)
      `,
      [now],
    );

    // verify the document is inserted
    const docRes = await client.query<QueryRow>(`
    SELECT * FROM ${config.documentsTable} WHERE id = 1
      `);
    expect(docRes.rows.length).toBe(1);
    expect(docRes.rows[0].content).toBe("test content");

    // verify the shadow record is inserted
    const shadowRes = await client.query<QueryRow>(`
    SELECT * FROM ${schemaName}.shadows WHERE doc_id = 1
      `);
    expect(shadowRes.rows.length).toBe(1);
    expect(shadowRes.rows[0].doc_id).toBe(1);

    // delete the document
    await client.query(`
      DELETE FROM ${config.documentsTable} WHERE id = 1
      `);

    // verify the shadow record is deleted
    const shadowRes2 = await client.query<QueryRow>(`
    SELECT * FROM ${schemaName}.shadows WHERE doc_id = 1
      `);
    expect(shadowRes2.rows.length).toBe(0);
  });

  it("should create the chunks table with the correct columns and cascade on delete", async () => {
    const res = await client.query<QueryRow>(
      `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2;
    `,
      [schemaName, "chunks"],
    );

    const columns = res.rows.map((row: QueryRow) => row.column_name);
    expect(columns).toEqual(
      expect.arrayContaining([
        "id",
        "doc_id",
        "index",
        "chunk_hash",
        "chunk_text",
        "chunk_blob",
        "chunk_json",
        "embedding",
      ]),
    );

    // Check the indexes on chunks table
    const indexes = await client.query<QueryRow>(
      `
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = $1 AND tablename = $2;
    `,
      [schemaName, "chunks"],
    );

    const indexNames = indexes.rows.map((row: QueryRow) => row.indexname);

    // Check for the new indexes we added
    expect(indexNames).toContain(
      `idx_${schemaName}_chunks_doc_id_vector_clock`,
    );
    expect(indexNames).toContain(`idx_${schemaName}_chunks_doc_id_index`);

    // test delete is cascading
    // insert a document
    const now = new Date();
    await client.query(
      `
      INSERT INTO ${config.documentsTable} (content, updated_at)
    VALUES('test content', $1)
      `,
      [now],
    );

    // verify the document is inserted
    const docRes = await client.query<QueryRow>(`
    SELECT * FROM ${config.documentsTable} WHERE id = 1
      `);
    expect(docRes.rows.length).toBe(1);
    expect(docRes.rows[0].content).toBe("test content");

    // insert a chunk
    await client.query(
      `
      INSERT INTO ${schemaName}.chunks(doc_id, chunk_hash, chunk_text, chunk_json, chunk_blob, embedding, index)
    VALUES(1, 'testhash', 'test chunk', '{"test": "test"}', $1, '[${Array(1536).fill(0).join(", ")}]':: vector, 0)
      `,
      [Buffer.from("test blob")],
    );

    // verify the chunk is inserted
    const chunkRes = await client.query<QueryRow>(`
    SELECT * FROM ${schemaName}.chunks WHERE doc_id = 1
      `);
    expect(chunkRes.rows.length).toBe(1);
    expect(chunkRes.rows[0].doc_id).toBe(1);

    // delete the document
    await client.query(`
      DELETE FROM ${config.documentsTable} WHERE id = 1
      `);

    // verify the chunk is deleted
    const chunkRes2 = await client.query<QueryRow>(`
    SELECT * FROM ${schemaName}.chunks WHERE doc_id = 1
      `);
    expect(chunkRes2.rows.length).toBe(0);
  });

  it("should create the work queue table with proper indexes", async () => {
    // Check the work_queue table indexes
    const indexes = await client.query<QueryRow>(
      `
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = $1 AND tablename = $2;
    `,
      [schemaName, "work_queue"],
    );

    const indexNames = indexes.rows.map((row: QueryRow) => row.indexname);

    // Verify all the expected indexes are created
    expect(indexNames).toContain(`idx_${schemaName}_work_queue_status`);
    expect(indexNames).toContain(`idx_${schemaName}_work_queue_doc_id`);
    expect(indexNames).toContain(`idx_${schemaName}_work_queue_vector_clock`);

    // Check for the new performance indexes
    expect(indexNames).toContain(`idx_${schemaName}_work_queue_stalled_jobs`);
    expect(indexNames).toContain(
      `idx_${schemaName}_work_queue_doc_id_vector_clock`,
    );

    // Verify column definition and constraints
    const columnsRes = await client.query<QueryRow>(
      `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2;
    `,
      [schemaName, "work_queue"],
    );

    const columns = columnsRes.rows.map((row: QueryRow) => row.column_name);
    expect(columns).toEqual(
      expect.arrayContaining([
        "id",
        "doc_id",
        "vector_clock",
        "status",
        "processing_started_at",
        "worker_id",
        "error",
        "retry_count",
      ]),
    );
  });

  it("should create the config table and store the configs", async () => {
    const res = await client.query<ConfigRow>(`
      SELECT key, value FROM ${schemaName}.config;
    `);
    expect(res.rows.length).toBe(7);
    expect(res.rows[0].key).toBe("documentsSchema");
    expect(res.rows[0].value).toBe("public");
    expect(res.rows[1].key).toBe("documentsTable");
    expect(res.rows[1].value).toBe("documents");
    expect(res.rows[2].key).toBe("docIdType");
    expect(res.rows[2].value).toBe("INT");
    expect(res.rows[3].key).toBe("embeddingDimension");
    expect(res.rows[3].value).toBe("1536");
    expect(res.rows[4].key).toBe("shadowTable");
    expect(res.rows[4].value).toBe("ragmatic_test.shadows");
    expect(res.rows[5].key).toBe("chunksTable");
    expect(res.rows[5].value).toBe("ragmatic_test.chunks");
    expect(res.rows[6].key).toBe("ragmaticSchemaVersion");
    expect(res.rows[6].value).toBe("1");

    // update the config
    await setup({
      ...config,
      shadowTable: "shadows_b",
      chunksTable: "chunks_b",
    });
    const res2 = await client.query<ConfigRow>(`
      SELECT key, value FROM ${schemaName}.config;
    `);
    expect(res2.rows[4].key).toBe("shadowTable");
    expect(res2.rows[4].value).toBe("ragmatic_test.shadows_b");
    expect(res2.rows[5].key).toBe("chunksTable");
    expect(res2.rows[5].value).toBe("ragmatic_test.chunks_b");
  });

  it("should process existing rows", async () => {
    await cleanupDatabase(client);
    // Create a minimal "documents" table required by our triggers.
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${config.documentsTable} (
      id SERIAL PRIMARY KEY,
        content TEXT NOT NULL,
          updated_at TIMESTAMP NOT NULL
      );
  `);

    // insert a document
    const now = new Date();
    await client.query(
      `
      INSERT INTO ${config.documentsTable} (content, updated_at)
  VALUES('test content', $1)
    `,
      [now],
    );

    await setup(config);

    // verify the shadow record is inserted
    const shadowRes = await client.query<QueryRow>(`
  SELECT * FROM ${schemaName}.shadows WHERE doc_id = 1
    `);
    expect(shadowRes.rows.length).toBe(1);
    expect(shadowRes.rows[0].doc_id).toBe(1);
    expect(Number(shadowRes.rows[0].vector_clock)).toBe(1);
  });

  it("should update the shadow table on document update", async () => {
    // Insert a document.
    const now = new Date();
    const insertRes = await client.query<QueryRow>(
      `INSERT INTO ${config.documentsTable} (content, updated_at)
  VALUES($1, $2) RETURNING id`,
      ["Test insert content", now],
    );
    const docId = insertRes.rows[0].id;

    // verify the shadow record is inserted
    const shadowRes = await client.query<QueryRow>(
      `SELECT * FROM ${schemaName}.shadows WHERE doc_id = $1`,
      [docId],
    );
    expect(shadowRes.rows.length).toBe(1);
    expect(shadowRes.rows[0].doc_id).toBe(docId);
    expect(Number(shadowRes.rows[0].vector_clock)).toBe(1);
  });

  it("should delete the shadow record on document deletion and cascade delete chunks", async () => {
    // Insert a document.
    const now = new Date();
    const insertRes = await client.query<QueryRow>(
      `INSERT INTO ${config.documentsTable} (content, updated_at)
  VALUES($1, $2) RETURNING id`,
      ["Content to delete", now],
    );
    const docId = insertRes.rows[0].id;

    // Manually insert a dummy chunk in the chunks table.
    await client.query(
      `INSERT INTO ${schemaName}.chunks(doc_id, chunk_hash, chunk_text, embedding, index)
  VALUES($1, $2, $3, '[${Array(1536).fill(0).join(", ")}]':: vector, $4)`,
      [docId, "dummyhash", "dummy text", 0],
    );

    // Delete the document.
    await client.query(`DELETE FROM ${config.documentsTable} WHERE id = $1`, [
      docId,
    ]);

    // Verify the shadow record is gone.
    const shadowRes = await client.query<QueryRow>(
      `SELECT * FROM ${schemaName}.shadows WHERE doc_id = $1`,
      [docId],
    );
    expect(shadowRes.rows.length).toBe(0);

    // Verify that the chunk row is also deleted via cascade.
    const chunksRes = await client.query<QueryRow>(
      `SELECT * FROM ${schemaName}.chunks WHERE doc_id = $1`,
      [docId],
    );
    expect(chunksRes.rows.length).toBe(0);
  });

  it("should delete the shadow table and chunks table if the schema is dropped", async () => {
    // Drop the schema.
    await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE; `);

    // Verify the shadow table and chunks table are gone.
    const tableExistsQuery = `
      SELECT EXISTS(
    SELECT 1 
        FROM information_schema.tables 
        WHERE table_schema = $1
        AND table_name = $2
  );
  `;
    let shadowTableExists = await client.query(tableExistsQuery, [
      schemaName,
      config.shadowTable,
    ]);
    let chunksTableExists = await client.query(tableExistsQuery, [
      schemaName,
      config.chunksTable,
    ]);

    expect(shadowTableExists.rows[0].exists).toBe(false);
    expect(chunksTableExists.rows[0].exists).toBe(false);
  });

  it("should properly clean up orphaned records when documents table is dropped", async () => {
    // First, create a fresh database state
    await cleanupDatabase(client);

    // Create the documents table
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${config.documentsTable} (
    id SERIAL PRIMARY KEY,
      content TEXT NOT NULL,
        updated_at TIMESTAMP NOT NULL
      );
`);

    // Set up the ragmatic schema
    await setup(config);
    const schemaName = `${PREFIX}${config.trackerName} `;

    // Insert two test documents - we'll use ID 2 to verify that orphaned records with IDs
    // that don't conflict with new document IDs will be properly cleaned up
    const now = new Date();
    await client.query(
      `INSERT INTO ${config.documentsTable} (content, updated_at)
VALUES($1, $2), ($3, $4)`,
      ["Test document 1", now, "Test document 2", now],
    );

    // Insert work queue items for both documents
    await client.query(`
      INSERT INTO ${schemaName}.work_queue(doc_id, vector_clock)
VALUES(1, 1), (2, 1);
`);

    // Insert dummy chunks for both documents
    await client.query(`
      INSERT INTO ${schemaName}.chunks(doc_id, index, chunk_hash, chunk_text, embedding)
VALUES
  (1, 0, 'hash1', 'doc1 chunk text', '[${Array(1536).fill(0).join(", ")}]':: vector),
  (2, 0, 'hash2', 'doc2 chunk text', '[${Array(1536).fill(0).join(", ")}]'::vector);
`);

    // Verify we have two documents each with their related records
    let docCount = await client.query(
      `SELECT COUNT(*) FROM ${config.documentsTable} `,
    );
    expect(Number(docCount.rows[0].count)).toBe(2);

    let shadowCount = await client.query(
      `SELECT COUNT(*) FROM ${schemaName}.shadows`,
    );
    expect(Number(shadowCount.rows[0].count)).toBe(2);

    let workQueueCount = await client.query(
      `SELECT COUNT(*) FROM ${schemaName}.work_queue`,
    );
    expect(Number(workQueueCount.rows[0].count)).toBe(2);

    let chunksCount = await client.query(
      `SELECT COUNT(*) FROM ${schemaName}.chunks`,
    );
    expect(Number(chunksCount.rows[0].count)).toBe(2);

    // Now drop the documents table
    await client.query(`DROP TABLE ${config.documentsTable} CASCADE; `);

    // Recreate the documents table
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${config.documentsTable} (
  id SERIAL PRIMARY KEY,
    content TEXT NOT NULL,
      updated_at TIMESTAMP NOT NULL
      );
`);

    // Insert only one new document - this will reuse ID 1, but not ID 2
    await client.query(
      `INSERT INTO ${config.documentsTable} (content, updated_at)
VALUES($1, $2)`,
      ["New document after table drop", now],
    );

    // Run setup again - this should clean up orphaned data
    // an alternative approach would be to drop the schema and recreate it
    // but users might not want to drop the schema and lose all the data every time they run setup
    // so setup behaves like a good up migration
    await setup(config);

    // Verify we only have records for document ID 1 now
    let docResult = await client.query(
      `SELECT id FROM ${config.documentsTable} `,
    );
    expect(docResult.rows.length).toBe(1);
    expect(docResult.rows[0].id).toBe(1);

    // Verify shadows - should only have one for ID 1
    let shadowResult = await client.query(`
      SELECT doc_id, vector_clock FROM ${schemaName}.shadows ORDER BY doc_id
  `);
    expect(shadowResult.rows.length).toBe(1);
    expect(shadowResult.rows[0].doc_id).toBe(1);

    // Verify work queue is cleaned up fully
    let workQueueResult = await client.query(`
      SELECT doc_id FROM ${schemaName}.work_queue ORDER BY doc_id
  `);
    expect(workQueueResult.rows.length).toBe(0);

    // Verify chunks - ID 2 chunks cleaned up, ID 1 chunks remain
    let chunksResult = await client.query(`
      SELECT doc_id FROM ${schemaName}.chunks ORDER BY doc_id
    `);
    expect(chunksResult.rows.length).toBe(1);
    expect(chunksResult.rows[0].doc_id).toBe(1);
  });

  describe("Multiple trackers", () => {
    beforeAll(async () => {
      await cleanupDatabase(client);
    });

    it("should allow multiple shadow tables tracking the same documents table", async () => {
      // setup the second schema
      const configB: Config = { ...config, trackerName: "test_b" };
      await setup(configB);
      const schemaBName = `${PREFIX}${configB.trackerName} `;

      // insert a document
      const now = new Date();
      const insertRes = await client.query(
        `
        INSERT INTO ${config.documentsTable} (content, updated_at)
VALUES('test content', $1)
        RETURNING id
  `,
        [now],
      );
      const docId = insertRes.rows[0].id;

      // verify the document is inserted
      const docRes = await client.query<QueryRow>(
        `
SELECT * FROM ${config.documentsTable} WHERE id = $1`,
        [docId],
      );
      expect(docRes.rows.length).toBe(1);
      expect(docRes.rows[0].content).toBe("test content");

      // verify the shadow record is inserted in both schemas
      const shadowRes = await client.query<QueryRow>(
        `
SELECT * FROM ${schemaBName}.shadows WHERE doc_id = $1`,
        [docId],
      );
      expect(shadowRes.rows.length).toBe(1);
      expect(shadowRes.rows[0].doc_id).toBe(docId);
      expect(Number(shadowRes.rows[0].vector_clock)).toBe(1);
      const shadowRes2 = await client.query<QueryRow>(
        `
SELECT * FROM ${schemaName}.shadows WHERE doc_id = $1`,
        [docId],
      );
      expect(shadowRes2.rows.length).toBe(1);
      expect(shadowRes2.rows[0].doc_id).toBe(docId);
      expect(Number(shadowRes2.rows[0].vector_clock)).toBe(1);

      // update the document
      const later = new Date(now.getTime() + 1000);
      await client.query(
        `UPDATE ${config.documentsTable} SET content = $1, updated_at = $2 WHERE id = $3`,
        ["Updated content", later, docId],
      );

      // verify the shadow record is updated in both schemas
      const shadowRes3 = await client.query<QueryRow>(
        `
SELECT * FROM ${schemaBName}.shadows WHERE doc_id = $1`,
        [docId],
      );
      expect(shadowRes3.rows.length).toBe(1);
      expect(shadowRes3.rows[0].doc_id).toBe(docId);
      expect(Number(shadowRes3.rows[0].vector_clock)).toBe(2);

      const shadowRes4 = await client.query<QueryRow>(
        `
SELECT * FROM ${schemaName}.shadows WHERE doc_id = $1`,
        [docId],
      );
      expect(shadowRes4.rows.length).toBe(1);
      expect(shadowRes4.rows[0].doc_id).toBe(docId);
      expect(Number(shadowRes4.rows[0].vector_clock)).toBe(2);
    });

    it("should allow multiple trackers tracking different documents tables", async () => {
      const configB: Config = {
        ...config,
        documentsTable: "documents_b",
        trackerName: "test_b",
      };

      // create a second documents table
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${configB.documentsTable} (
  id SERIAL PRIMARY KEY,
    content TEXT NOT NULL,
      updated_at TIMESTAMP NOT NULL
          );
`);

      // setup the second schema
      await setup(configB);
      const schemaBName = `${PREFIX}${configB.trackerName} `;

      // insert a document into both tables
      const now = new Date();
      const insertRes = await client.query(
        `
        INSERT INTO ${config.documentsTable} (content, updated_at)
VALUES('test content', $1)
        RETURNING id
  `,
        [now],
      );
      const docId = insertRes.rows[0].id;
      const insertResB = await client.query(
        `
        INSERT INTO ${configB.documentsTable} (content, updated_at)
VALUES('test content', $1)
        RETURNING id
  `,
        [now],
      );
      const docIdB = insertResB.rows[0].id;

      // verify the documents are inserted
      const docRes = await client.query<QueryRow>(
        `
SELECT * FROM ${config.documentsTable} WHERE id = $1`,
        [docId],
      );
      expect(docRes.rows.length).toBe(1);
      expect(docRes.rows[0].content).toBe("test content");

      const docResB = await client.query<QueryRow>(
        `
SELECT * FROM ${configB.documentsTable} WHERE id = $1`,
        [docIdB],
      );
      expect(docResB.rows.length).toBe(1);
      expect(docResB.rows[0].content).toBe("test content");

      // verify the shadow records are inserted in both schemas and have the correct doc_id and vector_clock
      const shadowRes = await client.query<QueryRow>(
        `
SELECT * FROM ${schemaName}.shadows WHERE doc_id = $1`,
        [docId],
      );
      expect(shadowRes.rows.length).toBe(1);
      expect(shadowRes.rows[0].doc_id).toBe(docId);
      expect(Number(shadowRes.rows[0].vector_clock)).toBe(1);

      const shadowResB = await client.query<QueryRow>(
        `
SELECT * FROM ${schemaBName}.shadows WHERE doc_id = $1`,
        [docIdB],
      );
      expect(shadowResB.rows.length).toBe(1);
      expect(shadowResB.rows[0].doc_id).toBe(docIdB);
      expect(Number(shadowResB.rows[0].vector_clock)).toBe(1);

      // update the first document
      const later = new Date(now.getTime() + 1000);
      await client.query(
        `UPDATE ${config.documentsTable} SET content = $1, updated_at = $2 WHERE id = $3`,
        ["Updated content", later, docId],
      );

      // verify the shadow record is updated in only the correct shadow table
      const shadowRes2 = await client.query<QueryRow>(
        `
SELECT * FROM ${schemaName}.shadows WHERE doc_id = $1`,
        [docId],
      );
      expect(shadowRes2.rows.length).toBe(1);
      expect(shadowRes2.rows[0].doc_id).toBe(docId);
      expect(Number(shadowRes2.rows[0].vector_clock)).toBe(2);

      const shadowResB2 = await client.query<QueryRow>(
        `
SELECT * FROM ${schemaBName}.shadows WHERE doc_id = $1`,
        [docIdB],
      );
      expect(shadowResB2.rows.length).toBe(1);
      expect(shadowResB2.rows[0].doc_id).toBe(docIdB);
      expect(Number(shadowResB2.rows[0].vector_clock)).toBe(1);
    });
  });
});
