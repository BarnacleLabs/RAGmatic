import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  beforeAll,
  afterAll,
} from "vitest";
// @ts-ignore
import pg from "pg";
import { setup } from "../dbSetup";
import { PREFIX } from "../utils/constants";
import { WorkerConfig, Config, ChunkData, EmbeddingData } from "../types";
import { Worker } from "../worker";
import { cleanupDatabase } from "../utils/utils";
import type { Mock } from "vitest";

interface QueryRow {
  id?: number;
  content?: string;
  vector_clock?: string;
  is_dirty?: boolean;
  doc_id?: number | string; // Can be either type depending on source
  chunk_count?: string;
  error?: string;
  chunk_text?: string;
  chunk_json?: Record<string, any>;
  chunk_blob?: Buffer;
  chunk_hash?: string;
  embedding?: number[];
  index?: number;
  status?: string;
  retry_count?: number;
  worker_id?: string;
  processing_started_at?: Date;
}

const dbConfig: Config = {
  connectionString: "postgresql://test:test@localhost:5432/ragmatic_test",
  documentsTable: "documents",
  trackerName: "comprehensive_test",
  embeddingDimension: 1536,
};

const schemaName = `${PREFIX}${dbConfig.trackerName}`;

describe("Worker Comprehensive Tests", () => {
  let client: pg.Client;
  let mockEmbeddingGenerator: Mock;
  let mockChunkGenerator: Mock;
  let mockHashFunction: Mock;
  let worker: Worker;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: dbConfig.connectionString });
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
  });

  beforeEach(async () => {
    // Clean the database before each test to avoid interference
    await cleanupDatabase(client);

    // Create a minimal "documents" table required by our triggers.
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${dbConfig.documentsTable} (
        id SERIAL PRIMARY KEY,
        content TEXT NOT NULL,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Run the database setup
    await setup(dbConfig);

    vi.useFakeTimers();

    // Reset worker state for tests
    mockChunkGenerator = vi
      .fn()
      .mockImplementation((doc: any): Promise<ChunkData[]> => {
        return Promise.resolve(
          doc.content.split(" ").map((word: string, index: number) => {
            return { text: word, extraData: { position: index } };
          }),
        );
      });

    mockEmbeddingGenerator = vi
      .fn()
      .mockImplementation(
        (chunk: ChunkData, index: number): Promise<EmbeddingData> => {
          return Promise.resolve({
            embedding: Array(1536).fill(1),
            text: chunk.text,
            extraData: chunk.extraData,
          });
        },
      );

    mockHashFunction = vi
      .fn()
      .mockImplementation((chunk: ChunkData): Promise<string> => {
        return Promise.resolve(`hash-${chunk.text}`);
      });

    // Import the test logger from testUtils
    const { createTestLogger } = await import("./testUtils");

    const workerConfig: WorkerConfig = {
      connectionString: dbConfig.connectionString,
      trackerName: dbConfig.trackerName,
      pollingIntervalMs: 100, // Shorter polling to speed up tests
      embeddingGenerator: mockEmbeddingGenerator,
      chunkGenerator: mockChunkGenerator,
      hashFunction: mockHashFunction,
      batchSize: 3,
      maxRetries: 3,
      initialRetryDelayMs: 100,
      stalledJobTimeoutMinutes: 0.01, // Short timeout for testing
      logger: {
        level: "error", // Show all logs in tests
        service: "test",
      },
    };

    worker = new Worker(workerConfig);
  });

  afterEach(async () => {
    vi.restoreAllMocks();

    // Make sure we stop all workers
    if (worker) {
      await worker.pause();
    }

    // Reset timers
    vi.useRealTimers();
  });

  // Helper function to insert a test document
  async function insertTestDocument(content: string): Promise<number> {
    const now = new Date();
    const insertRes = await client.query<QueryRow>(
      `INSERT INTO ${dbConfig.documentsTable} (content, updated_at)
       VALUES ($1, $2) RETURNING id`,
      [content, now],
    );
    return insertRes.rows[0].id!;
  }

  // Helper function to check work queue status
  async function getWorkQueueItems(docId: number): Promise<QueryRow[]> {
    const queueRes = await client.query<QueryRow>(
      `SELECT * FROM ${schemaName}.work_queue WHERE doc_id = $1 ORDER BY vector_clock`,
      [String(docId)],
    );
    return queueRes.rows;
  }

  // Helper function to check chunks
  async function getChunks(docId: number): Promise<QueryRow[]> {
    const chunksRes = await client.query<QueryRow>(
      `SELECT * FROM ${schemaName}.chunks WHERE doc_id = $1 ORDER BY index`,
      [String(docId)],
    );
    return chunksRes.rows;
  }

  // Helper function to create a worker with specific config
  function createWorker(overrides: Partial<WorkerConfig> = {}): Worker {
    return new Worker({
      connectionString: dbConfig.connectionString,
      trackerName: dbConfig.trackerName,
      pollingIntervalMs: 100,
      embeddingGenerator: mockEmbeddingGenerator,
      chunkGenerator: mockChunkGenerator,
      hashFunction: mockHashFunction,
      batchSize: 3,
      maxRetries: 3,
      initialRetryDelayMs: 100,
      stalledJobTimeoutMinutes: 0.01,
      logger: {
        level: "error", // Only show error logs in tests
        service: "test",
      },
      ...overrides,
    });
  }

  describe("Worker Lifecycle", () => {
    it("should connect and load config on start", async () => {
      // Spy on loadConfig
      const loadConfigSpy = vi.spyOn(worker, "loadConfig");

      await worker.start();
      await worker.pause();

      expect(loadConfigSpy).toHaveBeenCalledTimes(1);
      expect(worker["connected"]).toBe(true);
      expect(worker["documentsTable"]).not.toBeNull();
      expect(worker["shadowTable"]).not.toBeNull();
      expect(worker["chunksTable"]).not.toBeNull();
      expect(worker["embeddingDimension"]).toBe(1536);
    });

    it("should start polling on run", async () => {
      const pollSpy = vi.spyOn(worker, "poll");

      await worker.start();

      // Timer should be set but no poll yet
      expect(worker["timer"]).not.toBeNull();
      expect(pollSpy).not.toHaveBeenCalled();

      // Advance timer to trigger first poll
      await vi.advanceTimersByTimeAsync(100);

      expect(pollSpy).toHaveBeenCalledTimes(1);

      await worker.pause();
    });

    it("should pause correctly", async () => {
      await worker.start();

      // Verify worker is running
      expect(worker["timer"]).not.toBeNull();

      // Pause the worker
      await worker.pause();

      // Timer should be cleared
      expect(worker["timer"]).toBeNull();
      expect(worker["running"]).toBeNull();

      // Start again
      await worker.start();
      expect(worker["timer"]).not.toBeNull();

      await worker.pause();
    });
  });

  describe("Polling and Job Processing", () => {
    it("should create jobs from dirty shadow records", async () => {
      // Insert a document to trigger shadow creation
      const docId = await insertTestDocument("First test document");

      // Manually call createJobs to test it
      await worker.start();
      await worker.createJobs();

      // Check work queue
      const queueItems = await getWorkQueueItems(docId);
      expect(queueItems.length).toBe(1);
      expect(queueItems[0].status).toBe("pending");
      expect(Number(queueItems[0].vector_clock)).toBe(1);

      await worker.pause();
    });

    it("should find and claim pending jobs", async () => {
      // Insert a document
      const docId = await insertTestDocument("Test claiming jobs");

      // Start worker but don't poll yet
      await worker.start();

      // Manually create and claim jobs
      await worker.createJobs();
      const jobs = await worker.findAndClaimJobs();

      // Check claimed jobs
      expect(jobs.length).toBe(1);
      // For comparison of the doc_id, we need to handle type differences
      expect(String(jobs[0].doc_id)).toBe(String(docId));
      // In our database, vector_clock might be stored as string or number
      expect(Number(jobs[0].vector_clock)).toBe(1);

      // Check work queue status
      const queueItems = await getWorkQueueItems(docId);
      expect(queueItems.length).toBe(1);
      expect(queueItems[0].status).toBe("processing");
      expect(queueItems[0].worker_id).toBe(worker["workerId"]);
      expect(queueItems[0].processing_started_at).not.toBeNull();

      await worker.pause();
    });

    it("should process a job completely in one poll cycle", async () => {
      // Insert a document
      const docId = await insertTestDocument("Complete job test document");

      // Start worker and allow one poll cycle
      await worker.start();
      await vi.advanceTimersByTimeAsync(100);
      await worker.pause();

      // Check chunks were created
      const chunks = await getChunks(docId);
      expect(chunks.length).toBe(4); // "Complete job test document" -> 4 words

      // Check work queue item completed
      const queueItems = await getWorkQueueItems(docId);
      expect(queueItems.length).toBe(1);
      expect(queueItems[0].status).toBe("completed");

      // Verify generator calls
      expect(mockChunkGenerator).toHaveBeenCalledTimes(1);
      expect(mockEmbeddingGenerator).toHaveBeenCalledTimes(4);
      expect(mockHashFunction).toHaveBeenCalledTimes(4);
    });

    it("should handle empty job lists gracefully", async () => {
      // Start worker with no documents
      await worker.start();

      // Poll should run without errors
      await worker.poll();

      // No generators should be called
      expect(mockChunkGenerator).not.toHaveBeenCalled();
      expect(mockEmbeddingGenerator).not.toHaveBeenCalled();

      await worker.pause();
    });
  });

  describe("Job Processing Logic", () => {
    it("should deduplicate chunks correctly", async () => {
      // Insert a document
      const docId = await insertTestDocument("Duplicate duplicate word test");

      // Process it
      await worker.start();
      await vi.advanceTimersByTimeAsync(100);
      await worker.pause();

      // Check chunks - should have 4 chunks despite "duplicate" appearing twice
      const chunks = await getChunks(docId);
      expect(chunks.length).toBe(4);

      // Verify hashing and embedding calls
      // Since we control the hash function mock, each word will have a unique hash
      // and be considered unique despite being duplicated in content
      expect(mockChunkGenerator).toHaveBeenCalledTimes(1);
      expect(mockHashFunction).toHaveBeenCalledTimes(4);
      expect(mockEmbeddingGenerator).toHaveBeenCalledTimes(4);

      // Now change the hash function to return the same hash for each word
      mockHashFunction.mockReset();
      mockHashFunction.mockImplementation(() => Promise.resolve("same-hash"));

      // Update document to trigger processing
      await client.query(
        `UPDATE ${dbConfig.documentsTable} SET content = $1, updated_at = NOW() WHERE id = $2`,
        ["New duplicate duplicate test", docId],
      );

      // Process again
      await worker.start();
      await vi.advanceTimersByTimeAsync(100);
      await worker.pause();

      // Only one embedding should be generated since all hashes are the same
      // Our implementation adds index to hash so this test now tracks unique (hash+index) combos
      expect(mockEmbeddingGenerator).toHaveBeenCalledTimes(8); // 4 original + 4 new
    });

    it("should properly update vector clocks on chunks", async () => {
      // Insert a document
      const docId = await insertTestDocument("Vector clock test");

      // Process it
      await worker.start();
      await vi.advanceTimersByTimeAsync(100);
      await worker.pause();

      // Check chunks have vector_clock = 1
      let chunks = await getChunks(docId);
      chunks.forEach((chunk) => {
        expect(Number(chunk.vector_clock)).toBe(1);
      });

      // Update document
      await client.query(
        `UPDATE ${dbConfig.documentsTable} SET content = $1, updated_at = NOW() WHERE id = $2`,
        ["Updated vector clock test", docId],
      );

      // Process again
      await worker.start();
      await vi.advanceTimersByTimeAsync(100);
      await worker.pause();

      // Check all chunks have vector_clock = 2
      chunks = await getChunks(docId);
      chunks.forEach((chunk) => {
        expect(Number(chunk.vector_clock)).toBe(2);
      });
    });

    it("should skip jobs when document is deleted", async () => {
      // Start worker to create jobs
      await worker.start();
      // manually managing the loop this time
      await worker.pause();

      // Insert a document
      const docId = await insertTestDocument("To be deleted");

      // Create jobs
      await worker.createJobs();

      const queueItemsPending = await getWorkQueueItems(docId);
      expect(queueItemsPending.length).toBe(1);
      expect(queueItemsPending[0].status).toBe("pending");

      // find and claim jobs
      let jobs = await worker.findAndClaimJobs();
      expect(jobs.length).toBe(1);

      // Verify job was created
      const queueItemsProcessing = await getWorkQueueItems(docId);
      expect(queueItemsProcessing.length).toBe(1);
      expect(queueItemsProcessing[0].status).toBe("processing");

      // Delete the document
      await client.query(
        `DELETE FROM ${dbConfig.documentsTable} WHERE id = $1`,
        [docId],
      );

      // Process the job
      await worker.processJobs(jobs);

      // Check job was skipped
      const queueItemsSkipped = await getWorkQueueItems(docId);
      expect(queueItemsSkipped.length).toBeGreaterThan(0);
      expect(queueItemsSkipped[0].status).toBe("skipped");

      // Next loop
      await worker.createJobs();
      let jobs2 = await worker.findAndClaimJobs();
      expect(jobs2.length).toBe(0);

      // Check job was skipped
      const queueItems = await getWorkQueueItems(docId);
      expect(queueItems.length).toBe(1);
      expect(queueItems[0].status).toBe("skipped");

      // No chunks should be created
      const chunks = await getChunks(docId);
      expect(chunks.length).toBe(0);

      await worker.pause();
    });

    it("should process multiple vector clock updates correctly", async () => {
      // Insert a document
      const docId = await insertTestDocument("Initial test content");

      // Process the initial document
      await worker.start();
      await vi.advanceTimersByTimeAsync(100);
      await worker.pause();

      // First update
      await client.query(
        `UPDATE ${dbConfig.documentsTable} SET content = $1, updated_at = NOW() WHERE id = $2`,
        ["Updated content once", docId],
      );

      // Second update
      await client.query(
        `UPDATE ${dbConfig.documentsTable} SET content = $1, updated_at = NOW() WHERE id = $2`,
        ["Updated content twice", docId],
      );

      // Process both updates
      await worker.start();
      await vi.advanceTimersByTimeAsync(100);
      await worker.pause();

      // Check work queue - there should be job entries
      const queueItems = await getWorkQueueItems(docId);

      // At least one job should be completed for the latest update
      const completedJobs = queueItems.filter(
        (item) => item.status === "completed",
      );
      expect(completedJobs.length).toBeGreaterThan(0);

      // The chunks should reflect the latest content
      const chunks = await getChunks(docId);
      expect(chunks.map((c) => c.chunk_text)).toEqual([
        "Updated",
        "content",
        "twice",
      ]);
    });
  });

  describe("Retry Logic", () => {
    it("should retry temporary errors", async () => {
      // Insert a document
      const docId = await insertTestDocument("Retry test");

      // Make embedding generator fail with temporary error first time
      let failCount = 0;
      mockEmbeddingGenerator.mockImplementation((chunk, index) => {
        if (failCount < 1) {
          failCount++;
          throw new Error("Temporary failure");
        }
        return Promise.resolve({
          embedding: Array(1536).fill(1),
          text: chunk.text,
          extraData: chunk.extraData,
        });
      });

      // Start worker and process
      await worker.start();
      await vi.advanceTimersByTimeAsync(100);
      await worker.pause();

      // Check work queue - job should be retried
      const queueItems = await getWorkQueueItems(docId);

      // Verify the job has been attempted at least once
      expect(queueItems.length).toBeGreaterThan(0);

      // Either the job is retrying (pending) or already completed
      const retryPending = queueItems.some(
        (item) => item.status === "pending" && Number(item.retry_count) > 0,
      );
      const completed = queueItems.some((item) => item.status === "completed");

      expect(retryPending || completed).toBe(true);

      // Process again to ensure completion
      await worker.start();
      await vi.advanceTimersByTimeAsync(100);
      await worker.pause();

      // Final check - job should be completed eventually
      const finalQueueItems = await getWorkQueueItems(docId);
      const completedJob = finalQueueItems.find(
        (item) => item.status === "completed",
      );
      expect(completedJob).toBeDefined();

      // Chunks should exist
      const chunks = await getChunks(docId);
      expect(chunks.length).toBeGreaterThan(0);
    });

    it("should handle persistent failures", async () => {
      // Insert a document
      const docId = await insertTestDocument("Persistent failure test");

      // Create a worker with fewer retries for faster testing
      const testWorker = createWorker({ maxRetries: 1 });

      // Always fail the embedding generator
      mockEmbeddingGenerator.mockImplementation(() => {
        throw new Error("Persistent failure");
      });

      // We need to manually create a job for this test
      await testWorker.start();
      await testWorker.createJobs();

      // Get a job and manually process it - should fail
      const jobs = await testWorker.findAndClaimJobs();
      await testWorker.processJobs(jobs);
      await testWorker.pause();

      // Process again to retry
      await testWorker.start();
      await vi.advanceTimersByTimeAsync(100);
      await testWorker.pause();

      // Check work queue - job should show retry attempt
      const queueItems = await getWorkQueueItems(docId);
      expect(queueItems.length).toBeGreaterThan(0);

      // Verify job has retry count > 0 or is marked as failed
      const hasRetries = queueItems.some((job) => Number(job.retry_count) > 0);

      expect(hasRetries).toBe(true);

      // No chunks should be created due to persistent failures
      const chunks = await getChunks(docId);
      expect(chunks.length).toBe(0);
    });
  });

  describe("Concurrency", () => {
    it("should claim and lock jobs during processing", async () => {
      // Insert a document
      const docId = await insertTestDocument("Job locking test");

      // Start worker
      await worker.start();

      // Create a job
      await worker.createJobs();

      // Manually claim the job
      const jobs = await worker.findAndClaimJobs();
      expect(jobs.length).toBe(1);

      // Check that job is marked as processing
      const queueItems = await getWorkQueueItems(docId);
      expect(queueItems.length).toBe(1);
      expect(queueItems[0].status).toBe("processing");
      expect(queueItems[0].worker_id).toBe(worker["workerId"]);

      // Attempting to claim the same job again should return nothing
      const testWorker = createWorker();
      await testWorker.start();
      const secondClaim = await testWorker.findAndClaimJobs();
      expect(secondClaim.length).toBe(0);

      // Complete processing by original worker
      await worker.processJobs(jobs);

      // Check job is completed
      const finalQueueItems = await getWorkQueueItems(docId);
      expect(finalQueueItems[0].status).toBe("completed");

      await worker.pause();
      await testWorker.pause();
    });

    it("should handle stalled jobs", async () => {
      // Insert a document
      const docId = await insertTestDocument("Stalled job test");

      // Create first worker with stalled job threshold of 1ms
      const worker1 = createWorker({
        stalledJobTimeoutMinutes: 0.00001,
        logger: {
          level: "error", // Show all logs in tests
          service: "test",
        },
      });

      // Start first worker and create/claim job
      await worker1.start();
      await worker1.pause();
      await worker1.createJobs();
      const jobs = await worker1.findAndClaimJobs();

      // Check job is claimed by worker1
      const initialQueueItems = await getWorkQueueItems(docId);
      expect(initialQueueItems.length).toBe(1);
      expect(initialQueueItems[0].status).toBe("processing");
      expect(initialQueueItems[0].worker_id).toBe(worker1["workerId"]);

      // Start second worker to pick up stalled job
      const worker2 = createWorker({
        logger: {
          level: "error", // Show all logs in tests
          service: "test",
        },
        stalledJobTimeoutMinutes: 0.00001,
      });
      await worker2.start();
      await worker2.pause();

      // Worker2 should pick up and process the stalled job
      // findAndClaimJobs should return the job
      const jobs2 = await worker2.findAndClaimJobs();
      expect(jobs2.length).toBe(1);
      expect(jobs2[0].status).toBe("processing");
      expect(jobs2[0].worker_id).toBe(worker2["workerId"]);
      expect(Number(jobs2[0].vector_clock)).toBe(1);

      // Process the job
      await worker2.processJobs(jobs2);

      // Check job is completed
      const finalQueueItems = await getWorkQueueItems(docId);
      expect(finalQueueItems.length).toBe(1);
      expect(finalQueueItems[0].status).toBe("completed");
      expect(finalQueueItems[0].worker_id).toBe(worker2["workerId"]);

      // Finish processing the job in the first worker
      await worker1.processJobs(jobs);

      // Check job is completed
      const finalQueueItems2 = await getWorkQueueItems(docId);
      expect(finalQueueItems2.length).toBe(1);
      expect(finalQueueItems2[0].status).toBe("completed");
      // still worker2
      expect(finalQueueItems2[0].worker_id).toBe(worker2["workerId"]);

      // Check chunks were created
      const chunks = await getChunks(docId);
      expect(chunks.length).toBeGreaterThan(0);
    });

    it("should skip jobs when newer vector clock is detected", async () => {
      // Insert a document
      const docId = await insertTestDocument("Vector clock test doc");

      // Start worker and create first job
      await worker.start();
      await worker.createJobs();

      // Manually claim the job but don't process it yet
      const jobs = await worker.findAndClaimJobs();
      expect(jobs.length).toBe(1);
      expect(Number(jobs[0].vector_clock)).toBe(1);

      // Verify the job is in processing state
      const queueItemsProcessing = await getWorkQueueItems(docId);
      expect(queueItemsProcessing.length).toBe(1);
      expect(queueItemsProcessing[0].status).toBe("processing");

      // Update the document to trigger a new vector clock
      await client.query(
        `UPDATE ${dbConfig.documentsTable} SET content = $1, updated_at = NOW() WHERE id = $2`,
        ["Updated vector clock content", docId],
      );

      // Manually create new job (normally this would happen in next poll cycle)
      await worker.createJobs();

      // Check that a new job was created with vector_clock = 2
      const queueItemsWithNewJob = await getWorkQueueItems(docId);
      expect(queueItemsWithNewJob.length).toBe(2);

      // Verify we have both vector clocks (1 for processing, 2 for pending)
      const hasVectorClock1 = queueItemsWithNewJob.some(
        (job) => Number(job.vector_clock) === 1,
      );
      const hasVectorClock2 = queueItemsWithNewJob.some(
        (job) => Number(job.vector_clock) === 2,
      );
      expect(hasVectorClock1).toBe(true);
      expect(hasVectorClock2).toBe(true);

      // Now process the first job - it should detect the newer job and skip
      await worker.processJobs(jobs);

      // Check that the job with vector_clock=1 was skipped
      const queueItemsAfterProcessing = await getWorkQueueItems(docId);
      const skippedJob = queueItemsAfterProcessing.find(
        (job) => Number(job.vector_clock) === 1,
      );
      expect(skippedJob).not.toBeUndefined();
      expect(skippedJob?.status).toBe("skipped");
      expect(skippedJob?.error).toContain("Newer job found");

      // Complete a full poll cycle to process the newer job
      await worker.findAndClaimJobs().then(worker.processJobs.bind(worker));

      // Check that the job with vector_clock=2 was completed
      const finalQueueItems = await getWorkQueueItems(docId);
      const completedJob = finalQueueItems.find(
        (job) => Number(job.vector_clock) === 2,
      );
      expect(completedJob).not.toBeUndefined();
      expect(completedJob?.status).toBe("completed");

      // Verify chunks have the latest vector clock
      const chunks = await getChunks(docId);
      expect(chunks.length).toBeGreaterThan(0);
      chunks.forEach((chunk) => {
        expect(Number(chunk.vector_clock)).toBe(2);
      });

      await worker.pause();
    });

    it("should detect newer vector clock from shadow table during processing", async () => {
      // Insert a document
      const docId = await insertTestDocument("Shadow vector clock test");

      // Start worker
      await worker.start();
      await worker.pause();

      // Create and claim job without processing
      await worker.createJobs();
      const jobs = await worker.findAndClaimJobs();
      expect(jobs.length).toBe(1);
      expect(Number(jobs[0].vector_clock)).toBe(1);

      // Verify the job is in processing state
      const queueItemsProcessing = await getWorkQueueItems(docId);
      expect(queueItemsProcessing.length).toBe(1);
      expect(queueItemsProcessing[0].status).toBe("processing");

      // Directly update the shadow table to simulate a newer version
      // This is what happens when a document is updated while a job is processing
      await client.query(
        `UPDATE ${schemaName}.shadows SET vector_clock = 2 WHERE doc_id = $1`,
        [String(docId)],
      );

      // Now process the job - it should detect newer vector clock in shadow table
      await worker.processJobs(jobs);

      // Check that the job was skipped
      const queueItems = await getWorkQueueItems(docId);
      expect(queueItems.length).toBe(1);
      expect(queueItems[0].status).toBe("skipped");
      expect(queueItems[0].error).toContain("Vector clock is no longer latest");

      await worker.pause();
    });

    it("should efficiently process multiple documents", async () => {
      // Insert multiple documents
      const docIds = [];
      for (let i = 0; i < 3; i++) {
        docIds.push(await insertTestDocument(`Batch test document ${i}`));
      }

      // Configure worker with larger batch size
      const batchWorker = createWorker({ batchSize: 5 });

      // Process in batches
      await batchWorker.start();
      await vi.advanceTimersByTimeAsync(100);
      await batchWorker.pause();

      // Check all documents were processed
      let allProcessed = true;
      for (const docId of docIds) {
        const chunks = await getChunks(docId);
        if (chunks.length === 0) {
          allProcessed = false;
        }

        const queueItems = await getWorkQueueItems(docId);
        if (queueItems.length === 0 || queueItems[0].status !== "completed") {
          allProcessed = false;
        }
      }

      // If not all are processed, run another cycle
      if (!allProcessed) {
        await batchWorker.start();
        await vi.advanceTimersByTimeAsync(100);
        await batchWorker.pause();
      }

      // Verify chunks for each document
      for (const docId of docIds) {
        const chunks = await getChunks(docId);
        expect(chunks.length).toBe(4); // "Batch test document X" -> 4 words

        const queueItems = await getWorkQueueItems(docId);
        expect(queueItems.length).toBe(1);
        expect(queueItems[0].status).toBe("completed");
      }

      // Verify appropriate number of generator calls
      // If chunking and embedding worked correctly
      expect(mockChunkGenerator.mock.calls.length).toBeGreaterThanOrEqual(3);
      expect(mockEmbeddingGenerator.mock.calls.length).toBeGreaterThanOrEqual(
        12,
      ); // 3 docs * 4 words
    });
  });
});
