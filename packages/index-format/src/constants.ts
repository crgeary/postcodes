/**
 * Format constants. Any change to the layout must bump FORMAT_VERSION.
 */

/** Four ASCII bytes at offset 0 of every index file. */
export const MAGIC = 'PCIX';
export const FORMAT_VERSION = 1;
export const HEADER_SIZE = 64;

/** Header flag bits. */
export const FLAG_HAS_COORDINATES = 1;

/** Inward letters in index order. C, I, K, M, O and V never appear in an inward code. */
export const INWARD_LETTERS = 'ABDEFGHJLNPQRSTUWXYZ';
export const INWARD_LETTER_COUNT = 20; // INWARD_LETTERS.length
/** digit (10) x letter (20) x letter (20) */
export const INWARD_COUNT = 4000;
/** 4,000 bits in 125 x Uint32 */
export const WORDS_PER_DISTRICT = 125;
export const BITSET_BYTES = WORDS_PER_DISTRICT * 4; // 500

/** Outward codes are stored as fixed 4-byte, space-padded ASCII. */
export const OUTWARD_BYTES = 4;
export const OUTWARD_MIN_LENGTH = 2;
export const OUTWARD_MAX_LENGTH = 4;

/** Bounding box: minLat, minLon, latSpan, lonSpan as Float32. */
export const BBOX_FLOATS = 4;
export const BBOX_BYTES = BBOX_FLOATS * 4; // 16

/** Two Uint16 per postcode. */
export const COORD_BYTES = 4;
/** Quantised value meaning "no coordinates". */
export const NO_COORDINATE = 0xffff;
/** Largest quantised value with coordinates. */
export const QUANT_MAX = 65534;

/** SHA-256 digest size. */
export const CHECKSUM_BYTES = 32;
/** Offset of the checksum within the header. */
export const CHECKSUM_OFFSET = 24;

/** Longest normalised autocomplete input: 4-char outward, space, 3-char inward. */
export const MAX_QUERY_LENGTH = 8;
