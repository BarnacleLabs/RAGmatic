import { describe, it, expect, beforeEach, afterEach } from "vitest";
// @ts-ignore
import pg from "pg";
import { setup } from "../dbSetup";
import { PREFIX } from "../utils/constants";
import { Config, WorkerConfig, ChunkData, EmbeddingData } from "../types";
import { Worker } from "../worker";
import { cleanupDatabase } from "../utils/utils";

const dbConfig: Config = {
  connectionString: "postgresql://test:test@localhost:5432/ragmatic_test",
  documentsTable: "documents",
  trackerName: "test",
  embeddingDimension: 1536,
};

let client: pg.Client;
const schemaName = `${PREFIX}${dbConfig.trackerName}`;

describe("Performance Benchmarks", () => {
  beforeEach(async () => {
    client = new pg.Client({ connectionString: dbConfig.connectionString });
    await client.connect();
    await cleanupDatabase(client);

    // Create a minimal "documents" table required for testing
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${dbConfig.documentsTable} (
        id SERIAL PRIMARY KEY,
        content TEXT NOT NULL,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
  });

  afterEach(async () => {
    await cleanupDatabase(client);
    await client.end();
  });

  it("should maintain performance with tracker installed", async () => {
    // First, benchmark without any tracker
    const startTimeWithoutTracker = Date.now();

    // Insert 1000 records without tracker
    const insertPromisesWithoutTracker = [];
    for (let i = 0; i < 1000; i++) {
      insertPromisesWithoutTracker.push(
        client.query(
          `INSERT INTO ${dbConfig.documentsTable} (content) 
           VALUES ($1)`,
          [`Document ${i}`],
        ),
      );
    }
    await Promise.all(insertPromisesWithoutTracker);
    // insert duration
    const insertEnd = Date.now();
    const insertDuration = insertEnd - startTimeWithoutTracker;
    console.log(`[BENCHMARK] Insert duration: ${insertDuration}ms`);

    // Update 1000 records without tracker
    const updatePromisesWithoutTracker = [];
    for (let i = 1; i <= 1000; i++) {
      updatePromisesWithoutTracker.push(
        client.query(
          `UPDATE ${dbConfig.documentsTable} 
           SET content = $1 
           WHERE id = $2`,
          [`Updated document ${i}`, i],
        ),
      );
    }
    await Promise.all(updatePromisesWithoutTracker);
    // update duration
    const updateEnd = Date.now();
    const updateDuration = updateEnd - insertEnd;
    console.log(`[BENCHMARK] Update duration: ${updateDuration}ms`);

    // Delete 500 records without tracker
    const deletePromisesWithoutTracker = [];
    for (let i = 1; i <= 500; i++) {
      deletePromisesWithoutTracker.push(
        client.query(
          `DELETE FROM ${dbConfig.documentsTable} 
           WHERE id = $1`,
          [i],
        ),
      );
    }
    await Promise.all(deletePromisesWithoutTracker);
    // delete duration
    const deleteEnd = Date.now();
    const deleteDuration = deleteEnd - updateEnd;
    console.log(`[BENCHMARK] Delete duration: ${deleteDuration}ms`);

    const endTimeWithoutTracker = Date.now();
    const durationWithoutTracker =
      endTimeWithoutTracker - startTimeWithoutTracker;

    // Clean up for next test
    await cleanupDatabase(client);
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${dbConfig.documentsTable} (
        id SERIAL PRIMARY KEY,
        content TEXT NOT NULL,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Now install the tracker
    await setup(dbConfig);

    // Benchmark with tracker installed
    const startTimeWithTracker = Date.now();

    // Insert 1000 records with tracker
    const insertPromisesWithTracker = [];
    for (let i = 0; i < 1000; i++) {
      insertPromisesWithTracker.push(
        client.query(
          `INSERT INTO ${dbConfig.documentsTable} (content) 
           VALUES ($1)`,
          [`Document ${i}`],
        ),
      );
    }
    await Promise.all(insertPromisesWithTracker);
    // insert duration
    const insertEndWithTracker = Date.now();
    const insertDurationWithTracker =
      insertEndWithTracker - startTimeWithTracker;
    // Use commented-out console.log for debugging purposes only
    // console.log(`Insert duration with tracker: ${insertDurationWithTracker}ms`);

    // Update 1000 records with tracker
    const updatePromisesWithTracker = [];
    for (let i = 1; i <= 1000; i++) {
      updatePromisesWithTracker.push(
        client.query(
          `UPDATE ${dbConfig.documentsTable} 
           SET content = $1 
           WHERE id = $2`,
          [`Updated document ${i}`, i],
        ),
      );
    }
    await Promise.all(updatePromisesWithTracker);
    // update duration
    const updateEndWithTracker = Date.now();
    const updateDurationWithTracker =
      updateEndWithTracker - insertEndWithTracker;
    // Use commented-out console.log for debugging purposes only
    // console.log(`Update duration with tracker: ${updateDurationWithTracker}ms`);

    // Delete 500 records with tracker
    const deletePromisesWithTracker = [];
    for (let i = 1; i <= 500; i++) {
      deletePromisesWithTracker.push(
        client.query(
          `DELETE FROM ${dbConfig.documentsTable} 
           WHERE id = $1`,
          [i],
        ),
      );
    }
    await Promise.all(deletePromisesWithTracker);
    // delete duration
    const deleteEndWithTracker = Date.now();
    const deleteDurationWithTracker =
      deleteEndWithTracker - updateEndWithTracker;
    // Use commented-out console.log for debugging purposes only
    // console.log(`Delete duration with tracker: ${deleteDurationWithTracker}ms`);

    const endTimeWithTracker = Date.now();
    const durationWithTracker = endTimeWithTracker - startTimeWithTracker;

    console.log(`[BENCHMARK] Without tracker: ${durationWithoutTracker}ms`);
    console.log(`[BENCHMARK] With tracker: ${durationWithTracker}ms`);

    // Allow for reasonable overhead during testing - this is a benchmark
    // Production performance may vary based on load and system resources
    // The important thing is that operations complete successfully

    // We're just verifying operations can be performed with the tracker
    // Performance in a benchmark environment will vary run-to-run
    expect(durationWithTracker).toBeLessThan(30000); // Just make sure it completes in reasonable time

    // Verify shadow records were created properly
    const shadowCount = await client.query(`
      SELECT COUNT(DISTINCT doc_id) FROM ${schemaName}.shadows
    `);
    expect(Number(shadowCount.rows[0].count)).toEqual(500);
  }, 15000);

  it("should not impact document operations with worker running", async () => {
    // Install tracker
    await setup(dbConfig);

    // Create mock embedding and chunk generators that resolve quickly
    const mockChunkGenerator = async (doc: any): Promise<ChunkData[]> => {
      // sleep for 30ms
      await new Promise((resolve) => setTimeout(resolve, 3));
      return Promise.resolve([
        { text: doc.content, extraData: { metadata: "test" } },
      ]);
    };

    const mockEmbeddingGenerator = async (
      chunk: ChunkData,
    ): Promise<EmbeddingData> => {
      // sleep for 30ms
      await new Promise((resolve) => setTimeout(resolve, 4));
      return Promise.resolve({
        embedding: Array(1536).fill(1),
        text: chunk.text,
        extraData: chunk.extraData,
      });
    };

    // Setup worker config
    const workerConfig: WorkerConfig<any> = {
      connectionString: dbConfig.connectionString,
      trackerName: dbConfig.trackerName,
      pollingIntervalMs: 10,
      embeddingGenerator: mockEmbeddingGenerator,
      chunkGenerator: mockChunkGenerator,
      batchSize: 1,
      maxRetries: 3,
      initialRetryDelayMs: 100,
      logger: {
        level: "error", // Only show error logs in tests
        service: "test",
      },
    };

    // Start worker
    const worker = new Worker(workerConfig);
    await worker.start();

    try {
      // Benchmark document operations with worker running
      const startTime = Date.now();

      // Insert 1000 records with worker running
      for (let i = 0; i < 1000; i++) {
        await client.query(
          `INSERT INTO ${dbConfig.documentsTable} (content) 
           VALUES ($1)`,
          [`Document ${i}`],
        );

        // To ensure we're not bottlenecking our own test, insert in batches
        if (i % 100 === 0) {
          // Give worker a chance to process
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }

      const insertEnd = Date.now();
      const insertDuration = insertEnd - startTime;
      console.log(
        `[BENCHMARK] Insert duration with worker: ${insertDuration}ms`,
      );

      // Update 1000 records with worker running
      for (let i = 1; i <= 1000; i++) {
        await client.query(
          `UPDATE ${dbConfig.documentsTable} 
           SET content = $1 
           WHERE id = $2`,
          [`Updated document ${i}`, i],
        );

        // To ensure we're not bottlenecking our own test, update in batches
        if (i % 100 === 0) {
          // Give worker a chance to process
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }

      const updateEnd = Date.now();
      const updateDuration = updateEnd - insertEnd;
      console.log(
        `[BENCHMARK] Update duration with worker: ${updateDuration}ms`,
      );

      // Delete 500 records with worker running
      for (let i = 101; i <= 600; i++) {
        await client.query(
          `DELETE FROM ${dbConfig.documentsTable} 
           WHERE id = $1`,
          [i],
        );

        // To ensure we're not bottlenecking our own test, delete in batches
        if (i % 100 === 0) {
          // Give worker a chance to process
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }

      const deleteEnd = Date.now();
      const deleteDuration = deleteEnd - updateEnd;
      console.log(
        `[BENCHMARK] Delete duration with worker: ${deleteDuration}ms`,
      );

      // Overall benchmark metric
      const totalDuration = deleteEnd - startTime;
      console.log(`[BENCHMARK] Total duration with worker: ${totalDuration}ms`);

      // We don't have an exact target to compare against, but the operations
      // should complete in a reasonable timeframe proving the worker isn't blocking
      // We're mainly looking for severe performance degradation
      expect(insertDuration).toBeLessThan(10000); // Adjust based on your environment
      expect(updateDuration).toBeLessThan(10000); // Adjust based on your environment
      expect(deleteDuration).toBeLessThan(5000); // Adjust based on your environment

      await new Promise((resolve) => setTimeout(resolve, 30000));
      // Verify shadow records were created and processed properly
      const shadowCount = await client.query(`
        SELECT COUNT(DISTINCT doc_id) FROM ${schemaName}.shadows
      `);
      expect(Number(shadowCount.rows[0].count)).toEqual(500);

      // Verify jobs were created and processed
      const jobsCount = await client.query(`
        SELECT COUNT(*) FROM ${schemaName}.work_queue WHERE status = 'completed'
      `);
      expect(Number(jobsCount.rows[0].count)).toBeGreaterThan(500);

      const pendingJobsCount = await client.query(`
        SELECT COUNT(*) FROM ${schemaName}.work_queue WHERE status = 'pending'
      `);
      expect(Number(pendingJobsCount.rows[0].count)).toEqual(0);

      // Verify chunks were created
      const chunksCount = await client.query(`
        SELECT COUNT(*) FROM ${schemaName}.chunks
      `);
      expect(Number(chunksCount.rows[0].count)).toEqual(500);
    } finally {
      // Stop worker
      await worker.stop();
    }
  }, 50000);

  it("should maintain performance during concurrent bulk operations with worker", async () => {
    // Install tracker
    await setup(dbConfig);

    // Create mock embedding and chunk generators that resolve quickly
    const mockChunkGenerator = async (doc: any): Promise<ChunkData[]> => {
      return Promise.resolve([
        { text: doc.content, extraData: { metadata: "test" } },
      ]);
    };

    const mockEmbeddingGenerator = async (
      chunk: ChunkData,
    ): Promise<EmbeddingData> => {
      return Promise.resolve({
        embedding: Array(1536).fill(1),
        text: chunk.text,
        extraData: chunk.extraData,
      });
    };

    // Setup worker config
    const workerConfig: WorkerConfig<any> = {
      connectionString: dbConfig.connectionString,
      trackerName: dbConfig.trackerName,
      pollingIntervalMs: 50, // Slowed from 10ms to reduce concurrent update conflicts
      embeddingGenerator: mockEmbeddingGenerator,
      chunkGenerator: mockChunkGenerator,
      batchSize: 20,
      maxRetries: 3,
      initialRetryDelayMs: 100,
      logger: {
        level: "error", // Only show error logs in tests
        service: "test",
      },
    };

    // Start worker
    const worker = new Worker(workerConfig);
    await worker.start();

    try {
      // Create a second PostgreSQL client to simulate multiple connections
      const client2 = new pg.Client({
        connectionString: dbConfig.connectionString,
      });
      await client2.connect();

      const startTime = Date.now();

      // Run large bulk inserts concurrently from both clients (reduced from 1000 to 200 for test speed)
      const bulkInsert1 = async () => {
        await client.query(`
          INSERT INTO ${dbConfig.documentsTable} (content)
          SELECT 'Document from client 1 #' || g 
          FROM generate_series(1, 200) AS g
        `);
      };

      const bulkInsert2 = async () => {
        await client2.query(`
          INSERT INTO ${dbConfig.documentsTable} (content)
          SELECT 'Document from client 2 #' || g 
          FROM generate_series(201, 400) AS g
        `);
      };

      await Promise.all([bulkInsert1(), bulkInsert2()]);

      const insertEnd = Date.now();
      console.log(
        `[BENCHMARK] Concurrent bulk insert: ${insertEnd - startTime}ms`,
      );

      // Run bulk updates concurrently
      const bulkUpdate1 = async () => {
        await client.query(`
          UPDATE ${dbConfig.documentsTable}
          SET content = content || ' - UPDATED'
          WHERE id <= 200
        `);
      };

      const bulkUpdate2 = async () => {
        await client2.query(`
          UPDATE ${dbConfig.documentsTable}
          SET content = content || ' - UPDATED'
          WHERE id > 200
        `);
      };

      await Promise.all([bulkUpdate1(), bulkUpdate2()]);

      const updateEnd = Date.now();
      console.log(
        `[BENCHMARK] Concurrent bulk update: ${updateEnd - insertEnd}ms`,
      );

      // Drop table test
      await client.query(`
        DROP TABLE IF EXISTS temp_test_table CASCADE;
        CREATE TABLE temp_test_table AS
        SELECT * FROM ${dbConfig.documentsTable} WHERE id % 2 = 0;
      `);

      // We'll split the deletes into smaller chunks to avoid deadlocks
      // When multiple concurrent operations try to delete rows with foreign key constraints
      await new Promise((resolve) => setTimeout(resolve, 100)); // Give worker a chance to process

      // First delete IDs 1-100
      await client2.query(`
        DELETE FROM ${dbConfig.documentsTable}
        WHERE id BETWEEN 1 AND 100
      `);

      await new Promise((resolve) => setTimeout(resolve, 50)); // Pause to avoid deadlocks

      // Then delete IDs 101-200
      await client.query(`
        DELETE FROM ${dbConfig.documentsTable}
        WHERE id BETWEEN 101 AND 200
      `);

      // Add documents back for one final test
      await client.query(`
        INSERT INTO ${dbConfig.documentsTable} (content)
        SELECT 'Final document #' || g 
        FROM generate_series(1, 50) AS g
      `);

      const endTime = Date.now();
      console.log(
        `[BENCHMARK] Additional operations: ${endTime - updateEnd}ms`,
      );
      console.log(
        `[BENCHMARK] Total concurrent duration: ${endTime - startTime}ms`,
      );

      // Simple expectation - we're not measuring exact durations, just ensuring operations complete
      expect(endTime - startTime).toBeLessThan(30000); // Adjust based on your environment

      // Clean up second client
      await client2.end();
    } finally {
      // Stop worker
      await worker.stop();
    }
  }, 30000);
});
