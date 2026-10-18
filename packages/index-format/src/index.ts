export * from './constants.js';
export { encodeInward, decodeInward, inwardPrefixRange, LETTER_INDEX, isDigitCode } from './inward.js';
export { computeChecksum, storedChecksum, checksumsEqual, checksumHex } from './checksum.js';
export {
  IndexFormatError,
  readHeader,
  writeHeader,
  computeLayout,
  align4,
  hasCoordinates,
  type IndexHeader,
  type IndexLayout,
} from './header.js';
export { toAlignedArrayBuffer } from './buffer.js';
export type { IndexMetadata } from './metadata.js';
export { districtPrecisionMetres, type DistrictPrecision } from './precision.js';
export { normaliseQuery, normalisePostcode } from './normalise.js';
export { validateIndexBuffer, type ValidatedIndex } from './validate.js';
export {
  buildIndex,
  type BuildDistrict,
  type BuildEntry,
  type BuildMetadata,
  type BuildOptions,
  type BuildResult,
  type BuildSummary,
} from './encode.js';
export { PostcodeIndex, popcount32, type PostcodeResult } from './index-reader.js';
