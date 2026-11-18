# AWS Lab — Angular on AWS

A production-style monorepo built around an Angular SPA deployed on AWS. It includes:

- a custom domain;
- Amazon Cognito authentication;
- a serverless API protected by JWT;
- a keyless CI/CD pipeline with separate dev and prod environments;
- infrastructure as code with AWS CDK.

It also has a containerized **NestJS + PostgreSQL** API that validates the same Cognito tokens and runs locally with **Docker Compose**.

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

### Local (Docker Compose)

```mermaid
flowchart LR
    B[Browser] -->|:4200| WEB[web<br/>nginx + Angular build]
    B -->|Login: PKCE| COG[Amazon Cognito]
    B -->|:3000 /items<br/>Bearer access token| API[api<br/>NestJS]
    API -->|verifies JWT with JWKS| COG
    API -->|TypeORM| DB[(db<br/>PostgreSQL 17)]
    DB --- VOL[(db-data volume)]
```

| Service | Image | Port | Notes |
| --- | --- | --- | --- |
| `web` | Built from `web/Dockerfile` (nginx) | `4200 → 80` | Built with the `docker` Angular configuration, so it calls the local API |
| `api` | Built from `api/Dockerfile` (Node) | `3000` | Starts only after `db` is healthy (`depends_on: service_healthy`) |
| `db` | `postgres:17-alpine` | `5432` | Data persisted in the `db-data` named volume; healthcheck with `pg_isready` |

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

---

## Tech stack

- **Front end:** Angular, TypeScript, SCSS, [`angular-auth-oidc-client`](https://github.com/damienbod/angular-auth-oidc-client)
- **Back end:** NestJS, TypeORM, PostgreSQL, `class-validator`, [`aws-jwt-verify`](https://github.com/awslabs/aws-jwt-verify)
- **Containers:** Docker (multi-stage builds), Docker Compose, nginx
- **AWS:** S3, CloudFront, ACM, Cognito, API Gateway (HTTP API), Lambda (Node.js), IAM, STS, CloudTrail, CloudWatch Logs
- **CI/CD:** GitHub Actions, GitHub Environments
- **Infrastructure as code:** AWS CDK (TypeScript), AWS CloudFormation
- **DNS:** Cloudflare
- **Tooling:** Angular CLI, Nest CLI, AWS CLI v2, Docker Desktop

---

## Project structure

```
.github/
└── workflows/
    └── deploy.yml               # Build + deploy web to dev or prod, rollback, release tags
web/                             # Angular SPA
├── Dockerfile                   # Multi-stage: node build → nginx
├── nginx.conf                   # SPA fallback (try_files) + no-cache for index.html
├── .dockerignore
├── angular.json                 # Includes a "docker" build configuration
└── src/
    ├── environments/
    │   ├── environment.ts              # ng build (pipeline): items API disabled
    │   ├── environment.development.ts  # ng serve: items API on localhost:3000
    │   └── environment.docker.ts       # docker compose build: items API on localhost:3000
    └── app/
        ├── app.config.ts        # Router, HttpClient + auth interceptor, OIDC config (secureRoutes)
        ├── app.routes.ts        # /privado and /items protected by autoLoginPartialRoutesGuard
        ├── app.ts / app.html    # Top bar, login / logout, session state with signals
        ├── services/
        │   └── items.service.ts # Calls the NestJS items API
        └── pages/
            ├── home/            # Overview of the lab
            ├── perfil/          # User data from the ID token
            ├── privado/         # Calls the protected API Gateway + Lambda API
            └── items/           # CRUD against the NestJS API (per-user items)
api/                             # NestJS API
├── Dockerfile                   # Multi-stage: build → prune → non-root runtime
├── .dockerignore
├── .env                         # Local only, never committed
└── src/
    ├── main.ts                  # ValidationPipe, CORS, port
    ├── app.module.ts            # ConfigModule + TypeORM (PostgreSQL)
    ├── auth/
    │   ├── cognito-auth.guard.ts      # Verifies Cognito access tokens
    │   └── current-user.decorator.ts  # @CurrentUser() → token claims
    └── items/                   # Entity, DTO, service and controller
infra/                           # AWS CDK app (own package.json)
├── bin/infra.ts                 # Entry point: one stack per environment
└── lib/infra-stack.ts           # Hosting stack: private S3 bucket + CloudFront + OAC
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

### Quick API checks (PowerShell)

```powershell
Invoke-RestMethod http://localhost:3000/items          # 401: missing bearer token
docker compose exec db psql -U lab -d awslab -c 'select id, name, "ownerSub" from items;'
```

In PowerShell, `curl` is an alias for `Invoke-WebRequest`. Use `Invoke-RestMethod` or `curl.exe` instead.

---

## CI/CD

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
4. `ng build`.
5. Assume the IAM role with OIDC.
6. Upload the hashed assets with long-lived caching.
7. Upload `index.html` with `no-cache`.
8. Invalidate `/index.html` in CloudFront.

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

---

## Roadmap

- [x] CI/CD with GitHub Actions using **OIDC** (no long-lived AWS keys) and least-privilege IAM roles
- [x] Separate dev and prod environments with a required approval for prod
- [x] Rollback by redeploying a previous tag or commit
- [x] Automatic release tag after each successful prod deploy
- [x] Hosting stack in AWS CDK (qa environment), with security headers
- [ ] Custom domain and certificate for qa in CDK
- [x] Config moved to Angular environment files
- [x] Invite-only Cognito user pool
- [x] API Gateway throttling
- [x] Monorepo (`web/`, `api/`, `infra/`) with path-filtered pipeline
- [x] Dockerized front end (multi-stage build + nginx)
- [x] NestJS + PostgreSQL items API, containerized
- [x] Local stack with Docker Compose (healthchecks, named volume)
- [x] NestJS API protected with Cognito JWT and per-user ownership
- [ ] Push the API image to **Amazon ECR**
- [ ] Run the API on **ECS Fargate** behind an ALB with HTTPS, with **RDS PostgreSQL** and Secrets Manager (CDK)
- [ ] CI pipeline for the API (build, scan with Trivy, push to ECR, deploy to ECS)
- [ ] TypeORM migrations instead of `synchronize`
- [ ] CloudWatch alarm on API errors

---

## Author

**David Lucas Bautista** — Senior Software Engineer
[davidlucas.dev](https://davidlucas.dev) · [LinkedIn](https://linkedin.com/in/david-lb)
