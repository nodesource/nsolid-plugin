#!/usr/bin/env node

// nsolid-api.cjs — What the N|Solid skills' scripts share: where the N|Solid API is,
// the token to read it with, and small helpers around fetch.
//
// Configuration, first found wins:
//   1. Environment: NSOLID_API_URL, NSOLID_API_TOKEN, and optionally NSOLID_TENANT.
//   2. ~/.agents/.nsolid-auth.json: { "apiUrl": "...", "token": "...", "tenant": "..." }
// The token is an N|Solid API token. Reports need the "read" scope; downloading a
// heap snapshot needs "operate", and pulled source code "nsolid:source-code".
//
// Data read here goes to files, never to the agent's context.

'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { Readable } = require('stream')
const { pipeline } = require('stream/promises')

const CONFIG_FILE = path.join(os.homedir(), '.agents', '.nsolid-auth.json')
// Sent with every request: N|Solid's usage reports tell the plugin's scripts
// from other API callers (and from the MCP server, which labels itself).
const CLIENT_HEADERS = { 'x-nsolid-client': 'api', 'x-nsolid-client-name': 'nsolid-plugin' }
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

function readConfig () {
  let file = {}
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      file = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
    } catch (err) {
      throw new Error(`${CONFIG_FILE} is not valid JSON: ${err.message}`)
    }
  }
  const apiUrl = process.env.NSOLID_API_URL || file.apiUrl
  const token = process.env.NSOLID_API_TOKEN || file.token
  const tenant = process.env.NSOLID_TENANT || file.tenant || ''
  if (!apiUrl || !token) {
    throw new Error(
      'N|Solid is not configured: set NSOLID_API_URL and NSOLID_API_TOKEN, ' +
      `or write ${CONFIG_FILE} with "apiUrl" and "token"`
    )
  }
  let url
  try {
    url = new URL(apiUrl)
  } catch {
    throw new Error(`not a URL: ${apiUrl}`)
  }
  // The token travels with every request: plain http only to this machine.
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname))) {
    throw new Error('the N|Solid API URL must use https (plain http only for localhost)')
  }
  return { apiUrl: url.href.replace(/\/$/, ''), token, tenant }
}

async function failure (res, what) {
  let message = `${res.status} ${res.statusText}`
  try {
    const body = await res.json()
    if (body?.error?.message) message = body.error.message
  } catch {}
  return new Error(`${what}: ${message}`)
}

function createClient (config = readConfig()) {
  const auth = { authorization: `Bearer ${config.token}`, ...CLIENT_HEADERS }

  async function get (pathname) {
    const res = await fetch(config.apiUrl + pathname, { headers: { ...auth, accept: 'application/json' } })
    if (!res.ok) throw await failure(res, pathname)
    return res.json()
  }

  /** Streams a file to `dest` (through a temporary file, so a failed download leaves nothing). */
  async function download (pathname, dest) {
    // identity: the API decompresses, so the file on disk is the file itself.
    const res = await fetch(config.apiUrl + pathname, { headers: { ...auth, 'accept-encoding': 'identity' } })
    if (!res.ok) throw await failure(res, pathname)
    const partial = `${dest}.partial`
    try {
      await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(partial))
      fs.renameSync(partial, dest)
    } catch (err) {
      fs.rmSync(partial, { force: true })
      throw err
    }
    return fs.statSync(dest).size
  }

  /** The tenant to read: configured, or the token's only one. */
  async function tenant () {
    if (config.tenant) return config.tenant
    const me = await get('/v1/me')
    if (me.tenants?.length === 1) return me.tenants[0].id
    throw new Error(
      `the token can read ${me.tenants?.length ?? 0} tenants (${(me.tenants ?? []).map((t) => t.id).join(', ')}); ` +
      'set NSOLID_TENANT, or "tenant" in the config file'
    )
  }

  return { get, download, tenant, config }
}

/** Safe for file names. */
function slug (value, fallback = 'unknown') {
  const s = String(value ?? '').replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '')
  return s || fallback
}

module.exports = { CLIENT_HEADERS, CONFIG_FILE, readConfig, createClient, slug }
