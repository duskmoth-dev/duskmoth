# Safe unsigned BigInt byte adapter

Original MIT-licensed Duskmoth implementation of the four byte conversion functions
used by `@solana/buffer-layout-utils`: `toBigIntBE`, `toBigIntLE`, `toBufferBE`, and
`toBufferLE`. It replaces the unmaintained native `bigint-buffer` dependency, rather
than suppressing its advisory or relabeling the vulnerable source.

Uses standard JavaScript BigInt and Buffer. No native code, bindings, install scripts,
network access, wallet access, or signing. Inputs are limited to 1 MiB, unsigned values
must fit the requested width, and decoding never changes the input buffer.
This is not a general-purpose constant-time cryptographic library.

The application regression tests cover byte order, boundary values, zero width,
invalid input, large buffers, and the actual Solana account layouts.
