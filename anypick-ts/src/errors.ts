/** anypick errors. */

/** Base class for anypick errors. */
export class AnypickError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnypickError";
  }
}

/**
 * Raised when filtering empties the candidate set.
 *
 * `survivorsByClause` is an ordered mapping of clause name -> count of models
 * surviving *that* clause (cumulative, in application order). The last entry
 * being 0 pinpoints the filter that emptied the set.
 */
export class NoModelsFound extends AnypickError {
  readonly survivorsByClause: Record<string, number>;
  constructor(survivorsByClause: Record<string, number>) {
    const clauses = Object.entries(survivorsByClause)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
    super(`No models survived the filters (${clauses})`);
    this.name = "NoModelsFound";
    this.survivorsByClause = survivorsByClause;
  }
}

/** A provider returned a non-2xx response (other than 401/429). */
export class ProviderError extends AnypickError {
  readonly status: number;
  readonly body: string;
  constructor(status: number, body: string) {
    super(`Provider error ${status}: ${body.slice(0, 200)}`);
    this.name = "ProviderError";
    this.status = status;
    this.body = body;
  }
}

/** A keyed endpoint returned 401. */
export class BadAuth extends AnypickError {
  constructor(message: string = "Missing or invalid API key (401).") {
    super(message);
    this.name = "BadAuth";
  }
}

/** A keyed endpoint returned 429 after backoff was exhausted. */
export class RateLimited extends AnypickError {
  constructor(message: string = "Rate limit exceeded (429).") {
    super(message);
    this.name = "RateLimited";
  }
}
