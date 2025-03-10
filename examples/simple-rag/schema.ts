import {
  pgSchema,
  index,
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  vector,
  jsonb,
} from "drizzle-orm/pg-core";

export const movies = pgTable("movies", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  year: integer("year").notNull(),
  description: text("description").notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// RAGmatic will create this table.
// The schema is for one tracker, so you can have multiple trackers for different embeddings of the same documents.
// The schema name is configured with the `trackerName` option in the setup. Follows the pattern `ragmatic_${config.trackerName || 'default'}`
// The table name is configured with the `chunksTable` option in the setup.
export const embeddingSchema = pgSchema("ragmatic_default");
export const moviesChunks = embeddingSchema.table(
  "chunks",
  {
    id: serial("id").primaryKey(),
    docId: integer("doc_id").notNull(),
    index: integer("index").notNull(),
    chunkHash: text("chunk_hash").notNull(),
    chunkText: text("chunk_text").notNull(),
    metadata: jsonb("metadata").default("{}"),
    embedding: vector("embedding", { dimensions: 1536 }),
  },
  (table) => [
    index("embeddingIndex").using(
      "hnsw",
      table.embedding.op("vector_cosine_ops"),
    ),
  ],
);
