/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/__tests__'],
  // Files under __tests__/helpers/ are shared test utilities, not test
  // suites — without this, Jest's default testMatch would pick them up
  // and fail with "Your test suite must contain at least one test."
  testPathIgnorePatterns: ['/node_modules/', '/__tests__/helpers/'],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: { jsx: 'react-jsx' } }],
  },
  // The `server-only` package ships an index.js that deliberately throws
  // when imported. That's the right behavior in a Client Component bundle,
  // but Jest runs in a plain Node environment without the `react-server`
  // exports condition — so every `import 'server-only'` would blow up at
  // test time. Mapping it to an empty shim lets us keep the guard in
  // production code while still unit-testing the same modules.
  moduleNameMapper: {
    '^server-only$': '<rootDir>/__mocks__/server-only.js',
  },
};
