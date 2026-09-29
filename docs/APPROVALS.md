# Platform approvals

Serving **your own** ad accounts needs no approval from anybody. Serving
**someone else's** needs permission from both Google and Meta, and getting it
takes longer than building the thing that uses it.

This is the critical path. Start it on day one, in parallel with the code.

> Both programmes change their requirements without much notice. Treat the
> specifics here as a map, not a contract, and check each against the live
> documentation before submitting. What does not change is the shape: an
> application, a review by a human, and a rejection if the use case is vague.

---

## Why today's setup does not extend

The current pipeline works precisely because it never leaves COVU's own
property, and both shortcuts evaporate the moment a stranger connects.

| | Today | For any account |
|---|---|---|
| **Google Ads** | An Ads **Script**, running inside the account's own UI with the account's own permissions. No token, no OAuth, no approval — that is why `pipeline/google-ads-script.js` is a script and not an API client. | Scripts cannot reach another company's account. You need the **Google Ads API**, which needs a **developer token**. |
| **Meta** | A **System User token** from COVU's own Business Manager. App Review is not required to read your own ad accounts. | A system user exists only inside one business. Other companies' users authorise through OAuth, and `ads_read` on accounts you do not own needs **Advanced Access**, which needs **App Review**. |

---

## Google Ads: developer token

**What it is.** One token belonging to *you*, the platform, sent on every API
call. Each customer separately authorises via OAuth; the token identifies the
tool, the OAuth grant identifies whose data it may touch.

**Prerequisite.** It is issued to a **manager (MCC) account**, not an ordinary
one. If COVU has no MCC, create one first — it is free, and it does not need to
manage anything.

**Where.** MCC → Tools & Settings → Setup → **API Center**.

**Access levels.** This is the part that catches people out:

- **Test** — granted instantly, and works *only against test accounts*. Useless
  for reporting on real spend. Do not mistake having a token for being done.
- **Basic** — real accounts, capped daily operations. This is what you apply
  for, and it is comfortably enough for daily reporting pulls.
- **Standard** — higher limits, applied for later once you can show usage.

**The application** asks what the tool does, who uses it, your company website,
and whether it serves third parties. Answer as a reporting product that reads
campaign performance on behalf of customers who authorise it. Vagueness is the
main cause of delay.

**Compliance to read before you submit.** The Google Ads API Terms impose
obligations on tools exposed to third parties. A read-only reporting tool is a
lighter case than one that manages campaigns, but the obligations are not zero,
and you agree to them on submission.

**Timeline.** Days to a couple of weeks. Faster than Meta.

**In code.** OAuth scope `https://www.googleapis.com/auth/adwords`, offline
access so you receive a refresh token, and the `login-customer-id` header set
to the manager account when acting through it. The customer ID becomes
`source.external_id`; the refresh token becomes a `connection` row.

---

## Meta: App Review and Business Verification

Slower, stricter, and the more common place to get stuck.

**What you need:** **Advanced Access** to **`ads_read`**.

- *Standard Access* — granted by default, but only reaches accounts whose users
  have a role in your app's own business. Fine for testing, useless for
  customers.
- *Advanced Access* — any account whose owner authorises you. This is the one
  under review.

`ads_management` is for writing. This product reads. Do not request it —
asking for more than you demonstrate is a reliable rejection.

**Business Verification.** The business that owns the app must be verified:
legal name, address, and documentary proof. Start this immediately; it is
independent of App Review, it gates it, and it can itself take days.

**What the submission needs:**

1. A **privacy policy** URL, publicly reachable.
2. A **terms of service** URL.
3. A **data deletion** path — a callback or documented instructions.
4. App icon, category, and a real business email.
5. A written use case: what data you read, why, and what the user sees.
6. A **screencast**. This sinks more submissions than anything else. It must
   show the actual end-to-end flow on a real screen — a customer signing in,
   reaching the connect screen, granting permission, and then the specific data
   appearing in your product. A slide deck, a mockup, or a video that starts
   after the permission dialog will be rejected.

**Timeline.** Roughly one to two weeks per submission, and first submissions are
often rejected. Budget for two rounds.

**Afterwards.** Business Use Case rate limits apply per ad account and are
generous for daily reporting, but they are per-account, so a hundred tenants is
a different shape of load than one.

---

## What this obliges you to build

Both programmes require a privacy policy and a deletion path, so these stop
being paperwork and become product surface:

- **A privacy policy** that names the ad platforms, what is read, how long it
  is kept, and who it is shared with.
- **Deletion that deletes.** `on delete cascade` from `org` already removes
  facts and sources; what it must also do is revoke tokens at the provider
  rather than merely dropping the row. A deleted customer whose refresh token
  still works is a breach waiting to be discovered.
- **Disconnection** as a first-class action, separate from deletion.
- **A subprocessor list** — Vercel, Neon, Google, Meta — the moment you have a
  customer who asks.

None of this is optional once you hold other companies' advertising data.

---

## Order of work

1. **Today** — create the MCC; start Meta Business Verification. Both are
   waiting games with no code attached.
2. **This week** — publish a privacy policy and terms. Both applications ask
   for the URLs, so neither can be submitted without them.
3. **Then** — apply for the Google developer token (Basic).
4. **Build in parallel** — connectors, OAuth flows, the account switcher. The
   code will be finished before the approvals are, which is the right way round.
5. **Record the screencast last**, against the real working flow. Recording it
   early against a mockup is how submissions get rejected.
