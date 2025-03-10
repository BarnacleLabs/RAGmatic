# Simple RAG Example

This example demonstrates how to build a Retrieval-Augmented Generation (RAG) system for an example `movies` table using **RAGmatic**. The system allows you to semantically search through movie information using natural language queries. **RAGmatic** will setup and keep your embeddings up to date in the background tracking any changes to your movie table.

## Prerequisites

- Docker and Docker Compose
- Node.js (v20 or higher)
- npm

## Setup

1. Start the PostgreSQL database with the [pgvector extension](https://github.com/pgvector/pgvector):

```bash
docker compose up -d
```

2. Install dependencies:

```bash
npm install
```

3. Configure the `.env` file with your OpenAI API key:

```bash
cp .env.example .env
```

## Usage

Follow these steps in order to set up and run the movie RAG system:

1. Seed the database with sample movie data:

```bash
npm run seed
```

2. Configure RAGmatic to track your movies table:

```bash
npm run setup
```

3. Start the background worker for processing and updating embeddings:

```bash
npm run worker
```

4. Run semantic searches on your movie database:

```bash
npm run search "A movie about a man who is a superhero"
```

## How It Works

This example showcases:

- Setting up and keeping vector embeddings up to date on your table in PostgreSQL using RAGmatic and a custom pipeline with OpenAI
- How to use drizzle to use the embeddings created by RAGmatic
- Retrieving movie information using natural language queries

## Example Queries

Try searching with queries like:

- "Find me action movies from the 90s"
- "What are some comedy movies with Tom Hanks?"
- "Show me highly rated sci-fi movies"
