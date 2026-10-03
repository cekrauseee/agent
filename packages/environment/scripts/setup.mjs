#!/usr/bin/env node
import { prepareEnv, workspaceRoot } from '../src/index.mjs'

prepareEnv(process.argv.includes('--workspace') ? workspaceRoot(process.cwd()) : process.cwd())
