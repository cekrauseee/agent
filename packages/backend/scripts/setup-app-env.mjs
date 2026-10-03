#!/usr/bin/env node
import { prepareEnv } from '@agent/environment'
import { databaseDefaults } from '../src/development.mjs'

prepareEnv(process.cwd(), databaseDefaults())
