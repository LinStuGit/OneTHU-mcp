// tsx 具名导出互操作 shim：绕过 paths 别名直达 CJS 本体（防自引用环）
import { createRequire } from "node:module";
const require = createRequire("/Volumes/PortableSSD/Projects/thuapp/OneTHU/scripts/_sm-shim.mjs");
const sm = require("/Volumes/PortableSSD/Projects/thuapp/OneTHU/node_modules/.pnpm/sm-crypto@0.5.7/node_modules/sm-crypto/src/index.js");
export const sm2 = sm.sm2;
export const sm3 = sm.sm3;
export const sm4 = sm.sm4;
export default sm;
