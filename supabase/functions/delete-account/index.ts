import { createClient } from "jsr:@supabase/supabase-js@2";
import { ErrorCode } from "../_shared/error_code.ts";
import { handleDeleteAccount } from "./handler.ts";
import { unlinkOAuthProviders } from "./provider_unlink.ts";

Deno.serve(async (request) => {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  return await handleDeleteAccount(request, {
    authenticate: async (accessToken) => {
      if (!supabaseUrl || !anonKey) {
        console.error(JSON.stringify({
          event: "account_deletion_auth_config_missing",
          errorCode: ErrorCode.INTERNAL_ERROR.code,
        }));
        return { account: null, error: new Error("auth_config_missing") };
      }

      const client = createClient(supabaseUrl, anonKey, {
        global: { headers: { Authorization: `Bearer ${accessToken}` } },
      });
      const { data, error } = await client.auth.getUser(accessToken);
      const account = data.user
        ? {
          userId: data.user.id,
          identities: (data.user.identities ?? []).map((identity) => ({
            provider: identity.provider,
            providerUserId: String(
              identity.identity_data?.sub ?? identity.identity_data?.id ?? "",
            ),
          })).filter((identity) => identity.providerUserId.length > 0),
        }
        : null;
      return { account, error };
    },
    unlinkProviders: async (account, body) => {
      try {
        await unlinkOAuthProviders({
          identities: account.identities,
          providerTokens: {
            kakao: typeof body.providerTokens?.kakao === "string"
              ? body.providerTokens.kakao
              : undefined,
            google: typeof body.providerTokens?.google === "string"
              ? body.providerTokens.google
              : undefined,
          },
          appleAuthorizationCode:
            typeof body.appleAuthorizationCode === "string"
              ? body.appleAuthorizationCode
              : undefined,
          appleClientId: Deno.env.get("APPLE_CLIENT_ID") ??
            "com.yeogidamm.app",
          appleClientSecret: Deno.env.get("APPLE_CLIENT_SECRET"),
        });
        return {};
      } catch (error) {
        return { error };
      }
    },
    deleteUser: async (userId) => {
      if (!supabaseUrl || !serviceRoleKey) {
        console.error(JSON.stringify({
          event: "account_deletion_admin_config_missing",
          errorCode: ErrorCode.INTERNAL_ERROR.code,
        }));
        return { error: new Error("admin_config_missing") };
      }

      const admin = createClient(supabaseUrl, serviceRoleKey, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
      const { error } = await admin.auth.admin.deleteUser(userId, false);
      return { error };
    },
    log: (entry) => console.info(JSON.stringify(entry)),
  });
});
