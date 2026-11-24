/** @type {import('jest').Config} */
module.exports = {
  preset: 'jest-expo',
  setupFiles: ['<rootDir>/jest.setup.ts'],
  moduleNameMapper: { '^~/(.*)$': '<rootDir>/src/$1' },
  testPathIgnorePatterns: [
    '/node_modules/',
    '<rootDir>/openalgo/',
    '<rootDir>/spike/',
    '<rootDir>/dev/',
    '<rootDir>/scripts/',
    '<rootDir>/test/compat/',
    '<rootDir>/test/real/',
  ],
  modulePathIgnorePatterns: ['<rootDir>/openalgo/'],
}
