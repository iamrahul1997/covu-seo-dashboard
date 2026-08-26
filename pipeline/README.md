# Ads pipeline

Two fetchers that write paid-media performance into the **GSC Data** sheet, so
the dashboard reads ads exactly the way it reads Search Console and GA4 — one
data source, no ad-platform credentials anywhere near Vercel.

| File | Runs in | Writes |
|---|---|---|
| `google-ads-script.js` | Google Ads → Scripts | `ads_google_daily`, `ads_google_keyword` |
| `meta-ads-appsscript.gs` | Apps Script (same project as the GSC pipeline) | `ads_meta_daily`, `ads_meta_ad` |

Both are idempotent: each run refreshes the trailing 90 days and preserves
anything older. Re-running never duplicates rows, and late-attributed
conversions get corrected on the next pass.

Both stamp the `meta` tab (`ads_google_last_run`, `ads_meta_last_run`) so the
dashboard can show when ads data was last refreshed and flag it when stale.

## Are these APIs free?

Yes — neither charges for reading data. The cost is setup friction, and it
differs sharply:

**Google Ads.** The REST API needs a developer token issued to a *manager*
(MCC) account, and Basic access is granted by application, typically a few days.
Test-level tokens only work against test accounts, which is useless for real
reporting. Ads **Scripts** sidestep all of it — they run inside the Ads UI with
the account's own permissions and can write to a spreadsheet directly. No token,
no OAuth, no approval. That is why `google-ads-script.js` is a script and not an
API client.

**Meta Marketing API.** Free, and App Review is **not** required to read your own
ad accounts. A System User token from Business Manager with `ads_read` is enough,
and it does not expire — which is what you want for an unattended job. Rate
limits are generous for a single account.

## Schema

`ads_google_daily` — `date, campaign, impressions, clicks, cost, conversions, conversion_value`
`ads_google_keyword` — `date, keyword, match_type, campaign, impressions, clicks, cost, conversions`
`ads_meta_daily` — `date, campaign, adset, impressions, clicks, link_clicks, spend, leads`
`ads_meta_ad` — `date, ad, adset, campaign, impressions, clicks, link_clicks, spend, leads`

Dates are written as text so the CSV export the dashboard reads stays ISO rather
than being reformatted into a locale string. Money is in account currency.

Meta reports conversions inside a nested `actions` array rather than as columns,
so `leads` sums `lead`, `onsite_conversion.lead*` and
`offsite_conversion.fb_pixel_lead`. If the lead definition should differ, that is
the function to change.

## Accounts

- Google Ads: `351-420-0735` — currently one brand search campaign
- Meta: `act_4460021897602415` (COVU Ads, under the COVU, Inc. business portfolio)

## What this replaces

The August 2026 paid report was assembled by reading Ads Manager and Google Ads
through a browser session by hand. That does not scale, cannot be scheduled, and
silently breaks whenever either UI changes. These two scripts make the same data
available on a schedule.

## Once data is flowing

The dashboard gains separate ads tabs reading these four tabs by gid, the same
way every other tab is read. Add the new gids to the `TABS` map at the top of
`api/data.js` — regenerate them with the `htmlview` command documented there.
