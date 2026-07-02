# Pivot-Tech Middleware — Claude Code Context

## Who You Are Working With
- **Company:** Pivot-Tech Development Inc. (`pivot-tech.io`)
- **Owner/Director:** Jim, CEO — product owner for this project
- **Dev partner:** Revolutic (`revolutic.com`) may review or extend this codebase
- **You are:** Senior backend engineer executing against a fully written functional spec

---

## What This Project Is

A Node.js middleware platform that connects three vendor services into a
seamless consumer MVNO product — **MobilityNet**, sold as
**$25/month unlimited talk, text & data** — and, increasingly, an **MVNE**
platform that white-labels the same stack for partner brands (multi-tenant).

### The Three Vendor Layers

| Layer | Vendor | Role |
|---|---|---|
| Cellular data | BICS SIMforThings | eSIM data — LTE/5G, roaming profile 19855 (ATT+TMO) |
| Dialer app | Acrobits Cloud Softphone | White-label dialer, external provisioning, HTTP messaging, push notifications |
| PSTN gateway | Telnyx | SIP trunking (credential connection 2984224004669178914), DID inventory, SMS P2P, E911, CNAM, number porting (FastPort) |

> **Migration note:** The platform was originally specced against SignalWire and
> was fully migrated to **Telnyx**. Two DB column names are retained for
> compatibility and now hold Telnyx identifiers: `dids.signalwire_sid` (the
> Telnyx phone-number resource id) and `port_requests.signalwire_port_id` (the
> Telnyx port-order id). `SIGNALWIRE_WEBHOOK_SECRET` is likewise a legacy env
> name for the shared HMAC secret. There is no live SignalWire integration.

### Key Architectural Insight
Customer DIDs exist **only** in the Telnyx/SIP stack. The native iOS Phone.app
is irrelevant by design — the Acrobits dialer is the sole phone interface for a
customer's number. Voice, SMS and MMS ride over the data connection as SIP/IP;
SMS/MMS specifically flow over **HTTP web services** (Acrobits cannot bridge
messaging over SIP), through this middleware to the Telnyx Messaging API.

---

## MVNE Multi-Tenant Model

The platform is multi-tenant. The flagship tenant is **MobilityNet**; partner
brands (MVNE customers) are additional tenants that reuse the whole stack with
their own branding, plan catalog, Acrobits Cloud ID, and Telnyx/BICS config.

- `tenants` table holds per-tenant config (brand, plans JSONB, billing config,
  Acrobits Cloud ID, Telnyx credential connection, BICS SIM range).
- **Default tenant** (MobilityNet): `00000000-0000-4000-a000-000000000001`.
- Every tenant-scoped table carries `tenant_id UUID NOT NULL`
  (`accounts`, `dids`, `admin_users`, `call_records`, `message_records`,
  `usage_records`, `push_tokens`). `port_requests` and `provisioning_tokens`
  inherit tenancy through their `account_id`.
- `src/middleware/tenantResolver.js` resolves the request's tenant (by host /
  header) and attaches it to the request; reads take an optional `tenantId`
  filter, writes default to the caller's tenant.
- Admin routes scope by role: `super_admin` sees all tenants (or filters by
  `?tenant_id=`); a tenant-scoped admin sees only its own.
- Tenant onboarding is a 6-step wizard in the dashboard (`/admin/tenants/onboard`).

---

## Tech Stack

```
Runtime:        Node.js 20 LTS
Language:       JavaScript (ES2022) — no TypeScript in the middleware
Framework:      Express.js
Database:       PostgreSQL 15 (AWS RDS)
Cache:          Redis 7 (AWS ElastiCache)
Queue:          AWS SQS
Secrets:        AWS Secrets Manager (SECRETS_ARN injects the JSON secret at boot)
Containers:     Docker → AWS ECR → AWS App Runner
CI/CD:          GitHub Actions → ECR → App Runner
Testing:        Jest + Supertest (570 tests)
Linting:        ESLint (airbnb-base)
Logging:        Pino (structured JSON) — never log SIP passwords, transfer PINs, account numbers
```

Dashboard (separate repo, Next.js/TypeScript on Netlify) consumes the admin +
customer APIs.

---

## Project Structure

```
pivot-tech-middleware/
├── CLAUDE.md
├── .env.example                 ← every env var, documented; never commit .env
├── src/
│   ├── app.js                   ← Express app factory (mounts routes, tenantResolver)
│   ├── server.js                ← boot: secrets → config → migrate → listen
│   ├── scheduler.js             ← background poller (BICS usage every N hours)
│   ├── config/
│   │   ├── index.js             ← loads + validates env, groups vendor config
│   │   ├── markets.js           ← market → ordered area codes
│   │   └── secrets.js           ← AWS Secrets Manager bootstrap (pre-Pino)
│   ├── db/
│   │   ├── index.js             ← pg pool singleton
│   │   ├── migrate.js           ← applies migrations/*.sql once, in order
│   │   └── migrations/          ← 001…024 sequential SQL
│   ├── cache/index.js           ← Redis client singleton
│   ├── services/
│   │   ├── accountService.js            ├── adminService.js
│   │   ├── adminUserService.js          ├── authService.js
│   │   ├── didOrchestrationService.js   ├── portOrchestrationService.js
│   │   ├── provisioningService.js       ├── webhookService.js
│   │   ├── messagingService.js          ├── pushService.js
│   │   ├── cdrService.js                ├── voiceService.js
│   │   ├── usageService.js              ├── tenantService.js
│   │   ├── telgoo5Service.js            ├── billingExportService.js
│   │   ├── billingMigrationService.js   ├── notificationService.js
│   │   └── emailTemplates.js
│   ├── routes/
│   │   ├── v1/  accounts, auth, dids, provision, webhooks, messages,
│   │   │        acrobitsMessaging, voice, billing, partner
│   │   └── admin/  index.js, tenants.js
│   ├── middleware/
│   │   ├── auth.js              ← customer JWT
│   │   ├── adminAuth.js         ← admin JWT + role + IP allowlist
│   │   ├── tenantResolver.js    ← resolves + attaches tenant
│   │   ├── telnyxWebhookVerify.js ← Ed25519 webhook verification
│   │   ├── errorHandler.js  rateLimiter.js
│   ├── integrations/
│   │   ├── telnyx.js            ← ALL Telnyx API calls
│   │   ├── bics.js             ← BICS SIMforThings (eSIM/data)
│   │   ├── acrobits.js         ← Account XML generation
│   │   ├── telgoo5.js          ← Telgoo5/vCare billing
│   │   └── email.js            ← Amazon SES
│   └── utils/  crypto.js, e164.js, token.js, logger.js
└── tests/  unit/, integration/
```

---

## Database Schema

Sequential migrations in `src/db/migrations` are the source of truth
(`001`…`024`). Core tables and their key columns:

- **tenants** — `id, slug (unique), name, domain, acrobits_cloud_id,
  brand_config JSONB, plans JSONB, bics_sim_range TEXT[],
  telnyx_credential_conn_id, roaming_profile_id, billing_config JSONB,
  status ('onboarding'|'active'|'suspended'|'cancelled')`.
- **accounts** — `id, tenant_id, email (unique), phone_e164, first_name,
  last_name, status ('pending'|'active'|'suspended'|'cancelled'), market, plan,
  sip_endpoint_id, sip_username, sip_password_hash, esim_iccid,
  bics_endpoint_id, external_billing_provider, parent_account_id (multi-line),
  e911_address_id, e911_enabled, activated_at, cancelled_at, timestamps`.
- **dids** — `id, tenant_id, e164 (unique), area_code, market,
  signalwire_sid (Telnyx number resource id), account_id, campaign_id,
  status ('available'|'assigned'|'porting_in'|'porting_out'|'reserved'),
  ported_in`.
- **port_requests** — `id, account_id, number_e164, losing_carrier,
  account_number, pin_encrypted (AES-256-GCM), billing_zip,
  signalwire_port_id (Telnyx port-order id), status, failure_reason,
  submitted_at, completed_at`.
- **provisioning_tokens** — `id, account_id, token_hash (unique), used,
  expires_at` (single-use, 72h TTL).
- **admin_users** — `id, tenant_id, username (unique), email (unique),
  password_hash (bcrypt), role ('super_admin'|'admin'|'viewer'), last_login_at`.
- **call_records** — `id, tenant_id, account_id, call_sid, direction, from_number,
  to_number, status, duration_seconds, started_at, ended_at` (voice CDRs).
- **message_records** — `id, tenant_id, account_id, message_id, direction,
  from_number, to_number, status, message_type ('sms'|'mms')` (messaging CDRs).
- **usage_records** — `id, tenant_id, account_id, endpoint_id, period_start,
  period_end, data_*_mb, data_cost, sms_count, plan_data_cap_mb, overage_mb,
  overage_charge, polled_at` (BICS usage snapshots).
- **push_tokens** — `id, account_id, tenant_id, selector, push_token_calls,
  push_token_other, push_app_id_calls, push_app_id_other, device_id, platform`,
  `UNIQUE(account_id, selector)` (Acrobits Push Token Reporter).
- **messages** — per-message store backing the Acrobits fetch/thread view.
- **tcr_campaigns** — 10DLC campaign metadata (`signalwire_campaign_id` legacy name).

---

## API Surface

All customer endpoints versioned under `/v1/`; admin under `/admin/`.
Responses JSON (except Acrobits endpoints, which return XML). All phone numbers
E.164. Customer auth: Bearer JWT. Admin: admin-scoped JWT (role + IP allowlist).

### Customer / app endpoints
```
POST   /v1/auth/token                     Issue customer JWT
POST   /v1/auth/send-code                 Passwordless login: email a code
POST   /v1/auth/verify-code               Passwordless login: verify + issue JWT

POST   /v1/accounts                       Create account (new number or port-in)
GET    /v1/accounts/:id                   Account detail
PATCH  /v1/accounts/:id                   Update account
GET    /v1/accounts/:id/status            Lightweight onboarding poll
GET    /v1/accounts/:id/history           Call + message history
GET    /v1/accounts/:id/usage             Usage stats

GET    /v1/numbers/available              Search available DIDs (by area code)
GET    /v1/provision                      Acrobits Account XML (token flow)
POST   /v1/provision/reissue              Reissue provisioning token

POST   /v1/messages                       Send SMS/MMS
GET    /v1/messages                       List messages
GET    /v1/messages/conversation/:number  Conversation thread

GET|POST /v1/acrobits/send                Acrobits outbound message web service
GET      /v1/acrobits/fetch               Acrobits message polling (Modern API XML)
POST     /v1/acrobits/push-token          Acrobits Push Token Reporter
GET      /v1/acrobits/provision           Acrobits External Provisioning (Account XML, SIP-auth)

POST   /v1/voice/status                   Telnyx voice status callback (CDRs)
GET    /v1/billing/:accountId             Billing summary
GET    /v1/billing/export[/csv]           Billing export
POST   /v1/partner/link | /unlink         Broadband partner linkage
GET    /v1/partner/status

POST   /v1/webhooks/port                  Telnyx port lifecycle
POST   /v1/webhooks/telnyx                General Telnyx events
POST   /v1/webhooks/messaging             Telnyx messaging (inbound + delivery, Ed25519)
```

### Admin endpoints (`/admin`, super_admin-gated where noted)
```
POST   /admin/login | /forgot-password | /reset-password | /bootstrap
GET    /admin/whoami
GET|POST /admin/users   PATCH|DELETE /admin/users/:id            (super_admin)
GET    /admin/accounts  GET /admin/accounts/:id
GET    /admin/accounts/:id/history | /usage
PATCH  /admin/accounts/:id | /admin/accounts/:id/status
POST   /admin/accounts/:id/refresh-sip-credentials               (super_admin)
POST   /admin/accounts/:id/provision/reissue
GET    /admin/dids   GET /admin/ports   POST /admin/ports/:id/retry
GET    /admin/metrics   GET /admin/usage/summary   POST /admin/usage/poll
GET    /admin/analytics/hourly-activity | usage-distribution |
       hourly-data-voice | hourly-messages | usage-trends | billing-reconciliation
# Tenants (super_admin):
GET|POST /admin/tenants   GET /admin/tenants/:id   GET /admin/tenants/:id/accounts
PATCH  /admin/tenants/:id   POST /admin/tenants/:id/suspend | /activate
```

---

## Error Response Format

Always return this shape on errors — no exceptions:

```json
{
  "error": {
    "code": "DID_UNAVAILABLE",
    "message": "No numbers available in area code 208. Please try 630.",
    "field": "area_code",
    "trace_id": "req_abc123"
  }
}
```

Standard codes: `VALIDATION_ERROR`, `NOT_FOUND`, `UNAUTHORIZED`, `FORBIDDEN`,
`DID_UNAVAILABLE`, `PORT_ALREADY_PENDING`, `PORT_SUBMISSION_FAILED`,
`TOKEN_EXPIRED`, `TELNYX_ERROR` (migrated equivalent of the old
`SIGNALWIRE_ERROR`), `INTERNAL_ERROR`.

---

## Telnyx Integration

Base URL: `https://api.telnyx.com/v2` — Bearer auth (`TELNYX_API_KEY`).
All Telnyx calls live in `src/integrations/telnyx.js`. Never call Telnyx from a
route/service directly.

Key capabilities used:
- **Number search / purchase** — `GET /available_phone_numbers`,
  `POST /number_orders`.
- **Provision a number** — resolve its numeric resource id, then
  `PATCH /phone_numbers/{id}/voice` (point at the TeXML voice connection) and
  `PATCH /phone_numbers/{id}/messaging` (attach the messaging profile). The
  messaging sub-resource can lag the order; retry once on 404.
- **SIP credentials (gencred)** — Telnyx auto-generates the SIP
  username/password on the credential connection; we store the bcrypt hash and
  hold plaintext only in memory during Account XML rendering. Passwords are NOT
  rotatable — fetch the existing credential on GET when needed.
- **CNAM** — `PATCH /phone_numbers/{id}/voice` with a `cnam_listing` object
  (name capped at 15 chars; brand fallback "MobilityNet").
- **E911** — create address + enable emergency calling (best-effort).
- **SMS/MMS** — Messaging API (`from` = subscriber DID).
- **Porting** — FastPort submit; lifecycle via `/v1/webhooks/port`.

Retry policy: 3 retries, exponential backoff 1s/2s/4s; 4xx (except 429) not
retried; on exhaustion log, emit ops alert, throw `TELNYX_ERROR`.

---

## Acrobits Provisioning & Messaging

### Account XML (`GET /v1/provision?token=…` and `GET /v1/acrobits/provision`)

Built in `src/integrations/acrobits.js`. Returns XML, not JSON. The exact,
current element choices (each is load-bearing — see decisions below):

```xml
<account>
  <username>{gencred SIP username}</username>        <!-- NOT the phone number -->
  <fromUser>{phone_e164}</fromUser>                  <!-- outbound caller ID number -->
  <authUsername>{gencred SIP username}</authUsername>
  <password>{sip_password_plaintext}</password>
  <host>sip.telnyx.com</host>                         <!-- NOT <domain> -->
  <transport>udp</transport>                          <!-- lowercase; NO <port> element -->
  <title>Pivot-Tech</title>
  <allowMessage>0</allowMessage>                       <!-- SIMPLE off; messaging via web service -->
  <allowVideo>1</allowVideo>
  <pushEnabled>1</pushEnabled>
  <displayName>{first last | national-format number}</displayName>
  <codecPriority>OPUS,ULAW,ALAW</codecPriority>
  <genericSmsSendUrl>{BASE}/v1/acrobits/send?username=%account[authUsername]%&amp;password=%account[password]%&amp;to=%sms_to%&amp;body=%sms_body%</genericSmsSendUrl>
  <genericSmsFetchUrl>{BASE}/v1/acrobits/fetch?username=%account[authUsername]%&amp;password=%account[password]%&amp;last_known=%last_known_sms_id%</genericSmsFetchUrl>
  <pushTokenReporterUrl>{BASE}/v1/acrobits/push-token</pushTokenReporterUrl>
  <pushTokenReporterPostData>username=%account[authUsername]%&amp;password=%account[password]%&amp;selector=%selector%&amp;pushTokenIncomingCall=%pushTokenIncomingCall%&amp;pushTokenOther=%pushTokenOther%&amp;pushappid_incoming_call=%pushappid_incoming_call%&amp;pushappid_other=%pushappid_other%</pushTokenReporterPostData>
  <pushTokenReporterContentType>application/x-www-form-urlencoded</pushTokenReporterContentType>
  <rewriting><!-- prepend +1 to 10-digit US; + to 11-digit starting with 1 --></rewriting>
</account>
```

**Provisioning security:** token single-use, 72h TTL; plaintext SIP password
only in this XML + in-memory during credential rendering — never logged/stored;
`TOKEN_EXPIRED` (401) if expired/used. External Provisioning (`/v1/acrobits/provision`)
authenticates by SIP credentials instead of a token (Acrobits calls it
repeatedly), accepting `username`/`password` or `cloud_username`/`cloud_password`.

### Messaging web services
- `GET|POST /v1/acrobits/send` — auth by SIP creds; normalizes `to` to E.164;
  reads the body from `p.body || p.sms_body || p.message_body`; sends via Telnyx.
- `GET /v1/acrobits/fetch` — returns **Modern API** XML: top-level `<date>`,
  `<item>` blocks with `<sms_id>`, `<sending_date>`, `<sender>`, `<recipient>`
  (both sides so the app threads correctly), `<sms_text>`, `<content_type>`,
  `<stream_id>` (the peer number).

### Push notifications
- `POST /v1/acrobits/push-token` — Push Token Reporter; UPSERT by
  `(account_id, selector)`; stores the calls + "other" tokens/app-ids.
- Inbound messages POST a `NotifyTextMessage` to
  `https://pnm.cloudsoftphone.com/pnm2/send` using the "other" token
  (best-effort, never throws).

---

## Security Rules — Non-Negotiable

1. **Never log:** SIP passwords, transfer PINs, full account numbers, full DIDs in query params.
2. **Transfer PINs:** AES-256-GCM encrypted at rest; decrypted only in
   `portOrchestrationService` immediately before Telnyx submission; never returned.
3. **SIP passwords:** bcrypt-hashed for storage; plaintext only in memory during
   credential creation + Account XML rendering.
4. **All secrets** from AWS Secrets Manager via `SECRETS_ARN` (`config/secrets.js`);
   never from `.env` in production.
5. **Webhook validation:** Telnyx messaging/voice webhooks are **Ed25519**-verified
   (`telnyx-signature-ed25519` + `telnyx-timestamp` over `${timestamp}|${rawBody}`,
   `src/middleware/telnyxWebhookVerify.js`). The `/port` and `/telnyx` routes use a
   shared-secret HMAC (`x-telnyx-signature`). Hard-reject (403) on failure.
6. **Idempotency:** webhook handlers are idempotent (CDR UPSERT by call_sid /
   message_id; port events keyed by the Telnyx port id).

---

## Environment Variables

`.env.example` is the authoritative, documented list. Groups:

- **Server:** `NODE_ENV, PORT, LOG_LEVEL, CORS_ORIGINS, SECRETS_ARN`
- **Data stores:** `DATABASE_URL, REDIS_URL`
- **Auth:** `JWT_SECRET, JWT_PUBLIC_KEY, ADMIN_JWT_SECRET, ADMIN_IP_ALLOWLIST, ENCRYPTION_KEY`
- **Telnyx:** `TELNYX_API_KEY, TELNYX_SIP_CONNECTION_ID, TELNYX_MESSAGING_PROFILE_ID,
  TELNYX_OUTBOUND_VOICE_PROFILE_ID, TELNYX_WEBHOOK_PUBLIC_KEY`
  (`SIGNALWIRE_WEBHOOK_SECRET` retained as the legacy HMAC secret name)
- **BICS:** `BICS_USERNAME, BICS_PASSWORD, BICS_BASE_URL, BICS_TARGET_ACCOUNT_ID,
  BICS_PLAN_ID, BICS_APN_GROUP_ID, BICS_ROAMING_PROFILE_ID, BICS_DATA_COUNTER_ID`
- **Acrobits:** `ACROBITS_CLOUD_ID`
- **Billing (Telgoo5/vCare):** `TELGOO5_BASE_URL, TELGOO5_VENDOR_ID, TELGOO5_USERNAME,
  TELGOO5_PASSWORD, TELGOO5_PIN, TELGOO5_AGENT_ID, TELGOO5_CARRIER`
- **Partners:** `FOX_PARTNER_KEY, CONFLUENCE_PARTNER_KEY`
- **Email (SES):** `EMAIL_FROM, EMAIL_ENABLED`
- **Push (APNs/FCM):** `APNS_KEY_ID, APNS_TEAM_ID, APNS_BUNDLE_ID, APNS_PRIVATE_KEY,
  FCM_PROJECT_ID, FCM_PRIVATE_KEY, FCM_CLIENT_EMAIL`
- **AWS/queues:** `AWS_REGION, SQS_DID_ASSIGNMENT_QUEUE_URL, SQS_NOTIFICATION_QUEUE_URL`
- **App:** `PROVISIONING_BASE_URL, PROVISIONING_TOKEN_TTL_HOURS, USAGE_POLL_INTERVAL_HOURS`

---

## Key Architectural Decisions

- **[DECISION]** Acrobits messaging web-service URLs are delivered in the
  **Account XML** via external provisioning (`genericSmsSendUrl` /
  `genericSmsFetchUrl`), **not** in the Acrobits portal's "Outgoing SMS via web
  service" field.
- **[DECISION]** Account XML template variables use Acrobits Account XML syntax:
  `%account[authUsername]%` and `%account[password]%` (resolve from the same
  document), plus service vars `%sms_to%`, `%sms_body%`, `%last_known_sms_id%`,
  and push vars `%selector%`, `%pushTokenIncomingCall%`, `%pushTokenOther%`,
  `%pushappid_incoming_call%`, `%pushappid_other%`.
- **[DECISION]** The `/v1/acrobits/send` handler reads the body from
  `p.body || p.sms_body || p.message_body` (Acrobits varies the field name).
- **[DECISION]** `<username>` in the Account XML must be the **gencred** SIP
  credential (matching `<authUsername>`) so SIP REGISTER authenticates — **not**
  the phone number. The subscriber's E.164 lives in `<fromUser>` / `<callerID>` /
  `<displayName>`.
- **[DECISION]** SIP account uses `<host>` (not `<domain>`), lowercase
  `<transport>udp`, and **no** `<port>` element (unrecognized) — this is what
  Telnyx SIP registration accepts.
- **[DECISION]** `<allowMessage>0</allowMessage>` — SIP SIMPLE messaging is off;
  all messaging runs over HTTP via the generic SMS web service.
- **[DECISION]** Telnyx SIP credential passwords are vendor-generated and cannot
  be rotated; provisioning fetches the existing credential rather than rotating.
- **[DECISION]** `dids.signalwire_sid` / `port_requests.signalwire_port_id` keep
  their legacy names but hold Telnyx ids; not renamed to avoid a data migration.

---

## Markets

Config-driven (`src/config/markets.js`) — new markets add here, no code change.
Current: **Lewiston, Idaho** (`208`), **Kendall County, Illinois** (`630`, `331`).
Area codes are tried in order until Telnyx returns availability. Market is stored
on every account and DID.

---

## Delivery Status

Phases 1–3 are built and deployed; parts of Phase 4 (multi-tenant/MVNE, billing)
are in progress.

**Done:**
- Project scaffolding, Docker, sequential migrations (auto-applied at boot).
- Account service (CRUD, JWT + passwordless email login, status machine, multi-line).
- DID orchestration on Telnyx (search → purchase → route voice/messaging → SIP
  credential → E911 → CNAM).
- Provisioning (Account XML, single-use token, External Provisioning, QR/deep link).
- Messaging: outbound + inbound SMS/MMS via Telnyx; Acrobits HTTP web services
  (send/fetch Modern API); push via Acrobits PNM.
- Voice: inbound TeXML routing + call/message CDRs (`cdrService`).
- Webhooks: Telnyx Ed25519 verification, idempotent handlers.
- Admin API: accounts, DID inventory, ports, metrics, analytics, admin users.
- MVNE multi-tenant: tenants table, `tenant_id` everywhere, tenantResolver,
  tenant onboarding wizard, tenant-scoped admin.
- Billing: Telgoo5/vCare integration, billing export, billing reconciliation;
  BICS usage polling via the background scheduler.
- Port-in (FastPort) with status tracking + admin retry.
- Email via Amazon SES.

**Phase 4 remaining / in progress:** multi-tenant Telnyx/BICS sharding at scale,
Stripe billing, customer self-service portal, CPNI/CCPA tooling.

---

## Deployment

- **GitHub:** `git@github.com:PivotJDC/pivot-tech-middleware.git` (branch `main`)
- **App Runner service:** `pivot-tech-middleware-v11`
- **Middleware URL:** `https://bwgwcrstym.us-east-1.awsapprunner.com`
- **Dashboard:** `https://mymobilitynet.io` (Netlify, separate Next.js repo)
- **Version:** `v0.5.1-alpha` — 570 tests passing
- CI/CD: GitHub Actions → ECR → App Runner. Do **not** run
  `aws apprunner start-deployment` unprompted.

---

## How to Work With Jim

- Jim is the CEO and product owner, not a developer. Explain technical decisions
  in plain language when asking for input.
- On spec ambiguity: make a reasonable decision, implement it, and leave a
  `// DECISION: [explanation]` comment. Never block on a question you can default.
- Commit frequently with clear messages (`feat:`, `fix:`, `test:`, `chore:`,
  `docs:`). Keep lint + the full test suite green before committing.
- After a milestone, output a plain-language summary of what changed and what the
  next session should start with.

---

## Starting a New Claude Code Session

1. Read this file (`CLAUDE.md`).
2. `git log --oneline -10` to orient.
3. `npm test` to confirm current status.
4. Ask Jim what to focus on today.
5. Then proceed.
