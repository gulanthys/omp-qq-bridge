import js from '@eslint/js'
import globals from 'globals'

export default [
  {
    ignores: ['node_modules/**', '.runtime/**', '.omp-qq/**'],
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.node,
    },
    rules: {
      ...js.configs.recommended.rules,
      curly: ['error', 'all'],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'one-var': ['error', 'never'],
      'id-match': ['error', '^[A-Za-z_$][A-Za-z0-9_$]*$', { properties: true }],
      'no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          caughtErrors: 'all',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },
]
