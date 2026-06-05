module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.js'],
  collectCoverageFrom: [
    'src/**/*.js',
    '!src/server.js',
    '!src/db/migrate.js',
  ],
  coverageDirectory: 'coverage',
  clearMocks: true,
};
