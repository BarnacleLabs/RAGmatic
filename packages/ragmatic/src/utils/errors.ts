import { ErrorType } from "../types";

export class ProcessingError extends Error {
  constructor(
    message: string,
    public type: ErrorType,
    public cause?: Error,
  ) {
    super(message);
    this.name = "ProcessingError";
  }
}

// Determine if an error is temporary and should be retried
export function isTemporaryError(error: any): boolean {
  // Network connectivity issues
  if (error.code === "ECONNREFUSED" || error.code === "ECONNRESET") {
    return true;
  }

  // Deadlock detection and serialization failures
  if (error.code === "40P01" || error.code === "40001") {
    return true;
  }

  // Connection pool errors
  if (error.code === "08006" || error.code === "08001") {
    return true;
  }

  // Generic connection errors
  if (error.code && error.code.startsWith("08")) {
    return true;
  }

  return false;
}
