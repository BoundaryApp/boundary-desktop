# Inference deployments

Boundary Desktop deploys models to cloud providers using a **model catalog**, **deployment recipes** (opinionated hardware and config), and **provider drivers** (RunPod Terraform, Baseten Truss, etc.). Users pick a model and provider, enter credentials, and wait for the OpenAI-compatible endpoint to become healthy.

## Architecture

| Layer | Location | Role |
|-------|----------|------|
| Catalog | `infrastructure/catalog/models.json` | Models and which providers are available |
| Recipes | `infrastructure/recipes/*.json` | Per-(model, provider) secrets, readiness, driver config |
| Drivers | `src/main/services/infrastructure/drivers/` | Provision / destroy / runtime per provider |

Legacy manifests under `infrastructure/manifests/` remain for compatibility; recipes are the source of truth.

## Prerequisites

- **Terraform 1.5+** on your `PATH` — required for **RunPod** only.
- **Truss CLI** — required for **Baseten** deploys. Boundary installs Truss automatically on first deploy (Python venv or bundled `uv`); no manual `pip` step for most users.
- Provider API keys stored with OS encryption via Electron `safeStorage`.

## User workflow

1. Open **Inference** in the sidebar.
2. Choose a **model**, then a **provider** (RunPod or Baseten today; Modal/Cerebrium shown as coming soon).
3. Enter credentials and **Save** (see stack-specific requirements below).
4. **Deploy** — Boundary provisions cloud resources. Progress appears under **Tasks**.
5. Monitor **status** (phase `warming` until the model responds, then `active`; health on OpenAI `/v1/models`).
6. Use the **RunPod runtime** panel for worker counts (RunPod only).
7. Use **Test endpoint** once phase is `active` to chat via the OpenAI-compatible API (streaming).
8. **Destroy** when finished (confirmation required).

RunPod state is stored under `{userData}/infrastructure/{instanceId}/module/`. Baseten stores a Truss project under `{userData}/infrastructure/{instanceId}/truss/`.

## Baseten vLLM (Llama 3.3 70B) — dedicated deploy

Recipe id: `baseten-llama-33-70b`

Boundary deploys a **dedicated** Baseten model via [Truss](https://docs.baseten.co/examples/deploy-a-hugging-face-model) and the bundled `config.yaml` under `infrastructure/baseten-truss/llama-3.3-70b-instruct/`. This creates a model in your [Baseten dashboard](https://app.baseten.co/models/) (unlike the shared Model API catalog).

### What you provide

| Credential | Purpose |
|------------|---------|
| **Baseten API key** | `truss push` and Management API (`Api-Key` on inference) |
| **Hugging Face token** | Gated weights for `meta-llama/Llama-3.3-70B-Instruct` (accept license on Hugging Face first). Boundary syncs this to Baseten as `hf_access_token` before deploy. |

### Deploy behavior

1. Validates your Baseten API key.
2. Upserts your Hugging Face token into Baseten workspace secrets as `hf_access_token` (required for gated weight mirroring).
3. Configures a Baseten remote via `truss login --api-key` (stored under Boundary userData, not your global `~/.trussrc`), then runs `truss push` from the instance workspace (may take **30–45+ minutes** on first deploy while weights download and the image builds).
3. Sets outputs:
   - `openai_base_url` → `https://model-{id}.api.baseten.co/environments/production/sync/v1`
   - `model_id` → `meta-llama/Llama-3.3-70B-Instruct` (must match `--served-model-name` in `config.yaml` for chat)

### Destroy behavior

**Destroy** calls `DELETE /v1/models/{model_id}` on the Baseten Management API and removes the model from your workspace.

## RunPod vLLM (Llama 3.3)

Recipe / legacy stack id: `runpod-vllm-llama`

### What you provide

| Credential | Purpose |
|------------|---------|
| **RunPod API key** | REST API (template create), Terraform provider, runtime polling |
| **Hugging Face token** | Gated model access for `meta-llama/Llama-3.3-70B-Instruct` on the worker template |

No RunPod Hub visit or `template_id` is required. Boundary:

1. Creates a **serverless template** via `POST /v1/templates` (pinned `runpod/worker-v1-vllm` image and env).
2. Creates a **serverless endpoint** via Terraform (`runpod_endpoint`) with **2× A100 80GB** per worker.
3. On destroy, runs `terraform destroy` then deletes the template via `DELETE /v1/templates/{id}`.

### Opinionated defaults (2×80GB)

Pinned in [`infrastructure/profiles/runpod-vllm-llama.json`](../infrastructure/profiles/runpod-vllm-llama.json):

| Setting | Value |
|---------|--------|
| Model | `meta-llama/Llama-3.3-70B-Instruct` |
| GPUs per worker | 2 (`gpu_count` + `TENSOR_PARALLEL_SIZE=2`) |
| GPU types | A100 80GB PCIe and A100-SXM4-80GB |
| Regions | US-CA-2, US-TX-3 |
| Container disk | 200 GB (room for ~140 GB model download) |
| Max context | 8192 tokens |

Re-**Apply** after upgrading Boundary to pick up profile changes on existing instances.

### Phases: `warming` vs `active`

After a successful Terraform apply or Baseten Truss push, the instance enters **`warming`** (not `active`) until `GET {openai_base_url}/v1/models` succeeds (or Baseten reports the deployment is ready, including scale-to-zero). The **deploy task stays `running`** during this period—do not treat Truss/Terraform finishing as deploy complete.

For Baseten, task stages show Management API status while the platform is still building (e.g. `Baseten deployment: BUILDING`). Status polls every **30s** during warming for Baseten (see recipe `pollIntervalMs`); every **45s** when healthy.
