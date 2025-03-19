import * as dotenv from "dotenv";
import { searchWithOpenAI } from "./pipelines/openai/search";
import { searchWithOpenAIHyde } from "./pipelines/openai-hyde/search";
import { searchWithCohere } from "./pipelines/cohere/search";
import { searchWithOllama } from "./pipelines/ollama/search";

dotenv.config();

// Get user input from command line
const query = process.argv[2] || "a black and white movie about a trial";
const pipeline = process.argv[3] || "all"; // 'openai', 'cohere', 'openai-hyde', 'ollama', or 'all'

const runSearch = async () => {
  // Handle OpenAI search
  if (pipeline === "openai" || pipeline === "all") {
    const { results, success } = await searchWithOpenAI({ query });
    if (success) {
      console.log(`\nSimilar movies to "${query}" (OpenAI):`, results);
    }
  }

  // Handle OpenAI-Hyde search
  if (pipeline === "openai-hyde" || pipeline === "all") {
    const { results, success } = await searchWithOpenAIHyde({ query });
    if (success) {
      console.log(`\nSimilar movies to "${query}" (OpenAI-Hyde):`, results);
    }
  }

  // Handle Cohere search
  if (pipeline === "cohere" || pipeline === "all") {
    const { results, success } = await searchWithCohere({ query });
    if (success) {
      console.log(`\nSimilar movies to "${query}" (Cohere):`, results);
    }
  }

  // Handle Ollama search
  if (pipeline === "ollama" || pipeline === "all") {
    const { results, success } = await searchWithOllama({ query });
    if (success) {
      console.log(`\nSimilar movies to "${query}" (Ollama/Nomic):`, results);
    }
  }
};

runSearch()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Error running search:", error);
    process.exit(1);
  });
