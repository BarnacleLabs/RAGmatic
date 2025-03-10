import { ProcessingError, isTemporaryError } from "./errors";
import { ErrorType } from "../types";
import { sleep } from "./utils";

// Exponential backoff delay calculation
export function getRetryDelay(
  initialRetryDelay: number,
  attempt: number,
): number {
  return Math.min(
    initialRetryDelay * Math.pow(2, attempt),
    3000000, // Max delay of 3000 seconds
  );
}

// Retry wrapper for database operations
export async function withRetry<T>(
  operation: () => Promise<T>,
  context: string,
  maxRetries: number,
  initialRetryDelay: number,
  attempt: number = 0,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    attempt++;

    const isTemporary = isTemporaryError(error);

    if (!isTemporary || attempt > maxRetries) {
      console.error(
        `Permanent error or max retries exceeded in "${context}":`,
        error,
      );
      throw new ProcessingError(
        `Failed operation in "${context}"`,
        ErrorType.Permanent,
        error as Error,
      );
    }

    const delay = getRetryDelay(initialRetryDelay, attempt);
    console.log(
      `Temporary error in "${context}", retry ${attempt}/${maxRetries} after ${delay}ms:`,
      error,
    );

    await sleep(delay);
    return withRetry(
      operation,
      context,
      maxRetries,
      initialRetryDelay,
      attempt,
    );
  }
}
