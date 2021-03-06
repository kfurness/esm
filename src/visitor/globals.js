import COMPILER from "../constant/compiler.js"

import Visitor from "../visitor.js"

import isIdentifer from "../parse/is-identifier.js"
import isShadowed from "../parse/is-shadowed.js"
import shared from "../shared.js"

function init() {
  const {
    TRANSFORMS_CONSOLE,
    TRANSFORMS_REFLECT
  } = COMPILER

  const shadowedMap = new Map

  class GlobalsVisitor extends Visitor {
    reset(options) {
      this.globals = null
      this.magicString = null
      this.possibleIndexes = null
      this.runtimeName = null
      this.transforms = 0

      if (options !== void 0) {
        this.globals = options.globals
        this.magicString = options.magicString
        this.possibleIndexes = options.possibleIndexes
        this.runtimeName = options.runtimeName
      }
    }

    visitCallExpression(path) {
      const node = path.getValue()
      const { callee } = node

      if (callee.type !== "MemberExpression") {
        this.visitChildren(path)
        return
      }

      const { object } = callee
      const { name } = object

      if (! this.globals.has(name)) {
        this.visitChildren(path)
        return
      }

      const args = node.arguments

      if (args.length === 0) {
        return
      }

      const parent = path.getParentNode()

      if (! isIdentifer(object, parent) ||
          isShadowed(path, name, shadowedMap)) {
        return
      }

      if (name === "console") {
        let skip = true

        for (const { type } of args) {
          if (type !== "Literal" &&
              type !== "TemplateLiteral") {
            skip = false
            break
          }
        }

        if (skip) {
          return
        }

        this.transforms |= TRANSFORMS_CONSOLE
      } else if (name === "Reflect") {
        this.transforms |= TRANSFORMS_REFLECT
      }

      this.magicString.prependLeft(object.start, this.runtimeName + ".g.")

      path.call(this, "visitWithoutReset", "arguments")
    }
  }

  return new GlobalsVisitor
}

export default shared.inited
  ? shared.module.visitorGlobals
  : shared.module.visitorGlobals = init()
