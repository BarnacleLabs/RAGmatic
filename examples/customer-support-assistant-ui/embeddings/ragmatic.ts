import { RAGmatic, type ChunkData, type EmbeddingData } from "ragmatic";
import * as dotenv from "dotenv";
import { type Faq } from "../lib/db/schema/faqs";
import { chunk } from "llm-chunk";
import { OpenAI } from "openai";

dotenv.config();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const recordToChunksFunction = async (faq: Faq): Promise<ChunkData[]> => {
  return chunk(faq.content, {
    minLength: 100,
    maxLength: 1000,
    splitter: "sentence",
    overlap: 0,
  }).map((chunk, index) => ({
    text: chunk,
    title: faq.title,
  }));
};

const chunkToEmbeddingFunction = async (
  chunk: ChunkData,
): Promise<EmbeddingData> => {
  const text = `title: ${chunk.title}\ncontent: ${chunk.text}`;
  const response = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: text,
  });
  return {
    embedding: response.data[0].embedding,
    text,
  };
};

const main = async () => {
  const faqsToEmbeddingsPipeline = await RAGmatic.create<Faq>({
    name: "faqs_openai_v1",
    tableToWatch: "faqs",
    connectionString: process.env.DATABASE_URL!,
    embeddingDimension: 1536,
    recordToChunksFunction: recordToChunksFunction,
    chunkToEmbeddingFunction: chunkToEmbeddingFunction,
  });

  await faqsToEmbeddingsPipeline.start();
};

main().catch(console.error);
