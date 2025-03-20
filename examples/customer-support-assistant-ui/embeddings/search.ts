import { embed } from "ai";
import { openai } from "@ai-sdk/openai";
import { db } from "../lib/db/index";
import { faqsChunks, FaqChunk } from "./ragmatic.schema";
import { faqs } from "../lib/db/schema/faqs";
import { cosineDistance, desc, eq, gt, sql } from "drizzle-orm";

const embeddingModel = openai.embedding("text-embedding-3-small");

export const generateEmbedding = async (value: string): Promise<number[]> => {
  const input = value.replaceAll("\\n", " ");
  const { embedding } = await embed({
    model: embeddingModel,
    value: input,
  });
  return embedding;
};

const findSimilarFaqs = async (
  queryEmbedding: number[],
  topK: number = 4,
): Promise<any[]> => {
  const similarity = sql<number>`
    1 - (${cosineDistance(faqsChunks.embedding, queryEmbedding)})
  `;

  const similarFaqChunks = await db
    .select({
      similarity,
      chunk: faqsChunks.chunkText,
      metadata: faqsChunks.chunkJson,
      docId: faqsChunks.docId,
      title: faqs.title,
    })
    .from(faqsChunks)
    .leftJoin(faqs, eq(faqsChunks.docId, faqs.id))
    .where(gt(similarity, 0.2))
    .orderBy((t: any) => desc(t.similarity))
    .limit(topK);

  return similarFaqChunks;
};

const searchFaqs = async (query: string) => {
  console.log("query", query, process.env.OPENAI_API_KEY);
  const embedding = await generateEmbedding(query);
  const similarFaqChunks = await findSimilarFaqs(embedding);
  console.log("similarFaqChunks", similarFaqChunks);
  return similarFaqChunks.map((chunk: any) => ({
    citation: chunk.title,
    chunk: chunk.chunk,
  }));
};

export default searchFaqs;
