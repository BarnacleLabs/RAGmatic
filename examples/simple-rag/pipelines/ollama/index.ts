import { RAGmatic, type ChunkData, type EmbeddingData } from "ragmatic";
import * as dotenv from "dotenv";
import { type Movie } from "../../db/schema";
import { chunk } from "llm-chunk";
import fetch from "node-fetch";

dotenv.config();

// Ollama API client for Nomic embed models
const ollamaEndpoint =
  process.env.OLLAMA_API_ENDPOINT || "http://localhost:11434";
const embedModel = process.env.OLLAMA_EMBED_MODEL || "nomic-embed-text";

const recordToChunksFunction = async (movie: Movie): Promise<ChunkData[]> => {
  return chunk(movie.description, {
    minLength: 100,
    maxLength: 1000,
    splitter: "sentence",
    overlap: 0,
  }).map((chunk, index) => {
    return {
      text: chunk,
      // You can add any extra context to the chunk to improve its relevance
      title: movie.title,
    };
  });
};

const getEmbeddingsFromOllama = async (text: string): Promise<number[]> => {
  try {
    const response = await fetch(`${ollamaEndpoint}/api/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: embedModel,
        prompt: text,
      }),
    });

    if (!response.ok) {
      throw new Error(
        `Ollama API error: ${response.status} ${response.statusText}`,
      );
    }

    const data = (await response.json()) as { embedding: number[] };
    return data.embedding;
  } catch (error) {
    console.error("Error calling Ollama API:", error);
    throw error;
  }
};

const chunkToEmbeddingFunction = async (
  chunk: ChunkData,
): Promise<EmbeddingData> => {
  const text = `movie title: ${chunk.title} description: ${chunk.text}`;
  console.log(`Embedding chunk: ${text}`);

  const embedding = await getEmbeddingsFromOllama(text);

  console.log(`done embedding chunk ${text}`);
  return {
    embedding,
    text,
  };
};

const moviesToEmbeddingsPipeline = await RAGmatic.create<Movie>({
  name: "movies_ollama_v1",
  tableToWatch: "movies",
  connectionString: process.env.DATABASE_URL!,
  embeddingDimension: 768, // Nomic embed-text is 768 dimensions
  // recordToChunksFunction is called when a new movie is added or updated
  recordToChunksFunction: recordToChunksFunction,
  // chunkToEmbeddingFunction will only be called if the chunk's content has actually changed to avoid expensive re-embeddings
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
