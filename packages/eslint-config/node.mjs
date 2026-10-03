import { defineConfig } from 'eslint/config'
import tseslint from 'typescript-eslint'
import { qualityConfig } from './base.mjs'

export function nodeConfig(tsconfigRootDir) {
  return defineConfig([...tseslint.configs.recommended, ...qualityConfig(tsconfigRootDir)])
}
