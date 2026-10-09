---
label: Google Workspace
icon: plug
description: Connect Google Workspace tenants with one click to sync users, licences, storage, groups, domains, devices and security alerts.
---

# Google Workspace Integration

**Google Workspace** is Google's suite of business email, storage and collaboration apps, managed from the Google Admin console.

The Weavestream Google Workspace driver is **read-only**. One integration is one customer tenant. You set up one Google Cloud OAuth app for your whole Weavestream install, and then each customer is connected with a single **Connect with Google** sign-in by one of their admins.

## Overview & Features

- **One-click connect per customer**: no per-customer Google Cloud project, no service account keys.
- **Match first**: on the first sync, Google records link to the assets you already have (users by email, devices by serial number, domains by name). An asset is only created when nothing matches.
- **No new layout fields**: Google data does not add fields to your layouts. A created asset gets only its name and match value. Everything else shows in a **Google Workspace** section on the asset page.
- **Usage bars**: mailbox, Drive and total storage per user, and pooled storage for the tenant, shown as bars that turn amber at 80% and red at 95%.
- **Built-in setup guide and Check setup**: the steps below are also shown inside Weavestream, and **Check setup** points to the step that needs fixing.

## Synced Data Reference

| Resource | Suggested layout | Matched on | Section groups on the asset page |
|---|---|---|---|
| **Tenant** | Google Workspace Tenants (created) | Customer ID | Overview, Licences assigned per edition, Storage (used vs pooled, with Gmail, Drive and shared drives), Security (2-step verification coverage, super admins, unused licences) |
| **Users** | People | Email | Account (status, org unit, created, last login), Licences, Mailbox, Drive, Total storage, Security (admin role, 2-step verification, unused licence) |
| **Groups** | Distribution Lists | Email | Group (description, member count, members) |
| **Domains** | Domains | Domain name | Domain (primary, verified, alias of, created) |
| **Chrome devices** | Chromebooks, Laptops or Workstations | Serial number | Chrome OS (model, OS version, status, last sync, user, org unit, MAC, auto-update expiration) |
| **Mobile devices** | Phones | Serial number | Device (model, OS, type, owner, status, last sync, compromised) |
| **Security alerts** | Google Security Alerts (created) | Alert ID | Alert (type, source, times, status, console link). Alerts from the last 90 days. |

Chromebook **auto-update expiration** can optionally be mapped to a date field marked as an expiry, so it shows up in **Expiring soon**.

### What Google cannot provide

- **No bill, purchased seat count or renewal date** for customers you do not resell. Google only exposes *assigned* licences. Invoices are only in the Admin console. Resellers get purchased seats and renewal dates for their customers through [Reseller Subscriptions](#reseller-subscriptions).
- **No size per shared drive.** Only the tenant total for all shared drives is available.
- **Usage data lags 1–3 days.** Storage figures come from Google's usage reports, which Google publishes with a delay. The section shows the date the figures are from.

## Setup Instructions

The same steps are shown in Weavestream under **Admin > Settings > Integrations** (Google OAuth app card) and on each Google Workspace integration's **Credentials & schedule** tab. Steps 1–6 are done **once per Weavestream install**. Steps 7–9 are done **once per customer**.

### Step 1: Create a Google Cloud project

Open [console.cloud.google.com/projectcreate](https://console.cloud.google.com/projectcreate) and create a project. Any Google account works; your own company's Workspace admin account is a good choice. Name it, for example, **Weavestream**, and make sure it is selected at the top of the console.

### Step 2: Turn on three Google APIs

Open each API with the project selected and press **Enable**:

- [Admin SDK API](https://console.cloud.google.com/apis/library/admin.googleapis.com) (users, groups, domains, devices, usage reports)
- [Enterprise License Manager API](https://console.cloud.google.com/apis/library/licensing.googleapis.com) (licences)
- [Google Workspace Alert Center API](https://console.cloud.google.com/apis/library/alertcenter.googleapis.com) (security alerts)

### Step 3: Set up the consent screen and publish it

Open **Google Auth Platform** (press **Get started** if you see it).

1. **Branding**: app name **Weavestream**, your support email and a developer contact email.
2. **Audience**: user type **External**. Then press **Publish app** so the status shows **In production**.

Do not leave the app in **Testing**: in Testing, every connection stops working after 7 days. You do not need Google verification. An unverified app can be approved by up to **100 admins in total** over the life of the project; you connect one admin per customer, so that is plenty.

<!-- TODO(screenshot): ![Google Auth Platform Audience page set to External, In production](./assets/google-workspace-audience.png) -->

### Step 4: Add the scopes

Open **Data Access**, press **Add or remove scopes**, and paste the scope list from the Weavestream setup guide under **Manually add scopes**. Press **Add to table**, **Update**, then **Save**. The scopes are listed under [Security model](#security-model).

### Step 5: Create the OAuth client

Open **Clients** and press **Create client**:

- Application type: **Web application**
- Name: **Weavestream**
- **Authorized redirect URIs**: press **Add URI** and paste the redirect URI from the Weavestream setup guide (it ends in `/v1/admin/integrations/oauth/callback`).

Press **Create** and copy the **Client ID** and **Client secret**. Google shows the secret only once; you can also download it as JSON.

<!-- TODO(screenshot): ![Create OAuth client with the redirect URI filled in](./assets/google-workspace-client.png) -->

### Step 6: Paste the client into Weavestream

In **Admin > Settings > Integrations**, paste the Client ID and Client secret into the **Google OAuth app** card and press **Save OAuth app** (this asks you to confirm with MFA). Then press **Check setup**: steps that pass turn green, and a red step tells you what to fix.

### Step 7: Connect a customer

1. Go to **Admin > Integrations > New integration** and choose **Google Workspace**.
2. On the **Credentials & schedule** tab, press **Connect with Google**.
3. Sign in with that customer's **super admin**. A delegated admin also works if their role can read users, groups, reports, licences, alerts and devices.
4. On the "Google hasn't verified this app" screen, press **Advanced**, then **Go to Weavestream (unsafe)**. This warning appears because the app is your own and not reviewed by Google; the data only goes to your own Weavestream server.
5. Tick every permission and press **Continue**.

Back in Weavestream, press **Check setup** in the setup guide to confirm each API answers.

### Step 8: If the customer blocks third-party apps

If sign-in fails with "access blocked" or `admin_policy_enforced`, the customer only allows approved apps. In the customer's Google Admin console, open **Security > Access and data control > API controls > Manage third-party app access**, press **Configure new app**, search for your **Client ID**, and set it to **Trusted**. Then connect again.

### Step 9: Map layouts and run the first sync

1. Open **Organizations** and map the tenant to its Weavestream company.
2. Open **Map layouts** (see below), then set **Status** to active and save.
3. Run a **Dry run**, check **Run history**, then **Run sync now**.

## Map Layouts and Match-first

The **Map layouts** tab lists every Google resource. For each one, pick the layout it goes into (or create a new one, or skip it) and the field to match on. Weavestream suggests existing layouts by name, such as People for users and Phones for mobile devices.

On sync, a Google record whose match value equals **exactly one** unlinked asset you created yourself adopts that asset instead of creating a duplicate. Text matching ignores upper and lower case. If two or more assets match, the run reports it and links nothing, so you can clean up the duplicates first.

An adopted asset keeps the name you gave it. Assets that Google created follow the Google name (for example when a user is renamed).

## Reseller Subscriptions

> [!NOTE]
> Only for Google Workspace **resellers** (partners who buy Google Workspace for their customers through the Partner Sales Console). A direct Google customer cannot use it: Google answers with "This Google account is not a Google Workspace reseller".

The **Google Workspace (reseller)** integration is a separate integration that uses the same Google Cloud project and OAuth app. One integration covers **all** your reseller customers: connect once with an admin of your reseller domain, and every customer that holds a subscription is listed under **Organizations** by its domain. Map each one to its Weavestream company.

**Setup** follows the steps above with three differences:

1. In step 2, also enable the **Google Workspace Reseller API**.
2. In step 7, create **New integration > Google Workspace (reseller)** and sign in with your reseller admin, not a customer admin.
3. The only scope requested is `https://www.googleapis.com/auth/apps.order.readonly` (plus `openid` and `email`). It is read-only.

**What it syncs**: one record per subscription, named `<edition> - <customer domain>` and matched on the **Subscription ID**. Weavestream suggests a layout named like Licenses or Subscriptions. The integration section shows:

| Group | Values |
|---|---|
| Plan | Edition and SKU, plan (annual paid monthly or yearly, Flexible, Trial, Free), commitment, renewal setting, status, trial, purchase order |
| Seats | Licensed of purchased seats (annual plans) or licensed of maximum seats (Flexible and Trial) as a usage bar, plus each count |
| Dates | Created, commitment start, commitment end (renewal), trial end |

**Renewals in Expiring soon**: on **Map layouts**, add a date field flagged as an expiry to the subscriptions layout and map **Commitment end (renewal)** (or **Trial end**) to it. Renewal dates then appear in **Expiring soon** with reminders. These two fields are optional and not part of a new layout by default.

Tenant isolation: each sync first asks Google whether the mapped customer belongs to the connected reseller and only requests that customer's subscriptions, so a company never receives another customer's data.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Check setup: step 5 or 6 red, "does not recognise this client ID and secret" | Wrong client ID or secret (`invalid_client`) | Copy both again from **Clients** and save. Create a new secret if you lost it. |
| Check setup: step 5 red, "redirect URI is not registered" | Redirect URI missing or different (`redirect_uri_mismatch`) | Add the exact redirect URI from the guide under **Authorized redirect URIs**. |
| Check setup: step 2 red, names an API | API not enabled (`accessNotConfigured` / `SERVICE_DISABLED`) | Enable that API in the same project, wait a few minutes, check again. |
| Check setup: step 7 red, "no admin access" | The connected account is not an admin or lacks a privilege (403) | Reconnect with a super admin, or give the delegated admin read access to that data. |
| Check setup: step 7 red, "tick every permission" | A permission box was left unticked on the consent screen | Press **Reconnect** and tick every permission. |
| Check setup: step 8 red, or sign-in says access blocked | The customer blocks unconfigured apps (`admin_policy_enforced`) | Mark the client ID **Trusted** in the customer's Admin console (step 8). |
| Check setup: step 3 red, or sign-in says the app is limited to its organisation | Audience is **Internal** (`org_internal`) | Set Audience to **External** and publish the app. |
| **Reconnect** shown on the integration | The refresh token was revoked, the admin was deleted or lost admin rights, or it went unused for 6 months (`invalid_grant`) | Press **Reconnect** and sign in with a current admin. |
| Connections stop working after a week | The app is still in **Testing** (tokens expire after 7 days) | Press **Publish app** under **Audience**, then reconnect each customer. |
| "Google hasn't verified this app" warning | Expected for a self-hosted app | Press **Advanced**, then **Go to Weavestream (unsafe)**. |
| Google refuses new connections with a user cap message | An unverified app allows 100 approving admins over the project's life | Use a new Cloud project for the next customers, or submit the app for Google verification. |
| Storage shows "not available" or an older date | Usage reports lag 1–3 days | Wait; the next sync picks up newer figures. |
| A record was not linked and the run reports "multiple assets match" | Two or more of your assets share the match value | Remove or rename the duplicates, then sync again. |
| Reseller: "This Google account is not a Google Workspace reseller" | The connected account is not an admin of a reseller domain (403) | Reconnect with an admin who can sign in to the Partner Sales Console. |
| Reseller: "not one of the connected reseller's customers" | The mapped customer was transferred away or the mapping points at another customer | Remap the organization, or reconnect with the right reseller admin. |

## Security Model

- **Read-only.** The driver only sends GET requests to Google. Check setup is read-only too.
- **Scopes requested**: `openid`, `email`, and `admin.directory.user.readonly`, `admin.directory.group.readonly`, `admin.directory.group.member.readonly`, `admin.directory.domain.readonly`, `admin.directory.customer.readonly`, `admin.directory.device.chromeos.readonly`, `admin.directory.device.mobile.readonly`, `admin.reports.usage.readonly`, `apps.licensing`, `apps.alerts` (each prefixed with `https://www.googleapis.com/auth/`). Google offers no read-only variant of `apps.licensing` and `apps.alerts`; Weavestream only reads with them. The reseller integration requests only `apps.order.readonly` (plus `openid` and `email`).
- **Encrypted secrets.** The OAuth client secret and each customer's refresh token are encrypted at rest (AES-256-GCM) and never shown again or logged. Saving the client needs settings permission and an MFA step-up, and is audited.
- **State and PKCE.** Every connect uses a single-use random state bound to the signed-in user and a PKCE code verifier.
- **Tenant isolation.** A connection's tokens only ever feed the company its tenant is mapped to; a token for a different tenant stops the sync.
- **No raw Google errors.** Errors shown in Weavestream are fixed messages; Google's own error text is never passed through.
- **Hidden from client users.** Google Workspace sections are never shown to client users, even on assets they can see.
