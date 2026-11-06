---
version: 1
slug: "index-html"
primary_target: "index.html"
related_targets: ["admin.html"]
---

# Unified Portal Surface

Visitor mode: Operate.

## Signed-Out Entrance

Intent: A mysterious welcome with a reassuringly clear purpose. The clubhouse exists to make Elliot's technological know-how accessible to friends and family; individual services are revealed after sign-in, not advertised here.

Content contract: "A familiar face. A few hidden doors." paired with "A private corner for friends and family, where Elliot's know-how makes the complicated a little simpler." No Strong8K or playoff-pool references in the signed-out entrance.

Visual world: Inherit the existing Sora, ink, paper, and emerald system. A joined ink welcome panel and paper form, one quiet doorway line motif, restrained corners, and no fantasy imagery or gamification. This is a code-led extension, not a replacement design system.

Hierarchy: Personal identity, approved welcome and purpose, then plainly labelled email/password fields and Sign in. Create account and Forgot password remain obvious secondary actions.

Behavior: Preserve Firebase Auth and account claiming. Registration and recovery have visible inline feedback, loading states, and duplicate-submit protection. Passwords remain password inputs with appropriate autofill tokens. No service-specific claims on auth forms.

Responsive and acceptance: Stack on narrow viewports without horizontal overflow. Retain clear labels, keyboard focus, password-manager compatibility, reduced motion, friendly errors, and signed-in routing. Test all auth actions against synthetic Firebase, never by emailing or creating real accounts.

Scope: Recompose the authenticated customer portal and admin workspace around one shared navigation model. Customers should retrieve and copy complete Strong8K license details with minimal interpretation. Elliot should land in a focused action workspace with fast access to people and Strong8K operations.

Constraints: Preserve Firebase Auth, Firestore data shapes and rules, the existing Strong8K renewal/profile behavior, and all current form IDs used by JavaScript. Admin visibility and access must remain role-gated by the existing backend-enforced role or configured admin identity. License passwords are intentionally visible; portal account passwords are never displayed.

## Direction contract

### Prospect Outreach Extension

Job: Elliot distinguishes prospective customers from incomplete customer setups and manually starts a personal conversation. This is an admin-only Operate flow, not a sales CRM.

Outcome: Prospect classification stays separate from messaging. Start conversation is available for every non-archived person from People, the profile, and linked Action Inbox rows. Review a personal email draft from info@goelliot.vip, then explicitly send or copy for Messenger. Copy is not evidence of contact. Delivery status stays in the existing conversation workspace. Prospects receive the setup starter; other people receive a neutral greeting without being labelled Prospect.

Structure: Preserve the room rail and flat ledger. Confirmed prospects have quiet neutral rows and a People filter, never rose setup-failure styling. A profile section holds the label and actions; the existing inbox workspace hosts the full-width compose flow with profile context.

Boundaries: No stages, scheduled follow-ups, automatic outreach, access grants, payment approval, license purchases, or renewal changes. Private classification uses admin-only data. No Firebase Auth account modifications.

States: Legacy empty-license history is unknown, not proof of a prospect. Classification requires explicit informed confirmation. Saved history and incomplete licenses remain review cases. The first complete license converts to Customer without losing conversation history. Recipient changes, archived profiles, paused sending, failed or uncertain saves, missing email, existing conversations, and copied-only messages remain distinct.

Verification: Synthetic browser fixtures prove classification, filters, conversion, keyboard navigation, mobile stacking, draft retention, copy-only behavior, and idempotent email queue retries. Production smoke tests are read-only; do not classify real profiles or send real messages as a deployment test.

THESIS: One persistent room rail and one uninterrupted ledger make this feel like a private clubhouse with purposeful rooms, refusing the generic dashboard made from equal-weight app tiles and metric cards.

OWN-WORLD: A deep-ink rail anchors a mist ground and a single white paper canvas. Emerald marks the active room, positive state, and selected ledger item; amber and rose appear only for attention and failure. Compact labels, hairline divisions, restrained soft corners, and familiar web controls carry the interface.

STORY: A customer signs in, immediately recognizes the Strong8K room, sees every license in full, and copies credentials or requests renewal/help. Elliot enters Operations, scans payment, expiry, automation, and support queues, filters the ledger, then opens a person or task in place without losing context.

FIRST VIEWPORT: At desktop width, a compact fixed room rail occupies the left edge and the remaining width is one generous work canvas. The customer view leads with the complete license stack before renewal, setup, or preferences. Operations leads with a concise heading, queue filters, and actionable rows rather than a bank of cards. The signature move is the room-to-row focus line: the active rail marker and selected ledger row share one emerald status spine, with details expanding in place. On mobile, the rail becomes an explicit room drawer while the ledger remains a single vertical reading stream.

FORM: Room Rail + Ledger, the second structure in the approved surface hand. seed:f2fbd7ea2d22d31c.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

Implementation note: The admin workspace may remain at `admin.html` in this pass, reached through the role-gated Operations room. Matching shell, navigation, and state language must make it feel like the same portal rather than a detached site.
