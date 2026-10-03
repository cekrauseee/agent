import { defineConfig, globalIgnores } from 'eslint/config'
import prettier from 'eslint-config-prettier/flat'

export function qualityConfig(tsconfigRootDir) {
  return defineConfig([
    {
      files: ['**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}'],
      languageOptions: { parserOptions: { projectService: true, tsconfigRootDir } },
      rules: {
        'no-unused-vars': 'off',
        '@typescript-eslint/no-unused-vars': [
          'error',
          {
            args: 'all',
            argsIgnorePattern: '^_',
            caughtErrors: 'all',
            caughtErrorsIgnorePattern: '^_',
          },
        ],
        '@typescript-eslint/no-deprecated': 'error',
      },
    },
    prettier,
    globalIgnores(['**/.next/**', '**/out/**', '**/build/**', '**/next-env.d.ts']),
  ])
}
