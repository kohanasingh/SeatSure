# Deployment

Live: **https://seatsure-web.vercel.app**

## Topology

- **Frontend** — Next.js on Vercel, built from this repo (`apps/web`).
- **API + worker + DB + cache** — a single free-tier GCP e2-micro VM
  (`us-central1-a`, static IP `35.193.123.67`, DNS `seatsure.duckdns.org`),
  running `docker-compose.prod.yml`: nginx → NestJS API (with the BullMQ
  worker in-process) → Postgres + Redis, all on that one box.
- **TLS** — Let's Encrypt for `seatsure.duckdns.org`, validated via webroot
  so nginx never has to stop to renew; renewal runs unattended via the VM's
  `certbot.timer`, with a deploy-hook that reloads nginx only when a
  renewal actually happens.
- **Redeploys** — the VM is redeployed with a `git pull` + `docker compose
  up -d --build`; the frontend is redeployed to Vercel via the CLI. The CI
  workflow also has a Cloud Run deploy job wired up, gated behind an
  unset `DEPLOY_ENABLED` repo variable — dormant, not part of the live path.

## Why a VM instead of Cloud Run

The BullMQ worker has to stay warm to process the booking queue, which
means `min-instances: 1` on Cloud Run — and a container that's never
allowed to scale to zero defeats the premise of Cloud Run's free tier,
which is priced for scale-to-zero workloads. A single always-on e2-micro VM
is free under GCP's always-free tier with no such constraint, so that's
what's actually running. `deploy/cloud-run.sh` stays in the repo as the
production-scale path if this ever needs to grow past one VM.
