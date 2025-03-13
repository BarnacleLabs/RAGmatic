import { RAGmatic, type ChunkData, type EmbeddingData } from "ragmatic";
import * as dotenv from "dotenv";
import { type Movie } from "../../db/schema";
import { chunk } from "llm-chunk";
import { OpenAI } from "openai";

dotenv.config();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const transformDocumentToChunks = async (doc: Movie): Promise<ChunkData[]> => {
  return chunk(doc.description, {
    minLength: 100,
    maxLength: 1000,
    splitter: "sentence",
    overlap: 0,
  }).map((chunk, index) => {
    return {
      text: chunk,
      // You can add any extra context to the chunk to improve it's relevance
      title: doc.title,
    };
  });
};

const embedChunk = async (chunk: ChunkData): Promise<EmbeddingData> => {
  const text = `movie title: ${chunk.title} description: ${chunk.text}`;
  console.log(`Embedding chunk: ${text}`);
  const response = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: text,
  });
  console.log(`done embedding chunk ${text}`);
  return {
    embedding: response.data[0].embedding,
    text,
  };
};

const moviesToEmbeddings = await RAGmatic.create<Movie>({
  name: "movies_openai_v1",
  tableToWatch: "movies",
  connectionString: process.env.DATABASE_URL!,
  embeddingDimension: 1536,
  // transformDocumentToChunks is called when a new movie is added or updated
  transformDocumentToChunks,
  // embedChunk will only be called if the chunk's content has actually changed to avoid expensive re-embeddings
  embedChunk,
});

await moviesToEmbeddings.start();

setInterval(async () => {
  const count = await moviesToEmbeddings.countRemainingDocuments();
  console.log(`Remaining documents to embed: ${count}`);
  if (count === 0) {
    console.log("No remaining documents to embed");
    process.exit(0);
  }
}, 1000);
