/**
 * Database client interface
 */
export interface DBClient {
  query(queryText: string, values?: any[]): Promise<any>;
  connect(): Promise<void>;
  end(): Promise<void>;
}

/**
 * Error types for retry logic
 */
export enum ErrorType {
  Temporary = "temporary",
  Permanent = "permanent",
}

import { LoggerConfig } from "./utils/logger";

/**
 * Configuration options for setting up the database
 */
export interface Config {
  /**
   * PostgreSQL connection string
   */
  connectionString?: string;
  /**
   * Database client
   */
  dbClient?: DBClient;
  /**
   * Name of the documents table in the public schema
   */
  documentsTable: string;
  /**
   * The type of the id of the documents table, e.g. INT, UUID, etc.
   * @default 'INT'
   */
  docIdType?: "INT" | "UUID" | "TEXT" | "BIGINT" | string;
  /**
   * Dimension of the embedding vectors
   */
  embeddingDimension: number;
  /**
   * Identifier to allow multiple trackers for the same table
   * @default 'default'
   */
  trackerName: "default" | string;
  /**
   * Name of the shadow table to track changes
   * @default 'shadows'
   */
  shadowTable?: "shadows" | string;
  /**
   * Name of the table to store embedding chunks
   * @default 'chunks'
   */
  chunksTable?: "chunks" | string;
  /**
   * If true, skips creating the hnsw index for cosine distance to setup an index manually.
   * Read more: https://github.com/pgvector/pgvector?tab=readme-ov-file#indexing
   * @default false
   */
  skipEmbeddingIndexSetup?: boolean;
  /**
   * Logging configuration options
   */
  logger?: LoggerConfig;
}

/**
 * Configuration options for the worker
 */
export interface WorkerConfig {
  /**
   * PostgreSQL connection string
   */
  connectionString?: string;
  /**
   * Database client
   */
  dbClient?: DBClient;
  /**
   * Name of the tracker to use
   */
  trackerName: string;
  /**
   * Function to generate an embedding vector (and any other metadata) for a new chunk
   * @param chunk - A new chunk that was created by the chunkGenerator, deduplicated by the hashFunction
   * @param index - The index of the chunk in the document
   * @returns The data to store in the database including the embedding vector
   * @description This function is used to generate an embedding for a single chunk
   * It's NOT called when a chunk's content hash has not changed, to avoid expensive re-embedding work.
   */
  embeddingGenerator: (
    chunk: ChunkData,
    index: number,
  ) => Promise<EmbeddingData>;
  /**
   * Optional override for the default chunk generator. Splits a document into smaller chunks deterministically.
   * @param doc - The document to generate chunks from
   * @returns The generated chunks
   * @description It is called every time a new document is added or updated in the database.
   * Note that the deduplication assumes that the chunkGenerator returns chunks in the same order for the same document in a deterministic way.
   * @default returns the document as a single chunk
   */
  chunkGenerator?: (doc: any) => Promise<ChunkData[]>;
  /**
   * Optional override for the default hash function that is used to deduplicate chunks.
   * @param chunk - The chunk to generate a hash for
   * @returns A checksum of the chunk
   * @description This function is used to deduplicate chunks in order to avoid expensive re-embedding work.
   */
  hashFunction?: (chunk: ChunkData) => Promise<string>;
  /**
   * Polling interval in milliseconds
   */
  pollingIntervalMs: number;
  /**
   * Maximum number of dirty shadow records to process per polling cycle
   * @default 5
   */
  batchSize?: number;
  /**
   * Maximum number of retries for temporary errors
   * @default 3
   */
  maxRetries?: number;
  /**
   * Initial retry delay in milliseconds
   * @default 1000
   */
  initialRetryDelayMs?: number;
  /**
   * Maximum time a job can be stalled before being considered dead
   * @default 1
   */
  stalledJobTimeoutMinutes?: number;
  /**
   * Logging configuration options
   * @default { level: 'info', format: 'text' }
   */
  logger?: LoggerConfig;
}

/**
 * Any JSON serializable data to embed
 */
interface ChunkDataBase extends Record<string, any> {}

/**
 * Extended chunk data to embed with blob data
 */
interface ChunkDataWithBlob extends ChunkDataBase {
  /**
   * Blob data to embed
   * If you want to pass a blob and use the default hash function
   * you need to pass the blob as a Buffer here
   */
  blob: Buffer;
}

/**
 * Chunk data to embed
 */
export type ChunkData = ChunkDataWithBlob | ChunkDataBase;

interface EmbeddingDataBase {
  /**
   * Generated embedding vector
   */
  embedding: number[];
}

interface EmbeddingDataWithText extends EmbeddingDataBase {
  /**
   * Text content of the chunk
   */
  text: string;
}

interface EmbeddingDataWithJson extends EmbeddingDataBase {
  /**
   * JSON data that was embedded
   */
  json: Record<string, any>;
}

interface EmbeddingDataWithBlob extends EmbeddingDataBase {
  /**
   * Blob data that was embedded
   */
  blob: Buffer;
}

/**
 * Embedded chunk data to store in the database
 */
export type EmbeddingData =
  | EmbeddingDataWithBlob
  | EmbeddingDataWithJson
  | EmbeddingDataWithText;

interface ChunkRecordBase {
  hash: string;
  index: number;
  embedding: string;
  vector_clock: number;
}

interface ChunkRecordWithText extends ChunkRecordBase {
  text: string;
}

interface ChunkRecordWithJson extends ChunkRecordBase {
  json: Record<string, any>;
}

interface ChunkRecordWithBlob extends ChunkRecordBase {
  blob: Buffer;
}

export type ChunkRecord =
  | ChunkRecordWithBlob
  | ChunkRecordWithJson
  | ChunkRecordWithText;

export type ShadowRecord = {
  shadow: {
    doc_id: string;
    is_dirty: boolean;
    vector_clock: number;
    chunk_count?: number;
    updated_at?: Date;
  };
  doc?: any;
};

export type Job = {
  doc_id: string;
  vector_clock: number;
  status: "pending" | "processing" | "completed" | "failed" | "skipped";
  created_at: Date;
  processing_started_at?: Date;
  completed_at?: Date;
  worker_id?: string;
  error?: string;
  retry_count: number;
};
