import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";

/**
 * One scope for every JavaScript analysis in this process. A healthy worker
 * stays parked between commands; {@link closeCliJavaScriptResources} stops it.
 * Pending cleanup is still retried before each command returns. This owner is
 * separate from the analysis command so the executable can close the scope
 * without loading JavaScript analysis for commands that never used it.
 */
let retainedScope: ArtifactResourceScope | undefined;
/** One shutdown shared by the exit callback and the dispatch `finally`. */
let closing: Promise<void> | undefined;

/** The process-owned JavaScript analysis scope, created on first use. */
export const cliJavaScriptResourceScope = (): ArtifactResourceScope => {
  retainedScope ??= new ArtifactResourceScope();
  return retainedScope;
};

/**
 * Stop the process-owned JavaScript worker. Callers that overlap share the
 * attempt in flight. The scope stays owned when shutdown fails, so the next
 * call retries instead of treating the worker as already released.
 */
export const closeCliJavaScriptResources = (): Promise<void> => {
  if (closing !== undefined) return closing;
  const scope = retainedScope;
  if (scope === undefined) return Promise.resolve();
  let published: Promise<void>;
  published = scope
    .close()
    .then(() => {
      if (retainedScope === scope) retainedScope = undefined;
    })
    .finally(() => {
      if (closing === published) closing = undefined;
    });
  closing = published;
  return published;
};
