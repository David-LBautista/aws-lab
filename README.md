# AWS Lab — Angular on AWS

[![CI](https://github.com/David-LBautista/aws-lab/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/David-LBautista/aws-lab/actions/workflows/ci.yml)

A production-style monorepo built around an Angular SPA deployed on AWS. It includes:

- a custom domain;
- Amazon Cognito authentication;
- a serverless API protected by JWT;
- unit tests for the front end and the API, run by CI on every pull request;
- a keyless CI/CD pipeline with separate dev and prod environments;
- infrastructure as code with AWS CDK;
- an **AI credit agent with human-in-the-loop approval**, streamed to the UI over the AG-UI protocol from AWS Lambda.

It also has a containerized **NestJS + PostgreSQL** API that validates the same Cognito tokens and runs locally with **Docker Compose**.

> **AI agent demo:** sign in at https://lab.davidlucas.dev and open **Agente de crédito**. The agent analyzes a loan application step by step (credit report, affordability, decision), streams its reasoning and tool calls live, and pauses for an analyst to approve, adjust or reject before anything irreversible happens. See [AI credit agent](#ai-credit-agent).

| Environment | URL | Branch | Deploy | Infrastructure |
| --- | --- | --- | --- | --- |
| **prod** | https://lab.davidlucas.dev | `main` | Automatic after **manual approval** | Created in the console |
| **dev** | https://dev-lab.davidlucas.dev | `develop` | Automatic on every push | Created in the console |
| **qa** | CloudFront default domain | — | Manual upload | **AWS CDK** (`infra/`) |
| **local** | http://localhost:4200 | any | `docker compose up` | **Docker Compose** |

---

## Architecture

### Cloud

```mermaid
flowchart LR
    U[Browser<br/>Angular SPA] -->|HTTPS| DNS[Cloudflare DNS]
    DNS --> CF[CloudFront<br/>CDN + TLS from ACM]
    CF -->|Origin Access Control| S3[(S3 bucket<br/>private)]

    U -->|Login: Authorization Code + PKCE| COG[Amazon Cognito<br/>User Pool + Managed Login]
    COG -->|ID / access / refresh tokens| U

    U -->|GET /items<br/>Authorization: Bearer access token| APIGW[API Gateway<br/>HTTP API + CORS]
    APIGW -->|JWT authorizer validates token| COG
    APIGW --> L[Lambda<br/>Node.js]
```

Each environment has its own S3 bucket, CloudFront distribution, ACM certificate and subdomain. Cognito and the API are shared, and they allow both origins.

| Layer | Service | What it does |
| --- | --- | --- |
| Hosting | **Amazon S3** | Stores the Angular build output in a **private** bucket (Block Public Access on). |
| CDN | **Amazon CloudFront** | Serves the app over HTTPS from edge locations. It is the only reader of the bucket, via **Origin Access Control (OAC)**. |
| TLS | **AWS Certificate Manager (ACM)** | Free, auto-renewing certificates issued in `us-east-1` (required by CloudFront) and validated through DNS. |
| DNS | **Cloudflare** | `CNAME` records for ACM validation and for routing each subdomain to its CloudFront distribution (DNS only, not proxied). |
| Auth | **Amazon Cognito** | Invite-only User Pool (self-service sign-up disabled) with sign-in and Managed Login pages. Public app client (no secret) using **Authorization Code + PKCE**. |
| API | **Amazon API Gateway (HTTP API)** | `GET /items` route with a **JWT authorizer** backed by Cognito, CORS restricted to the app origins, and stage-level **throttling**. |
| Compute | **AWS Lambda** | Node.js function that returns data and reads the already-validated token claims. |
| CI/CD | **GitHub Actions + IAM OIDC** | Builds and deploys on push with short-lived credentials and one IAM role per environment. |
| Access | **AWS IAM** | Root account with MFA and no access keys. Daily work uses an IAM admin user. The pipeline and Lambda use least-privilege roles. |

### AI agents (AWS)

```mermaid
flowchart LR
    U[Browser<br/>Angular SPA] -->|POST /api/agents/credit<br/>Bearer access token| APIGW[API Gateway<br/>REST API · STREAM]
    APIGW -->|Cognito authorizer| COG[Amazon Cognito]
    APIGW -->|InvokeWithResponseStream| L[Lambda<br/>Node.js 22 · ARM]
    L -->|AG-UI events over SSE| U
    L -->|threads + pending approvals| DDB[(DynamoDB<br/>TTL 1 day)]
    L -->|API key, read once per cold start| SM[Secrets Manager]
    L -->|tool use| C[Claude API]
```

| Layer | Service | What it does |
| --- | --- | --- |
| API | **API Gateway (REST API)** | `POST /api/agents/{agentId}` with **response streaming** (`responseTransferMode: STREAM`), a **Cognito authorizer**, CORS for the app origins and stage throttling. `GET /api/health` is public. |
| Compute | **AWS Lambda** | The same agents code that runs locally, bundled with esbuild and wrapped with `awslambda.streamifyResponse`. It writes AG-UI events as Server-Sent Events while the agent runs. |
| State | **Amazon DynamoDB** | One item per conversation thread: shared state, Claude message history and the pending approval. On-demand billing; items expire after one day (TTL). |
| Secrets | **AWS Secrets Manager** | Stores the Anthropic API key. The function reads it once per cold start; the key never appears in code, environment variables or the repository. |
| Access | **Cognito group** | Only users in `agents-claude` can run the agent with Claude. Everyone else can use the free simulated mode. |

### Local (Docker Compose)

```mermaid
flowchart LR
    B[Browser] -->|:4200| WEB[web<br/>nginx + Angular build]
    B -->|Login: PKCE| COG[Amazon Cognito]
    B -->|:3000 /items<br/>Bearer access token| API[api<br/>NestJS]
    API -->|verifies JWT with JWKS| COG
    API -->|TypeORM| DB[(db<br/>PostgreSQL 17)]
    DB --- VOL[(db-data volume)]
    B -->|:8787 /api/agents/credit<br/>SSE stream| AG[agents<br/>Express]
    AG -->|optional, with ANTHROPIC_API_KEY| C[Claude API]
```

| Service | Image | Port | Notes |
| --- | --- | --- | --- |
| `web` | Built from `web/Dockerfile` (nginx) | `4200 → 80` | Built with the `docker` Angular configuration, so it calls the local API |
| `api` | Built from `api/Dockerfile` (Node) | `3000` | Starts only after `db` is healthy (`depends_on: service_healthy`) |
| `db` | `postgres:17-alpine` | `5432` | Data persisted in the `db-data` named volume; healthcheck with `pg_isready` |
| `agents` | Built from `agents/Dockerfile` (Node) | `8787` | AI agents API (Express + SSE). Simulated mode by default; Claude mode when `ANTHROPIC_API_KEY` is set in the root `.env`. `web` waits until it is healthy |

Inside the Compose network the containers reach each other by service name. That is why the API connects to `db:5432` rather than `localhost`.

---

## Features

### Front end and hosting

- **Static hosting on S3 + CloudFront** with a private bucket and OAC.
- **SPA routing on refresh.** CloudFront maps `403`/`404` to `/index.html` with a `200`, so deep links like `/perfil` work.
- **Cache strategy.** Hashed assets are cached for one year (`immutable`). `index.html` is uploaded with `no-cache` and invalidated on every deploy.
- **HTTPS everywhere.** HTTP is redirected to HTTPS at the CloudFront behavior.
- **Modern Angular:**
  - standalone components;
  - signals and `computed` for session state;
  - the new control flow (`@if`, `@for` / `@empty`);
  - zoneless change detection.

### Authentication and the serverless API

- **Authentication with Cognito.** Login, logout (local and Cognito session), and user data from the ID token.
- **Protected routes.** `/privado` and `/items` use a guard that redirects to Cognito Managed Login when there is no session.
- **HTTP interceptor.** It attaches the access token only to requests that target the configured APIs (`secureRoutes`), never to third-party URLs.
- **Serverless API.** API Gateway rejects missing or invalid tokens with `401` before Lambda runs.
- **Throttling.** The API stage allows 5 requests per second with a burst of 10. Extra requests get `429 Too Many Requests`, which protects against abuse and unexpected costs.
- **Invite-only access.** Self-service sign-up is disabled in Cognito, so an administrator creates every user.
- **Centralized configuration.** Cognito and API settings live in Angular environment files instead of being hardcoded in components.

### CI/CD and infrastructure

- **Tested on every pull request.** A CI workflow runs the unit tests and the production build of the front end and the API in parallel. `main` only accepts changes whose checks pass.
- **No deploy with broken tests.** The deploy workflow runs the front-end tests before building, so a failing test stops the release.
- **Keyless CI/CD.** GitHub Actions assumes an IAM role through OIDC. No AWS access keys are stored anywhere.
- **Dev and prod environments.** `develop` deploys to dev automatically. `main` deploys to prod only after a required reviewer approves.
- **Rollback.** A manual workflow run can redeploy any previous tag or commit through the same approval gate.
- **Automatic release tags.** Every successful prod deploy creates the next semantic version tag (`v1.0.2`, `v1.0.3`, …).
- **Infrastructure as code.** The hosting layer (S3 + CloudFront + OAC) is defined once in AWS CDK and parameterized by environment.

### Monorepo and Docker

- **Monorepo.** `web/` (Angular), `api/` (NestJS) and `infra/` (CDK) live in one repository. Path filters keep the front-end pipeline from running on API-only changes.
- **Multi-stage Docker images:**
  - The web image builds with Node and serves the static files with nginx.
  - The API image builds with Node, prunes dev dependencies and runs as a **non-root** user.
- **One command to run the whole stack.** `docker compose up --build` starts the front end, the API and the database.

### NestJS items API

- **REST API.** `GET`, `POST` and `DELETE /items`, backed by PostgreSQL through TypeORM.
- **Input validation.** A global `ValidationPipe` with `whitelist` and `forbidNonWhitelisted` uses `class-validator` DTOs. Invalid or unexpected fields return `400`.
- **Cognito JWT validation inside the API.** A NestJS guard verifies the access token with `aws-jwt-verify`: signature via JWKS, issuer, expiry, `token_use` and `client_id`.
- **Per-user ownership.**
  - Each item stores the Cognito `sub` of its owner, and every query filters by it.
  - A user can never list or delete another user's items.
  - Deleting another user's item returns `404`.

### AI credit agent

The **Agente de crédito** page shows how a front end consumes an AI agent: streaming, live agent state and human approval.

**What the user sees**

1. The analyst fills in a loan application (or picks a sample: direct approval, term adjustment, rejection).
2. The agent works through three steps (**credit report**, **affordability**, **decision**). Its reasoning streams token by token, and each tool call shows its arguments while they are still being generated, then its result.
3. The application card updates live: credit score, risk checks, rate, monthly payment and debt-to-income ratio.
4. The agent proposes a decision and **stops**. Nothing is issued or rejected until the analyst clicks **Aprobar**, **Rechazar** or **Enviar a revisión manual**.

**Two interchangeable engines behind the same UI**

| Engine | How it decides | Cost |
| --- | --- | --- |
| **Simulado** (mock) | A scripted agent that follows the same rules | Free; default for visitors |
| **Claude** | Claude chooses which tool to call, which term to try next and what to recommend, and writes its own reasoning | Uses the Anthropic API; restricted to the `agents-claude` Cognito group |

Both emit exactly the same AG-UI events, so the Angular page does not know which one is running.

**Who does what**

| Responsibility | Owner |
| --- | --- |
| Decide the next step and explain it | The model (or the scripted mock) |
| Calculations: rate by score, French amortization, debt-to-income | Deterministic code in `agents/src/credit/domain.ts`. The model never does the math |
| Business rules: minimum score 600, debt-to-income ≤ 40%, allowed terms | The server. If Claude proposes an approval that breaks a rule, the tool call is returned to it as an error and never reaches the analyst |
| Irreversible actions (`approve_loan`, `reject_loan`) | The analyst. The run ends with an **interrupt**; a new run with `resume` executes the action with the values the analyst approved |

**AG-UI protocol.** The agent streams standard [AG-UI](https://docs.ag-ui.com) events: `RUN_STARTED`/`RUN_FINISHED`/`RUN_ERROR`, `TEXT_MESSAGE_*`, `TOOL_CALL_START/ARGS/END/RESULT`, `STATE_SNAPSHOT`/`STATE_DELTA` (JSON Patch) and `STEP_STARTED`/`STEP_FINISHED`. A pause is a `RUN_FINISHED` with `outcome: { type: 'interrupt' }`; the answer is a new run carrying `resume: [{ interruptId, payload }]`.

**Angular side**

- `AgentStreamService` posts the `RunAgentInput` with `fetch` (not `EventSource`, which cannot send a POST body or an `Authorization` header) and exposes the SSE stream as an RxJS `Observable`. Unsubscribing aborts the request, which cancels the agent on the server.
- `applyEvent` is a **pure reducer**: current view + one event → new view. All protocol logic lives there, independent of Angular.
- `CreditAgentStore` keeps the view in one signal and exposes `computed` slices. Events are batched per animation frame (`bufferTime(0, animationFrameScheduler)`), so hundreds of tokens per second do not trigger hundreds of renders.
- The application form validates on the client for UX; the server validates again because the browser is not trusted.

---

## Tech stack

- **Front end:** Angular, TypeScript, SCSS, [`angular-auth-oidc-client`](https://github.com/damienbod/angular-auth-oidc-client)
- **Back end:** NestJS, TypeORM, PostgreSQL, `class-validator`, [`aws-jwt-verify`](https://github.com/awslabs/aws-jwt-verify)
- **AI agents:** Node.js, Express, [AG-UI protocol](https://docs.ag-ui.com) (`@ag-ui/core`), Anthropic SDK (Claude with tool use), Server-Sent Events, `fast-json-patch`, `partial-json`
- **Containers:** Docker (multi-stage builds), Docker Compose, nginx
- **AWS:** S3, CloudFront, ACM, Cognito, API Gateway (HTTP API and REST API with response streaming), Lambda (Node.js, response streaming), DynamoDB, Secrets Manager, IAM, STS, CloudTrail, CloudWatch Logs
- **Testing:** Vitest (front end and API), Angular `TestBed`, NestJS `Test.createTestingModule`
- **CI/CD:** GitHub Actions, GitHub Environments, branch protection with required checks
- **Infrastructure as code:** AWS CDK (TypeScript), AWS CloudFormation
- **DNS:** Cloudflare
- **Tooling:** Angular CLI, Nest CLI, AWS CLI v2, Docker Desktop

---

## Project structure

```
.github/
└── workflows/
    ├── ci.yml                   # Tests + build of web and api on every PR and push
    └── deploy.yml               # Test + build + deploy web to dev or prod, rollback, release tags
web/                             # Angular SPA
├── Dockerfile                   # Multi-stage: node build → nginx
├── nginx.conf                   # SPA fallback (try_files) + no-cache for index.html
├── .dockerignore
├── angular.json                 # Includes a "docker" build configuration
└── src/
    ├── testing/
    │   └── oidc-mock.ts         # Fake OidcSecurityService for unit tests (no Cognito, no redirects)
    ├── environments/
    │   ├── environment.ts              # ng build (pipeline): items API disabled, agents API on AWS
    │   ├── environment.development.ts  # ng serve: items API on :3000, agents API on :8787
    │   └── environment.docker.ts       # docker compose build: items API on :3000, agents API on :8787
    └── app/
        ├── app.config.ts        # Router, HttpClient + auth interceptor, OIDC config (secureRoutes)
        ├── app.routes.ts        # /privado and /items protected by autoLoginPartialRoutesGuard
        ├── app.ts / app.html    # Top bar, login / logout, session state with signals
        ├── services/
        │   └── items.service.ts # Calls the NestJS items API
        ├── agents/              # AG-UI client
        │   ├── agent-stream.service.ts  # fetch + SSE → Observable<AGUIEvent>, abort on unsubscribe
        │   ├── sse.ts                   # Parses SSE frames from text chunks
        │   ├── agent-run.reducer.ts     # Pure reducer: (view, event) → view (+ spec)
        │   ├── credit-agent.store.ts    # Signals store: start, respond (resume), stop, engine (+ spec)
        │   └── credit.types.ts
        └── pages/
            ├── home/            # Overview of the lab
            ├── perfil/          # User data from the ID token
            ├── privado/         # Calls the protected API Gateway + Lambda API
            ├── items/           # CRUD against the NestJS API (per-user items)
            └── agente-credito/  # AI credit agent: form, live activity, approval
api/                             # NestJS API
├── Dockerfile                   # Multi-stage: build → prune → non-root runtime
├── .dockerignore
├── .env                         # Local only, never committed
└── src/
    ├── main.ts                  # ValidationPipe, CORS, port
    ├── app.module.ts            # ConfigModule + TypeORM (PostgreSQL)
    ├── auth/
    │   ├── cognito-auth.guard.ts      # Verifies Cognito access tokens
    │   ├── cognito-auth.guard.spec.ts # Guard tests with aws-jwt-verify mocked
    │   └── current-user.decorator.ts  # @CurrentUser() → token claims
    └── items/                   # Entity, DTO, service (+ spec) and controller
agents/                          # AI agents API (own package.json)
├── Dockerfile                   # Multi-stage, non-root, healthcheck
├── vitest.config.ts
├── src/
│   ├── index.ts                 # Express server (local / Docker)
│   ├── lambda.ts                # Lambda handler with response streaming (AWS)
│   ├── sse.ts                   # SSE writer for Express
│   ├── server/prepareRun.ts     # Shared request validation and engine selection
│   ├── agents/
│   │   ├── registry.ts          # agentId → { mock, claude }
│   │   └── types.ts             # AgentContext: input, emit, signal, store
│   ├── credit/
│   │   ├── domain.ts            # Credit rules, calculations and input validation
│   │   ├── creditMockAgent.ts   # Scripted agent (free)
│   │   └── creditClaudeAgent.ts # Claude agent: tool loop, guardrails, interrupt/resume
│   └── store/
│       ├── threadStore.ts       # ThreadStore interface + in-memory implementation
│       └── dynamoThreadStore.ts # DynamoDB implementation
└── test/                        # Vitest: domain, both agents, prepareRun, Lambda handler
infra/                           # AWS CDK app (own package.json)
├── bin/infra.ts                 # Entry point: one stack per environment + agents stack
├── lib/infra-stack.ts           # Hosting stack: private S3 bucket + CloudFront + OAC
└── lib/agents-stack.ts          # Agents stack: REST API (streaming) + Lambda + DynamoDB + Cognito group
docker-compose.yml               # web + api + db for local development
```

---

## Running locally

### Option A: everything in Docker

Requirements: Docker Desktop. Create `api/.env` first (see below).

```bash
docker compose up --build -d
```

| URL | What |
| --- | --- |
| http://localhost:4200 | Angular app (nginx container) |
| http://localhost:3000/items | NestJS API (requires a Bearer token) |
| http://localhost:8787/api/health | Agents API (shows whether Claude mode is available) |
| `localhost:5432` | PostgreSQL (`lab` / `awslab`) |

```bash
docker compose ps              # status and health
docker compose logs -f api     # follow API logs
docker compose down            # stop (keeps the data volume)
docker compose down -v         # stop and delete the database data
```

### Option B: hot reload while developing

Requirements: Node.js 20+ and the Angular CLI. Run the database in Docker and the apps with their dev servers:

```bash
docker compose up -d db
docker compose stop web        # frees port 4200 if the web container is running

cd api && npm install && npm run start:dev     # http://localhost:3000
cd web && npm install && ng serve              # http://localhost:4200
```

`ng serve` uses `environment.development.ts`. `http://localhost:4200` is registered in Cognito as an allowed callback and sign-out URL, and it is allowed in the CORS settings of both APIs.

### API environment variables (`api/.env`)

```
PORT=3000
DATABASE_URL=postgres://lab:lab_password@localhost:5432/awslab
COGNITO_USER_POOL_ID=us-east-1_XXXXXXX
COGNITO_CLIENT_ID=<app-client-id>
```

In Docker Compose the same values are set in `docker-compose.yml`, with the host `db` instead of `localhost`. The user pool ID and client ID are public identifiers, not secrets. The database password is a local development value only.

### Agents API (`agents/`)

Simulated mode needs nothing. For Claude mode, create a `.env` file in the **repository root** (it is ignored by Git) with a key from the Claude Console. A Claude Pro subscription does not include API access.

```
ANTHROPIC_API_KEY=sk-ant-...
CLAUDE_MODEL=claude-haiku-5-5
```

```bash
docker compose up -d --build agents web     # or, with hot reload:
cd agents && npm install && npm run dev     # http://localhost:8787
```

Locally the agents API keeps threads in memory. Set `THREADS_TABLE` to a DynamoDB table name to use DynamoDB instead.

### Quick API checks (PowerShell)

```powershell
Invoke-RestMethod http://localhost:3000/items          # 401: missing bearer token
docker compose exec db psql -U lab -d awslab -c 'select id, name, "ownerSub" from items;'
```

In PowerShell, `curl` is an alias for `Invoke-WebRequest`. Use `Invoke-RestMethod` or `curl.exe` instead.

---

## Testing

Both apps use **Vitest**. The tests run in Node without a browser, a database or a connection to Cognito.

```bash
cd web && npx ng test --watch=false   # Angular
cd api && npm test                    # NestJS
cd agents && npm test                 # AI agents
```

| Area | What is tested | How external dependencies are replaced |
| --- | --- | --- |
| `App` (web) | Shows **Iniciar sesión** without a session and the logout action with one | `provideOidcMock({ authenticated })` |
| `Perfil` (web) | Renders the signed-in user's data | `provideOidcMock({ userData })` |
| `ItemsService` (api) | Lists, creates and deletes **only the current user's items**; returns `404` for another user's item | TypeORM repository replaced with `vi.fn()` spies through `getRepositoryToken(Item)` |
| `CognitoAuthGuard` (api) | `401` without a header, with a non-Bearer header and with an invalid token; a valid token is accepted and its claims are attached to the request | `aws-jwt-verify` replaced with `vi.mock` |
| `applyEvent` (web) | Every AG-UI event type: streamed text, partial tool arguments, JSON Patch without mutation, steps, interrupts, errors | None: it is a pure function |
| `CreditAgentStore` (web) | `start` sends the application, `respond` resumes the same thread with the interrupt ID, `stop` aborts the request, the engine chosen at start is kept on resume | `AgentStreamService` replaced with a fake that returns RxJS `Subject`s |
| Credit domain (agents) | Rates by score, amortization, debt-to-income, and input validation with every error collected | None |
| `creditMockAgent` (agents) | The three paths (approve, adjust term, reject), protocol order, **no irreversible action before approval**, resume outcomes, reused or unknown interrupts rejected | In-memory `ThreadStore` |
| `creditClaudeAgent` (agents) | Claude decides the steps while the server computes the numbers; guardrails reject rule-breaking approvals and invented terms; resume sends the analyst's decision back to Claude; invalid input never reaches the API | **Fake Claude client** that replays scripted turns with the real streaming event shape: no tokens spent |
| Lambda handler (agents) | Health and CORS by origin, SSE output until the interrupt, `400` on invalid JSON | `awslambda` runtime global faked, DynamoDB store replaced by the in-memory one |

**Mocking the auth library.** `angular-auth-oidc-client` needs its runtime configuration and would redirect to Cognito, so component tests never use the real service. `web/src/testing/oidc-mock.ts` provides a fake `OidcSecurityService` that exposes the session both as observables (`isAuthenticated$`, `userData$`) and as signals (`authenticated`, `userData`), and lets each test choose whether there is a session.

**Injecting the model client.** `createCreditClaudeAgent(getClient)` receives the Anthropic client instead of creating it, so tests pass a fake that streams scripted responses. The agent loop, the guardrails and the interrupt are tested without network access or API costs.

**Testing rules, not libraries.** The API tests do not check that TypeORM works. They check that the service always asks it for the right thing: every query and delete filters by the owner's Cognito `sub`.

---

## CI/CD

### Continuous integration

The [`ci.yml`](.github/workflows/ci.yml) workflow runs on every pull request and push to `develop` or `main`:

| Job | Steps |
| --- | --- |
| **Web (test, build)** | `npm ci` → `ng test` → `ng build` |
| **API (test, build)** | `npm ci` → `npm test` → `npm run build` |

- The two jobs run in parallel.
- A new commit on the same branch cancels the run still in progress (`concurrency`).
- The workflow only has read access to the repository.
- Both jobs are **required status checks** on `main`, so a pull request with failing tests cannot be merged into production.

### Deployment

```mermaid
flowchart LR
    D[push to develop] --> BD[Build] --> DEV[Deploy to dev<br/>dev-lab.davidlucas.dev]
    PR[PR develop → main] --> M[merge to main] --> BP[Build] --> A{Approval<br/>required reviewer} -->|approved| PROD[Deploy to prod<br/>lab.davidlucas.dev]
```

The workflow ([`.github/workflows/deploy.yml`](.github/workflows/deploy.yml)) runs on pushes to `develop` or `main` that change `web/**` or the workflow itself, and it picks the environment from the branch:

| | dev | prod |
| --- | --- | --- |
| Branch allowed to deploy | `develop` | `main` |
| Approval | None | Required reviewer (admins cannot bypass) |
| IAM role | `github-actions-aws-lab-dev` | `github-actions-aws-lab-deploy` |
| Variables | Its own bucket, distribution and role ARN | Its own bucket, distribution and role ARN |

**Pipeline steps:**

1. Checkout.
2. Detect the app folder.
3. `npm ci`.
4. `ng test` (skipped on rollbacks).
5. `ng build`.
6. Assume the IAM role with OIDC.
7. Upload the hashed assets with long-lived caching.
8. Upload `index.html` with `no-cache`.
9. Invalidate `/index.html` in CloudFront.

Only `index.html` is invalidated. Every other file has a content hash in its name, so a new build produces new file names.

**Monorepo-aware build.** A step checks whether `web/angular.json` exists and exposes the folder as a step output (`steps.app.outputs.dir`). The build and upload steps use it as their working directory. That way a rollback to a tag created before the monorepo refactor, when the app lived at the repository root, still builds correctly.

### Authentication with OIDC

GitHub Actions requests a signed OIDC token and exchanges it with AWS STS for temporary credentials, valid for one hour. Each role's trust policy only accepts tokens from this repository **and** its environment:

```json
"Condition": {
  "StringEquals": {
    "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
    "token.actions.githubusercontent.com:sub": "repo:<owner>@<owner-id>/aws-lab@<repo-id>:environment:prod"
  }
}
```

The `sub` claim includes the immutable owner and repository IDs, so a renamed or re-created repository with the same name cannot assume the role. Each role can only write to its own bucket and invalidate its own distribution.

### Rollback

Every stable prod release is tagged (`v1.0.0`, `v1.0.1`, …). To roll back:

1. Go to **Actions → Deploy to AWS → Run workflow**, from the `main` branch.
2. Enter the tag or commit SHA to deploy (for example `v1.0.0`).
3. Approve the prod deployment.
4. Fix forward in the code with `git revert` and a new PR, so `main` matches what is running in production.

The deployment history (**Deployments → prod**) records every deploy with its commit, approver and timestamp.

### Release tags

After a successful prod deploy, the workflow finds the highest `v*` tag, bumps the patch number and pushes the new tag. Rollbacks (manual runs with a `ref`) do not create tags, because they redeploy a version that is already tagged.

### Manual deployment (reference)

```bash
cd web
ng build
aws s3 sync dist/aws-lab/browser s3://<bucket-name> \
  --delete --exclude index.html \
  --cache-control "public,max-age=31536000,immutable"
aws s3 cp dist/aws-lab/browser/index.html s3://<bucket-name>/index.html \
  --cache-control "no-cache"
aws cloudfront create-invalidation --distribution-id <distribution-id> --paths "/index.html"
```

---

## Docker

### Web image (`web/Dockerfile`)

| Stage | Base | What it does |
| --- | --- | --- |
| `build` | `node:24-alpine` | `npm ci` (cached layer while `package*.json` does not change), then `ng build --configuration=$NG_CONFIG` |
| runtime | `nginx:stable-alpine` | Applies `apk upgrade` for OS patches, copies `nginx.conf` and only the compiled `browser/` output |

`NG_CONFIG` is a build argument: `production` by default, and `docker` in Compose. The final image contains no Node.js, no source code and no `node_modules`.

`nginx.conf` sends unknown paths to `index.html` (`try_files $uri $uri/ /index.html`) for Angular routing, and serves `index.html` with `Cache-Control: no-cache`. This is the same strategy CloudFront uses.

### API image (`api/Dockerfile`)

| Stage | Base | What it does |
| --- | --- | --- |
| `build` | `node:24-alpine` | `npm ci` → `npm run build` → `npm prune --omit=dev` |
| runtime | `node:24-alpine` | Copies `package*.json`, the production `node_modules` and `dist/`; `NODE_ENV=production`; runs as `USER node` |

### Useful commands

```bash
docker build -t aws-lab-web ./web
docker run --rm -p 8080:80 aws-lab-web        # http://localhost:8080
docker build --pull -t aws-lab-api ./api      # --pull refreshes the base image (security patches)
docker images                                 # compare image sizes
```

---

## Infrastructure as code (AWS CDK)

The `infra/` folder is an AWS CDK app in TypeScript. One reusable stack defines the hosting layer, and each environment is a single line:

```typescript
new InfraStack(app, 'AwsLab-Qa-Hosting', { env, envName: 'qa' });
```

The stack creates:

| Resource | Configuration |
| --- | --- |
| S3 bucket | Block Public Access, S3-managed encryption, HTTPS-only bucket policy (`enforceSSL`) |
| Origin Access Control | Only this distribution can read the bucket |
| CloudFront distribution | `index.html` root object, HTTP → HTTPS, `CachingOptimized`, compression, managed **security headers** policy |
| Error responses | `403`/`404` → `/index.html` with `200` for Angular routing |
| Outputs | Bucket name, distribution ID and domain, used by the deploy step |

```bash
cd infra
npm install
cdk synth     # generate the CloudFormation template
cdk diff      # preview changes, including IAM/security changes
cdk deploy    # create or update the stack
cdk destroy   # delete the environment
```

### Agents stack (`AwsLabAgents`)

A separate stack, so deploying or destroying it never touches the hosting stacks:

| Resource | Configuration |
| --- | --- |
| DynamoDB table | Partition key `threadId`, on-demand billing, TTL on `expiresAt` |
| Lambda function | Node.js 22 on ARM, 512 MB, 5-minute timeout, bundled from `agents/src/lambda.ts` with esbuild (AWS SDK left to the runtime), one-week log retention |
| REST API | `GET /api/health` (public) and `POST /api/agents/{agentId}` (Cognito authorizer with the `openid` scope, so it accepts access tokens), both with `responseTransferMode: STREAM`; throttling 5 req/s, burst 10; CORS preflight and CORS headers on 4XX/5XX gateway responses |
| Cognito | Imports the existing User Pool and creates the `agents-claude` group |
| IAM | The function can only read/write its table and read its secret |

The Anthropic key is created once, outside the code:

```bash
aws secretsmanager create-secret --name aws-lab/anthropic-api-key --secret-string "sk-ant-..."
cd infra && npx cdk deploy AwsLabAgents
aws cognito-idp admin-add-user-to-group --user-pool-id <pool-id> --username <username> --group-name agents-claude
```

The `AgentsApiUrl` output goes into `agentsApiUrl` in `web/src/environments/environment.ts`.

The account and region were bootstrapped once with `cdk bootstrap aws://<account-id>/us-east-1`.

Infrastructure and application are deployed separately. CDK creates the empty hosting stack, and the build is uploaded afterwards with `aws s3 sync` or by the pipeline.

**Migration plan.** dev and prod were built in the console first. Instead of importing them into CDK, each one will be recreated as a new CDK stack and switched over: DNS, certificate, pipeline variables and IAM permissions. Only then will the manual resources be removed. The order is qa first, then dev, then prod.

---

## Technical decisions

### Hosting and DNS

**Private bucket + OAC instead of S3 static website hosting.** The bucket is never public. CloudFront is the single entry point for HTTPS, caching and security headers.

**Certificates in `us-east-1`.** CloudFront only accepts ACM certificates from that region.

**Cloudflare in DNS-only mode.** Proxying through Cloudflare would put a second CDN in front of CloudFront and break TLS. The ACM validation records stay in place so the certificates renew automatically.

### Authentication and authorization

**Authorization Code + PKCE, no client secret.** Anything shipped to the browser is public, so the SPA uses a public client. PKCE protects the code exchange.

**Access token to the API, ID token for the UI.** The APIs authorize against the access token. The ID token is used only to show user details such as the email.

**Authorization at the gateway (serverless API).** API Gateway validates the signature, issuer, expiry and audience (`client_id`). Invalid requests never reach Lambda, so they cost nothing, and the function only receives trusted claims.

**Authorization in the application (NestJS API).** Without a gateway in front, the API validates the token itself with a guard and AWS's official `aws-jwt-verify` library. The library caches the User Pool's public keys (JWKS), so tokens are verified locally without calling Cognito on every request. The guard requires `token_use: access` and checks the app's `client_id`.

**The Cognito `sub` as the owner, not the email.** `sub` is unique and immutable, while an email can change. Every query includes `ownerSub`, so ownership is enforced in the data layer rather than only in the UI.

**`404` instead of `403` for another user's resource.** Deleting an item that belongs to someone else returns "not found", so the API does not reveal which IDs exist.

**Public configuration in environment files.** The Cognito client ID, domain and API URL are not secrets: in a SPA everything shipped to the browser is public. Security comes from PKCE, the allowed callback URLs in Cognito and JWT validation at the API. Keeping these values in `environment.ts` only makes them easier to manage per environment.

**`secureRoutes` built from the environment.** The interceptor's list is `[apiUrl, itemsApiUrl].filter(Boolean)`. The token is sent only to APIs that are configured for that environment, and the items API is left out when its URL is empty, as it is in dev and prod today.

**Items page enabled only where its API exists.** The navigation link is shown only when `itemsApiUrl` is set, which is currently in local and Docker builds.

**Invite-only users.** Self-service sign-up is disabled so the public demo cannot be used to create arbitrary accounts.

### API protection

**Throttling at the gateway.** A rate and burst limit on the API stage caps traffic before it reaches Lambda, so a flood of requests cannot run up costs.

**CORS limited to known origins.** API Gateway only allows `http://localhost:4200`, `https://dev-lab.davidlucas.dev` and `https://lab.davidlucas.dev`, with the `authorization` and `content-type` headers. The NestJS API currently allows only `http://localhost:4200`.

**Strict input validation.** `whitelist` strips unknown properties and `forbidNonWhitelisted` rejects them, so clients cannot set fields such as `ownerSub` or `id`.

### Pipeline and environments

**OIDC instead of access keys in CI.** There are no long-lived credentials to leak or rotate, and access is scoped per environment through the token's `sub` claim.

**One IAM role per environment.** The dev role cannot touch prod resources, even if the workflow file is modified, because it is only trusted for `environment:dev`.

**Approval gate on prod, no admin bypass.** Every production deploy, including rollbacks, needs an explicit approval and leaves an audit trail.

**Separate CI and deploy workflows.** CI runs on pull requests with read-only permissions and no AWS access. The deploy workflow is the only one that assumes an IAM role, and it runs only on `develop` and `main`. Code from a pull request never gets cloud credentials.

**Tests skipped only on rollbacks.** A rollback redeploys a version that already passed through production, and older tags predate the current test setup. Normal deploys always run the tests before building.

**Run both CI jobs on every change.** Each job takes about a minute, so the workflow does not filter by folder. That keeps the required checks simple: they always report a result, and no change can skip them.

### Infrastructure as code

**One parameterized CDK stack for every environment.** Environments differ only in their name, so they cannot drift apart, and a new one takes one line instead of repeated console steps.

**Migrate to CDK by recreating, not importing.** For CloudFront, OAC and bucket policies, rebuilding each environment as a new stack and switching traffic over is safer than `cdk import`. Production is not touched until the process has been proven on the lower environments.

**Shared Cognito and API across environments.** This is acceptable for a lab. In a real project, dev would have its own User Pool and API to keep test users and data out of production.

### Monorepo and containers

**Monorepo with path filters.** The front end, the API and the infrastructure change together and are reviewed in one PR. Each pipeline only runs when its own folder changes.

**Multi-stage images.** Build tools stay in the build stage, so the runtime images are smaller and have less attack surface.

**Non-root API container.** The API runs as the `node` user, so a compromised process has fewer privileges inside the container.

**`.dockerignore` per app.** `node_modules`, `dist` and `.env` are never sent to the build context. This keeps builds fast, keeps layer caching effective and keeps secrets out of images.

**Healthcheck-gated startup.** The API waits for PostgreSQL to report healthy instead of just started, which avoids connection errors on the first boot.

**Separate `docker` Angular configuration.** `fileReplacements` swaps in `environment.docker.ts`, so the containerized front end points to the local API without changing the production build.

**`synchronize: true` only for local development.** TypeORM creates the schema automatically in the lab. A deployed environment would use migrations instead.

### AI agents

**AG-UI instead of a custom event format.** It is an open protocol for agent-to-UI communication, so the same front end could talk to other agent frameworks, and the event types already cover streaming text, tool calls, shared state and interrupts.

**SSE over `fetch`, not WebSockets.** Each run is a request with a streamed response. SSE works through API Gateway and CloudFront, needs no connection management, and a stop is just an aborted request.

**REST API instead of HTTP API for the agents.** Response streaming is only supported on API Gateway REST APIs. The items API stays on the cheaper HTTP API.

**The model orchestrates; code calculates and enforces.** Claude chooses tools and explains its reasoning. Rates, payments and ratios come from deterministic functions, and the server re-validates every proposal before an analyst sees it. A wrong or manipulated model output cannot approve a loan that breaks the rules.

**Human approval enforced by the server.** Irreversible tools are intercepted and never executed in the run that proposes them. The proposal is stored with an interrupt ID; only a resume with that ID executes it, once.

**Interrupts end the run.** The server does not hold a connection open while a person decides. State lives in the `ThreadStore`, so an approval can come minutes later, from another Lambda instance.

**Dependency inversion for storage.** Agents depend on a `ThreadStore` interface. Local development and tests inject the in-memory store, AWS injects `DynamoThreadStore`, and no agent code changed for the deployment.

**Open/closed agent registry.** `registry.ts` maps an agent ID to its mock and Claude versions. Adding an agent is one entry; the server and the Lambda handler stay unchanged.

**One validation path for Express and Lambda.** `prepareRun` validates the request and picks the engine for both transports, so local and cloud behave the same.

**Claude restricted by Cognito group.** The demo is public, but model calls cost money. The engine choice is checked on the server against the token's groups, not hidden in the UI.

**Key in Secrets Manager, read once per container.** The key is fetched on cold start and cached for the life of the container, which keeps it out of environment variables and keeps request latency low.

**Lambda abort before timeout.** Lambda does not report a closed client connection, so the handler aborts the agent five seconds before the function timeout and closes the stream with a `RUN_ERROR` instead of being cut off.

**Batched rendering in Angular.** Applying events once per animation frame keeps the UI smooth when tokens arrive faster than the screen refreshes.

---

## Troubleshooting notes

Real issues found while building the lab, and how they were diagnosed:

| Symptom | Cause | Fix |
| --- | --- | --- |
| IAM user gets `AccessDenied` everywhere | User created without any policy (implicit deny) | Attach the required permissions |
| Certificate not listed in CloudFront | Requested outside `us-east-1` | Request it in `us-east-1` |
| API returns `401 invalid audience` | Leading spaces in the authorizer's audience | Paste the exact app client ID |
| `Not authorized to perform sts:AssumeRoleWithWebIdentity` | Trust policy used the old `sub` format; GitHub now includes owner and repo IDs | Read the real `sub` in **CloudTrail** and match it exactly |
| Prod deploy ran without approval | "Allow administrators to bypass" was enabled on the environment | Disable the bypass |
| `Context access might be invalid` warning in the workflow | Variable set through `$GITHUB_ENV`, which the linter cannot resolve | Use a step output (`$GITHUB_OUTPUT` → `steps.<id>.outputs.<name>`) |
| Docker Scout reports critical/high CVEs in the web image | Outdated OS packages in the nginx base image | Use `nginx:stable-alpine`, `apk upgrade --no-cache`, and rebuild with `--pull` |
| `ng serve` fails: port 4200 already in use | The `web` container is publishing `4200` | `docker compose stop web` while developing |
| `curl -X POST ...` fails in PowerShell | `curl` is an alias of `Invoke-WebRequest` | Use `Invoke-RestMethod` or `curl.exe` |
| `git add api` stages `node_modules` and `.env` | `nest new --skip-git` does not create a `.gitignore` | Add `api/.gitignore`, unstage, and `git rm --cached` any build output (`*.tsbuildinfo`) |
| `NG0201: No provider found for StsConfigLoader` in component tests | `TestBed` does not load `app.config.ts`, so the auth library has no configuration | Provide a fake `OidcSecurityService` with `provideOidcMock()` |
| `this.oidc.authenticated is not a function` in tests | The component reads the session through the library's signal API, and the mock only had observables | Add the `authenticated` and `userData` signals to the mock |
| `git add agents` stages `node_modules` even with a `.gitignore` | The file was created with PowerShell `echo`, which writes UTF-16; Git could not read it | Recreate it with `Set-Content -Encoding ascii` and check with `git check-ignore -v` |
| "La API de agentes no está configurada" in the Docker build | `agentsApiUrl` was empty in `environment.docker.ts` | Set it to `http://localhost:8787`; the browser calls the agents API directly, not the container network |
| `Cannot GET /` on the agents API | Only `/api/*` routes existed | Added a `GET /` index route; `/api/health` is the real check |
| Tool card stayed on "esperando autorización" after a rejection | The rejected tool call never got a result event | Every proposed tool call now ends with a `TOOL_CALL_RESULT`, even when it is not executed (the Claude API also requires one `tool_result` per `tool_use`) |
| Claude's replies showed `**` asterisks | The model wrote Markdown and the UI renders plain text | Ask for plain text in the system prompt |
| Claude tried a term shorter than the one requested | The prompt listed fixed terms | The server sends the allowed terms for each application, and rejects any other term |

---

## Security notes

- The root user is protected with MFA and has no access keys.
- Day-to-day work uses an IAM user. The AWS CLI is authenticated with temporary credentials (`aws login`).
- CI/CD uses OIDC and least-privilege roles, each scoped to one repository, one environment, one bucket and one distribution.
- No secrets are committed. The Cognito client ID, user pool ID and API URL are public by design in a SPA. `api/.env` is ignored by Git and excluded from the Docker build context.
- Cognito sign-up is invite-only; an administrator creates new users.
- API Gateway throttling (5 req/s, burst 10) limits abuse and cost exposure.
- Both APIs reject requests without a valid Cognito access token. The NestJS API also enforces per-user ownership of data.
- The API container runs as a non-root user, and both images are rebuilt from patched base images.
- A budget alert tracks credit and cost usage.
- The Anthropic API key lives only in Secrets Manager (AWS) and in an ignored root `.env` (local). The Lambda role can read that one secret and nothing else.
- Claude mode requires membership in the `agents-claude` Cognito group, checked on the server; a spending limit is also set in the Claude Console.
- Agent input from the browser is validated on the server before any model call, and model proposals are re-validated against the business rules before a person sees them.
- Agent threads expire from DynamoDB after one day.

---

## Roadmap

### Done

**Hosting and delivery**
- [x] Static hosting on S3 + CloudFront with OAC, custom domain and ACM certificates
- [x] CI/CD with GitHub Actions using **OIDC** (no long-lived AWS keys) and least-privilege IAM roles
- [x] Separate dev and prod environments with a required approval for prod
- [x] Rollback by redeploying a previous tag or commit, and an automatic release tag after each prod deploy
- [x] Hosting stack in AWS CDK (qa environment), with security headers

**Security and APIs**
- [x] Invite-only Cognito user pool and configuration in Angular environment files
- [x] Serverless API with a JWT authorizer and API Gateway throttling
- [x] NestJS + PostgreSQL items API protected with Cognito JWT and per-user ownership

**Monorepo, containers and tests**
- [x] Monorepo (`web/`, `api/`, `infra/`, `agents/`) with a path-filtered pipeline
- [x] Dockerized front end and APIs (multi-stage builds), local stack with Docker Compose
- [x] Unit tests with Vitest and a CI workflow on every pull request, with required checks on `main`

**AI agents**
- [x] AI credit agent with human-in-the-loop approval over the AG-UI protocol (Angular + Node.js)
- [x] Claude engine with tool use and server-side guardrails, tested with a fake client
- [x] Agents API on Lambda with response streaming, DynamoDB threads, Cognito authorizer and Secrets Manager (CDK)

### Next

- **Agents in CI:** run the agents tests on every pull request and deploy the agents stack from the pipeline.
- [x] Agents API CORS includes `https://dev-lab.davidlucas.dev` (deployment and end-to-end verification in progress).
- **React version:** a legal-themed front end that reuses the same agents API.
- **NestJS API on AWS:** image in ECR with a Trivy scan, ECS Fargate behind an ALB, RDS PostgreSQL and Secrets Manager, all in CDK; TypeORM migrations instead of `synchronize`.
- **Quality and operations:** front-end tests for the items page, API end-to-end tests, coverage report in CI and CloudWatch alarms on API errors.

---

## Author

**David Lucas Bautista** — Senior Software Engineer
[davidlucas.dev](https://davidlucas.dev) · [LinkedIn](https://linkedin.com/in/david-lb)
