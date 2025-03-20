CREATE TABLE IF NOT EXISTS "faqs" (
  "id" serial PRIMARY KEY NOT NULL,
  "title" text NOT NULL,
  "content" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
