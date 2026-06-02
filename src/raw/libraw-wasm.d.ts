// `libraw-wasm` ships no type declarations; the adapter narrows the shape it
// uses via its own LibRawCtor type, so a minimal module declaration suffices.
declare module "libraw-wasm" {
  const LibRaw: unknown;
  export default LibRaw;
}
