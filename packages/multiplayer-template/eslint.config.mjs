// eslint.config.mjs
import antfu from '@antfu/eslint-config'

export default antfu(
  {
    ignores: ['client/public/**'],
    rules: {
      'no-console': 'error',
      '@typescript-eslint/method-signature-style': ['error', 'method'],
    },
  },
)
