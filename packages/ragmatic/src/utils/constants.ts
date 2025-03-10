/**
 * Prefix for all table schemas created by the library
 */
export const PREFIX = "ragmatic_" as const;
/**
 * Name of the shadow table to track changes
 */
export const SHADOW_TABLE = "shadows" as const;
/**
 * Name of the table to store embedding chunks
 */
export const CHUNK_TABLE = "chunks" as const;

/**
 * Name of the work queue table
 */
export const WORK_QUEUE_TABLE = "work_queue" as const;
