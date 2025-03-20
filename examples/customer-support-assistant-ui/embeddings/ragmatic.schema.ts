import {
  pgSchema,
  serial,
  integer,
  text,
  jsonb,
  vector,
} from "drizzle-orm/pg-core";

export const embeddingSchema = pgSchema("ragmatic_faqs_openai_v1");
export const faqsChunks = embeddingSchema.table("chunks", {
  id: serial("id").primaryKey(),
  docId: integer("doc_id").notNull(),
  index: integer("index").notNull(),
  chunkHash: text("chunk_hash").notNull(),
  chunkText: text("chunk_text").notNull(),
  chunkJson: jsonb("chunk_json").default("{}"),
  embedding: vector("embedding", { dimensions: 1536 }),
});
export type FaqChunk = typeof faqsChunks.$inferSelect;
