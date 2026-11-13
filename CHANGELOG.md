# Changelog

## 0.2.0

- First public application-source candidate, refreshed from the current app.
- Includes Moth Pass, AI Pack, Private Payroll, transaction recovery and wallet
  connection improvements. MagicBlock remains an experimental, disabled-by-default engine.
- Updated Privacy Cash and Anthropic dependencies, pinned security fixes, and
  replaced native bigint-buffer with a bounded JavaScript implementation.
- Added portable PostgreSQL schema and standalone Node.js 24 CI.
- Credentials, runtime ledgers, issuer keys, proving files and generated bundles
  are not shipped. Build proving assets from the pinned upstream dependency.
- Automated fixture verification is not an independent security audit or proof
  of all funded mainnet routes.
