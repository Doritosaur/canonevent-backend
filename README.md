# canonevent-backend

Backend for the personal decision memory app (UI: `../canonevent`). Architecture:
`../personal_decision_memory_rag_architecture.md`.

| Piece | What it is | Local | Production |
|---|---|---|---|
| `supabase/` | Postgres + pgvector, Auth, RLS, migrations, and the `api` Edge Function (Hono) | Supabase CLI containers | Supabase managed project |
| `../canon-inference` | Separate project: embeddings (bge-m3) and speech-to-text (Sarvam) | Docker or uvicorn | Any public HTTPS host |
| Cloudflare R2 | Audio storage | your bucket | your bucket |

The Edge Functions reach canon-inference through `INFERENCE_URL` with the shared `INFERENCE_API_KEY`.

## Run locally

Prerequisites: Docker Desktop, the Supabase CLI, and `../canon-inference` running (see its README).

```sh
cp .env.example .env      # R2 keys, LLM, INFERENCE_API_KEY (same value as canon-inference/.env)
supabase start
supabase functions serve api --env-file .env     # stays in the foreground; Ctrl+C stops it
```

Stop Supabase with `supabase stop`.

## Production

Two deployments: this project on Supabase, and `../canon-inference` on a host with a public HTTPS URL (its README
covers both a VPS and managed container hosts). Deploy canon-inference first.

Make `.env.prod` from `.env.example` with `INFERENCE_URL=https://<canon-inference URL>`, a hosted `LLM_BASE_URL`, and the
same `INFERENCE_API_KEY` as canon-inference. Then:

```sh
supabase link --project-ref <ref>
supabase db push
supabase functions deploy api
supabase secrets set --env-file .env.prod
```

`SUPABASE_URL`, `SUPABASE_ANON_KEY` and the service-role key are provided to functions automatically. Also enable the
Google provider under Authentication, and add the web app's origin to the R2 bucket's CORS policy.

## Housekeeping

- The audio bucket has no automatic cleanup; deleting a memory removes its object.
- Pin `OLLAMA_IMAGE` to a specific version in `.env` once you have one that works.
