// @ts-ignore
import pg from "pg";
import crypto from "crypto";
import {
  WorkerConfig,
  ChunkData,
  EmbeddingData,
  ChunkRecord,
  ErrorType,
  Job,
} from "./types";
import { ProcessingError } from "./utils/errors";
import { PREFIX, WORK_QUEUE_TABLE } from "./utils/constants";
import { sql } from "./utils/utils";
import { createLogger, Logger } from "./utils/logger";

/**
 * A worker that polls the shadow table for dirty records and processes them.
 * @param config - The configuration for the worker.
 */
export class Worker<T> {
  private pool: pg.Pool;
  private pollingInterval: number;
  running: Promise<void> | null = null;
  private connected: boolean = false;
  private timer: NodeJS.Timeout | null = null;
  private createJobsTimer: NodeJS.Timeout | null = null;
  private createJobsRunning: Promise<void> | null = null;
  private logger: Logger;

  // Config:
  private workerId: string = crypto.randomUUID();
  private maxRetries: number;
  private initialRetryDelay: number;
  private batchSize: number;
  private schemaName: string;
  private chunkGenerator: (doc: T) => Promise<ChunkData[]>;
  private embeddingGenerator: (
    chunk: ChunkData,
    index: number,
  ) => Promise<EmbeddingData>;
  private hashFunction: (chunk: ChunkData) => Promise<string>;

  // Config loaded from db:
  private shadowTable: string | null = null;
  private chunksTable: string | null = null;
  private documentsTable: string | null = null;
  private embeddingDimension: number | null = null;
  private docIdType: string | null = null;
  private stalledJobTimeoutMinutes: number;
  constructor(private config: WorkerConfig<T>) {
    this.pollingInterval = config.pollingIntervalMs || 1000;
    this.maxRetries = config.maxRetries || 3;
    this.initialRetryDelay = config.initialRetryDelayMs || 1000;
    this.batchSize = config.batchSize || 5;
    this.stalledJobTimeoutMinutes = config.stalledJobTimeoutMinutes || 1;
    if (!config.dbClient && !config.connectionString) {
      throw new Error("Either dbClient or connectionString must be provided");
    }
    this.pool = new pg.Pool({ connectionString: config.connectionString });
    this.schemaName = `${PREFIX}${config.trackerName.replace(/[^a-zA-Z0-9_]/g, "_")}`;

    this.chunkGenerator =
      config.chunkGenerator ||
      (defaultChunkGenerator as (doc: T) => Promise<ChunkData[]>);
    this.embeddingGenerator =
      config.embeddingGenerator || defaultEmbeddingGenerator;
    this.hashFunction = config.hashFunction || defaultHash;

    // Initialize logger
    this.logger = createLogger({
      ...config.logger,
      trackerName: config.trackerName,
    });

    this.logger.debug("Worker instance created", {
      workerId: this.workerId,
      trackerName: config.trackerName,
      batchSize: this.batchSize,
      pollingInterval: this.pollingInterval,
    });
  }

  async loadConfig(): Promise<void> {
    // Get config values
    const configRes = await this.pool.query(sql`
      SELECT
        key,
        value
      FROM
        ${this.schemaName}.config
    `);
    const configMap = configRes.rows.reduce(
      (
        acc: Record<string, string | null>,
        row: { key: string; value: string },
      ) => {
        acc[row.key] = row.value || null;
        return acc;
      },
      {},
    );
    this.documentsTable = configMap.documentsTable as string;
    this.shadowTable = configMap.shadowTable as string;
    this.chunksTable = configMap.chunksTable as string;
    this.embeddingDimension = Number(configMap.embeddingDimension);
    this.docIdType = configMap.docIdType as string;
    // if any of the values are null, throw an error
    if (
      !this.documentsTable ||
      !this.shadowTable ||
      !this.chunksTable ||
      !this.embeddingDimension ||
      !this.docIdType
    ) {
      throw new ProcessingError(
        "Missing config values. Please run setup() first.",
        ErrorType.Permanent,
      );
    }
  }

  // Start the worker by connecting to the database and beginning the polling loop.
  async start(): Promise<void> {
    this.logger.info("Starting worker", { workerId: this.workerId });

    if (!("query" in this.pool)) {
      const error = new Error(
        "Invalid database client. Please use a pg.Client compatible client or pass a connection string instead.",
      );
      this.logger.error("Failed to start worker", {
        error: error.message,
        workerId: this.workerId,
      });
      throw error;
    }

    if (!this.connected) {
      try {
        // Check if the schema exists
        const schemaCheck = await this.pool.query(sql`
          SELECT
            1
          FROM
            pg_namespace
          WHERE
            nspname = '${this.schemaName}'
        `);

        if (schemaCheck.rowCount === 0) {
          const error = new ProcessingError(
            `Schema ${this.schemaName} does not exist. Please run setupDatabaseTracker() first.`,
            ErrorType.Permanent,
          );
          this.logger.error("Schema not found", {
            error: error.message,
            schema: this.schemaName,
            workerId: this.workerId,
          });
          throw error;
        }

        // Load config from db
        this.logger.debug("Loading configuration from database");
        await this.loadConfig();
        this.connected = true;
        this.logger.info("Worker connected to database", {
          schema: this.schemaName,
          embeddingDimension: this.embeddingDimension,
          documentsTable: this.documentsTable,
          workerId: this.workerId,
        });
      } catch (error) {
        this.logger.error("Failed to connect to database", {
          error: error instanceof Error ? error.message : String(error),
          schema: this.schemaName,
          workerId: this.workerId,
        });
        throw error;
      }
    }

    // Start the polling loop
    this.logger.info("Worker started", { workerId: this.workerId });
    await this.runCreateJobs();
    await this.run();
  }

  async pause(): Promise<void> {
    this.logger.info("Pausing worker", { workerId: this.workerId });
    if (this.createJobsTimer) {
      clearTimeout(this.createJobsTimer);
      this.createJobsTimer = null;
    }
    if (this.createJobsRunning) {
      await this.createJobsRunning;
      this.createJobsRunning = null;
    }
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.running) {
      await this.running;
      this.running = null;
    }
    this.logger.info("Worker paused", { workerId: this.workerId });
  }

  // Stop the worker gracefully by stopping the polling loop and disconnecting.
  async stop(): Promise<void> {
    this.logger.info("Stopping worker", { workerId: this.workerId });
    await this.pause();
    await this.pool.end();
    this.connected = false;
    this.logger.info("Worker stopped", { workerId: this.workerId });
  }

  async runCreateJobs(): Promise<void> {
    if (this.createJobsRunning) return;
    this.createJobsTimer = setTimeout(async () => {
      // Double-check connection status before starting work
      if (!this.connected || this.createJobsRunning) return;
      this.createJobsRunning = this.createJobs();
      await this.createJobsRunning;
      this.createJobsRunning = null;
      await this.runCreateJobs();
    }, this.pollingInterval);
  }

  async run(): Promise<void> {
    if (this.running) return;
    this.timer = setTimeout(async () => {
      // Double-check connection status before starting work
      if (!this.connected || this.running) return;
      this.running = this.poll();
      await this.running;
      this.running = null;
      await this.run();
    }, this.pollingInterval);
  }

  // The polling loop: poll the shadow table for dirty records, process them, and then schedule the next poll.
  async poll(): Promise<void> {
    try {
      this.logger.debug("Starting polling cycle", { workerId: this.workerId });

      // Claim jobs
      this.logger.debug("Finding and claiming pending jobs");
      const jobs = await this.findAndClaimJobs();

      if (jobs.length > 0) {
        this.logger.info("Claimed jobs for processing", {
          jobCount: jobs.length,
          workerId: this.workerId,
        });
      } else {
        this.logger.debug("No jobs to process", { workerId: this.workerId });
      }

      // Process each claimed job
      await this.processJobs(jobs);

      this.logger.debug("Completed polling cycle", { workerId: this.workerId });
    } catch (err) {
      if (err instanceof ProcessingError && err.type === ErrorType.Temporary) {
        this.logger.warn("Temporary failure during processing", {
          error: err.message,
          cause: err.cause
            ? err.cause instanceof Error
              ? err.cause.message
              : String(err.cause)
            : undefined,
          workerId: this.workerId,
        });
      } else {
        // TODO: Consider dead letter queue or error tracking for permanent failures
        this.logger.error("Error during processing", {
          error: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
          workerId: this.workerId,
        });
      }
    }
  }

  async createJobs(): Promise<void> {
    this.logger.debug("Creating jobs from outdated shadow records");
    const client = await this.pool.connect();
    try {
      await client.query(sql`
        SET
          SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL READ COMMITTED
      `);
      await client.query(sql`BEGIN`);

      this.logger.debug("Finding documents that need processing");
      const res = await client.query(sql`
        WITH
          latest_shadow_clocks AS (
            SELECT
              s.doc_id,
              s.vector_clock
            FROM
              ${this.shadowTable} s
          ),
          latest_chunk_clocks AS (
            SELECT
              doc_id,
              MAX(vector_clock) AS max_chunk_vector_clock
            FROM
              ${this.chunksTable}
            GROUP BY
              doc_id
          ),
          -- Select the documents that have a shadow clock greater than the max chunk clock
          -- aka. the documents that have outdated or missing chunks...
          work_needed AS (
            SELECT
              s.doc_id,
              s.vector_clock AS shadow_clock,
              COALESCE(c.max_chunk_vector_clock, 0) AS chunk_clock
            FROM
              latest_shadow_clocks s
              LEFT JOIN latest_chunk_clocks c ON s.doc_id = c.doc_id
            WHERE
              s.vector_clock > COALESCE(c.max_chunk_vector_clock, 0)
          ),
          -- ...and skip the (document, vector_clock) pairs that are already in the work queue
          current_work AS (
            SELECT
              doc_id,
              vector_clock
            FROM
              ${this.schemaName}.${WORK_QUEUE_TABLE}
          )
        SELECT
          w.doc_id,
          w.shadow_clock,
          w.chunk_clock
        FROM
          work_needed w
          LEFT JOIN current_work cw ON w.doc_id = cw.doc_id
          AND w.shadow_clock = cw.vector_clock
        WHERE
          cw.doc_id IS NULL -- Only select work not already in the queue
        ORDER BY
          w.shadow_clock - w.chunk_clock DESC, -- Prioritize documents most out of sync
          w.shadow_clock ASC -- Then older documents first
        LIMIT
          ${this.batchSize};
      `);

      if (res.rows.length > 0) {
        this.logger.info("Creating new jobs in work queue", {
          jobCount: res.rows.length,
          workerId: this.workerId,
          docIds: res.rows.map((r: { doc_id: string }) => r.doc_id),
        });

        await client.query(sql`
          INSERT INTO
            ${this
            .schemaName}.${WORK_QUEUE_TABLE} (doc_id, vector_clock, status)
          VALUES
            ${res.rows
            .map(
              (r: { doc_id: string; shadow_clock: number }) => sql`
                (
                  ${r.doc_id},
                  ${r.shadow_clock},
                  'pending'
                )
              `,
            )
            .join(",")}
          ON CONFLICT DO NOTHING;
        `);
      } else {
        this.logger.debug("No new jobs to create", { workerId: this.workerId });
      }

      await client.query(sql`COMMIT`);
    } catch (err) {
      await client.query(sql`ROLLBACK`);
      this.logger.error("Failed to create jobs", {
        error: err instanceof Error ? err.message : String(err),
        workerId: this.workerId,
      });
      throw err;
    } finally {
      client.release();
    }
  }

  async findUnclaimedOrStalledJobs(client: pg.PoolClient): Promise<Job[]> {
    this.logger.debug("Finding unclaimed or stalled jobs", {
      workerId: this.workerId,
    });
    const res = await client.query(sql`
      SELECT
        doc_id,
        vector_clock,
        status,
        processing_started_at,
        worker_id,
        error,
        retry_count,
        created_at
      FROM
        ${this.schemaName}.${WORK_QUEUE_TABLE}
      WHERE
        status = 'pending'
        OR status = 'processing'
        AND processing_started_at < NOW() - INTERVAL '${this
        .stalledJobTimeoutMinutes} minutes'
      FOR UPDATE
        SKIP LOCKED
      LIMIT
        ${this.batchSize}
    `);
    this.logger.debug("Found jobs", {
      jobIdsAndVectorClocks: res.rows.map(
        (r: { doc_id: string; vector_clock: number }) => ({
          doc_id: r.doc_id,
          vector_clock: r.vector_clock,
        }),
      ),
      jobCount: res.rows.length,
      workerId: this.workerId,
    });
    return res.rows;
  }

  async claimJobs(
    client: pg.PoolClient,
    jobs: { doc_id: string; vector_clock: number }[],
    worker_id: string,
  ): Promise<Job[]> {
    if (jobs.length === 0) {
      return [];
    }

    // Build WHERE conditions for each job pair
    const conditions: string[] = [];
    const params: (string | number)[] = [worker_id]; // $1 is worker_id
    let paramIndex = 2;

    for (const job of jobs) {
      conditions.push(
        `(doc_id = $${paramIndex} AND vector_clock = $${paramIndex + 1})`,
      );
      params.push(job.doc_id, job.vector_clock);
      paramIndex += 2;
    }

    const whereClause = conditions.join(" OR ");

    // Create the final query
    const query = `
      UPDATE ${this.schemaName}.${WORK_QUEUE_TABLE}
      SET
        status = 'processing',
        processing_started_at = NOW(),
        worker_id = $1
      WHERE 
        (${whereClause})
        AND (
          status = 'pending'
          OR (
            status = 'processing'
            AND processing_started_at < NOW() - INTERVAL '${this.stalledJobTimeoutMinutes} minutes'
          )
        )
      RETURNING *
    `;

    const res = await client.query(query, params);
    this.logger.debug("Claimed jobs", {
      jobIdsAndVectorClocks: res.rows.map(
        (r: { doc_id: string; vector_clock: number }) => ({
          doc_id: r.doc_id,
          vector_clock: r.vector_clock,
        }),
      ),
      jobCount: res.rows.length,
      workerId: this.workerId,
    });
    return res.rows;
  }

  async findAndClaimJobs(): Promise<Job[]> {
    this.logger.debug("Finding and claiming jobs", {
      workerId: this.workerId,
    });
    // Process jobs
    const client = await this.pool.connect();
    try {
      await client.query(sql`
        SET
          SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL READ COMMITTED
      `);
      await client.query(sql`BEGIN`);
      let jobs = await this.findUnclaimedOrStalledJobs(client);
      jobs = await this.claimJobs(client, jobs, this.workerId);
      await client.query(sql`COMMIT`);
      this.logger.debug("Claimed jobs", {
        jobCount: jobs.length,
        workerId: this.workerId,
      });
      return jobs;
    } catch (err) {
      this.logger.error("Failed to find and claim jobs", {
        error: err instanceof Error ? err.message : String(err),
        workerId: this.workerId,
      });
      await client.query(sql`ROLLBACK`);
      throw err;
    } finally {
      client.release();
    }
  }

  async processJobs(jobs: Job[]): Promise<void> {
    for (const job of jobs) {
      await this.processJob(job);
    }
  }

  async skipJob(doc_id: string, vector_clock: number, error?: string) {
    this.logger.debug("Skipping job", {
      docId: doc_id,
      vectorClock: vector_clock,
      error: error,
    });
    await this.pool.query(
      sql`
        UPDATE ${this.schemaName}.${WORK_QUEUE_TABLE}
        SET
          status = 'skipped',
          error = $3,
          completed_at = NOW()
        WHERE
          doc_id = $1
          AND vector_clock = $2
      `,
      [doc_id, vector_clock, error],
    );
  }

  async failJob(doc_id: string, vector_clock: number, error: Error) {
    this.logger.debug("Failing job", {
      docId: doc_id,
      vectorClock: vector_clock,
      error: error.message,
    });
    await this.pool.query(
      sql`
        UPDATE ${this.schemaName}.${WORK_QUEUE_TABLE}
        SET
          status = 'failed',
          error = $3,
          completed_at = NOW()
        WHERE
          doc_id = $1
          AND vector_clock = $2
      `,
      [doc_id, vector_clock, error],
    );
  }

  async getLatestJob(doc_id: string): Promise<{ vector_clock: number } | null> {
    const res = await this.pool.query(
      sql`
        SELECT
          vector_clock
        FROM
          ${this.schemaName}.${WORK_QUEUE_TABLE}
        WHERE
          doc_id = $1
        ORDER BY
          vector_clock DESC
        LIMIT
          1
      `,
      [doc_id],
    );
    if (res.rows.length === 0) {
      return null;
    }
    return { vector_clock: res.rows[0].vector_clock };
  }

  async processJob(job: Job): Promise<void> {
    this.logger.debug("Processing job", {
      docId: job.doc_id,
      vectorClock: job.vector_clock,
      workerId: this.workerId,
    });
    // If there's a newer job, complete the current job
    const latestJob = await this.getLatestJob(job.doc_id);
    if (latestJob && latestJob.vector_clock > job.vector_clock) {
      // complete the current job
      this.logger.debug("Newer job found, skipping", {
        docId: job.doc_id,
        vectorClock: job.vector_clock,
        latestVectorClock: latestJob.vector_clock,
      });
      await this.skipJob(job.doc_id, job.vector_clock, "Newer job found");
      return;
    }

    // Get doc
    const docRes = await this.pool.query(
      sql`
        SELECT
          *
        FROM
          ${this.documentsTable}
        WHERE
          id = $1
      `,
      [job.doc_id],
    );
    if (docRes.rows.length === 0) {
      // Document was deleted, skip
      this.logger.debug("Document already deleted, skipping", {
        docId: job.doc_id,
        vectorClock: job.vector_clock,
      });
      await this.skipJob(job.doc_id, job.vector_clock, "Document deleted");
      return;
    }
    const doc = docRes.rows[0] as T;

    // Generate chunks
    const chunks = await this.chunkGenerator(doc);
    const newChunkHashes = await Promise.all(
      chunks.map(async (c, i) => {
        const hash = await this.hashFunction(c);
        return `${hash}-${i}`;
      }),
    );

    const client = await this.pool.connect();
    try {
      await client.query(sql`BEGIN`);
      // Process chunks
      const { deduplicatedNew, deduplicatedOld } =
        await this.dedupeAndRemoveOld(client, job.doc_id, newChunkHashes);
      const toEmbed = chunks
        .map((c, index) => ({ ...c, index, hash: newChunkHashes[index] }))
        .filter((chunk, i) => deduplicatedNew.has(chunk.hash));

      // Generate embeddings
      const newChunks: ChunkRecord[] = await Promise.all(
        toEmbed.map(async (chunk, i) =>
          this.generateEmbeddingForChunk(
            chunk,
            i,
            chunk.hash,
            job.doc_id,
            job.vector_clock,
          ),
        ),
      );

      // Insert the new chunks
      await this.insertNewChunks(client, job.doc_id, newChunks);

      // Remove the old chunks
      await this.removeOldChunks(
        client,
        job.doc_id,
        Array.from(deduplicatedOld),
      );

      // Update vector clock (of existing chunks)
      await client.query(
        sql`
          UPDATE ${this.chunksTable}
          SET
            vector_clock = $1
          WHERE
            doc_id = $2
        `,
        [job.vector_clock, job.doc_id],
      );

      // Update job and check vector clock is still latest, otherwise roll back
      // also check if the worker is still the same worker that claimed the job
      const updateRes = await client.query(
        sql`
          WITH
            latest_shadow_clock AS (
              SELECT
                vector_clock AS latest_vector_clock
              FROM
                ${this.shadowTable}
              WHERE
                doc_id = $1
            ),
            updated AS (
              UPDATE ${this.schemaName}.${WORK_QUEUE_TABLE}
              SET
                status = 'completed',
                completed_at = NOW()
              WHERE
                doc_id = $1
                AND worker_id = $3
                AND vector_clock = $2
                AND vector_clock = (
                  SELECT
                    latest_vector_clock
                  FROM
                    latest_shadow_clock
                )
              RETURNING
                *
            )
          SELECT
            *
          FROM
            updated
        `,
        [job.doc_id, job.vector_clock, this.workerId],
      );
      if (updateRes.rowCount === 0) {
        // Vector clock is no longer latest, roll back
        this.logger.debug(
          "Vector clock is no longer latest or worker is not the job owner, rolling back",
          {
            docId: job.doc_id,
            vectorClock: job.vector_clock,
            workerId: this.workerId,
          },
        );
        await client.query(sql`ROLLBACK`);

        // check if there is a new owner or a newer job
        const shadowRes = await client.query(
          sql`
            SELECT
              vector_clock
            FROM
              ${this.shadowTable}
            WHERE
              doc_id = $1
          `,
          [job.doc_id],
        );
        if (shadowRes.rows[0]?.vector_clock > job.vector_clock) {
          // complete the current job as skipped
          this.logger.debug(
            "Vector clock is no longer latest, newer job found, skipping",
            {
              docId: job.doc_id,
              vectorClock: job.vector_clock,
              latestVectorClock: shadowRes.rows[0]?.vector_clock,
            },
          );
          await this.skipJob(
            job.doc_id,
            job.vector_clock,
            "Vector clock is no longer latest, newer job found",
          );
        } // else there is a new owner, so we don't need to do anything
      } else {
        // commit
        await client.query(sql`COMMIT`);
      }
    } catch (err) {
      await client.query(sql`ROLLBACK`);
      // if retries left, retry
      if (job.retry_count < this.maxRetries) {
        await this.retryJob(job, err as Error);
        return;
      } else {
        await this.failJob(job.doc_id, job.vector_clock, err as Error);
      }
    } finally {
      client.release();
    }
  }

  async retryJob(job: Job, err: Error): Promise<void> {
    this.logger.info("Retrying job", {
      docId: job.doc_id,
      vectorClock: job.vector_clock,
      error: err.message,
      workerId: this.workerId,
      retryCount: job.retry_count + 1,
    });

    await this.pool.query(
      sql`
        UPDATE ${this.schemaName}.${WORK_QUEUE_TABLE}
        SET
          status = 'pending',
          processing_started_at = NULL,
          worker_id = NULL,
          error = $3,
          retry_count = retry_count + 1
        WHERE
          doc_id = $1
          AND vector_clock = $2
      `,
      [job.doc_id, job.vector_clock, err.message],
    );
  }

  async dedupeAndRemoveOld(
    client: pg.PoolClient,
    doc_id: string,
    newChunkHashes: string[],
  ): Promise<{ deduplicatedNew: Set<string>; deduplicatedOld: Set<string> }> {
    const existingChunks = await client.query(
      sql`
        SELECT
          chunk_hash
        FROM
          ${this.chunksTable}
        WHERE
          doc_id = $1
      `,
      [doc_id],
    );
    const existingHashes = new Set<string>(
      existingChunks.rows.map((r: { chunk_hash: string }) => r.chunk_hash),
    );
    const deduplicatedNew = new Set(
      newChunkHashes.filter((hash: string) => !existingHashes.has(hash)),
    );
    const deduplicatedOld = new Set(
      [...existingHashes].filter(
        (hash: string) => !newChunkHashes.includes(hash),
      ),
    );
    return { deduplicatedNew, deduplicatedOld };
  }

  async removeOldChunks(
    client: pg.PoolClient,
    doc_id: string,
    chunk_hashes: string[],
  ): Promise<void> {
    await client.query(
      sql`
        DELETE FROM ${this.chunksTable}
        WHERE
          doc_id = $1
          AND chunk_hash = ANY ($2)
      `,
      [doc_id, chunk_hashes],
    );
  }

  async generateEmbeddingForChunk(
    chunk: ChunkData,
    index: number,
    hash: string,
    doc_id: string,
    vector_clock: number,
  ): Promise<ChunkRecord> {
    try {
      // Generate the embedding.
      // NOTE you can modify the text and metadata before returning them, eg.: "call an llm to get a summary"
      // but deduplication is based on the original chunk object that the hash is generated from.
      const { embedding, ...rest } = await this.embeddingGenerator(
        chunk,
        index,
      );
      // Add validation for embedding
      if (!Array.isArray(embedding)) {
        throw new ProcessingError(
          `Invalid embedding format: expected number[], got ${typeof embedding}`,
          ErrorType.Permanent,
        );
      }

      if (embedding.length !== this.embeddingDimension) {
        throw new ProcessingError(
          `Invalid embedding dimension: expected ${this.embeddingDimension}, got ${embedding.length}`,
          ErrorType.Permanent,
        );
      }

      if (!embedding.every((n) => typeof n === "number")) {
        throw new ProcessingError(
          "Invalid embedding: all elements must be numbers",
          ErrorType.Permanent,
        );
      }

      // Convert the number[] to pgvector format
      const pgvectorEmbedding = `[${embedding.join(",")}]`;
      return {
        ...rest,
        hash,
        embedding: pgvectorEmbedding,
        index,
        vector_clock,
      };
    } catch (err: unknown) {
      // If it's already a ProcessingError, rethrow it
      if (err instanceof ProcessingError) {
        throw err;
      }
      // Otherwise wrap it
      if (err instanceof Error) {
        throw new ProcessingError(
          `Error generating embedding for doc_id ${doc_id}: ${err.message}`,
          ErrorType.Temporary,
          err,
        );
      }
      throw new ProcessingError(
        `Error generating embedding for doc_id ${doc_id}: Unknown error`,
        ErrorType.Temporary,
        err as Error,
      );
    }
  }

  async insertNewChunks(
    client: pg.PoolClient,
    doc_id: string,
    chunks: ChunkRecord[],
  ): Promise<void> {
    if (chunks.length === 0) return;

    const values = chunks
      .map(
        (_, i) =>
          `($1, $${i * 7 + 2}, $${i * 7 + 3}, $${i * 7 + 4}, $${i * 7 + 5}, $${i * 7 + 6}, $${i * 7 + 7}, $${i * 7 + 8})`,
      )
      .join(",");
    const params = [
      doc_id,
      ...chunks.flatMap((c) => [
        c.hash,
        "text" in c ? c.text : null,
        "json" in c ? c.json : null,
        "blob" in c ? c.blob : null,
        c.embedding,
        c.index,
        c.vector_clock,
      ]),
    ];

    await client.query(
      sql`
        INSERT INTO
          ${this.chunksTable} (
            doc_id,
            chunk_hash,
            chunk_text,
            chunk_json,
            chunk_blob,
            embedding,
            index,
            vector_clock
          )
        VALUES
          ${values}
      `,
      params,
    );
  }
}

async function defaultHash(chunk: ChunkData): Promise<string> {
  let hash: string = "";

  // Handle Blob data by hashing its array buffer
  const { blob, ...rest } = chunk;
  if (blob instanceof Blob) {
    const arrayBuffer = await chunk.blob.arrayBuffer();
    hash = crypto
      .createHash("md5")
      .update(Buffer.from(arrayBuffer))
      .digest("hex");
  }

  // Handle JSON data by hashing its stringified version
  hash += crypto.createHash("md5").update(JSON.stringify(rest)).digest("hex");
  return hash;
}

function defaultChunkGenerator(doc: {
  text?: string;
  blob?: Blob;
  [key: string]: any;
}): Promise<ChunkData[]> {
  // try to get doc.text and treat the entire content as one chunk.
  const { text, blob, ...json } = { ...doc };
  // keep blob out of json
  return Promise.resolve([{ text, json: { ...json, text }, blob }]);
}

function defaultEmbeddingGenerator(
  chunk: ChunkData,
  index: number,
): Promise<EmbeddingData> {
  // TODO
  return Promise.resolve({
    embedding: [],
    text: chunk.text,
    json: chunk.json,
    blob: chunk.blob,
  });
}
