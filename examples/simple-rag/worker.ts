import { Worker, ChunkData, EmbeddingData } from "ragmatic";
import { OpenAI } from "openai";
import { chunk } from "llm-chunk";
import * as dotenv from "dotenv";

dotenv.config();

async function startWorker() {
  // Initialize OpenAI client for embeddings
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  // Create pg-auto-rag tracker
  const tracker = new Worker({
    connectionString: process.env.PG_CONNECTION_STRING!,
    trackerName: "default",
    // The worker will poll the database for new documents to process every 1 second
    pollingIntervalMs: 1000,
    // The batch size is the number of documents that will be processed in one go
    batchSize: 3,
    // The maximum number of retries for a failed operation
    maxRetries: 3,
    // The initial retry delay is the delay before the first retry, subsequent retries will be delayed exponentially
    initialRetryDelayMs: 1000,
    // The chunk generator is used to split the document into chunks
    // by default the chunk generator tries to get doc.content and treats the entire content as one chunk.
    // Here we are splitting the description into chunks of 100-1000 characters with 20 characters overlap
    chunkGenerator: async (doc: any): Promise<ChunkData[]> => {
      console.log(`Chunking ${doc.description}`);
      return chunk(doc.description, {
        minLength: 100,
        maxLength: 1000,
        overlap: 20,
      }).map((chunk, index) => {
        console.log(`Chunk ${index} text: ${chunk}`);
        return {
          text: chunk,
          metadata: {
            // You can add any metadata you want to the chunk to improve the relevance of the search
            title: doc.title,
          },
        };
      });
    },
    // the embedding generator will only be called if the chunk's content has actually changed to avoid expensive re-embeddings
    // you can override the deduplication logic by providing a custom hashFunction
    // by default the chunk data is JSON.stringify'd and md5 hashed to check for changes
    embeddingGenerator: async (chunk: ChunkData): Promise<EmbeddingData> => {
      // A common pattern is to ask an LLM to enrich the chunk with additional metadata, see [HYDE](https://arxiv.org/abs/2212.10496)
      // Another pattern is to improve the embedding by adding back the context where the chunk is from, eg. the title of the movie
      const enrichedChunk = await askLLM(openai, chunk);

      // Embed the enriched chunk
      const enrichedChunkText = `${chunk.text} Trivia: ${enrichedChunk?.metadata?.trivia} Blooper: ${enrichedChunk?.metadata?.blooper}`;
      // or `${chunk.metadata.title} - ${chunk.text}`
      const response = await openai.embeddings.create({
        model: "text-embedding-ada-002",
        // You can decide if you want to use the metadata to improve the embedding
        input: enrichedChunkText,
        // input: chunk.text,
      });
      console.log(`Embedding ${chunk.text}`);
      return {
        embedding: response.data[0].embedding,
        text: chunk.text,
        json: chunk.metadata,
      };
    },
  });

  // Start the worker to process embeddings
  await tracker.start();

  console.log("Worker started - processing embeddings in background");
  console.log("Press Ctrl+C to stop");

  // Keep the process running
  process.stdin.resume();
}

async function askLLM(openai: OpenAI, chunk: ChunkData): Promise<ChunkData> {
  // In HYDE you would generate hypothetical questions about the chunk.
  // Here we just ask for trivia about the movie.
  // The point is to show the flexibility of the pipeline which you can have many of
  // and then run an eval to see which embeddings work best for your queries
  const enrichedChunk = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content:
          "You are a helpful assistant with an immense amount of trivia about movies.",
      },
      {
        role: "user",
        content: `Tell me some trivia about the movie: ${chunk?.metadata?.title || ""}`,
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "movieTrivia",
        strict: true,
        schema: {
          type: "object",
          properties: {
            trivia: { type: "string" },
            blooper: { type: "string" },
          },
          required: ["trivia", "blooper"],
          additionalProperties: false,
        },
      },
    },
  });
  const movieTrivia = JSON.parse(
    enrichedChunk.choices[0].message.content || "{}",
  ) as { trivia: string; blooper: string };
  return {
    text: chunk.text,
    metadata: {
      ...chunk.metadata,
      trivia: movieTrivia.trivia,
      blooper: movieTrivia.blooper,
    },
  };
}

startWorker().catch((err) => {
  console.error(err);
  process.exit(1);
});
