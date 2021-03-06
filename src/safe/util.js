import isObjectLike from "../util/is-object-like.js"
import realUtil from "../real/util.js"
import safe from "../util/safe.js"
import setProperty from "../util/set-property.js"
import shared from "../shared.js"

function init() {
  const safeUtil = safe(realUtil)
  const { custom, defaultOptions } = safeUtil.inspect
  const { types } = safeUtil

  let defaultInspectOptions = defaultOptions

  if (! isObjectLike(defaultInspectOptions)) {
    defaultInspectOptions = {
      breakLength: 60,
      colors: false,
      compact: true,
      customInspect: true,
      depth: 2,
      maxArrayLength: 100,
      showHidden: false,
      showProxy: false
    }
  }

  if (isObjectLike(types)) {
    setProperty(safeUtil, "types", safe(types))
  }

  setProperty(safeUtil, "customInspectSymbol", custom)
  setProperty(safeUtil, "defaultInspectOptions", defaultInspectOptions)

  return safeUtil
}

const safeUtil = shared.inited
  ? shared.module.safeUtil
  : shared.module.safeUtil = init()

export const {
  customInspectSymbol,
  defaultInspectOptions,
  deprecate,
  inspect,
  types
} = safeUtil

export default safeUtil
