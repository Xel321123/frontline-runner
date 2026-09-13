/**
 * Node ESM resolve hook for the check scripts.
 *
 * The game source uses bundler-style extensionless imports (`'./assets'`),
 * which Vite and tsc resolve happily but plain Node does not. This hook
 * appends `.ts` when a relative specifier has no extension, so `scripts/*.mjs`
 * can import the real source modules unchanged.
 *
 * Registered from `check-campaign-data.mjs` — test tooling only, never shipped.
 */
export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') && !/\.[cm]?[jt]sx?$/i.test(specifier)) {
    try {
      return await nextResolve(`${specifier}.ts`, context);
    } catch {
      /* fall through to Node's default resolution */
    }
  }
  return nextResolve(specifier, context);
}
