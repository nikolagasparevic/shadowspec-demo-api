import { canonicalStringify } from "./canonical";
import { hasValidSnapshot } from "./state-derived";
import type {
  BindingReference,
  CaptureDefinition
} from "./load-scenarios";
import type {
  CapturedRequest,
  ScenarioSequence
} from "./scenario-types";

type CandidateValue = string | number;

export type InferenceScenarioRequest = {
  method: string;
  path: string;
  body: unknown;
  pathParams?: Record<
    string,
    string | BindingReference
  >;
  queryParams?: Record<string, string>;
};

export type InferenceScenarioStep = {
  request: InferenceScenarioRequest;
  expected: {
    status: number;
    body: unknown;
  };
  dynamicFields?: string[];
  capture?: Record<
    string,
    CaptureDefinition
  >;
};

export type InferenceLifecycleScenario = {
  id: number;
  steps: InferenceScenarioStep[];
  setup?: unknown;
};

type ScalarLeaf = {
  pointer: string;
  value: CandidateValue;
};

type SnapshotEvidence = {
  table: string;
  pointer: string;
  snapshotValueType: "string" | "number";
};

type AddedRow = {
  table: string;
  row: Record<string, unknown>;
};

type FlowCandidate = {
  sequenceIndex: number;
  producerStep: number;
  consumerStep: number;
  sourcePointer: string;
  pathParameter: string;
  pathSegment: number;
  value: CandidateValue;
  valueType: "string" | "number";
  snapshotEvidence: SnapshotEvidence;
  signature: string;
};

const SENTINEL = "__SHADOWSPEC_BINDING__";

function isCandidateValue(
  value: unknown
): value is CandidateValue {
  return (
    (typeof value === "string" &&
      value.length > 0) ||
    (typeof value === "number" &&
      Number.isFinite(value))
  );
}

function escapePointerToken(
  token: string
): string {
  return token
    .replace(/~/g, "~0")
    .replace(/\//g, "~1");
}

function decodePointerToken(
  token: string
): string {
  return token
    .replace(/~1/g, "/")
    .replace(/~0/g, "~");
}

function pointerTokens(
  pointer: string
): string[] {
  if (pointer === "") {
    return [];
  }

  return pointer
    .slice(1)
    .split("/")
    .map(decodePointerToken);
}

function getScalarLeaves(
  value: unknown,
  pointer = ""
): ScalarLeaf[] {
  if (isCandidateValue(value)) {
    return [{ pointer, value }];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      getScalarLeaves(
        item,
        `${pointer}/${index}`
      )
    );
  }

  if (
    value !== null &&
    typeof value === "object"
  ) {
    return Object.entries(value).flatMap(
      ([key, childValue]) =>
        getScalarLeaves(
          childValue,
          `${pointer}/${escapePointerToken(
            key
          )}`
        )
    );
  }

  return [];
}

function valuesMatch(
  left: CandidateValue,
  right: unknown
): boolean {
  return (
    (typeof right === "string" ||
      typeof right === "number") &&
    String(left) === String(right)
  );
}

function containsCandidate(
  value: unknown,
  candidate: CandidateValue
): boolean {
  if (valuesMatch(candidate, value)) {
    return true;
  }

  if (Array.isArray(value)) {
    return value.some((item) =>
      containsCandidate(item, candidate)
    );
  }

  if (
    value !== null &&
    typeof value === "object"
  ) {
    return Object.values(value).some(
      (childValue) =>
        containsCandidate(
          childValue,
          candidate
        )
    );
  }

  return false;
}

function getPointerValue(
  value: unknown,
  pointer: string
): {
  found: boolean;
  value?: unknown;
} {
  let current = value;

  for (const token of pointerTokens(pointer)) {
    if (
      current === null ||
      typeof current !== "object" ||
      !Object.prototype.hasOwnProperty.call(
        current,
        token
      )
    ) {
      return { found: false };
    }

    current = (
      current as Record<string, unknown>
    )[token];
  }

  return {
    found: true,
    value: current
  };
}

function replacePointerValue(
  value: unknown,
  pointer: string,
  replacement: unknown
): unknown {
  const tokens = pointerTokens(pointer);

  if (tokens.length === 0) {
    return replacement;
  }

  const clone = structuredClone(value);
  let current = clone;

  for (
    let index = 0;
    index < tokens.length - 1;
    index++
  ) {
    current = (
      current as Record<string, unknown>
    )[tokens[index]];
  }

  (
    current as Record<string, unknown>
  )[tokens[tokens.length - 1]] =
    replacement;

  return clone;
}

function isSuccessful(
  status: number
): boolean {
  return status >= 200 && status < 300;
}

function getMatchingPathSegment(
  path: string,
  parameterValue: string
): number | undefined {
  const segments = path.split("/");
  const matches: number[] = [];

  for (
    let index = 0;
    index < segments.length;
    index++
  ) {
    try {
      if (
        decodeURIComponent(segments[index]) ===
        parameterValue
      ) {
        matches.push(index);
      }
    } catch {
      return undefined;
    }
  }

  return matches.length === 1
    ? matches[0]
    : undefined;
}

function getNewRows(
  before: NonNullable<
    CapturedRequest["snapshot"]
  >,
  after: NonNullable<
    CapturedRequest["snapshot"]
  >
): AddedRow[] {
  const newRows: AddedRow[] = [];

  for (const [
    tableName,
    afterTable
  ] of Object.entries(after.tables)) {
    const beforeRows =
      before.tables[tableName]?.rows ?? [];

    if (
      afterTable.rows.length <=
      beforeRows.length
    ) {
      continue;
    }

    const beforeCounts = new Map<
      string,
      number
    >();

    for (const row of beforeRows) {
      const key = canonicalStringify(row);

      beforeCounts.set(
        key,
        (beforeCounts.get(key) ?? 0) + 1
      );
    }

    const unmatchedRows: Record<
      string,
      unknown
    >[] = [];

    for (const row of afterTable.rows) {
      const key = canonicalStringify(row);
      const remaining =
        beforeCounts.get(key) ?? 0;

      if (remaining > 0) {
        beforeCounts.set(key, remaining - 1);
      } else {
        unmatchedRows.push(row);
      }
    }

    if (
      unmatchedRows.length ===
      afterTable.rows.length -
        beforeRows.length
    ) {
      newRows.push(
        ...unmatchedRows.map((row) => ({
          table: tableName,
          row
        }))
      );
    }
  }

  return newRows;
}

function getSnapshotEvidence(
  producer: CapturedRequest,
  consumer: CapturedRequest,
  candidate: CandidateValue
): SnapshotEvidence | undefined {
  if (
    !hasValidSnapshot(producer.snapshot) ||
    !hasValidSnapshot(consumer.snapshot) ||
    containsCandidate(
      producer.snapshot,
      candidate
    )
  ) {
    return undefined;
  }

  const occurrences = getNewRows(
    producer.snapshot,
    consumer.snapshot
  ).flatMap(({ table, row }) =>
    getScalarLeaves(row)
      .filter((leaf) =>
        valuesMatch(candidate, leaf.value)
      )
      .map((leaf) => ({
        table,
        pointer: leaf.pointer,
        snapshotValueType:
          typeof leaf.value as
            | "string"
            | "number"
      }))
  );

  return occurrences.length === 1
    ? occurrences[0]
    : undefined;
}

function normalizeSequence(
  sequence: ScenarioSequence,
  candidate: Omit<
    FlowCandidate,
    "signature"
  >
): string {
  const normalized = sequence.requests.map(
    (request) => ({
      method: request.method,
      path: request.path,
      pathParams: request.pathParams,
      queryParams: request.queryParams,
      requestBody: request.requestBody,
      responseStatus: request.responseStatus,
      responseBody: request.responseBody
    })
  );

  const producer =
    normalized[candidate.producerStep];

  producer.responseBody = replacePointerValue(
    producer.responseBody,
    candidate.sourcePointer,
    SENTINEL
  );

  const consumer =
    normalized[candidate.consumerStep];
  const segments = consumer.path.split("/");

  segments[candidate.pathSegment] =
    SENTINEL;

  consumer.path = segments.join("/");
  consumer.pathParams = {
    ...consumer.pathParams,
    [candidate.pathParameter]: SENTINEL
  };
  consumer.responseBody = replacePointerValue(
    consumer.responseBody,
    candidate.sourcePointer,
    SENTINEL
  );

  return canonicalStringify({
    producerStep: candidate.producerStep,
    consumerStep: candidate.consumerStep,
    sourcePointer: candidate.sourcePointer,
    pathParameter: candidate.pathParameter,
    pathSegment: candidate.pathSegment,
    valueType: candidate.valueType,
    snapshotEvidence:
      candidate.snapshotEvidence,
    requests: normalized
  });
}

function findCandidates(
  sequence: ScenarioSequence,
  sequenceIndex: number
): FlowCandidate[] {
  const candidates: FlowCandidate[] = [];
  const initialSnapshot =
    sequence.requests[0]?.snapshot;

  if (!hasValidSnapshot(initialSnapshot)) {
    return candidates;
  }

  for (
    let producerStep = 0;
    producerStep < sequence.requests.length;
    producerStep++
  ) {
    const producer =
      sequence.requests[producerStep];

    if (
      producer.method !== "POST" ||
      !isSuccessful(producer.responseStatus) ||
      !hasValidSnapshot(producer.snapshot)
    ) {
      continue;
    }

    const responseLeaves = getScalarLeaves(
      producer.responseBody
    );

    for (const leaf of responseLeaves) {
      if (leaf.pointer === "") {
        continue;
      }

      const occurrenceCount =
        responseLeaves.filter(
          (candidateLeaf) =>
            valuesMatch(
              leaf.value,
              candidateLeaf.value
            )
        ).length;

      if (
        occurrenceCount !== 1 ||
        containsCandidate(
          producer.pathParams,
          leaf.value
        ) ||
        containsCandidate(
          producer.queryParams,
          leaf.value
        ) ||
        containsCandidate(
          producer.requestBody,
          leaf.value
        ) ||
        containsCandidate(
          initialSnapshot,
          leaf.value
        )
      ) {
        continue;
      }

      const consumers: {
        step: number;
        parameter: string;
        segment: number;
      }[] = [];

      for (
        let consumerStep = producerStep + 1;
        consumerStep < sequence.requests.length;
        consumerStep++
      ) {
        const consumer =
          sequence.requests[consumerStep];
        const matchingParameters =
          Object.entries(
            consumer.pathParams
          ).filter(([, parameterValue]) =>
            valuesMatch(
              leaf.value,
              parameterValue
            )
          );

        if (matchingParameters.length === 0) {
          continue;
        }

        if (matchingParameters.length !== 1) {
          consumers.push({
            step: consumerStep,
            parameter: "",
            segment: -1
          });
          continue;
        }

        const [parameter, parameterValue] =
          matchingParameters[0];
        const segment =
          getMatchingPathSegment(
            consumer.path,
            parameterValue
          );

        consumers.push({
          step: consumerStep,
          parameter,
          segment: segment ?? -1
        });
      }

      if (consumers.length !== 1) {
        continue;
      }

      const consumerMatch = consumers[0];
      const consumer =
        sequence.requests[consumerMatch.step];
      const echoed = getPointerValue(
        consumer.responseBody,
        leaf.pointer
      );
      const snapshotEvidence =
        getSnapshotEvidence(
          producer,
          consumer,
          leaf.value
        );

      if (
        consumer.method !== "GET" ||
        !isSuccessful(
          consumer.responseStatus
        ) ||
        consumerMatch.parameter === "" ||
        consumerMatch.segment < 0 ||
        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(
          consumerMatch.parameter
        ) ||
        consumer.path.includes(
          `:${consumerMatch.parameter}`
        ) ||
        !echoed.found ||
        typeof echoed.value !==
          typeof leaf.value ||
        echoed.value !== leaf.value ||
        snapshotEvidence === undefined
      ) {
        continue;
      }

      const baseCandidate = {
        sequenceIndex,
        producerStep,
        consumerStep: consumerMatch.step,
        sourcePointer: leaf.pointer,
        pathParameter:
          consumerMatch.parameter,
        pathSegment: consumerMatch.segment,
        value: leaf.value,
        valueType: typeof leaf.value as
          | "string"
          | "number",
        snapshotEvidence
      };

      candidates.push({
        ...baseCandidate,
        signature: normalizeSequence(
          sequence,
          baseCandidate
        )
      });
    }
  }

  return candidates;
}

function setPointerValue(
  value: unknown,
  pointer: string,
  replacement: unknown
): boolean {
  const tokens = pointerTokens(pointer);

  if (tokens.length === 0) {
    return false;
  }

  let current = value;

  for (
    let index = 0;
    index < tokens.length - 1;
    index++
  ) {
    if (
      current === null ||
      typeof current !== "object" ||
      !Object.prototype.hasOwnProperty.call(
        current,
        tokens[index]
      )
    ) {
      return false;
    }

    current = (
      current as Record<string, unknown>
    )[tokens[index]];
  }

  if (
    current === null ||
    typeof current !== "object" ||
    !Object.prototype.hasOwnProperty.call(
      current,
      tokens[tokens.length - 1]
    )
  ) {
    return false;
  }

  (
    current as Record<string, unknown>
  )[tokens[tokens.length - 1]] =
    replacement;

  return true;
}

export function inferLifecycleBindings(
  sequences: ScenarioSequence[],
  scenarios: InferenceLifecycleScenario[]
): InferenceLifecycleScenario[] {
  const candidates = sequences.flatMap(
    (sequence, sequenceIndex) =>
      findCandidates(
        sequence,
        sequenceIndex
      )
  );
  const groups = new Map<
    string,
    FlowCandidate[]
  >();

  for (const candidate of candidates) {
    const group =
      groups.get(candidate.signature) ?? [];

    group.push(candidate);
    groups.set(candidate.signature, group);
  }

  const qualified = Array.from(
    groups.values()
  )
    .filter((group) => {
      const sequenceIndexes = new Set(
        group.map(
          (candidate) =>
            candidate.sequenceIndex
        )
      );
      const values = new Set(
        group.map((candidate) =>
          JSON.stringify(candidate.value)
        )
      );

      return (
        sequenceIndexes.size >= 2 &&
        values.size >= 2
      );
    })
    .flat();

  const candidatesPerProducer = new Map<
    string,
    FlowCandidate[]
  >();

  for (const candidate of qualified) {
    const key = [
      candidate.sequenceIndex,
      candidate.producerStep
    ].join(":");
    const existing =
      candidatesPerProducer.get(key) ?? [];

    existing.push(candidate);
    candidatesPerProducer.set(
      key,
      existing
    );
  }

  const uniquePerProducer = qualified.filter(
    (candidate) =>
      candidatesPerProducer.get(
        [
          candidate.sequenceIndex,
          candidate.producerStep
        ].join(":")
      )?.length === 1
  );

  const uniqueGroups = new Map<
    string,
    FlowCandidate[]
  >();

  for (const candidate of uniquePerProducer) {
    const group =
      uniqueGroups.get(candidate.signature) ?? [];

    group.push(candidate);
    uniqueGroups.set(candidate.signature, group);
  }

  const accepted = Array.from(
    uniqueGroups.values()
  )
    .filter((group) => {
      const sequencesInGroup = new Set(
        group.map(
          (candidate) =>
            candidate.sequenceIndex
        )
      );
      const valuesInGroup = new Set(
        group.map((candidate) =>
          JSON.stringify(candidate.value)
        )
      );

      return (
        sequencesInGroup.size >= 2 &&
        valuesInGroup.size >= 2
      );
    })
    .flat();

  if (accepted.length === 0) {
    return scenarios;
  }

  const result = structuredClone(scenarios);

  for (const candidate of accepted) {
    const scenario =
      result[candidate.sequenceIndex];
    const producer =
      scenario.steps[candidate.producerStep];
    const consumer =
      scenario.steps[candidate.consumerStep];
    const sourceExpected = getPointerValue(
      producer.expected.body,
      candidate.sourcePointer
    );
    const consumerExpected = getPointerValue(
      consumer.expected.body,
      candidate.sourcePointer
    );

    if (
      !sourceExpected.found ||
      sourceExpected.value !== candidate.value ||
      !consumerExpected.found ||
      consumerExpected.value !== candidate.value
    ) {
      continue;
    }

    const bindingName = `step${
      candidate.producerStep + 1
    }Value1`;
    const reference: BindingReference = {
      $ref: bindingName
    };
    const pathSegments =
      consumer.request.path.split("/");

    pathSegments[candidate.pathSegment] =
      `:${candidate.pathParameter}`;

    consumer.request.path =
      pathSegments.join("/");
    consumer.request.pathParams = {
      ...(consumer.request.pathParams ?? {}),
      [candidate.pathParameter]: reference
    };

    if (
      !setPointerValue(
        consumer.expected.body,
        candidate.sourcePointer,
        reference
      )
    ) {
      continue;
    }

    producer.capture = {
      [bindingName]: {
        from: "response.body",
        pointer: candidate.sourcePointer,
        type: candidate.valueType
      }
    };
  }

  return result;
}
