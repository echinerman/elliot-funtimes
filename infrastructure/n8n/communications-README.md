# Unified customer inbox

## Rollout Status

The implementation extends the existing Operations inbox and Strong8K support area. The customer website is not a chat client: customers submit a message and receive replies by email from `goelliot.vip <info@goelliot.vip>`. Gmail is an inbound mailbox and attachment viewer, not the reply composer.

Verified on November 2, 2026:

- Local UI and backend regression tests pass against synthetic data; no customer email was sent by those tests.
- Seven communications/setup/readiness workflows are imported and verified inactive. Existing renewal-request and device-info workflows remain active and unchanged. The read-only readiness workflow completed on the VM, exercising two Firestore HTTP calls through the actual n8n replay loop.
- The original initializer reported success, but November 3 read-back checks found the runtime document absent. This exposed an HTTP adapter configuration issue before customer activation. GET/POST paths now use separate fixed settings, every JSON request declares its content type, and transactions require Firestore's commit acknowledgement. The corrected adapter was verified with real configuration, claim, completion, and ingestion writes; no customer subscription was changed.
- Gmail account identity is `e.chinerman@gmail.com`. Labels `goelliot-inbox` and `goelliot-processed` were created; no existing messages were labeled, moved, or imported.
- The existing Home Assistant token was imported over SSH standard input into n8n's encrypted credential store. It was not printed or saved in this project. The available phone service is `mobile_app_elliot_s_s24`.
- Home Assistant accepted one labeled setup notification to that phone service. Physical phone receipt still needs Elliot's confirmation; no customer details were included.
- The official Firestore emulator passed the actual rules against synthetic admin, customer, stranger, and anonymous identities. All messaging collections and nested messages reject non-admin access; private notes, shared history, role escalation protection, and customer profile field limits also passed.
- The scoped Impeccable finish reviewer returned `ship` for the supplied UI captures, not for infrastructure activation. No blocking UI finish findings were identified.

November 3, 2026 update: Elliot published the messaging security rules through the signed-in Chrome Firebase console. The published version was read back through the editor and its normalized SHA-256 matched the emulator-tested local rules (`025a4ea316dc41c4c56ad9888ca884fbe9b53db9aeae356530220f25a421a694`). The prior published rules matched the local baseline without the messaging additions; no unrelated access rule was replaced.

November 3 rollout verification:

- Website implementation was pushed to `main` as `3654977` and served successfully by GitHub Pages with the feature initially off. The deployment checkout is `artifacts/deployment-repo`, separate from the source workspace.
- The exact public support-webhook route is installed in Cloudflare's local tunnel config. The prior config is backed up at `/etc/cloudflared/config.yml.pre-inbox-20261103`. Existing webhook routes and the catch-all deny are preserved.
- Public preflight returned 204 with `Access-Control-Allow-Origin: https://goelliot.vip`; an unsigned POST returned 400 with `Sign in again` and created no message.
- n8n's own Gmail OAuth credential successfully identified `e.chinerman@gmail.com` and both dedicated labels, not merely the separate Gmail connector account.
- With Elliot's confirmation, Cloudflare's active `info@goelliot.vip` destination was changed from `chinermanelliot@gmail.com` to verified `e.chinerman@gmail.com`. Subaddressing is on; catch-all is still off.
- A Gmail filter now applies only `goelliot-inbox` to new mail matching `to:(@goelliot.vip)`. Existing routing accepts only the info address and its plus tags. Historical application, deletion, forwarding, archive, mark-as-read, and spam bypass were all left unchecked.
- A controlled reply traversed the real outbox/Oracle path and reached Elliot's Gmail inbox. From was `info@goelliot.vip`, Reply-To was `info+comm_setup_20261103@goelliot.vip`, and Gmail reported SPF, DKIM, and DMARC passing.
- A same-mailbox forwarded test exposed only its Sent copy, so it was not accepted as delivery evidence. Elliot then sent an external test from his other Gmail address. It arrived with Inbox and intake labels, was durably ingested, and received the processed label only afterward. A sender mismatch with the original test thread is isolated for review rather than silently merged.
- The five core communications workflows are published. The guarded activation helper verified all three runtime flags true only after checking the sent reply, durable external test, and expected HA/Gmail destinations. Manual readiness/acceptance helpers remain inactive.

The final website release is `d8ea5ef` on `main`; GitHub Pages served the enabled client flag and cache-busted scripts. The signed-in browser form was submitted with Elliot's explicit approval and returned `Message received`. Its full test body was then read back from the live admin conversation. A narrow read-only check confirmed `enabled`, `sending_enabled`, and `notifications_enabled` all true, and the portal test's notification status `sent` with no error. That means Home Assistant accepted the alert; physical display on the phone was not independently verified. Communications never approves payments or purchases/renews licenses.

## Components

`communications-model.mjs` contains validation, safe preview generation, email parsing, sender locking, and thread correlation. `communications-ui.js` integrates the admin directory, conversation, composer, customer context, and failure recovery. `portal-support.js` handles authenticated customer submissions. `communications.css` extends the existing room-rail ledger system.

`communications-db.mjs` defines transactional storage operations. The generated n8n workflows run those operations through native credential-bearing HTTP nodes. Code nodes do not read credentials. A replay adapter preserves completed HTTP results rather than repeating completed writes.

Generate the import bundle with:

```powershell
node infrastructure/n8n/communications.workflow.mjs | Set-Content -Encoding utf8 artifacts/communications-workflows.json
```

The bundle contains five inactive workers, a manual read-only readiness check, and an idempotent manual initializer. Existing Strong8K workflows are not replaced. All new workflows disable successful, failed, and manual payload retention. Do not enable payload logging while handling real messages.

## Disabled Runtime

Run `Communications - Initialize disabled settings` once to create `communication_config/runtime` only if absent. For an existing document it fills only missing Gmail/HA destination fields, preserving all existing values and runtime flags. Initial values are:

```json
{
  "enabled": false,
  "sending_enabled": false,
  "notifications_enabled": false,
  "gmail_label": "goelliot-inbox",
  "gmail_processed_label": "goelliot-processed",
  "ha_url": "http://100.70.117.124:8123",
  "ha_notify_service": "mobile_app_elliot_s_s24"
}
```

No credentials belong in this document. Native n8n credentials hold Firebase service-account access, Gmail OAuth, Oracle SMTP, and the HA Authorization header. Rotating credentials must not change client-side config.

## Activation Checklist

1. COMPLETED November 3: publish the repository's `firestore.rules` after emulator verification and compare the published source with the tested version. The emulator confirmed an ordinary signed-in customer cannot read or write any `communication_*` document, including messages, outbox, configuration, rate buckets, or mail references. Admin-only rules also protect support notes. Service-account access is IAM-controlled and bypasses client rules.
2. COMPLETED: create and preview the dedicated new-mail Gmail filter. Historical application, spam bypass, and other mail actions are off. The worker leaves originals in Gmail and marks processed only after durable storage.
3. COMPLETED: enable subaddressing and verify external delivery to the thread plus-address, without a catch-all. See [Cloudflare's routing/subaddressing documentation](https://developers.cloudflare.com/email-service/configuration/email-routing-addresses/).
4. COMPLETED: deploy only the exact support route and verify its 204 preflight, unsigned rejection, and successful authenticated browser POST. n8n's editor and credential endpoints remain outside the public allowlist.
5. COMPLETED at API level: verify the encrypted n8n HA credential, allowlisted base URL, phone service, and accepted test alert. Physical phone receipt and link tapping are an operator follow-up, not a claim made by the API test. Previews are deterministic and redacted, not AI summaries.
6. COMPLETED: run controlled inbound and signed-in form tests. Unit/browser/rules tests cover duplicates, ownership, metadata, isolation, and private access; the live external test was isolated for review when its sender differed from the original thread participant.
7. COMPLETED for controlled delivery: queue a test through the actual outbox, verify Gmail Inbox receipt, correct From/Reply-To/token, and SPF/DKIM/DMARC passing. Failure and uncertainty were tested with fixtures rather than interrupting a real customer send. A same-sender customer reply round-trip beyond the verified incoming plus-address remains a useful operator smoke check.
8. COMPLETED: publish the five workers and enable the verified runtime/client flag. The received email and authenticated portal test are visible in the live conversation directory; the portal test's HA alert is recorded sent. The renewal worker is informational only and cannot approve payment, buy credits, or renew a license.

## Failure And Recovery

- Duplicate portal requests use a stable client request ID. Ingestion uses Gmail message IDs. Transactional locks prevent duplicate messages/notifications.
- An admin reply keeps the same outbox ID when retrying a lost Firestore response within the current page session. An existing matching outbox/message pair is treated as already queued, never rewritten. Drafts are retained in memory while navigating; reloading or signing out discards them after a browser warning. Following an ambiguous save and reload, inspect the timeline before composing the same reply again.
- SMTP claims have five-minute leases. A stale lease becomes `uncertain`, not automatically queued. A definite pre-send failure is `failed`; unknown outcomes require operator review. Check delivery/logs before choosing Review and resend. A server acceptance status is not a delivery receipt.
- A new inbound message during sending leaves the thread open. Read state is tied to the specific last inbound message actually loaded, not to a timestamp.
- Phone-alert failures remain independent of email delivery. The admin can retry only the alert; this never queues an email. An older notice cannot overwrite the newest notice's status.
- Unknown senders remain unlinked. A correlation token from the wrong sender creates a separate review thread. Linking a profile never changes the stored reply recipient. Email sender matching is routing context, not proof that the sender authenticated as a portal user.
- Original HTML is displayed as escaped plain text. Attachments are never downloaded into Firestore; only filenames/size metadata and a Gmail link are retained. No customer thread-reading endpoint exists in v1.
- Every generated JSON HTTP request declares `contentType: json`. Firestore reads and POST writes use separate nodes with fixed body settings, and a transaction is successful only when its commit acknowledgement covers every intended write. A 200 response without that acknowledgement is an error, not a successful save.
- Saving a message to support history requires explicit confirmation. It creates an idempotent internal-only support event; it does not publish private email to a customer's shared timeline.

## Rollback And Maintenance

Set `sending_enabled` and `notifications_enabled` false first, then `enabled` false; disable the five workers and turn off the client flag. Finish operations may still save the outcome of an already-claimed attempt. Do not delete queued/uncertain records to hide an error. Back up Firestore and n8n's database/encryption key under the existing private backup policy; no credential exports belong in this repository.

The directory and conversation view show the latest 100 rows/messages. Direct links to older conversations remain live. Gmail ingestion processes one message per minute and the renewal worker examines up to 50 payment-reported requests per pass; revisit pagination/throughput before broader use. This is sized for friends and family, not a public help desk.

The installed n8n CLI warns that Postgres 16 is compatibility-only and recommends 17 or newer. Treat that as a separate planned infrastructure upgrade, not a hidden part of inbox deployment.

## Verification Commands

```powershell
node --test tests/*.test.mjs
node tests/communications-browser.mjs
node tests/communications-browser-server.mjs
firebase emulators:exec --only firestore --project demo-goelliot-inbox --config firebase.emulator.json "node tests/communications-rules-emulator.mjs"
```

The browser tests use synthetic Firebase data on loopback port 4327; the visible preview uses 4326. Both are independent of the production database. The test runtime needs Playwright and Microsoft Edge. The rules test requires Java 21+, Firebase CLI, `@firebase/rules-unit-testing`, and `firebase`; it refuses a non-loopback emulator and uses only `demo-goelliot-inbox`. During this run those dependencies were installed in the Windows temporary directory, not added to the production site. Use `NODE_PATH` if they are outside the project. See [Firebase's rules-testing documentation](https://firebase.google.com/docs/firestore/security/test-rules-emulator).

The 43 unit tests and browser regression pass. The official emulator checks also pass; the private-note fixture uses the real `strong8k_private` collection. Live mail acceptance above separately proves inbound storage and authenticated Oracle delivery; emulator tests alone cannot prove deliverability.

## Manual Acceptance Helpers

`communications-acceptance.workflow.mjs` generates inactive, single-recipient setup helpers; it requires a specific Gmail test message ID. The test runner uses private temporary output files, prints only safe result/error summaries, and deletes raw execution output. Its cleanup is restricted to its acceptance-session marker and refuses to disable an unrelated live activation. Do not publish these helpers as scheduled workflows or rerun initial acceptance against a live runtime.

The activation script publishes only the five communications workflows and requires a controlled sent reply and durably stored external test before enabling the runtime. These helpers never contain SMTP, Google, provider, or HA secrets. Some completed CLI executions can leave stale `running` metadata in n8n; inspect explicit workflow names/timestamps rather than serializing execution records or restarting during a real customer job.
