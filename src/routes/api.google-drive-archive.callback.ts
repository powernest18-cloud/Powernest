import { createFileRoute } from "@tanstack/react-router";
import { openDriveOAuthState, decryptDriveSecret, encryptDriveSecret, DRIVE_FILE_SCOPE } from "@/lib/drive-archive-oauth.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

function redirect(requestUrl: string, result: string) {
  const url = new URL("/dashboard", requestUrl);
  url.searchParams.set("driveArchiveOAuth", result);
  url.hash = "settings";
  return Response.redirect(url, 303);
}

export const Route = createFileRoute("/api/google-drive-archive/callback")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const currentUrl = new URL(request.url);
        if (currentUrl.searchParams.has("error")) return redirect(request.url, "denied");
        const code = currentUrl.searchParams.get("code");
        const signedState = currentUrl.searchParams.get("state");
        if (!code || !signedState) return redirect(request.url, "invalid");
        try {
          const state = openDriveOAuthState(signedState);
          const redirectUri = new URL(state.redirectUri);
          if (redirectUri.pathname !== currentUrl.pathname || redirectUri.origin !== currentUrl.origin) return redirect(request.url, "invalid");
          const { data: adminRole } = await supabaseAdmin.from("user_roles").select("role").eq("user_id", state.adminId).eq("role", "admin").maybeSingle();
          if (!adminRole) return redirect(request.url, "admin_required");
          const { data: row, error: rowError } = await (supabaseAdmin as any).from("gym_drive_archive_oauth")
            .select("client_id, client_secret_ciphertext, refresh_token_ciphertext, sender_email, folder_id, folder_url").eq("id", 1).maybeSingle();
          if (rowError || !row) return redirect(request.url, "setup_missing");
          const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ code, client_id: row.client_id, client_secret: decryptDriveSecret(row.client_secret_ciphertext), redirect_uri: state.redirectUri, grant_type: "authorization_code" }),
            signal: AbortSignal.timeout(15_000),
          });
          const tokens = await tokenResponse.json().catch(() => ({})) as { access_token?: string; refresh_token?: string; scope?: string; error?: string };
          if (!tokenResponse.ok || !tokens.access_token) return redirect(request.url, "exchange_failed");
          if (!(tokens.scope || "").split(/\s+/).includes(DRIVE_FILE_SCOPE)) return redirect(request.url, "scope_missing");
          const identityResponse = await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: { Authorization: `Bearer ${tokens.access_token}` }, signal: AbortSignal.timeout(12_000) });
          const identity = await identityResponse.json().catch(() => ({})) as { email?: string; email_verified?: boolean };
          if (!identityResponse.ok || !identity.email || identity.email_verified !== true) return redirect(request.url, "email_missing");
          const refreshToken = tokens.refresh_token || (row.refresh_token_ciphertext ? decryptDriveSecret(row.refresh_token_ciphertext) : "");
          if (!refreshToken) return redirect(request.url, "refresh_missing");
          let folderId = identity.email === row.sender_email ? row.folder_id : null;
          let folderUrl = identity.email === row.sender_email ? row.folder_url : null;
          if (!folderId) {
            const folderResponse = await fetch("https://www.googleapis.com/drive/v3/files?fields=id,name,webViewLink", {
              method: "POST",
              headers: { Authorization: `Bearer ${tokens.access_token}`, "Content-Type": "application/json" },
              body: JSON.stringify({ name: "Gym Manager Archives", mimeType: "application/vnd.google-apps.folder" }),
              signal: AbortSignal.timeout(15_000),
            });
            const folder = await folderResponse.json().catch(() => ({})) as { id?: string; webViewLink?: string; error?: { message?: string } };
            if (!folderResponse.ok || !folder.id) {
              console.error("Google Drive archive folder creation failed:", folder.error?.message || folderResponse.status);
              return redirect(request.url, "folder_failed");
            }
            folderId = folder.id;
            folderUrl = folder.webViewLink || `https://drive.google.com/drive/folders/${folder.id}`;
          }
          const { error } = await (supabaseAdmin as any).from("gym_drive_archive_oauth").update({
            refresh_token_ciphertext: encryptDriveSecret(refreshToken), sender_email: identity.email,
            folder_id: folderId, folder_url: folderUrl,
            connected_at: new Date().toISOString(), updated_at: new Date().toISOString(), updated_by: state.adminId,
          }).eq("id", 1);
          if (error) throw new Error(error.message);
          return redirect(request.url, "connected");
        } catch (error) {
          console.error("Google Drive archive OAuth callback failed:", error instanceof Error ? error.message : "Unknown error");
          return redirect(request.url, "failed");
        }
      },
    },
  },
});
