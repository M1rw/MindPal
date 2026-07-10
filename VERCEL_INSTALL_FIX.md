# Superseded Vercel install fix

The earlier npm-only `installCommand` fixed missing Tailwind tooling but prevented Vercel from installing the Python runtime dependencies. It must not be used.

The final mixed-runtime fix is documented in `VERCEL_PYTHON_DEPENDENCY_FIX.md`:

- remove `installCommand`;
- keep the root `requirements.txt`;
- move Tailwind and esbuild into regular npm dependencies;
- use `buildCommand: npm run build`.
