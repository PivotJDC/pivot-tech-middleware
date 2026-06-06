# Pivot-Tech Middleware — Claude Code Context

## Who You Are Working With
- **Company:** Pivot-Tech Development Inc. (`pivot-tech.io`)
- **Owner/Director:** Jim, CEO — product owner for this project
- **Dev partner:** Revolutic (`revolutic.com`) may review or extend this codebase
- **You are:** Senior backend engineer executing against a fully written functional spec

---

## What This Project Is

A Node.js middleware platform that connects three vendor services into a
seamless consumer MVNO product sold as **$25/month unlimited talk, text & data**.

### The Three Vendor Layers

| Layer | Vendor | Role |
|---|---|---|
| Cellular data | BICS SIMforThings | eSIM data pipe — LTE/5G. Voice/SMS ride over data as SIP/IP. No native voice at cellular layer. |
| Dialer app | Acrobits Cloud Softphone | White-label iOS/Android dialer. CallKit, SIP, SMS/MMS, video, VoIP push. Published as Pivot-Tech branded app. |
| PSTN gateway | SignalWire | SIP trunking, DID inventory, PSTN termination, 10DLC messaging, number porting. All customer phone numbers (DIDs) live here. |

### Key Architectural Insight
Customer DIDs exist **only** in the SignalWire/SIP stack. The native iOS
Phone.app is irrelevant by design — the Acrobits dialer is the sole phone
interface for a customer's Pivot-Tech number. This eliminates the iOS
default-dialer problem entirely.

---

## Tech Stack

```
Runtime:        Node.js 20 LTS
Language:       JavaScript (ES2022) — no TypeScript unless Jim explicitly requests it
Framework:      Express.js
Database:       PostgreSQL 15 (AWS RDS)
Cache:          Redis 7 (AWS ElastiCache)
Queue:          AWS SQS
Secrets:        AWS Secrets Manager — never hardcode credentials
Containers:     Docker → AWS ECR → AWS App Runner (MVP) or ECS Fargate (scale)
CI/CD:          GitHub Actions → ECR → App Runner
Testing:        Jest + Supertest
Linting:        ESLint (airbnb-base)
Logging:        Pino (structured JSON) — never log SIP passwords, transfer PINs, or account numbers
```

---

## Project Structure

```
pivot-tech-middleware/
├── CLAUDE.md                    ← you are here
├── .env.example                 ← document all env vars, never commit .env
├── .gitignore
├── package.json
├── docker-compose.yml           ← local dev: postgres + redis
├── Dockerfile
├── src/
│   ├── app.js                   ← Express app factory (no listen here)
│   ├── server.js                ← starts HTTP server
│   ├── config/
│   │   └── index.js             ← loads env vars, validates required keys
│   ├── db/
│   │   ├── index.js             ← pg pool singleton
│   │   └── migrations/          ← sequential SQL files: 001_create_accounts.sql etc.
│   ├── cache/
│   │   └── index.js             ← Redis client singleton
│   ├── queue/
│   │   └── index.js             ← SQS client, sendMessage, receiveMessage helpers
│   ├── services/
│   │   ├── accountService.js
│   │   ├── provisioningService.js
│   │   ├── didOrchestrationService.js
│   │   ├── portOrchestrationService.js
│   │   ├── webhookService.js
│   │   └── notificationService.js
│   ├── routes/
│   │   ├── v1/
│   │   │   ├── accounts.js
│   │   │   ├── provision.js
│   │   │   ├── dids.js
│   │   │   ├── ports.js
│   │   │   └── webhooks.js
│   │   └── admin/
│   │       └── index.js
│   ├── middleware/
│   │   ├── auth.js              ← JWT validation
│   │   ├── adminAuth.js         ← admin-scoped JWT + IP allowlist
│   │   ├── errorHandler.js      ← structured error responses
│   │   ├── rateLimiter.js       ← Redis-backed rate limiting
│   │   └── sanitizeLog.js       ← strips sensitive fields from logs
│   ├── integrations/
│   │   ├── signalwire.js        ← all SignalWire API calls
│   │   └── acrobits.js          ← Account XML generation
│   └── utils/
│       ├── crypto.js            ← AES-256 encrypt/decrypt for transfer PINs
│       ├── token.js             ← provisioning token generate/validate
│       └── e164.js              ← phone number formatting helpers
├── tests/
│   ├── unit/
│   └── integration/
└── infra/
    ├── docker-compose.yml
    └── github-actions/
        └── deploy.yml
```

---

## Database Schema

### accounts
```sql
CREATE TABLE accounts (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email               VARCHAR(255) UNIQUE NOT NULL,
  phone_e164          VARCHAR(20),
  status              VARCHAR(20) NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','active','suspended','cancelled')),
  market              VARCHAR(100) NOT NULL,
  plan                VARCHAR(50) NOT NULL DEFAULT 'unlimited_25',
  sip_endpoint_id     VARCHAR(100),
  sip_username        VARCHAR(100),
  sip_password_hash   VARCHAR(255),
  esim_iccid          VARCHAR(50),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  activated_at        TIMESTAMPTZ,
  cancelled_at        TIMESTAMPTZ
);
```

### dids
```sql
CREATE TABLE dids (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  e164                VARCHAR(20) UNIQUE NOT NULL,
  area_code           VARCHAR(3) NOT NULL,
  market              VARCHAR(100) NOT NULL,
  signalwire_sid      VARCHAR(100) NOT NULL,
  account_id          UUID REFERENCES accounts(id),
  campaign_id         UUID REFERENCES tcr_campaigns(id),
  status              VARCHAR(20) NOT NULL DEFAULT 'available'
                        CHECK (status IN ('available','assigned','porting_in','porting_out','reserved')),
  ported_in           BOOLEAN NOT NULL DEFAULT FALSE,
  ported_in_at        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### port_requests
```sql
CREATE TABLE port_requests (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id          UUID NOT NULL REFERENCES accounts(id),
  number_e164         VARCHAR(20) NOT NULL,
  losing_carrier      VARCHAR(100) NOT NULL,
  account_number      VARCHAR(100) NOT NULL,
  pin_encrypted       VARCHAR(500) NOT NULL,
  billing_zip         VARCHAR(10) NOT NULL,
  signalwire_port_id  VARCHAR(100),
  status              VARCHAR(20) NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('submitted','pending','approved','completed','failed','cancelled')),
  failure_reason      TEXT,
  submitted_at        TIMESTAMPTZ,
  completed_at        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### tcr_campaigns
```sql
CREATE TABLE tcr_campaigns (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  market                    VARCHAR(100) NOT NULL,
  campaign_name             VARCHAR(255) NOT NULL,
  signalwire_campaign_id    VARCHAR(100) NOT NULL,
  use_case                  VARCHAR(100) NOT NULL DEFAULT 'MIXED',
  status                    VARCHAR(20) NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending','approved','rejected','suspended')),
  approved_at               TIMESTAMPTZ,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### provisioning_tokens
```sql
CREATE TABLE provisioning_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  UUID NOT NULL REFERENCES accounts(id),
  token_hash  VARCHAR(255) NOT NULL UNIQUE,
  used        BOOLEAN NOT NULL DEFAULT FALSE,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

---

## API Surface

All endpoints versioned under `/v1/`. Admin endpoints under `/admin/`.
All responses JSON. All phone numbers E.164 format (`+12075550100`).
Auth: Bearer JWT (RS256, 24h TTL) on customer endpoints.
Admin: admin-scoped JWT (RS256, 8h TTL) + IP allowlist.

### Customer endpoints
```
POST   /v1/accounts                    Create account (new number or port-in)
GET    /v1/accounts/:id                Get account detail
PATCH  /v1/accounts/:id                Update account (email, status)
GET    /v1/accounts/:id/status         Lightweight status poll (for app onboarding screen)

GET    /v1/provision                   Acrobits provisioning endpoint — returns Account XML
POST   /v1/provision/reissue           Admin: reissue provisioning token

GET    /v1/ports/:id                   Get port status
DELETE /v1/ports/:id                   Cancel pending port

POST   /v1/webhooks/port               SignalWire port lifecycle events
POST   /v1/webhooks/signalwire         General SignalWire events (calls, SMS delivery)
```

### Admin endpoints
```
GET    /admin/accounts                 List accounts (filters: status, market, date)
GET    /admin/accounts/:id             Full account detail
PATCH  /admin/accounts/:id/status      Force status change with reason
POST   /admin/accounts/:id/provision/reissue  New provisioning token + QR
GET    /admin/dids                     DID inventory by market
GET    /admin/ports                    All port requests (filters: status, carrier)
POST   /admin/ports/:id/retry          Resubmit failed port
GET    /admin/metrics                  Operational metrics
```

---

## Error Response Format

Always return this shape on errors — no exceptions:

```json
{
  "error": {
    "code": "DID_UNAVAILABLE",
    "message": "No numbers available in area code 207. Please try 208.",
    "field": "area_code",
    "trace_id": "req_abc123"
  }
}
```

Standard error codes to use:
- `VALIDATION_ERROR` — malformed request body
- `NOT_FOUND` — resource does not exist
- `UNAUTHORIZED` — missing or invalid token
- `FORBIDDEN` — valid token but insufficient scope
- `DID_UNAVAILABLE` — no DIDs available for requested area code
- `PORT_ALREADY_PENDING` — duplicate port request for same number
- `PORT_SUBMISSION_FAILED` — SignalWire rejected the port
- `TOKEN_EXPIRED` — provisioning token expired or already used
- `SIGNALWIRE_ERROR` — SignalWire API call failed after retries
- `INTERNAL_ERROR` — unexpected server error

---

## SignalWire Integration

Base URL: `https://{SIGNALWIRE_SPACE}.signalwire.com`
Auth: HTTP Basic — `{SIGNALWIRE_PROJECT_ID}:{SIGNALWIRE_API_TOKEN}`

All SignalWire calls live in `src/integrations/signalwire.js`.
Never call SignalWire directly from route handlers — always via the integration module.

### Key API calls needed:

```javascript
// Search available phone numbers
// NB: the query param is `areacode` (no underscore) — `area_code` is silently
// ignored by SignalWire and returns numbers from any region.
GET /api/relay/rest/phone_numbers/search?areacode=207&max_results=5

// Purchase a phone number
POST /api/relay/rest/phone_numbers
{ "number": "+12075550100" }

// Create SIP endpoint
POST /api/relay/rest/endpoints/sip
{
  "username": "pivottech-{uuid}",
  "password": "{generated}",
  "caller_id": "+12075550100",
  "encryption": "required",
  "codecs": ["OPUS", "PCMU"]
}

// Assign number to SIP endpoint
PUT /api/relay/rest/phone_numbers/{sid}
{ "sip_endpoint_id": "{endpoint_id}" }

// Update SIP endpoint (e.g. rotate password at provisioning time)
PUT /api/relay/rest/endpoints/sip/{endpoint_id}
{ "password": "{generated}" }

// Submit port-in
POST /api/relay/rest/phone_numbers/port
{
  "number": "+12075550100",
  "account_number": "123456789",
  "pin": "123456",
  "billing_zip": "04240",
  "carrier": "T-Mobile",
  "notify_url": "https://api.pivot-tech.io/v1/webhooks/port"
}

// Delete SIP endpoint (on account cancellation)
DELETE /api/relay/rest/endpoints/sip/{endpoint_id}
```

### Retry policy for SignalWire calls:
- Retry 3 times with exponential backoff: 1s, 2s, 4s
- On all retries exhausted: log error, queue for ops alert, return `SIGNALWIRE_ERROR`

### Webhook signature validation:
```javascript
// Every inbound SignalWire webhook must validate signature before processing
const signature = req.headers['x-signalwire-signature'];
// validate HMAC-SHA256 against SIGNALWIRE_WEBHOOK_SECRET
// reject with 403 if invalid — do not process
```

---

## Acrobits Provisioning

The provisioning endpoint (`GET /v1/provision?token=xxx`) is called by the
Acrobits app during setup. It returns Account XML — not JSON.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<account>
  <username>{sip_username}</username>
  <password>{sip_password_plaintext}</password>
  <domain>{SIGNALWIRE_SPACE}.sip.signalwire.com</domain>
  <port>5061</port>
  <transport>TLS</transport>
  <srtp>required</srtp>
  <title>Pivot-Tech</title>
  <allowMessage>1</allowMessage>
  <allowVideo>1</allowVideo>
  <pushEnabled>1</pushEnabled>
  <displayName>{e164_formatted}</displayName>
  <callerID>{phone_e164}</callerID>
  <codecPriority>OPUS,ULAW,ALAW</codecPriority>
</account>
```

**Security rules for provisioning:**
- Token is single-use — mark `used=true` immediately on first valid request
- Token expires 72 hours after account creation
- Plaintext SIP password only appears in this XML response and in-memory during
  SignalWire endpoint creation — never logged, never stored
- Return 401 with `TOKEN_EXPIRED` if token is expired or already used

---

## Security Rules — Non-Negotiable

1. **Never log:** SIP passwords, transfer PINs, full account numbers, full DIDs in query params
2. **Transfer PINs:** AES-256-GCM encrypted before writing to DB. Decrypt only in `portOrchestrationService.js` immediately before SignalWire submission. Never returned in any API response.
3. **SIP passwords:** bcrypt-hashed for storage. Plaintext only held in memory during endpoint creation and provisioning XML generation.
4. **All secrets** (API keys, JWT signing keys, encryption keys) loaded from AWS Secrets Manager via `src/config/index.js`. Never from `.env` in production.
5. **Webhook validation:** Every inbound webhook validated with HMAC before processing. Hard reject (403) on failure.
6. **Idempotency:** All webhook handlers must be idempotent — duplicate delivery of the same event must not cause duplicate state changes. Use `signalwire_port_id` as idempotency key.

---

## Environment Variables

Document all of these in `.env.example`. Load and validate in `src/config/index.js`
— throw on startup if any required variable is missing.

```bash
# Server
NODE_ENV=development
PORT=3000
LOG_LEVEL=info

# Database
DATABASE_URL=postgresql://user:pass@localhost:5432/pivottech

# Redis
REDIS_URL=redis://localhost:6379

# JWT
JWT_SECRET=                    # RS256 private key (PEM)
JWT_PUBLIC_KEY=                # RS256 public key (PEM)
ADMIN_JWT_SECRET=              # separate key for admin tokens
ADMIN_IP_ALLOWLIST=            # comma-separated CIDRs

# SignalWire
SIGNALWIRE_SPACE=              # e.g. pivot-tech (results in pivot-tech.signalwire.com)
SIGNALWIRE_PROJECT_ID=
SIGNALWIRE_API_TOKEN=
SIGNALWIRE_WEBHOOK_SECRET=     # for HMAC validation

# Encryption (transfer PINs)
ENCRYPTION_KEY=                # 32-byte hex string for AES-256-GCM

# AWS
AWS_REGION=us-east-1
SQS_DID_ASSIGNMENT_QUEUE_URL=
SQS_NOTIFICATION_QUEUE_URL=

# Push notifications
APNS_KEY_ID=
APNS_TEAM_ID=
APNS_BUNDLE_ID=io.pivot-tech.dialer
APNS_PRIVATE_KEY=              # PEM from Apple VoIP push certificate

FCM_PROJECT_ID=
FCM_PRIVATE_KEY=
FCM_CLIENT_EMAIL=

# App
PROVISIONING_BASE_URL=https://api.pivot-tech.io
PROVISIONING_TOKEN_TTL_HOURS=72
```

---

## Delivery Phases

### Phase 1 — MVP (build this first)
- [ ] Project scaffolding, Docker Compose, DB migrations
- [ ] Account Service — CRUD, JWT auth, status machine
- [ ] DID Orchestration — SignalWire SIP endpoint + DID purchase + 10DLC assign
- [ ] Provisioning Service — Account XML, token lifecycle, QR/deep link generation
- [ ] Webhook Handler — port events, signature validation, idempotency
- [ ] Notification Service — APNs + FCM push
- [ ] Basic Admin API — account list, status change, token reissue
- [ ] Full test coverage on all services
- [ ] Docker build + GitHub Actions deploy pipeline

### Phase 1 — Definition of Done (all 10 must pass)
1. New account created via API, DID assigned within 60 seconds
2. Acrobits app provisions successfully from QR/deep link on first attempt
3. Outbound PSTN call completes from provisioned device
4. Inbound call to DID rings Acrobits app via CallKit on locked iOS device
5. Outbound SMS delivers to PSTN number
6. Inbound SMS from PSTN appears in Acrobits messaging thread
7. Outbound MMS (image) delivers to PSTN number
8. Admin API returns account list and individual account detail
9. All endpoints return structured error responses — no unhandled exceptions
10. SIP passwords and transfer PINs confirmed absent from all application logs

### Phase 2 — Port-In (after Phase 1 passes)
- Port Orchestration Service
- Carrier-specific port PIN instructions in onboarding API response
- Port status tracking endpoint
- Port retry logic in admin API

### Phase 3 — Operations
- Full admin dashboard API
- DID inventory management
- Bulk number provisioning
- Market expansion tooling (multi-market support)

### Phase 4 — Scale
- Multi-market SignalWire Space sharding
- Billing integration (Stripe)
- Customer self-service portal API
- CPNI compliance tooling
- Data export/deletion (CCPA)

---

## Markets

Initial markets: **Lewiston, Idaho** (area code 208), **Kendall County, Illinois** (area codes 630, 331).
Market is stored on every account and DID. All DIDs are assigned to a
market-specific TCR campaign. New markets added via config — no code changes required.

---

## How to Work With Jim

- Jim is the CEO and product owner, not a developer. Explain technical decisions
  in plain language when asking for input.
- When you hit an ambiguity in the spec, make a reasonable decision, implement it,
  and leave a `// DECISION: [explanation]` comment so Jim can review.
- Never block on a question if you can make a reasonable default. Move forward and flag.
- Commit frequently with clear commit messages: `feat:`, `fix:`, `test:`, `chore:`
- After completing each phase milestone, output a plain-language summary of what
  was built and what the next session should start with.

---

## Reference Documents

- Full functional specification: `docs/PivotTech_Middleware_Functional_Spec_v1.0.docx`
- BICS SIMforThings agreement: `docs/SFT_Service_Agreement_executed.pdf`
- SignalWire API docs: `https://docs.signalwire.com/`
- Acrobits Cloud Softphone provisioning: `https://doc.acrobits.net/cloud_softphone/`

---

## Starting a New Claude Code Session

At the start of every session, Claude Code should:
1. Read this file (`CLAUDE.md`)
2. Run `git log --oneline -10` to orient on current state
3. Run `npm test` to confirm current test status
4. Ask Jim: "Which phase are we working on, and is there anything specific to focus on today?"
5. Then proceed

Do not start writing code before completing steps 1–4.
