// Ostracon — server-side GraphQL public surface.
//
// Re-exports every codex type + field config a host needs to compose its
// own GraphQL schema. Hosts that consume `@chriscase/ostracon/graphql`
// build their Query and Mutation types from `codexQueryFields` and
// `codexMutationFields` (or pick a subset for read-only deployments).
//
// The context contract is `CodexGraphQLContext` — hosts extend it for
// their own context shape (extra fields invisible to codex resolvers).
//
// See `chriscase/Ostracon` issue #10 for the design rationale.

export * from './types';
export * from './context';
export * from './queries';
export * from './mutations';
