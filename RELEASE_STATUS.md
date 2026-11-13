# Source release verification

The standalone source builds successfully. There are 158 passing offline tests and
one skipped opt-in PostgreSQL integration test (136 application/publication tests,
plus 22 burn/browser-bundle tests). No funds are moved by these tests.

Dependency audit: 0 critical, 0 high, 3 moderate, 1 low. Remaining findings are
listed in DEPENDENCY_REVIEW.json and are not suppressed. A dependency audit is
not an independent review of application security.

Source files, reachable Git blobs and extracted release archives are checked for
configured credential values, credential patterns, runtime state and operational
workspace material. Public release requires successful CI for the exact commit.

This is a source-code release, not a deployment or a claim that every provider,
wallet or mainnet route has been independently tested. The database integration
test is skipped unless a disposable development database is explicitly configured.
MagicBlock public execution remains disabled by default.
