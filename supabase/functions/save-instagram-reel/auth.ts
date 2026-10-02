/** Internal batches require the exact server-only key, never just a key prefix. */
export function hasServiceRoleCredential(
  headers: Headers,
  serviceRoleKey: string | undefined,
): boolean {
  if (!serviceRoleKey) return false;

  // New secret keys are sent in apikey by supabase-js. Keep the bearer path
  // for callers using a legacy service-role JWT.
  const apiKey = headers.get("apikey");
  const bearer = (headers.get("Authorization") ?? "").replace(
    /^Bearer\s+/i,
    "",
  );
  return apiKey === serviceRoleKey || bearer === serviceRoleKey;
}
