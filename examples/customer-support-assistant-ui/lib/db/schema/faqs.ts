import { sql } from "drizzle-orm";
import { text, serial, timestamp, pgTable } from "drizzle-orm/pg-core";
import { createSelectSchema } from "drizzle-zod";
import { z } from "zod";

export const faqs = pgTable("faqs", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  content: text("content").notNull(),
  createdAt: timestamp("created_at")
    .notNull()
    .default(sql`now()`),
  updatedAt: timestamp("updated_at")
    .notNull()
    .default(sql`now()`),
});

export type Faq = typeof faqs.$inferSelect;

export const insertFaqSchema = createSelectSchema(faqs).extend({}).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type NewFaqParams = z.infer<typeof insertFaqSchema>;
