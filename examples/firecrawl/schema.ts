import {
  pgSchema,
  index,
  pgTable,
  serial,
  text,
  timestamp,
  vector,
  jsonb,
} from "drizzle-orm/pg-core";

export const sitePages = pgTable("site_pages", {
  id: serial("id").primaryKey(),
  url: text("url").notNull().unique(),
  content: text("content").notNull(), // Markdown content
  title: text("title").notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// RAGmatic will create and manage this schema
// This is just for type safety in our application
export const embeddingSchema = pgSchema("ragmatic_firecrawl");
export const sitePagesChunks = embeddingSchema.table("chunks", {
  id: serial("id").primaryKey(),
  docId: serial("doc_id").notNull(),
  vectorClock: serial("vector_clock").notNull().default(0),
  index: serial("index").notNull(),
  chunkHash: text("chunk_hash").notNull(),
  chunkText: text("chunk_text"),
  chunkBlob: text("chunk_blob"),
  chunkJson: jsonb("chunk_json"),
  embedding: vector("embedding", { dimensions: 1536 }).notNull(),
});
