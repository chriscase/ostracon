// Ambient declaration for CSS-module imports inside the package. Hosts
// using Next.js / Vite already get this from their build config; the
// package's standalone tsc needs this so consumers of the package
// don't see type errors when they typecheck the package on its own.

declare module '*.module.css' {
  const classes: { readonly [key: string]: string };
  export default classes;
}
