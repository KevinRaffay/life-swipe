// Is this build a demo-only one?
//
// `VITE_STATIC_DEMO=1` is set by .github/workflows/pages.yml and by nothing
// else, so it is true on the deployed GitHub Pages site and false in every
// local build (`npm run dev`, `npm start`) and every test.
//
// It exists because the deployed site has no server behind it and cannot get
// one: there is no storyteller there, so offering a full 16-to-death life
// would be offering the game with its engine removed. A demo life, by
// contrast, is complete on a static host by construction - it never calls a
// provider at all (see CLAUDE.md's "Demo mode"). So the Pages build shows the
// one thing it can actually deliver, and the local build is untouched.
//
// A BUILD-TIME CONSTANT, deliberately, not a runtime mode. It decides which
// entry point the start screen offers; it does not reach `state.demoMode`,
// the engine, the deck or anything either of them guards. A demo started
// here is the same demo the "Just show me" link starts locally, down the same
// `startDemo` path and through the same age gate.
//
// Vite inlines `import.meta.env.*` at build time, so the comparison is
// resolved and the dead branch is dropped from the bundle.
export const STATIC_DEMO = import.meta.env.VITE_STATIC_DEMO === '1';
