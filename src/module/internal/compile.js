import COMPILER from "../../constant/compiler.js"
import ENTRY from "../../constant/entry.js"
import ENV from "../../constant/env.js"
import MESSAGE from "../../constant/message.js"
import PACKAGE from "../../constant/package.js"

import CachingCompiler from "../../caching-compiler.js"
import Entry from "../../entry.js"
import GenericObject from "../../generic/object.js"
import Loader from "../../loader.js"
import Runtime from "../../runtime.js"

import captureStackTrace from "../../error/capture-stack-trace.js"
import compileSource from "./compile-source.js"
import errors from "../../parse/errors.js"
import get from "../../util/get.js"
import getLocationFromStackTrace from "../../error/get-location-from-stack-trace.js"
import getSourceMappingURL from "../../util/get-source-mapping-url.js"
import getStackFrames from "../../error/get-stack-frames.js"
import isAbsolute from "../../path/is-absolute.js"
import isObjectEmpty from "../../util/is-object-empty.js"
import isOwnPath from "../../util/is-own-path.js"
import isStackTraceMaskable from "../../util/is-stack-trace-maskable.js"
import maskStackTrace from "../../error/mask-stack-trace.js"
import setProperty from "../../util/set-property.js"
import shared from "../../shared.js"
import toExternalError from "../../util/to-external-error.js"
import toString from "../../util/to-string.js"

const {
  SOURCE_TYPE_MODULE,
  SOURCE_TYPE_SCRIPT,
  SOURCE_TYPE_UNAMBIGUOUS,
  TRANSFORMS_EVAL
} = COMPILER

const {
  NAMESPACE_FINALIZATION_DEFERRED,
  STATE_EXECUTION_COMPLETED,
  STATE_EXECUTION_STARTED,
  STATE_INITIAL,
  STATE_PARSING_COMPLETED,
  STATE_PARSING_STARTED,
  TYPE_CJS,
  TYPE_ESM
} = ENTRY

const {
  DEVELOPMENT,
  ELECTRON_RENDERER,
  FLAGS,
  NDB
} = ENV

const {
  ILLEGAL_AWAIT_IN_NON_ASYNC_FUNCTION
} = MESSAGE

const {
  MODE_ALL,
  MODE_AUTO
} = PACKAGE

const exportsRegExp = /^.*?\bexports\b/

function compile(caller, entry, content, filename, fallback) {
  const mod = entry.module
  const pkg = entry.package
  const { options } = pkg
  const pkgMode = options.mode

  let hint = SOURCE_TYPE_SCRIPT
  let sourceType = SOURCE_TYPE_SCRIPT

  if (entry.extname === ".mjs") {
    hint = SOURCE_TYPE_MODULE
    sourceType = SOURCE_TYPE_MODULE
  } else if (pkgMode === MODE_ALL) {
    sourceType = SOURCE_TYPE_MODULE
  } else if (pkgMode === MODE_AUTO) {
    sourceType = SOURCE_TYPE_UNAMBIGUOUS
  }

  const defaultPkg = Loader.state.package.default
  const isDefaultPkg = pkg === defaultPkg

  let { compileData } = entry

  if (compileData === null) {
    compileData = CachingCompiler.from(entry)

    if (compileData === null ||
        compileData.transforms !== 0) {
      const { cacheName } = entry
      const { cjs } = options

      const scriptData = compileData
        ? compileData.scriptData
        : null

      compileData = tryCompile(caller, entry, content, {
        cacheName,
        cachePath: pkg.cachePath,
        cjsVars: cjs.vars,
        filename,
        hint,
        mtime: entry.mtime,
        runtimeName: entry.runtimeName,
        sourceType,
        topLevelReturn: cjs.topLevelReturn
      })

      compileData.scriptData = scriptData

      entry.compileData = compileData
      pkg.cache.compile.set(cacheName, compileData)

      if (compileData.sourceType === SOURCE_TYPE_MODULE) {
        entry.type = TYPE_ESM
      }

      if (isDefaultPkg &&
          entry.type === TYPE_CJS &&
          compileData.transforms === TRANSFORMS_EVAL) {
        // Under the default package configuration, discard changes for CJS
        // modules with only `eval()` transformations.
        compileData.code = content
        compileData.transforms = 0
      }
    }
  }

  if (compileData !== null &&
      compileData.code === null) {
    compileData.code = content
  }

  const isESM = entry.type === TYPE_ESM
  const { moduleState } = shared

  let isSideloaded = false

  if (! moduleState.parsing) {
    if (isESM &&
        entry.state === STATE_INITIAL) {
      isSideloaded = true
      entry.state = STATE_PARSING_STARTED
      moduleState.parsing = true
    } else {
      return tryRun(entry, filename)
    }
  }

  if (isESM) {
    try {
      let result = tryRun(entry, filename)

      if (compileData.circular === -1) {
        compileData.circular = isDescendant(entry, entry) ? 1 : 0
      }

      if (compileData.circular === 1) {
        entry.circular = true
        entry.runtime = null
        mod.exports = GenericObject.create()

        const { codeWithTDZ } = compileData

        if (codeWithTDZ !== null) {
          compileData.code = codeWithTDZ
        }

        result = tryRun(entry, filename)
      }

      entry.updateBindings()

      if (entry._namespaceFinalized !== NAMESPACE_FINALIZATION_DEFERRED) {
        entry.finalizeNamespace()
      }

      if (! isSideloaded) {
        return result
      }
    } finally {
      if (isSideloaded) {
        moduleState.parsing = false
      }
    }
  } else if (typeof fallback === "function") {
    const parentEntry = Entry.get(mod.parent)
    const parentIsESM = parentEntry === null ? false : parentEntry.type === TYPE_ESM
    const parentPkg = parentEntry === null ? null : parentEntry.package

    if (! parentIsESM &&
        (isDefaultPkg ||
         parentPkg === defaultPkg)) {
      const frames = getStackFrames(new Error)

      for (const frame of frames) {
        const framePath = frame.getFileName()

        if (isAbsolute(framePath) &&
            ! isOwnPath(framePath)) {
          return fallback()
        }
      }
    }
  }

  return tryRun(entry, filename)
}

function isDescendant(entry, parentEntry, seen) {
  if (seen === void 0) {
    seen = new Set
  } else if (seen.has(parentEntry)) {
    return false
  }

  seen.add(parentEntry)

  const { children } = parentEntry

  for (const name in children) {
    const childEntry = children[name]

    if (entry === childEntry ||
        isDescendant(entry, childEntry, seen)) {
      return true
    }
  }

  return false
}

function tryCompile(caller, entry, content, options) {
  let error

  try {
    return CachingCompiler.compile(content, options)
  } catch (e) {
    error = e
  }

  entry.state = STATE_EXECUTION_COMPLETED

  if (Loader.state.package.default.options.debug ||
      ! isStackTraceMaskable(error)) {
    toExternalError(error)
  } else {
    captureStackTrace(error, caller)

    maskStackTrace(error, {
      content,
      filename: options.filename
    })
  }

  throw error
}

function tryRun(entry, filename) {
  const { moduleState } = shared
  const { parsing } = moduleState
  const async = useAsync(entry)
  const { compileData } = entry
  const isESM = entry.type === TYPE_ESM
  const mod = entry.module

  const cjsVars =
    entry.package.options.cjs.vars &&
    entry.extname !== ".mjs"

  let { runtime } = entry

  if (runtime === null) {
    if (isESM ||
        compileData.transforms !== 0) {
      runtime = Runtime.enable(entry, GenericObject.create())
    } else {
      runtime = GenericObject.create()
      entry.runtime = runtime
    }
  }

  let error
  let result
  let threw = false

  entry.state = parsing
    ? STATE_PARSING_STARTED
    : STATE_EXECUTION_STARTED

  const firstPass = runtime._runResult === void 0

  if (firstPass) {
    const source = compileSource(compileData, {
      async,
      cjsVars,
      runtimeName: entry.runtimeName,
      sourceMap: useSourceMap(entry)
    })

    entry.running = true

    try {
      if (isESM) {
        result = mod._compile(source, filename)
      } else {
        const { _compile } = mod

        runtime._runResult = (function *() {
          yield
          return Reflect.apply(_compile, mod, [source, filename])
        })()
      }
    } catch (e) {
      threw = true
      error = e
    }

    entry.running = false
  }

  // Debuggers may wrap `Module#_compile()` with
  // `process.binding("inspector").callAndPauseOnStart()`
  // and not forward the return value.
  const { _runResult } = runtime

  if (! threw &&
      ! parsing &&
      firstPass) {
    entry.running = true

    try {
      _runResult.next()
    } catch (e) {
      threw = true
      error = e
    }

    entry.running = false
  }

  const { firstAwaitOutsideFunction } = compileData

  if (! threw &&
      ! entry.running &&
      async &&
      isESM &&
      firstAwaitOutsideFunction !== null &&
      ! isObjectEmpty(entry.getters)) {
    threw = true
    error = new errors.SyntaxError({ input: "" }, ILLEGAL_AWAIT_IN_NON_ASYNC_FUNCTION)
    error.column = firstAwaitOutsideFunction.column
    error.inModule = true
    error.line = firstAwaitOutsideFunction.line
  }

  if (! threw &&
      ! entry.running) {
    entry.running = true

    try {
      result = _runResult.next().value
    } catch (e) {
      threw = true
      error = e
    }

    entry.running = false
  }

  if (! threw) {
    entry.state = parsing
      ? STATE_PARSING_COMPLETED
      : STATE_EXECUTION_COMPLETED

    if (isESM) {
      Reflect.defineProperty(mod, "loaded", {
        configurable: true,
        enumerable: true,
        get: () => false,
        set(value) {
          if (value) {
            setProperty(this, "loaded", value)
            entry.updateBindings()
            entry.loaded()
          }
        }
      })
    } else if (! parsing &&
               firstPass) {
      entry.module.loaded = true
      entry.loaded()
      entry.updateBindings()
    }

    return result
  }

  entry.state = STATE_EXECUTION_COMPLETED

  if (Loader.state.package.default.options.debug ||
      ! isStackTraceMaskable(error)) {
    throw error
  }

  const message = toString(get(error, "message"))
  const name = get(error, "name")

  if (isESM &&
      (name === "SyntaxError" ||
       (name === "ReferenceError" &&
        exportsRegExp.test(message)))) {
    entry.package.cache.dirty = true
  }

  const loc = getLocationFromStackTrace(error)

  if (loc !== null) {
    filename = loc.filename
  }

  maskStackTrace(error, {
    filename,
    inModule: isESM
  })

  throw error
}

function useAsync(entry) {
  return entry.package.options.await &&
    shared.support.await &&
    entry.extname !== ".mjs"
}

function useSourceMap(entry) {
  if (DEVELOPMENT ||
      ELECTRON_RENDERER ||
      NDB ||
      FLAGS.inspect ||
      entry.package.options.sourceMap) {
    return getSourceMappingURL(entry.compileData.code) === ""
  }

  return false
}

export default compile
