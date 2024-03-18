#!usr/bin/env node
// @ts-check

import { spawn } from "node:child_process"
import { Console as NodeConsole } from "node:console"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { createReadStream, createWriteStream, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { argv } from "node:process"
import { URL, fileURLToPath } from "node:url"
import sade from "sade"
import Chain from "stream-chain"
import Pick from "stream-json/filters/Pick.js"
import Ignore from "stream-json/filters/Ignore.js"
import StreamArray from "stream-json/streamers/StreamArray.js"
import Parser from "stream-json/Parser.js"
import pack from "./package.json" assert { type: "json" }

/**
 * @returns {void}
 */
function main() {
  const make = sade("./makefile.js")

  make
    .command("build")
    .action(async () => {
      const r = fileURLToPath(new URL(".", import.meta.url))

      const d = join(r, "dist")
      if (!existsSync(d)) {
        await mkdir(d)
      }

      const cf = join(d, "report.log")
      const cs = createWriteStream(cf)
      const c = new Console(cs, cs)

      await build(c, r, d)
      globalThis.console.error("end")
    })

  make.parse(argv)
}

/**
 * @typedef {Object} Parent
 * @property {string} path
 * @property {number} length
 */

/**
 * @param {Console} console
 * @param {string} root
 * @param {string} dist
 * @returns {Promise<void>}
 */
async function build(console, root, dist) {
  const tmp = join(tmpdir(), pack.name)
  const temp = await mkdtemp(`${tmp}-`)

  /**
   * @type {Parent[]}
   */
  const parents = []

  let f = "portals.json"
  let from = join(root, f)
  await new Promise((res, rej) => {
    const c = new Chain([
      createReadStream(from),
      new Parser(),
      new Ignore({ filter: /^\d+\.apiMethods\.\d+\./ }),
      new StreamArray(),
      (ch) => {
        parents.push({
          path: ch.value.path,
          length: ch.value.apiMethods.length
        })
      }
    ])
    // Keep this line to avoid terminating the process.
    c.on("data", () => {})
    c.on("error", rej)
    c.on("close", res)
  })

  // For the beauty of the picture, it would be great to stream this as well,
  // but it is easier this way.
  const base = {
    openapi: "3.0.1",
    info: {
      title: "Community Server REST API",
      version: "latest"
    },
    paths: {}
  }

  let i = 0
  await new Promise((res, rej) => {
    const c = new Chain([
      createReadStream(from),
      new Parser(),
      new Pick({ filter: /^\d+\.apiMethods/ }),
      new StreamArray(),
      (ch) => {
        const p = parents[0]
        if (p === undefined) {
          throw new Error("parents is empty")
        }

        console.info(`processing ${i} of ${p.path}...`)
        const r = process(console, p, ch.value)
        if (r === null) {
          console.warn(`skipping ${i} of ${p.path}...`)
        } else {
          console.info(`adding ${i} of ${p.path}...`)
          if (base.paths[r.endpoint] === undefined) {
            base.paths[r.endpoint] = {}
          }
          base.paths[r.endpoint][r.method] = r.object
        }

        p.length -= 1
        if (p.length === 0) {
          i = 0
          parents.shift()
        } else {
          i += 1
        }
      }
    ])
    // Keep this line to avoid terminating the process.
    c.on("data", () => {})
    c.on("error", rej)
    c.on("close", res)
  })

  let to = join(temp, f)
  await writeFile(to, JSON.stringify(base, null, 2))

  from = to
  to = join(dist, f)
  await prettifyJSON(from, to)
}

class Console extends NodeConsole {
  /**
   * @param  {...any} data
   * @returns {void}
   */
  info(...data) {
    super.info("info:", ...data)
  }

  /**
   * @param  {...any} data
   * @returns {void}
   */
  warn(...data) {
    super.warn("warn:", ...data)
  }
}

/**
 * @typedef {Object} Result
 * @property {string} endpoint
 * @property {string} method
 * @property {any} object
 *  @returns {[Object, boolean]}
 */

function validateC(c) {
  let invalid = false
  if (c.isVisible === false) {
    console.warn("is not visible")
    invalid = true
  }
  const names = ["path", "method", "category", "shortDescription"]
  const checks = [undefined, null, ""]
  names.forEach(name => {
    if (checks.includes(c[name])) {
      c[name] = ""
      console.warn(`${name} is missing`)
      invalid = true
    }
  })
  
  return [ c, invalid ]
}

/**
 * @param {any} c
 * @param {any} p
 * @returns {Object}
 */

function buildObject(c, p) {
  const object = {}
  if (c.category != "") {
    object.tags = [`${p.path}/${c.category}`]
  }
  if (c.shortDescription != "") {
    object.summary = c.shortDescription
  }
  return object
}

/**
 * @param {Console} console
 * @param {Parent} p
 * @param {any} c
 * @returns {Result | null}
 */

function process(console, p, c) {
  // DONE
  let [validated_c, isInvalid] = validateC(c)
  c = validated_c

  const method = c.method.toLowerCase()
  const endpoint = `/api/2.0/${p.path}/${c.path}`
  const object = buildObject(c, p)

  // TODO...
  const d = processDescription(c)
  if (d !== "") {
    object.description = d
  }

  if (object.description === undefined) {
    console.warn("failed to set description")
    isInvalid = true
  }

  const parameters = []
  // const requestBody = {
  //   content: {}
  // }

  if (!(c.parameters === undefined || c.parameters === null)) {
    c.parameters.forEach((p, i) => {
      console.info(`processing parameter ${i}...`)
      let isInvalid = false

      const o = {}

      if (p.isVisible === false) {
        console.warn("is not visible")
        isInvalid = true
      }

      if (p.name === undefined || p.name === null || p.name === "") {
        console.warn("parameter name is missing")
        isInvalid = true
        p.name = ""
      } else {
        o.name = p.name
      }

      if (p.in === undefined || p.in === null || p.in === "") {
        // todo: it is not our opportunity
        if (endpoint.includes(`{${p.name}}`)) {
          o.in = "path"
        } else {
          o.in = "body"
        }
      } else {
        o.in = p.in
      }

      const d = processDescription(p)
      if (d !== "") {
        o.description = d
      }

      const s = processSchema(p)
      if (s === undefined) {
        console.warn("type is missing")
        isInvalid = true
      } else {
        o.schema = s
      }

      if (isInvalid) {
        console.warn("failed to set parameter")
      } else {
        if (o.in === "body") {
          // todo: wait for the content-type
        } else {
          parameters.push(o)
        }
      }
    })
  }

  if (parameters.length > 0) {
    object.parameters = parameters
  }

  if (isInvalid) {
    return null
  }
  return {
    endpoint,
    method,
    object
  }
}

/**
 * @param {any} o
 * @returns {string}
 */
function processDescription(o) {
  let d = ""

  if (!(o.description === undefined || o.description === null || o.description === "")) {
    d = o.description
  }

  if (!(o.remarks === undefined || o.remarks === null || o.remarks === "")) {
    const r = `**Note**: ${o.remarks}`
    if (d === "") {
      d = r
    } else {
      d += `\n\n${r}`
    }
  }

  return d
}

/**
 * @param {any} o
 * @returns {any | undefined}
 */
function processSchema(o) {
  if (o.type === undefined || o.type === null) {
    return undefined
  }

  // todo: replace with p.type === "object"
  if (!(o.type.properties === undefined || o.type.properties === null)) {
    const s = {
      type: "object"
    }
    // const properties = o.type.flatMap((p) => {})
    return s
  }

  return undefined
}

/**
 * @param {string} from
 * @param {string} to
 * @returns {Promise<void>}
 */
function prettifyJSON(from, to) {
  const w = createWriteStream(to)
  const a = ["--monochrome-output", ".", from]
  return new Promise((res, rej) => {
    const s = spawn("jq", a)
    s.stdout.on("data", (ch) => {
      w.write(ch)
    })
    s.stdout.on("close", () => {
      w.close()
      res(undefined)
    })
    s.stdout.on("error", (e) => {
      w.close()
      rej(e)
    })
  })
}

main()
