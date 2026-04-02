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
)
