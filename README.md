# Dream Weaver

I have attached the theme image.

This project was built with [Lovable](https://lovable.dev).

**Live app**: https://aesthetic-weave-engine.lovable.app

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/ac16f50c-3664-4820-9fac-10331b328c59).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```

## Connect a Supabase project during first admin setup

When the app is built without a Supabase URL or publishable key, the blank database form opens on `/auth` before sign-in or registration. If the app already has a connection, choose **Create an account**, then **Need to connect a Supabase project first?**. The service-role key is sent only to the Netlify Function and stored in Netlify's server-side environment settings; it is not written to browser storage or returned to the page. Netlify encrypts environment-variable values at rest. Saving the connection queues a new production build because the browser Supabase URL and publishable key are embedded during the build.

Before using the form, the Netlify site owner must do this one-time deployment setup:

1. Create the Supabase project and apply this repository's migrations in timestamp order (or link the project and run `supabase db push`). The project schema must exist before the first admin signs up.
2. Create a Netlify personal access token with permission to manage this site's environment variables and trigger builds.
3. In Netlify **Project configuration → Environment variables**, add these server-side bootstrap variables, then deploy the app once so the setup function is available:
   - `NETLIFY_AUTH_TOKEN` — the Netlify API token; keep private.
   - `NETLIFY_SITE_ID` — this Netlify site's project/site ID.
   - `SUPABASE_SETUP_TOKEN` — a random code of at least 32 characters that the person connecting Supabase will enter in the form.
   - `NETLIFY_ACCOUNT_ID` — optional if the site API response already identifies its team; otherwise set the account/team slug or ID.
4. Open `/auth`, create an account, and connect the Supabase URL, publishable key, project ID, service-role key, and setup access code. Wait for the new production deploy to finish, then create the admin account.

The setup endpoint can change the database connection for this deployment, so share the setup access code only with the site owner. After initial setup, remove `NETLIFY_AUTH_TOKEN` and `SUPABASE_SETUP_TOKEN` from Netlify to disable further in-app changes; add them back only when intentionally changing the connected project. Keep the service-role key server-side and never use it as a `VITE_` variable.

## Membership renewal reminder emails

Netlify runs `netlify/functions/membership-renewal-reminders.mjs` daily at 02:00 UTC. It uses the gym timezone to find active memberships due for a reminder: the first email is sent 7 days before expiry and the follow-up 4 days before expiry. Delivery attempts are stored in `renewal_reminders` to avoid duplicate emails and retry failures.

Before enabling it in production:

1. Apply `supabase/migrations/20260929120000_membership_renewal_email_delivery.sql` and `supabase/migrations/20261001090000_admin_gmail_oauth_settings.sql` to the Supabase project.
2. Keep these server-side Netlify environment variables configured:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY` (keep this secret; never expose it as a `VITE_` variable)
   - `APP_URL` (optional; used to add a sign-in link to the email)
   - `GMAIL_CREDENTIALS_ENCRYPTION_KEY` (optional; use a long random secret to encrypt Gmail OAuth credentials separately. If omitted, the server derives the encryption key from `SUPABASE_SERVICE_ROLE_KEY`. Keep whichever key is used stable; if rotated, reconnect Gmail in Settings.)
3. Publish a Netlify production deploy. Scheduled functions run on published deploys; Netlify’s Functions page can invoke this scheduled function manually for an immediate delivery check.

### Configure Gmail API OAuth

The reminder sender uses the Gmail API's `gmail.send` permission. In Google Cloud, create a project, enable the Gmail API, configure the OAuth consent screen, and create a **Web application** OAuth client. From Admin **Settings → Membership reminder email**, copy the displayed callback URL and add it as an authorized redirect URI on the Google OAuth client. Paste the OAuth client ID and client secret into the same Settings panel and choose **Save credentials and connect Gmail**. Google then asks the administrator to authorize the Gmail account used to send reminders. The app encrypts the OAuth client secret and refresh token before storing them in its private Supabase table; neither value is sent back to the browser.

Administrators can click the dashboard’s **Expiring in 7 days** card to view members with active memberships expiring today through seven days from today in the gym timezone. The list provides one manual email reminder per membership; a manual send is recorded separately from the scheduled seven-day and follow-up reminders.

### Supabase Send Email Auth Hook

The `supabase/functions/send-email` Edge Function sends Supabase Auth emails through the Gmail OAuth sender connected in Admin Settings. It handles signup confirmation, password recovery, magic links, invitations, email changes, and reauthentication. Apply the Gmail OAuth settings migration before enabling the hook, then configure these Supabase Edge Function secrets:

- `SEND_EMAIL_HOOK_SECRET` — the signing secret generated in Supabase **Authentication → Hooks → Send Email**.
- `GMAIL_CREDENTIALS_ENCRYPTION_KEY` — the exact same value used by the Netlify app. If the app uses its documented fallback, configure this explicitly with the same Supabase service-role key value used when the Gmail credentials were encrypted.

The function reads the encrypted Gmail credentials from the private `gym_gmail_oauth` table using Supabase's server-side `SUPABASE_SERVICE_ROLE_KEY`. Set the Send Email Hook URL to `https://<project-ref>.supabase.co/functions/v1/send-email`, keep the Email Provider enabled, and test signup and password recovery. The function URL does not require a JWT because it authenticates each request with the hook signature.

For GitHub Actions deployment, add repository secrets `SUPABASE_ACCESS_TOKEN` and `SUPABASE_PROJECT_ID`; the workflow deploys this function when its code or Supabase configuration changes on `main`. The function still can be deployed manually with `supabase functions deploy send-email --project-ref <project-ref>`.

## Payment gateway setup

Apply `supabase/migrations/20261001100000_admin_payment_gateway_credentials.sql` to the connected Supabase project. In Admin **Settings**, use **Payment gateway integrations** to securely save Razorpay Key ID and Key Secret, or Stripe Secret Key and webhook signing secret. The keys are encrypted server-side in a private Supabase table; blank fields keep their existing saved values. The optional server variable `PAYMENT_CREDENTIALS_ENCRYPTION_KEY` provides a separate encryption key; if omitted, the app derives it from `SUPABASE_SERVICE_ROLE_KEY`. Keep that key stable, or re-enter the gateway credentials if you rotate it.

For Stripe, register the webhook URL shown in Settings and subscribe to `checkout.session.completed` and `checkout.session.async_payment_succeeded`. Existing `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `STRIPE_SECRET_KEY`, and `STRIPE_WEBHOOK_SECRET` server variables remain available as fallback credentials for deployments that have not moved their keys into Settings.

Use an OAuth app publishing status of **In production** for a long-lived refresh token. Google expires refresh tokens issued while an external OAuth app is in **Testing** after seven days for scopes such as `gmail.send`. Google classifies `gmail.send` as a sensitive scope, so an unverified app can show a warning; Google verification may be required for public distribution. Never put OAuth secrets or refresh tokens in frontend variables, source control, or chat. See Google's [Gmail OAuth scopes](https://developers.google.com/workspace/gmail/api/auth/scopes), [OAuth web-server flow](https://developers.google.com/workspace/gmail/api/auth/web-server), and [OAuth refresh-token guidance](https://developers.google.com/identity/protocols/oauth2#expiration).
