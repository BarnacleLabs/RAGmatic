import { RAGmatic, type ChunkData, type EmbeddingData } from "ragmatic";
import * as dotenv from "dotenv";
import { type Movie } from "../../db/schema";
import { chunk } from "llm-chunk";
import { OpenAI } from "openai";

dotenv.config();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

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
        content: `Tell me some trivia about the movie: ${chunk.title || ""}`,
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
    ...chunk,
    trivia: movieTrivia.trivia,
    blooper: movieTrivia.blooper,
  };
}

const recordToChunksFunction = async (movie: Movie): Promise<ChunkData[]> => {
  return chunk(movie.description, {
    minLength: 100,
    maxLength: 1000,
    splitter: "sentence",
    overlap: 0,
  }).map((chunk, index) => {
    return {
      text: chunk,
      // You can add any extra context to the chunk to improve it's relevance
      title: movie.title,
    };
  });
};

const chunkToEmbeddingFunction = async (
  chunk: ChunkData,
): Promise<EmbeddingData> => {
  // A common pattern is to ask an LLM to enrich the chunk with additional metadata, see [HYDE](https://arxiv.org/abs/2212.10496)
  const extra = await askLLM(openai, chunk);
  const response = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: `${chunk.text} Trivia: ${extra.trivia} Blooper: ${extra.blooper}`,
  });
  return {
    embedding: response.data[0].embedding,
    text: chunk.text,
    json: {
      // you can store any metadata next to the embedding
      title: chunk.title,
      trivia: extra.trivia,
      blooper: extra.blooper,
    },
    // even blob data:
    // blob: chunk.blob,
  };
};

const moviesToEmbeddingsPipeline = await RAGmatic.create<Movie>({
  name: "movies_openai_hyde_v1",
  tableToWatch: "movies",
  connectionString: process.env.DATABASE_URL!,
  embeddingDimension: 1536,
  // recordToChunksFunction is called when a new movie is added or updated
  recordToChunksFunction: recordToChunksFunction,
  // chunkToEmbeddingFunction will only be called if the chunk's content has actually changed to avoid expensive re-embeddings
  // you can override the deduplication logic by providing a custom hashFunction
  // by default the chunk data is JSON.stringify'd and md5 hashed to check for changes
  chunkToEmbeddingFunction: chunkToEmbeddingFunction,
});

await moviesToEmbeddingsPipeline.start();

setInterval(async () => {
  const count = await moviesToEmbeddingsPipeline.countRemainingDocuments();
  if (count > 0) {
    console.log(`Remaining documents to embed: ${count}`);
  } else {
    console.log("No remaining documents to embed, you can exit now");
  }
}, 1000);
