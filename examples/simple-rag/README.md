# Simple RAG Example

This example demonstrates how to build a Retrieval-Augmented Generation (RAG) system for an example `movies` table using **RAGmatic**. With this you can search through your movie database using natural language queries. **RAGmatic** will setup and keep your embeddings up to date in the background tracking any changes to your movies table.

## Prerequisites

- Docker and Docker Compose
- Node.js (v20 or higher)
- npm
- OpenAI API key

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

2. Start a RAGmatic pipeline:

```bash
npm run openai
```

3. Run semantic searches on your movie database:

```bash
npm run search "a black and white movie about a trial"
```

### How It Works

Take a look at the `pipelines/openai/index.ts` file to see how the RAGmatic pipeline is configured. It transforms the movie data into chunks, embeds them using OpenAI and then stores the embeddings in a table. At query time, the `search.ts` file will use drizzle to query the embeddings and retrieve the most similar movies.

### Example Queries

Try searching with queries like:

- "Find me action movies from the 90s"
- "What are some comedy movies with Tom Hanks?"
- "Show me highly rated sci-fi movies"

## Advanced: Compare your results with a second embedding pipeline leveraging Hypothetical Document Embeddings

To compare the results of the two pipelines:

1. Start the second pipeline:

```bash
npm run openai-hyde
```

2. Run the comparison:

```bash
npm run compare
```

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
