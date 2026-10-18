/** JSON stored after the header. Extra keys (e.g. the indexer's report) are kept as-is. */
export interface IndexMetadata {
  /** ONSPD release label, e.g. `FEB_2026`. */
  release: string;
  /** ISO 8601 build timestamp. */
  builtAt: string;
  /** Exclusion flags applied, e.g. `["ni", "crown-dependencies"]`. */
  exclusions: string[];
  /** Base names of the CSV files the index was built from. */
  sourceFiles: string[];
  /** Worst-case coordinate precision in metres across all districts. */
  worstPrecisionM: number;
  [key: string]: unknown;
}
