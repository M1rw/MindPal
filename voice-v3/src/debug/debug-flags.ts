export const DEBUG_V3 = true;

const debugGlobal = globalThis as typeof globalThis & {
  __MINDPAL_DEBUG_V3__?: boolean;
};

debugGlobal.__MINDPAL_DEBUG_V3__ = DEBUG_V3;

export function isDebugV3Enabled(): boolean {
  return debugGlobal.__MINDPAL_DEBUG_V3__ ?? DEBUG_V3;
}
