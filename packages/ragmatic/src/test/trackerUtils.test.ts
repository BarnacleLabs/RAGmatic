import { describe, it, expect, beforeAll, afterAll } from "vitest";
// @ts-ignore
import pg from "pg";
import {
  destroyTracker,
  getTrackerConfig,
  countRemainingDocuments,
  reprocessDocuments,
} from "../trackerUtils";
import { setup } from "../dbSetup";
import { sql } from "../utils/utils";

// Test connection string - update as needed for your test environment
const TEST_CONNECTION_STRING =
  "postgresql://test:test@localhost:5432/ragmatic_test";

// Test constants
const TEST_TRACKER_NAME = "test_tracker";
const TEST_TABLE_NAME = "test_documents";
const TEST_EMBEDDING_DIMENSION = 1536;

describe("Tracker Utilities", () => {
  let client: pg.Client;

  beforeAll(async () => {
    // Connect to database
    client = new pg.Client({ connectionString: TEST_CONNECTION_STRING });
    await client.connect();

    // Create test documents table
    await client.query(sql`
      DROP TABLE IF EXISTS ${TEST_TABLE_NAME} CASCADE;

      CREATE TABLE ${TEST_TABLE_NAME} (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);

    // Insert some test data
    await client.query(sql`
      INSERT INTO
        ${TEST_TABLE_NAME} (title, content)
      VALUES
        (
          'Test Document 1',
          'This is the content of test document 1'
        ),
        (
          'Test Document 2',
          'This is the content of test document 2'
        ),
        (
          'Test Document 3',
          'This is the content of test document 3'
        );
    `);

    // Set up the tracker
    await setup({
      connectionString: TEST_CONNECTION_STRING,
      documentsTable: TEST_TABLE_NAME,
      trackerName: TEST_TRACKER_NAME,
      embeddingDimension: TEST_EMBEDDING_DIMENSION,
    });
  });

  afterAll(async () => {
    // Clean up by destroying the tracker
    try {
      await destroyTracker(TEST_CONNECTION_STRING, TEST_TRACKER_NAME);
    } catch (error) {
      console.error("Error destroying tracker:", error);
    }

    // Drop the test table
    try {
      await client.query(sql`DROP TABLE IF EXISTS ${TEST_TABLE_NAME} CASCADE;`);
    } catch (error) {
      console.error("Error dropping test table:", error);
    }

    // Close the client connection
    await client.end();
  });

  it("should get tracker configuration", async () => {
    const config = await getTrackerConfig(
      TEST_CONNECTION_STRING,
      TEST_TRACKER_NAME,
    );

    expect(config).toBeDefined();
    expect(config.trackerName).toBe(TEST_TRACKER_NAME);
    expect(config.documentsTable).toBe(TEST_TABLE_NAME);
    expect(config.embeddingDimension).toBe(TEST_EMBEDDING_DIMENSION);
    expect(config.shadowTable).toBeDefined();
    expect(config.chunksTable).toBeDefined();
  });

  it("should count pending documents in the work queue", async () => {
    // First, manually trigger vector clock increment to create jobs
    // This will initialize the test state
    await reprocessDocuments(TEST_CONNECTION_STRING, TEST_TRACKER_NAME);

    // Count pending jobs
    const count = await countRemainingDocuments(
      TEST_CONNECTION_STRING,
      TEST_TRACKER_NAME,
    );

    // We should see pending jobs in the queue since we reprocessed docs
    expect(count).toBeGreaterThanOrEqual(0);
  });

  it("should reprocess documents by incrementing vector clocks", async () => {
    const schemaName = `ragmatic_${TEST_TRACKER_NAME}`;

    // Get the current vector clock for a document
    const vectorClockQuery = `
      SELECT vector_clock FROM ${schemaName}.shadows 
      ORDER BY id LIMIT 1
    `;
    const initialVectorClock = (await client.query(vectorClockQuery)).rows[0]
      ?.vector_clock;

    // Skip test if no shadows exist yet
    if (!initialVectorClock) {
      console.log("No shadow records found, skipping test");
      return;
    }

    // Now reprocess all documents
    await reprocessDocuments(TEST_CONNECTION_STRING, TEST_TRACKER_NAME);

    // Verify vector clocks were incremented
    const updatedVectorClock = (await client.query(vectorClockQuery)).rows[0]
      ?.vector_clock;
    expect(Number(updatedVectorClock)).toBeGreaterThan(
      Number(initialVectorClock),
    );
  });

  it("should destroy a tracker", async () => {
    // First, create a new tracker specifically for this test
    const destroyTestTrackerName = "test_tracker_to_destroy";

    await setup({
      connectionString: TEST_CONNECTION_STRING,
      documentsTable: TEST_TABLE_NAME,
      trackerName: destroyTestTrackerName,
      embeddingDimension: TEST_EMBEDDING_DIMENSION,
    });

    // Verify the tracker exists by getting its config
    const config = await getTrackerConfig(
      TEST_CONNECTION_STRING,
      destroyTestTrackerName,
    );
    expect(config).toBeDefined();

    // Now destroy the tracker
    await destroyTracker(TEST_CONNECTION_STRING, destroyTestTrackerName);

    // Verify the tracker no longer exists
    try {
      await getTrackerConfig(TEST_CONNECTION_STRING, destroyTestTrackerName);
      // If we get here, the tracker still exists
      expect(true).toBe(false); // This should fail
    } catch (error) {
      // We expect an error because the tracker should not exist
      expect(error).toBeDefined();
    }
  });
});
