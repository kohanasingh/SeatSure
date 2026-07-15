# DECISIONS.md — SeatSure

Ambiguities resolved during the build, per working-style rule: make the industry-standard
choice, note it here, continue.

## Phase 0

- **bcryptjs instead of native bcrypt.** Same algorithm and cost factor (12), pure-JS
  implementation. Avoids node-gyp native build headaches on the Windows dev machine and in
  alpine Docker images. The ~100–300 ms hash time is identical in spirit (it is the work
  factor, not the library, that provides the security margin).
- **Added one ORGANIZER seed user** (`organizer@seatsure.dev` / `password123`). The spec's
  seed list (20 users + 1 admin) has no organizer, but every Event requires an
  `organizerId` and the organizer flow (§8) is demoable only with an ORGANIZER-role user.
  Seeded events belong to this user. All seeded regular users share the password
  `password123`.
- **Initial migration generated offline** via `prisma migrate diff --from-empty --script`
  (no live DB needed), with the partial unique index
  (`one_confirmed_booking_per_seat`) appended to the same initial migration file, since
  Prisma's schema DSL cannot express partial indexes. `pnpm db:migrate` runs
  `prisma migrate deploy` (non-interactive, applies committed migrations).
- **Seeded events are created with `status=ON_SALE` and `onSaleAt` in the past** so the
  stack is demoable immediately after `pnpm seed` (per "everything demoable immediately").
  The DRAFT → ON_SALE delayed-job flow is exercised via `admin.createEvent` in Phase 2.
- **`packages/shared` is a built package** (tsc → CommonJS + d.ts in `dist/`), not a raw
  TS-source package. NestJS (CJS/tsc) and Next.js (bundler) both consume it without
  transpile hacks; `pnpm dev` runs `tsc --watch` for it alongside the two apps.
- **Toolchain versions:** Node 24, pnpm 9, NestJS 11, Prisma 6, Next.js 16, React 19,
  Tailwind 4, Zod 3.25.x (v3 API — broadest tRPC v11 compatibility).
