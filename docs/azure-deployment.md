# Azure deployment

How the CX Reply Assistant runs on Azure, and the exact steps to deploy and update it.

| Part                | Azure service                          | Name used here                   |
| ------------------- | -------------------------------------- | -------------------------------- |
| API (Fastify)       | Container Apps (one always-on replica) | `cx-api` in environment `cx-env` |
| API image           | Container Registry (Basic)             | `cxrohit17acr`                   |
| Web app (React)     | Static Web Apps (Free)                 | `cx-web`                         |
| Database/auth/files | Supabase (not on Azure, unchanged)     | your existing project            |
| Everything above    | Resource group, region Central India   | `cx-rg`                          |

The API stays at exactly **one replica**: rate limiting and the embedding sweep run inside the process.

## One-time setup

1. **Subscription.** portal.azure.com → Subscriptions must show an _Enabled_ subscription.
2. **Tools.** Install the Azure CLI, then:
   ```
   az login --tenant <your-tenant-id> --use-device-code     (approve the MFA prompt)
   az account list -o table                                  (State must be Enabled)
   az extension add --name containerapp --upgrade
   az provider register --namespace Microsoft.App
   az provider register --namespace Microsoft.OperationalInsights
   az provider register --namespace Microsoft.ContainerRegistry
   az provider register --namespace Microsoft.Web
   ```
   Wait until `az provider show -n Microsoft.App --query registrationState -o tsv` prints `Registered`.
3. **Resources.**
   ```
   az group create -n cx-rg -l centralindia
   az acr create -n <registry-name> -g cx-rg --sku Basic --admin-enabled true
   az containerapp env create -n cx-env -g cx-rg -l centralindia
   ```
   The registry name must be globally unique, lowercase letters and digits. If you pick another name than
   `cxrohit17acr`, pass `-Registry <name>` to the scripts.
4. **`.env`** at the repo root must contain plain `KEY=value` lines only (see `.env.example`). Never paste commands
   into it. The deploy scripts refuse values that contain spaces, `<`, `>` or `^`.
   Needed: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `OPENAI_API_KEY`,
   `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`. `ORDER_GATE_ENABLED=true` turns on the order-number check.

## Every deployment (code changed)

Run from the repo root, in Command Prompt. Use a new tag each time (`v3`, `v4`, ...).

```
powershell -ExecutionPolicy Bypass -File scripts\azure-build-image.ps1 -Tag v3
powershell -ExecutionPolicy Bypass -File scripts\azure-deploy-api.ps1 -Tag v3
powershell -ExecutionPolicy Bypass -File scripts\azure-deploy-web.ps1 -ApiUrl https://<api-address>
```

1. **build-image** copies a clean copy of the repo (no `node_modules`, no `.env`) and builds the image in Azure.
2. **deploy-api** creates the container app the first time, and updates image, secrets and settings afterwards. It
   prints the API address.
3. **deploy-web** builds the web app against that API address, uploads it, and re-runs deploy-api with the web
   address as the allowed origin (CORS).

Skip step 3 if only the API changed, and skip 1–2 if only the web app changed.

## First deployment only

- In Supabase → Authentication → URL Configuration, set the **Site URL** to the web address and add it to the redirect
  URLs. In Sign In / Providers, **disable public sign-ups**.
- Demo accounts exist in that Supabase project. Change or delete their passwords before real use.

## Verify

```
https://<api-address>/health      -> {"status":"ok"}
https://<api-address>/ready       -> {"status":"ready", database ok}
```

Then open the web address, log in, click a customer, send a message as _Customer simulator_ and click
**Generate AI reply** (progress steps and the draft text should stream in).

## Troubleshooting

| Symptom                                                  | Cause / fix                                                                                                                                    |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `az login`: AADSTS50076 MFA required                     | `az login --tenant <id> --use-device-code`, approve MFA.                                                                                       |
| "No subscriptions found"                                 | Log in with MFA first; otherwise create/enable a subscription in the portal.                                                                   |
| `MissingSubscriptionRegistration` for `Microsoft.Web`    | `az provider register --namespace Microsoft.Web --wait` (the web deploy script now does this itself).                                          |
| `az acr build` fails with `[WinError 3]` paths           | Always build from the clean copy (`azure-build-image.ps1`), never from the repo folder.                                                        |
| "The system cannot find the file specified" on a command | A long command was pasted and split. Use the scripts instead of pasting commands.                                                              |
| API `/health` hangs or times out                         | The container is crashing. `az containerapp logs show -n cx-api -g cx-rg --type console --tail 60` (e.g. `Invalid environment configuration`). |
| Log says `SUPABASE_URL: Invalid URL`                     | `.env` has junk or duplicate lines. Keep plain `KEY=value` lines only.                                                                         |
| Browser: CORS error                                      | Re-run `azure-deploy-api.ps1 -CorsOrigin https://<web-address>` (no trailing slash).                                                           |
| Web page blank after deploy                              | The web app was built without `VITE_*` values. Re-run `azure-deploy-web.ps1` (reads them from `.env`).                                         |

## Security

- Secrets live in Container Apps secrets, never in the image or in git (`.env` is git-ignored and excluded from the build).
- If a key is ever shown or pasted somewhere, rotate it: OpenAI dashboard for the OpenAI key,
  `az acr credential renew -n <registry> --password-name password` for the registry password (the scripts always read
  the current one).
- The browser only gets the Supabase URL and anon key (`VITE_*`); the service-role key stays on the server.

## Cost and cleanup

Registry (Basic) about $5/month, the always-on container a few dollars/month, Static Web Apps Free tier $0.
Remove everything with `az group delete -n cx-rg`.
