# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

The primary user is Elliot, the operator and administrator who uses the admin experience to provide technical solutions and hands-on assistance to friends and family, keeping their information and support history together.

Secondary users are friends and family who are not necessarily technically savvy. They use the client portal to create an account, access their subscription information, follow setup guidance, request help, and copy the credentials or URLs needed by their streaming player.

## Product Purpose

goelliot.vip is Elliot's private clubhouse: a familiar place where friends and family can make use of his technological know-how when things feel complicated. Technical assistance is the mission; subscriptions and personal technical rooms are the core of the portal. It reduces confusing back-and-forth by keeping credentials, setup notes, requests, and support history in one accessible place.

This version in elliot-funtimes provides the focused clubhouse experience centered on Strong8K and customer communications, without the recreational playoff pool application.

## Positioning

This is not a public enterprise service. Its meaningful distinction is an operator-led, shared workspace that combines a simple client portal for non-technical friends and family with a fast, information-dense admin view for the person providing hands-on setup and support.

## Operating Context

- Initial conversations and product decisions usually happen in Facebook Messenger before a person creates an account.
- A customer creates an account, advises Elliot that payment was made, and Elliot verifies payment before purchasing or renewing the relevant Strong8K license.
- Customers commonly use external Android TV devices such as a Fire Stick or Google Streamer and a compatible player such as TiviMate Premium.
- Elliot may recommend EPGenius for improved live-TV guide functionality and may separately help customers understand optional on-demand tools such as Stremio and Real-Debrid.
- When troubleshooting, Elliot needs to review prior setup steps, devices, apps, credentials, interpretations, and follow-up actions. Interaction history may be recorded as pasted summaries or transcripts and later consolidated into useful support notes.

## Capabilities and Constraints

- Firebase Auth and Firestore remain the backend foundation.
- The application has a public/client portal and an administrative experience.
- Administrator access must be enforced by backend authorization and Firestore rules; client-side controls must never be treated as sufficient protection against admin spoofing.
- Strong8K profiles must support multiple licenses per person, credentials, domains, expiry information, setup notes, internal notes, preferences, and additional fields as the provider platform evolves.
- The Strong8K renewal profile workflow must remain functional, with n8n flows intended to minimize operator intervention while preserving deliberate payment approval and safe renewal processing.
- Customers should be able to request help and indicate payment; Elliot must be able to verify payment and initiate or approve the associated purchase or renewal.
- No secrets, provider API keys, or private credentials may be committed to the repository.
- Product and account data are personal and limited to Elliot's friends and family; the system is not intended to be positioned as a public enterprise offering.

## Brand Commitments

- Preserve the goelliot.vip identity and the friendly, practical, operator-led purpose.
- Keep customer-facing language clear and non-technical wherever possible.
- Keep admin workflows efficient and information-rich without making the customer experience feel like an internal dashboard.

## Evidence on Hand

- Web implementation in `index.html`, `portal-app.js`, `admin.html`, `admin-app.js`, `app-model.js`, and `user-editor.js`.
- Firebase configuration in `config.js` and access policy in `firestore.rules`.
- Strong8K profile, product, license, expiry, setup-note, and synchronization flows in the application code.
- Verified absence of the playoff pool application.

## Product Principles

- Make the next action obvious for people who are not technically confident.
- Give the operator fast access to the complete support and subscription history.
- Automate repetitive renewal work, but preserve explicit payment approval and safe failure handling.
- Treat backend authorization, data privacy, and credential protection as product requirements.

## Accessibility & Inclusion

The client experience must accommodate friends and family with limited technical confidence. Use plain language, clear recovery paths, readable controls, keyboard-accessible interactions, and responsive layouts suitable for ordinary phones, tablets, and desktop browsers.
