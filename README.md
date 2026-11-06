# elliot-funtimes

Elliot's private clubhouse portal and admin operations workspace (`goelliot.vip`), streamlined without the playoff pool application.

## Overview

- **Client Portal (`index.html` + `portal-app.js`)**: Clean sign-in, room navigation rail, Strong8K subscription and license credential details (copy-ready for streaming players like TiviMate), renewal request review with e-transfer submission, setup notes, live/VOD preferences, and shared support communication history.
- **Admin Workspace (`admin.html` + `admin-app.js`)**: Operations inbox with action queue (renewals, expiring licenses, manual review, prospects, support, messages), customer profile editor, Strong8K tools (license and product catalogs, configuration seeding, profile merging), and integrated customer communication inbox.
- **Shared Architecture**: Firebase Auth and Firestore with role-based security rules (`firestore.rules`), webhook integrations for support and renewal pipelines, and automated test suite.

## Running Tests

Run the test suite using Node's built-in test runner:

```bash
node --test tests/*.test.mjs
```
