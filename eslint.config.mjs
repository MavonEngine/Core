// eslint.config.mjs
import antfu from '@antfu/eslint-config'

export default antfu(
  {
    rules: {
      'no-console': 'error',
      '@typescript-eslint/method-signature-style': ['error', 'method'],
    },
  },
  {
    files: ['**/*.{ts,tsx}'],
  },
  {
    // vitest 4+ invokes vi.fn() implementations with `new` when the mock is
    // constructed, so constructor mocks must be function expressions, not arrows.
    files: ['**/tests/**'],
    rules: {
      'prefer-arrow-callback': 'off',
    },
  },
)
