# Planner launch smoke test & troubleshooting

Use this guide to confirm the planner can create automated runs after wiring up
Supabase and to gather actionable diagnostics if a launch fails.

## Prerequisites

- Planner served locally (`python3 -m http.server 8000` from the repo root) or
  deployed at `https://futurefunds.ai`.
- Admin credentials that can sign into Supabase and the planner.
- Supabase edge functions deployed (`npm run functions:deploy`) with the anon key
  copied into `planner.html`.

## Smoke test steps

1. Open the planner and sign in with an administrator account.
2. Select a scope (universe, watchlist, or custom tickers) and make sure custom
   tickers are populated if that mode is chosen.
3. Choose Stage 1–3 models and a budget, then click **Start automated run**.
4. Watch the **Status** chip above the launch button:
   - **Success** → You should see `Run created: <run_id>` and a log entry such as
     `Run created successfully with N tickers queued.`
   - **Failure** → The chip now shows the HTTP status or error message returned
     by the edge function.

## Troubleshooting a failure

- Expand the planner log panel (upper-right) to review the recent entries. The
  launch error is mirrored there, including the HTTP response text when the
  request reached Supabase.
- Open your browser’s developer tools and inspect the **Network** tab. Filter for
  requests to `/runs-create` or `/health` to confirm the `apikey` and
  `Authorization: Bearer <token>` headers are attached.
- Check the browser console for `Automated run launch failed`—the full error
  object is logged so you can inspect stack traces or response bodies.
- Ensure the Supabase project reference is correct and the anon key in
  `planner.html` matches the project you deployed functions to.
- If the response status is `403` or `404`, verify the edge function is deployed
  and your Supabase **Functions** settings allow requests from the planner
  origin.

Once the smoke test passes, the planner is ready to schedule unattended runs.
