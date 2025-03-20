# Simple RAG Example

This example demonstrates how to build a Retrieval-Augmented Generation (RAG) system for an example `movies` table using **RAGmatic**. With this you can search through your movie database using natural language queries. **RAGmatic** will setup and keep your embeddings up to date in the background tracking any changes to your movies table.

## Prerequisites

- Docker and Docker Compose
- Node.js (v20 or higher)
- npm
- OpenAI API key (for OpenAI pipelines)
- Cohere API key (for Cohere pipeline)
- Ollama (for Ollama pipeline with Nomic embedding models)

For the Ollama pipeline, you'll need to install Ollama and pull the Nomic embedding model:

```bash
# Install Ollama from https://ollama.com/
# Then pull the Nomic model
ollama pull nomic-embed-text
```

## Setup

1. Clone this example:

```bash
pnpx degit BarnacleLabs/RAGmatic/examples/simple-rag simple-rag
```

2. Create a `.env` file based on `.env.example`

```bash
cp .env.example .env
```

3. Install dependencies:

```bash
npm install
```

4. Start the PostgreSQL database with docker compose:

```bash
npm run db:up
```

## Usage

Follow these steps in order to set up and run the movie RAG system:

1. Seed the database with sample movie data:

```bash
npm run seed
```

2. Start one or more RAGmatic pipelines:

```bash
npm run openai        # Uses OpenAI's text-embedding-3-small model
npm run cohere        # Uses Cohere's embed-english-v3.0 model
npm run openai-hyde   # Uses OpenAI with Hypothetical Document Embeddings
npm run ollama        # Uses Ollama with Nomic's embed-text model
```

3. Run semantic searches on your movie database:

```bash
npm run search "a black and white movie about a trial"          # Searches across all available pipelines
npm run search "movies about space" openai                      # Search using only OpenAI pipeline
npm run search "comedies from the 90s" cohere                   # Search using only Cohere pipeline
npm run search "sci-fi thriller" openai-hyde                    # Search using only OpenAI-Hyde pipeline
npm run search "action movies" ollama                           # Search using only Ollama/Nomic pipeline
```

The search tool will automatically check which pipelines have been run and only search those that have embeddings available.

### How It Works

Take a look at the pipeline files to see how each of the RAGmatic pipelines are configured:

- `pipelines/openai/index.ts` - Uses OpenAI embeddings
- `pipelines/cohere/index.ts` - Uses Cohere embeddings
- `pipelines/openai-hyde/index.ts` - Uses OpenAI with HyDE technique
- `pipelines/ollama/index.ts` - Uses Ollama with Nomic embeddings

Each pipeline transforms the movie data into chunks, embeds them using the specified model, and then stores the embeddings in a table. At query time, the `search.ts` file will use drizzle to query the embeddings and retrieve the most similar movies.

### Example Queries

Try searching with queries like:

- "Find me action movies from the 90s"
- "What are some comedy movies with Tom Hanks?"
- "Show me highly rated sci-fi movies"

### What is HyDE and why should I care?

Hypothetical Document Embeddings (HyDE) is a technique first proposed in the paper [Precise Zero-Shot Dense Retrieval without Relevance Labels](https://arxiv.org/abs/2212.10496).

HyDE works by generating hypothetical documents based on a query with **_the idea that the embedding of the hypothetical document will be more similar to your stored documents in the latent space, than the original query._** We found it's more practical to do this work in advance and pre-compute **hypothetical questions** for your stored documents at embedding time instead of generating **hypothetical documents** at query time.

Eg.:

```js
const query = "What is the capital of France?";
const chunk = "The capital of France is Paris";
const metadata = await askLLM(
  `Write 5 questions the following text can answer: ${chunk}`,
);
similarity(embedding(chunk + metadata), embedding(query)) <
  similarity(embedding(chunk), embedding(query));
```
