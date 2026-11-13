# Contributing to Duskmoth

## Developer support and integration

Use [SDK Discussions](https://github.com/duskmoth-dev/duskmoth-sdk/discussions) for developer questions.
Runnable, unfunded integration examples are in the
[SDK examples](https://github.com/duskmoth-dev/duskmoth-sdk/tree/main/examples).
Do not post wallet proofs, private payment lists, request bodies, or real user data.
Dependency review runs on pull requests and Dependabot proposes dependency/action updates;
updates require review and are not automatically merged.
OpenSSF Scorecard checks repository practices, not anonymity or funded payment correctness.

Thank you for contributing. Contact: hello@duskmoth.xyz.

1. Open an issue describing a reproducible bug or a narrowly scoped proposal.
2. Fork the repository and create a descriptive branch.
3. Add regression tests and run `npm test` before submitting a pull request.
4. Describe the behavior change, test results, and any remaining limitations.

## Safety requirements

- Never submit API tokens, seed phrases, wallet private keys, signed payloads, real user data, or .env files.
- Use ephemeral unfunded fixtures for automated tests. No CI job may move mainnet funds.
- Keep wallet approval separate from AI intent parsing; an AI response is not transaction authorization.
- Do not replace unknown balances with zero, screening failures with approval, or pending transactions with success.
- Report vulnerabilities privately using GitHub's private reporting feature when available, or contact hello@duskmoth.xyz first for a secure reporting channel. Do not email keys or private financial records.
- Include upstream notices. The project license does not replace dependency or asset licenses.

Use real commits with an accurate author identity. Do not backdate commits, fabricate contributors, or generate contribution activity.

By submitting code, you agree to license your original contribution under this repository's MIT license.
