#!/usr/bin/env node
// wait.cjs — sleeps for N seconds. More reliable than asking the AI to "wait".
// Usage: node wait.cjs <seconds>

'use strict'

const seconds = parseFloat(process.argv[2])
if (!seconds || isNaN(seconds) || seconds <= 0) {
  console.error('Usage: node wait.cjs <seconds>')
  process.exit(1)
}

setTimeout(() => {}, seconds * 1000)
