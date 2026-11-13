# Duskmoth

[![CI](https://github.com/duskmoth-dev/duskmoth/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/duskmoth-dev/duskmoth/actions/workflows/ci.yml)

Source code for the Duskmoth Solana application: wallet-approved private-transfer
flows, wallet privacy estimates, Moth Pass, AI Pack and Private Payroll.

## What you can build or contribute

- Inspect the browser-wallet connection, transaction review and recovery flows.
- Run your own interface with your own Helius, Scorechain and optional Anthropic access.
- Improve accessibility, wallet compatibility, tests and provider integrations.
- Fork the source, reproduce a bug and submit a focused pull request.

This application is separate from the [HTTP SDK](https://github.com/duskmoth-dev/duskmoth-sdk).
The SDK does not sign transactions or execute payments.

## Local setup

Requires Node.js 24+ and pnpm 10.26.1.

```sh
pnpm install --frozen-lockfile --ignore-scripts
cp .env.example .env
pnpm test
pnpm build
pnpm test:pass-client
pnpm start
```

Open http://localhost:8787. Routes: `/`, `/app`, `/pass`, `/tools`, `/docs`.
The example configuration deliberately leaves real transfers disabled until your
own services are configured. Never paste provider credentials into frontend code.
Do not import another operator's issuer keys or replay databases.

For durable Moth Pass storage, provision your own PostgreSQL database, review and
apply `database/001_moth_pass.sql` using your database tool, then configure
`DATABASE_URL`, a stable strong `SESSION_SECRET` and the documented storage flags.
The application does not migrate the database automatically.
Database integration tests are opt-in and use `TEST_DATABASE_URL`, which must
point to a disposable development database, never production.

## Architecture and feature boundaries

- **Privacy Cash:** browser-side private-balance scans, proof preparation and
  wallet-approved shielding/withdrawal through the configured relayer.
- **Helius:** Solana RPC and public-chain activity. Some enriched endpoints
  require an appropriate provider plan.
- **Scorechain:** sanctions-only address checks, not full AML or a privacy score.
- **Anthropic:** optional intent parsing and AI Pack plans. AI does not approve,
  sign or execute transactions. Do not put secrets in prompts.
- **Moth Pass:** optional bearer passes issued for verified public $DMOTH burns;
  core app usage does not require the token. Back up locally stored passes.
- **Private Payroll:** reviewed sequential withdrawals from an existing private
  balance. One pass per authorized batch; uncertain payments are not auto-replayed.
- **MagicBlock:** experimental, separately configured USDC engine. Public execution
  remains disabled by default and is not represented as general public availability.

Unknown balances, incomplete screening and ambiguous transaction results remain
explicit errors, not invented approvals or successful payments. A confirmed source
transaction alone does not prove recipient settlement.

## Security and licensing

See [SECURITY.md](SECURITY.md), [DEPENDENCY_REVIEW.json](DEPENDENCY_REVIEW.json),
[RELEASE_STATUS.md](RELEASE_STATUS.md) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
The native bigint-buffer dependency is replaced with an original, bounded
[JavaScript adapter](vendor/bigint-buffer/README.md), with account-layout regression tests.
Remaining lower-severity dependency findings are disclosed, not hidden or ignored.

Passing CI is not an independent audit, anonymity guarantee or funded verification
of every mainnet route. Mainnet transactions spend real funds. This release does
not change the availability or configuration of the hosted application.

MIT covers original Duskmoth source. Upstream dependencies and third-party visual
assets retain their own terms; brand marks are not a trademark license.
See [CONTRIBUTING.md](CONTRIBUTING.md) before opening an issue or pull request.
Never include credentials, seed phrases, wallet keys or private payment records.

## Links

- App: https://duskmoth.xyz
- SDK: https://github.com/duskmoth-dev/duskmoth-sdk
- Documentation: https://github.com/duskmoth-dev/duskmoth-docs
- X: https://x.com/duskmoth_app
- Contact: hello@duskmoth.xyz
