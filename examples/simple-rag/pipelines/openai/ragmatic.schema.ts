import {
  pgSchema,
  serial,
  integer,
  text,
  jsonb,
  vector,
  index,
} from "drizzle-orm/pg-core";

// RAGmatic will create this `chunks` table when you call ragmatic.create, here we just define the schema so we can use drizzle to query the table.
// The schema is for one pipeline, so you can have multiple pipelines for different embeddings of the same documents.
// The schema name is configured with the `name` option from create. Follows the pattern `ragmatic_${config.name}`
export const embeddingSchema = pgSchema("ragmatic_movies_openai_v1");
export const moviesChunks = embeddingSchema.table(
  "chunks",
  {
    id: serial("id").primaryKey(),
    docId: integer("doc_id").notNull(),
    index: integer("index").notNull(),
    chunkHash: text("chunk_hash").notNull(),
    chunkText: text("chunk_text").notNull(),
    chunkJson: jsonb("chunk_json").default("{}"),
    embedding: vector("embedding", { dimensions: 1536 }),
  },
  (table) => [
    index("embeddingIndex").using(
      "hnsw",
      table.embedding.op("vector_cosine_ops"),
    ),
  ],
);
export type MovieChunk = typeof moviesChunks.$inferSelect;
