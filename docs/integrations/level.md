---
label: Level
icon: plug
description: Sync Level RMM devices per top-level group, with hardware, storage, OS, network, security, patches and alerts.
---

# Level Integration

**Level** is a remote monitoring and management (RMM) platform for Windows, macOS and Linux devices.

The Weavestream Level driver is **read-only**. One integration is one Level account. Each **top-level group** in Level is mapped to one Weavestream company, and its devices (including the devices of groups nested under it) sync into that company.

## Overview & Features

- **One API key per Level account**: a Read-only key is all it needs.
- **Top-level groups as organizations**: map each top-level group to a company. Nested groups sync with their top-level group.
- **Match first**: on the first sync, Level devices link to the assets you already have by **serial number**. An asset is only created when nothing matches.
- **No new layout fields beyond name and serial number**: everything else shows in a **Level** section on the asset page.
- **Built-in setup guide and Check setup**: the steps below are also shown on the integration's **Credentials & schedule** tab, and **Check setup** points to the step that needs fixing.

## Synced Data Reference

| Resource | Suggested layout | Matched on | Layout fields |
|---|---|---|---|
| **Devices** | Workstations, Computers, Servers, Devices, Configurations or Laptops (or a new **Devices** layout) | Serial number | Name (nickname, or hostname when there is none), Serial number |

The **Level** section on each device shows these groups:

| Group | Contents |
|---|---|
| **Status** | Online or offline, last seen, last reboot, logged-in user, maintenance mode, role, platform, group, location |
| **Hardware** | Manufacturer, model, serial number, CPU and cores, memory, memory slots and modules, disks (model, type, size), motherboard, BIOS version, architecture |
| **Storage** | One usage bar per partition (used = size minus free space), labelled by mount point |
| **Operating system** | Name, version, end of life (red when the OS is end of life), install date |
| **Network** | Public IP, private IPs, and per network interface its MAC address, IP addresses, gateway and DNS servers |
| **Security** | Risk, security score, patch compliance, antivirus, firewall, encryption of the primary partition, user account control, automatic updates, admin accounts |
| **Patches** | Number of available updates and the first 20 by name |
| **Alerts** | Number of active alerts and the first 20 with severity and start time |
| **Tags** | Level tags |
| **Notes** | Level device notes |

Devices **without a serial number** (common for virtual machines) are created as new assets on the first sync and stay linked by their Level device id afterwards; they cannot match an existing asset.

### What Level's API does not provide

- **Installed software.**
- **Agent version.**
- **Warranty dates.**

### Limits

- **Devices that are in no group are not synced.** Put them in a group in Level.
- **Alerts and patches need the matching Level access.** If your plan or key cannot read them, devices still sync and the group says "Not available".
- **Very large accounts.** Active alerts and available updates hold at most 50,000 entries per sync. Above that, the group says the data is not shown instead of showing a partial list.

## Setup Instructions

### Step 1: Create a read-only API key in Level

In Level, open **Settings > API keys** and press **Create API key**. Name it, for example **Weavestream**, and set the access level to **Read-only**. Copy the key. A Level key covers the whole account and does not expire, so store it safely.

### Step 2: Paste the key into Weavestream

1. Go to **Admin > Integrations > New integration** and choose **Level**.
2. On the **Credentials & schedule** tab, paste the key into **API key** and save.
3. Press **Test connection**, then **Check setup** in the setup guide.

### Step 3: Map each top-level group to a company

Open **Organizations**. Every top-level group in Level is listed. Map each one to its Weavestream company.

### Step 4: Map layouts and run the first sync

1. Open **Map layouts** (see below), then set **Status** to active and save.
2. Run a **Dry run**, check **Run history**, then **Run sync now**.

## Map Layouts and Match-first

The **Map layouts** tab lists the **Devices** resource. Pick the layout devices go into (or create a new one, or skip it) and the field to match on. Weavestream suggests existing layouts by name, such as Workstations or Configurations, and a field named like Serial number. If the layout you pick has no field for a value the integration needs (the name or the serial number), choose **Create field** and Weavestream adds that field to the layout when you save.

On sync, a device whose serial number equals **exactly one** unlinked asset you created yourself adopts that asset instead of creating a duplicate. Text matching ignores upper and lower case. If two or more assets match, the run reports it and links nothing.

An adopted asset keeps the name you gave it. Assets that Level created follow the Level name.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Test connection or Check setup: "does not accept this API key" | The key is mistyped or was revoked (HTTP 401) | Create a new key (step 1) and paste it again (step 2). |
| Check setup: "has no access to devices and groups" | The key lacks access (HTTP 403) | Create a key with **Read-only** access. |
| Check setup: "rate limiting" | Level returned HTTP 429 | Wait a minute and check again. Syncs retry on their own. |
| Check setup: "no top-level groups" | No groups exist in Level | Put devices in a group in Level. |
| Sync fails with "not a top-level group of this Level account" | The mapped group was deleted, moved under another group, or belongs to another account | Map a group that is listed under **Organizations**. |
| A device is missing | It is in no group | Put it in a group in Level. |
| Patches or Alerts say "Not available" | Your plan or key cannot read updates or alerts | Use a key and plan with that access. Devices still sync. |
| A record was not linked and the run reports "multiple assets match" | Two or more of your assets share the serial number | Remove or rename the duplicates, then sync again. |

## Security Model

- **Read-only.** The driver only sends GET requests to `https://api.level.io/v2`. Check setup is read-only too. A **Read-only** key is recommended.
- **Encrypted key.** The API key is encrypted at rest (AES-256-GCM), never shown again and never logged. Level expects the raw key in the `Authorization` header.
- **Tenant isolation.** A company only receives devices of the top-level group mapped to it, and only when that group is a top-level group of the connected account.
- **No raw Level errors.** Errors shown in Weavestream are fixed messages; Level's own error text is never passed through.
- **Hidden from client users.** Level sections are never shown to client users, even on assets they can see.

Reference: [Level public API, getting started](https://docs.level.io/en/articles/12152745-public-api-getting-started) and the [Level API reference](https://developers.level.io).
