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
        /**
         * Allow console logs in bootstrap package
         */
        files: ['packages/bootstrap/**'],
        rules: {
            'no-console': 'off',
        },
    },
)
