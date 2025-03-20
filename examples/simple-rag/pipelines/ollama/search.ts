import { moviesChunks } from "./ragmatic.schema";
import { movies } from "../../db/schema";
import { drizzle } from "drizzle-orm/node-postgres";
import { cosineDistance, desc, eq, gt, sql } from "drizzle-orm";
import fetch from "node-fetch";
import * as dotenv from "dotenv";

dotenv.config();

// Database connection
const db = drizzle(process.env.DATABASE_URL!);

// Ollama API configuration
const ollamaEndpoint =
  process.env.OLLAMA_API_ENDPOINT || "http://localhost:11434";
const embedModel = process.env.OLLAMA_EMBED_MODEL || "nomic-embed-text";

// Interface for search results
export interface SearchResult {
  similarity: number;
  chunk: string;
  metadata: any;
  docId: number;
  title: string | null;
  year: number | null;
}

// Search options
export interface OllamaSearchOptions {
  query: string;
  topK?: number;
}

// Ollama-specific embedding generator
const generateEmbedding = async (input: string): Promise<number[]> => {
  try {
    const response = await fetch(`${ollamaEndpoint}/api/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: embedModel,
        prompt: input.replaceAll("\n", " "),
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
    console.error(
      "\nError generating Ollama embedding. Check your Ollama server is running and has the Nomic model loaded.",
    );
    console.error("You can load the model with: ollama pull nomic-embed-text");
    return [];
  }
};

// Check if the pipeline table exists and has records
const checkPipelineExists = async (): Promise<boolean> => {
  try {
    const count = await db
      .select({ count: sql<number>`count(*)` })
      .from(moviesChunks)
      .then((result) => Number(result[0].count))
      .catch(() => 0);

    return count > 0;
  } catch (error) {
    return false;
  }
};

// Find similar movies using Ollama embeddings
const findSimilarMovies = async (
  queryEmbedding: number[],
  topK: number = 4,
): Promise<SearchResult[]> => {
  const similarity = sql<number>`
    1 - (${cosineDistance(moviesChunks.embedding, queryEmbedding)})
  `;

  const similarMovies = await db
    .select({
      similarity,
      chunk: moviesChunks.chunkText,
      metadata: moviesChunks.chunkJson,
      docId: moviesChunks.docId,
      title: movies.title,
      year: movies.year,
    })
    .from(moviesChunks)
    .leftJoin(movies, eq(moviesChunks.docId, movies.id))
    .where(gt(similarity, 0.2))
    .orderBy((t) => desc(t.similarity))
    .limit(topK);

  return similarMovies;
};

// Main search function
export const searchWithOllama = async (
  options: OllamaSearchOptions,
): Promise<{ results: SearchResult[]; success: boolean }> => {
  const { query, topK = 4 } = options;

  try {
    // Check if pipeline exists
    const exists = await checkPipelineExists();
    if (!exists) {
      console.log(
        "\nOllama pipeline has not been run yet or has no embeddings. Run: npm run ollama",
      );
      return { results: [], success: false };
    }

    // Generate embedding
    const embedding = await generateEmbedding(query);
    if (embedding.length === 0) {
      return { results: [], success: false };
    }

    // Search using embedding
    const results = await findSimilarMovies(embedding, topK);
    return { results, success: true };
  } catch (error) {
    console.error("\nError searching with Ollama:", error);
    return { results: [], success: false };
  }
};
