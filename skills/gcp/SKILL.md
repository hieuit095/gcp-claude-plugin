---
name: gcp
description: Operate Google Cloud Platform via the gcloud, bq and gsutil CLIs — projects, Compute Engine, Cloud Run, GKE, Storage, BigQuery, IAM, logging, billing. Use when the user mentions GCP, Google Cloud, gcloud, BigQuery, GCS buckets, Cloud Run, or GKE.
---

# Google Cloud operations

MCP tools (server `gcp`): `gcloud`, `bq`, `gsutil`, `gcloud_auth_status`, `gcloud_login`, `gcloud_set_project`, `gcloud_list_projects`, `gcloud_help`.

## Start of any task
1. `gcloud_auth_status` — logged in? which project/region?
2. Not logged in → ask the user, then `gcloud_login` (opens Google sign-in in their browser). Use `adc=true` too if Terraform/client libraries need Application Default Credentials.
3. Wrong project → `gcloud_list_projects` then `gcloud_set_project`; or pass `--project` on each command. Never guess a project id.

## Safety model (enforced by the server)
- Read-only commands (list/describe/get/logs read, config get, bq ls/show/dry_run) run immediately.
- Anything that creates, changes or deletes returns "CONFIRMATION REQUIRED" and does nothing. Show the exact command + what it affects + likely cost to the user; re-call with `confirm=true` only after explicit approval of that command.
- Credential-printing commands (print-access-token, secret access, key creation) are blocked unless the user sets `GCP_ALLOW_SECRET_OUTPUT=1`. `GCP_READ_ONLY=1` blocks all writes.

## Practices
- Discover syntax with `gcloud_help` rather than guessing flags.
- Use `--filter`, `--limit`, `--format="value(...)"` to keep output small.
- BigQuery: always `bq query --dry_run --use_legacy_sql=false "..."` first and report bytes scanned before the real run.
- Before deleting: describe the resource, show dependencies, name the project. Prefer stop/disable over delete when reversible.
- After creating billable resources (VMs, GKE, Cloud SQL, static IPs), list them at the end and say what is still costing money.
- Prefer IAM least privilege; never grant `roles/owner` or `allUsers` without explicit user request.
- Use `--project`, `--region`/`--zone` explicitly when the user works across projects.
