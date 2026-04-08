// Test-only shim for the `server-only` package.
//
// The real package intentionally throws on import to prevent accidentally
// bundling server-only modules into a Client Component. Jest has no such
// notion — every module runs in plain Node — so the throw is a false
// alarm at test time.  This shim is mapped in jest.config.js via
// moduleNameMapper so that `import 'server-only'` in a lib file becomes
// a no-op during tests while still firing in dev / prod builds.
module.exports = {};
