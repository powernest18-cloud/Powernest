import { createFileRoute } from "@tanstack/react-router";
import { openOAuthState } from "@/lib/gmail-oauth.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

function dashboardRedirect(requestUrl: string, result: string) {
  const url = new URL("/dashboard", requestUrl);
  url.searchParams.set("gmailOAuth", result);
  url.hash = "settings";
  return Response.redirect(url, 303);
}

export const Route = createFileRoute("/api/gmail-oauth/callback")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const requestUrl = new URL(request.url);
        if (requestUrl.searchParams.has("error")) return dashboardRedirect(request.url, "denied");
        const code = requestUrl.searchParams.get("code");
        const signedState = requestUrl.searchParams.get("state");
        if (!code || !signedState) return dashboardRedirect(request.url, "invalid");

        try {
          const state = openOAuthState(signedState);
          if (new URL(state.redirectUri).pathname !== requestUrl.pathname || new URL(state.redirectUri).origin !== requestUrl.origin) {
            return dashboardRedirect(request.url, "invalid");
          }
          const { data: adminRole, error: roleError } = await supabaseAdmin.from("user_roles")
            .select("role").eq("user_id", state.adminId).eq("role", "admin").maybeSingle();
          if (roleError || !adminRole) return dashboardRedirect(request.url, "admin_required");

          const { data: row, error: rowError } = await supabaseAdmin.from("gym_gmail_oauth")
            .select("id, client_id, client_secret_ciphertext, refresh_token_ciphertext")
            .eq("id", 1).maybeSingle();
          if (rowError || !row) return dashboardRedirect(request.url, "setup_missing");

          const { decryptGmailSecret } = await import("@/lib/gmail-oauth.server");
          const clientSecret = decryptGmailSecret(row.client_secret_ciphertext);
          const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              code,
              client_id: row.client_id,
              client_secret: clientSecret,
              redirect_uri: state.redirectUri,
              grant_type: "authorization_code",
            }),
            signal: AbortSignal.timeout(12_000),
          });
          const tokens = await tokenResponse.json().catch(() => ({})) as {
            access_token?: string; refresh_token?: string; scope?: string; error?: string;
          };
          if (!tokenResponse.ok || !tokens.access_token) {
            console.error("Gmail OAuth code exchange failed:", tokens.error || tokenResponse.status);
            return dashboardRedirect(request.url, "exchange_failed");
          }
          const grantedScopes = (tokens.scope || "").split(/\s+/);
          const { GMAIL_SEND_SCOPE } = await import("@/lib/gmail-oauth.server");
          if (!grantedScopes.includes(GMAIL_SEND_SCOPE)) return dashboardRedirect(request.url, "scope_missing");

          const identityResponse = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
            headers: { Authorization: `Bearer ${tokens.access_token}` },
            signal: AbortSignal.timeout(12_000),
          });
          const identity = await identityResponse.json().catch(() => ({})) as { email?: string; email_verified?: boolean };
          if (!identityResponse.ok || !identity.email || identity.email_verified !== true) return dashboardRedirect(request.url, "email_missing");
          const refreshToken = tokens.refresh_token;
          if (!refreshToken && !row.refresh_token_ciphertext) return dashboardRedirect(request.url, "refresh_missing");

          const { encryptGmailSecret: encrypt } = await import("@/lib/gmail-oauth.server");
          const { error: saveError } = await supabaseAdmin.from("gym_gmail_oauth").update({
            refresh_token_ciphertext: refreshToken ? encrypt(refreshToken) : row.refresh_token_ciphertext,
            sender_email: identity.email,
            connected_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            updated_by: state.adminId,
          }).eq("id", 1);
          if (saveError) throw new Error(saveError.message);
          return dashboardRedirect(request.url, "connected");
        } catch (error) {
          console.error("Gmail OAuth callback failed:", error instanceof Error ? error.message : "Unknown error");
          return dashboardRedirect(request.url, "failed");
        }
      },
    },
  },
});
