export type CapturePrivacyOptions = {
  forbiddenRequestPointers?: readonly string[];
  forbiddenResponsePointers?: readonly string[];
  forbiddenHeaders?: readonly string[];
  snapshotAllowedColumns?: Readonly<Record<string, readonly string[]>>;
};

export type CapturePrivacyErrorCode =
  | "CAPTURE_PRIVACY_CONFIGURATION_INVALID"
  | "CAPTURE_PRIVACY_POLICY_VIOLATION"
  | "CAPTURE_SECRET_REPLAY_REQUIRED"
  | "CAPTURE_SNAPSHOT_COLUMN_FORBIDDEN";

export type CapturePrivacyLocation =
  | "header"
  | "request-body"
  | "query"
  | "path-params"
  | "response-body";

export class CapturePrivacyError extends Error {
  readonly name = "CapturePrivacyError";

  constructor(
    readonly code: CapturePrivacyErrorCode,
    message: string,
    readonly location?: CapturePrivacyLocation,
    readonly pointer?: string,
    readonly headerName?: string,
    readonly tableName?: string,
    readonly columnName?: string
  ) {
    super(message);
  }
}

type CompiledPointer = {
  source: string;
  tokens: string[];
  location: CapturePrivacyLocation;
};

export type CapturePrivacyPolicy = {
  requestPointers: readonly CompiledPointer[];
  responsePointers: readonly CompiledPointer[];
  forbiddenHeaders: ReadonlySet<string>;
  snapshotAllowedColumns: SnapshotColumnPolicy;
};

export type SnapshotColumnPolicy = Readonly<
  Record<string, readonly string[]>
>;

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const BUILT_IN_FORBIDDEN_HEADERS = ["authorization", "cookie"];

function invalidConfiguration(): never {
  throw new CapturePrivacyError(
    "CAPTURE_PRIVACY_CONFIGURATION_INVALID",
    "ShadowSpec privacy configuration is invalid."
  );
}

function decodeToken(token: string): string {
  if (/~(?:[^01]|$)/.test(token)) invalidConfiguration();
  return token.replaceAll("~1", "/").replaceAll("~0", "~");
}

function compilePointers(
  pointers: readonly string[] | undefined,
  allowedRoots: Readonly<Record<string, CapturePrivacyLocation>>
): CompiledPointer[] {
  if (pointers !== undefined && !Array.isArray(pointers)) {
    invalidConfiguration();
  }
  const seen = new Set<string>();
  return (pointers ?? []).map((pointer) => {
    if (typeof pointer !== "string" || !pointer.startsWith("/")) {
      return invalidConfiguration();
    }
    if (seen.has(pointer)) invalidConfiguration();
    seen.add(pointer);

    const tokens = pointer.slice(1).split("/").map(decodeToken);
    const location = allowedRoots[tokens[0]];
    if (location === undefined) invalidConfiguration();
    return { source: pointer, tokens, location };
  });
}

export function compileCapturePrivacyPolicy(
  options: CapturePrivacyOptions = {},
  configuredTables: readonly string[] = []
): CapturePrivacyPolicy {
  if (options === null || typeof options !== "object") {
    invalidConfiguration();
  }
  const forbiddenHeaders = new Set(BUILT_IN_FORBIDDEN_HEADERS);
  if (
    options.forbiddenHeaders !== undefined &&
    !Array.isArray(options.forbiddenHeaders)
  ) {
    invalidConfiguration();
  }
  for (const configured of options.forbiddenHeaders ?? []) {
    if (typeof configured !== "string") invalidConfiguration();
    const normalized = configured.trim().toLowerCase();
    if (!HEADER_NAME.test(normalized) || forbiddenHeaders.has(normalized)) {
      invalidConfiguration();
    }
    forbiddenHeaders.add(normalized);
  }

  const tables = [...new Set(
    configuredTables.map((table) => table.trim()).filter(Boolean)
  )];
  if (tables.some((table) => !IDENTIFIER.test(table))) {
    invalidConfiguration();
  }
  const configuredTableSet = new Set(tables);
  const source = options.snapshotAllowedColumns;
  if (
    source !== undefined &&
    (source === null || typeof source !== "object" || Array.isArray(source))
  ) {
    invalidConfiguration();
  }
  const snapshotAllowedColumns: Record<string, readonly string[]> =
    Object.create(null);
  const seenTables = new Set<string>();
  for (const [rawTable, rawColumns] of Object.entries(source ?? {})) {
    const table = rawTable.trim();
    if (
      !IDENTIFIER.test(table) ||
      seenTables.has(table) ||
      !configuredTableSet.has(table) ||
      !Array.isArray(rawColumns) ||
      rawColumns.length === 0
    ) {
      invalidConfiguration();
    }
    seenTables.add(table);
    const columns = rawColumns.map((column) => {
      if (typeof column !== "string") return invalidConfiguration();
      const normalized = column.trim();
      if (!IDENTIFIER.test(normalized)) invalidConfiguration();
      return normalized;
    });
    if (new Set(columns).size !== columns.length) invalidConfiguration();
    snapshotAllowedColumns[table] = [...columns].sort();
  }
  if (
    tables.some((table) => !seenTables.has(table)) ||
    seenTables.size !== tables.length
  ) {
    invalidConfiguration();
  }

  return {
    requestPointers: compilePointers(
      options.forbiddenRequestPointers,
      {
        body: "request-body",
        query: "query",
        pathParams: "path-params"
      }
    ),
    responsePointers: compilePointers(
      options.forbiddenResponsePointers,
      { body: "response-body" }
    ),
    forbiddenHeaders,
    snapshotAllowedColumns
  };
}

function snapshotColumnError(
  table: string,
  column?: string
): CapturePrivacyError {
  return new CapturePrivacyError(
    "CAPTURE_SNAPSHOT_COLUMN_FORBIDDEN",
    "ShadowSpec snapshot columns do not match the approved privacy inventory.",
    undefined,
    undefined,
    undefined,
    table,
    column
  );
}

export function assertSnapshotColumnsAllowed(
  allowedColumns: SnapshotColumnPolicy,
  table: string,
  actualColumns: readonly string[]
): readonly string[] {
  const approved = allowedColumns[table];
  if (approved === undefined) throw snapshotColumnError(table);
  const actual = [...actualColumns].sort();
  const unexpected = actual.find((column) => !approved.includes(column));
  const missing = approved.find((column) => !actual.includes(column));
  if (
    unexpected !== undefined ||
    missing !== undefined ||
    actual.length !== approved.length
  ) {
    throw snapshotColumnError(table, unexpected ?? missing);
  }
  return approved;
}

export function assertSnapshotPrimaryKeyAllowed(
  table: string,
  primaryKey: readonly string[],
  approvedColumns: readonly string[]
): void {
  const forbidden = primaryKey.find((column) =>
    !approvedColumns.includes(column)
  );
  if (forbidden !== undefined) {
    throw snapshotColumnError(table, forbidden);
  }
}

function hasPointer(value: unknown, tokens: readonly string[]): boolean {
  let current = value;
  for (const token of tokens) {
    if (current === null || typeof current !== "object") return false;
    if (Array.isArray(current) && !/^(0|[1-9][0-9]*)$/.test(token)) {
      return false;
    }
    if (!Object.prototype.hasOwnProperty.call(current, token)) return false;
    current = (current as Record<string, unknown>)[token];
  }
  return true;
}

function assertPointersAllowed(
  value: unknown,
  pointers: readonly CompiledPointer[]
): void {
  for (const pointer of pointers) {
    if (hasPointer(value, pointer.tokens)) {
      throw new CapturePrivacyError(
        "CAPTURE_PRIVACY_POLICY_VIOLATION",
        "ShadowSpec capture was rejected by its privacy policy.",
        pointer.location,
        pointer.source
      );
    }
  }
}

export function assertRequestPrivacy(
  policy: CapturePrivacyPolicy,
  input: {
    headers: Readonly<Record<string, unknown>>;
    body: unknown;
    query: unknown;
    pathParams: unknown;
  }
): void {
  for (const headerName of policy.forbiddenHeaders) {
    if (Object.keys(input.headers).some(
      (candidate) => candidate.toLowerCase() === headerName &&
        input.headers[candidate] !== undefined
    )) {
      throw new CapturePrivacyError(
        "CAPTURE_SECRET_REPLAY_REQUIRED",
        "ShadowSpec cannot safely capture a request containing a forbidden header.",
        "header",
        undefined,
        headerName
      );
    }
  }

  const requestValue: Record<string, unknown> = {
    query: input.query,
    pathParams: input.pathParams
  };
  if (input.body !== undefined) requestValue.body = input.body;
  assertPointersAllowed(requestValue, policy.requestPointers);
}

export function assertResponsePrivacy(
  policy: CapturePrivacyPolicy,
  body: unknown
): void {
  assertPointersAllowed({ body }, policy.responsePointers);
}
