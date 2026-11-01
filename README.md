# Duskmoth

AI-assisted wallet insights and wallet-approved private transaction preparation on Solana.

**Release status: private review candidate. Stable publication is blocked by dependency security findings.**
This source snapshot is not an independent audit or a funded end-to-end mainnet verification.

## Local development

Requires Node.js 22+ and pnpm. Install dependencies, copy `.env.example` to `.env`, supply your own provider credentials, then:

```sh
pnpm install
pnpm test
pnpm build
pnpm start
```

Default port: 8787. Routes: `/`, `/app`, `/docs`, and `/api/*`.
No hosted-workspace service is required. Live transfers are off in the example configuration.
Scorechain and Helius are required for live transfer readiness; Claude is optional for intent parsing.
Keys stay server-side. Never configure a server-held wallet private key.

## Transaction model

- Shield deposits into a private balance.
- Withdraw uses an existing private balance without another deposit.
- Send creates a new deposit before a private payout.
- The browser wallet approves actions. AI only prepares a reviewable intent.
- Proofs are generated in the browser using the upstream Privacy Cash SDK.
- First-time private-pool scans may be slow; progress must remain visible and failed scans must not skip recovered notes.
- A confirmed deposit is not proof that a recipient payout succeeded. Check each transaction separately.

## Limits

Scorechain checks sanctions lists only, not full AML risk. Its provider coverage and commercial terms require separate verification.
Helius funding-source data may require an upgraded plan. Unknown signals are not proof of safety.
No app can promise complete anonymity or untraceability. Mainnet uses real funds.
The waitlist endpoint is unavailable until durable storage and consent handling are implemented.

## Community

[Documentation](https://github.com/duskmoth-dev/duskmoth-docs) · [API client](https://github.com/duskmoth-dev/duskmoth-sdk) · [Contribution guide](CONTRIBUTING.md)

Contact: hello@duskmoth.xyz · [X](https://x.com/duskmoth_app)
