/** @type {import('next').NextConfig} */
// `turbopack.root` is pinned because the repository now carries TWO lockfiles
// (the root one and apps/studio's, both introduced by ATS-102). Without it
// Next infers the workspace root from the lockfile set and picks the
// repository root, which emits a warning and makes the inferred root depend
// on which lockfile happens to be seen first.
// See docs/16-BASELINE-ADR.md §5.2 for the other known build side effect
// (next-env.d.ts / tsconfig.json are rewritten by `next build`).
export default {
  output: 'export',
  images: { unoptimized: true },
  trailingSlash: true,
  turbopack: { root: import.meta.dirname },
};
