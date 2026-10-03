import { defineConfig } from 'eslint/config'
import nextVitals from 'eslint-config-next/core-web-vitals'
import nextTs from 'eslint-config-next/typescript'
import { qualityConfig } from './base.mjs'

export function nextConfig(tsconfigRootDir) {
  return defineConfig([
    ...nextVitals,
    ...nextTs,
    { settings: { next: { rootDir: tsconfigRootDir } } },
    ...qualityConfig(tsconfigRootDir),
  ])
}
