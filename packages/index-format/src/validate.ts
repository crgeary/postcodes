import { checksumsEqual, computeChecksum, storedChecksum } from './checksum.js';
import { HEADER_SIZE } from './constants.js';
import { computeLayout, IndexFormatError, readHeader, type IndexHeader, type IndexLayout } from './header.js';
import type { IndexMetadata } from './metadata.js';

export interface ValidatedIndex {
  header: IndexHeader;
  layout: IndexLayout;
  metadata: IndexMetadata;
}

const decoder = new TextDecoder('utf-8', { fatal: true });

/**
 * Validate magic, version, declared length, section layout and SHA-256 before
 * any view is created. Throws `IndexFormatError` on any mismatch.
 */
export function validateIndexBuffer(buffer: ArrayBuffer): ValidatedIndex {
  const header = readHeader(buffer);
  if (header.fileLength !== buffer.byteLength) {
    throw new IndexFormatError(
      `declared length ${header.fileLength} does not match buffer length ${buffer.byteLength}`,
    );
  }
  const layout = computeLayout(
    header.districtCount,
    header.postcodeCount,
    header.metadataLength,
    header.flags,
  );
  if (layout.fileLength !== buffer.byteLength) {
    throw new IndexFormatError(
      `section layout implies ${layout.fileLength} bytes but file is ${buffer.byteLength}`,
    );
  }
  if (layout.metadataOffset + layout.metadataLength > buffer.byteLength) {
    throw new IndexFormatError('metadata extends past end of file');
  }
  if (!checksumsEqual(computeChecksum(buffer), storedChecksum(buffer))) {
    throw new IndexFormatError('checksum mismatch');
  }
  let metadata: IndexMetadata;
  try {
    const bytes = new Uint8Array(buffer, HEADER_SIZE, header.metadataLength);
    metadata = JSON.parse(decoder.decode(bytes)) as IndexMetadata;
  } catch (err) {
    throw new IndexFormatError(`metadata is not valid JSON: ${(err as Error).message}`);
  }
  if (metadata === null || typeof metadata !== 'object') {
    throw new IndexFormatError('metadata is not a JSON object');
  }
  const rank = new Uint32Array(buffer, layout.rankOffset, header.districtCount + 1);
  if (rank[header.districtCount] !== header.postcodeCount) {
    throw new IndexFormatError(
      `rank table ends at ${rank[header.districtCount]} but header declares ${header.postcodeCount} postcodes`,
    );
  }
  return { header, layout, metadata };
}
