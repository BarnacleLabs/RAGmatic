import { RAGmatic, type ChunkData, type EmbeddingData } from "ragmatic";
import * as dotenv from "dotenv";
import { type Movie } from "../../db/schema";
import { chunk } from "llm-chunk";
import { CohereClient } from "cohere-ai";

dotenv.config();

// Initialize Cohere client with API key
const cohere = new CohereClient({
  token: process.env.COHERE_API_KEY,
});

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

const chunkToEmbeddingFunction = async (
  chunk: ChunkData,
): Promise<EmbeddingData> => {
  const text = `movie title: ${chunk.title} description: ${chunk.text}`;
  console.log(`Embedding chunk: ${text}`);

  const response = await cohere.embed({
    texts: [text],
    model: "embed-english-v3.0",
    inputType: "search_document",
  });

  console.log(`done embedding chunk ${text}`);
  return {
    embedding: (response.embeddings as number[][])[0],
    text,
  };
};

const moviesToEmbeddingsPipeline = await RAGmatic.create<Movie>({
  name: "movies_cohere_v1",
  tableToWatch: "movies",
  connectionString: process.env.DATABASE_URL!,
  embeddingDimension: 1024, // embed-english-v3.0 produces 1024-dimension vectors
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
