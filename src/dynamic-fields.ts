import { canonicalStringify } from "./canonical";
import { escapeJsonPointerToken } from "./json-pointer";

export type DynamicCandidateReason =
  | "value_changed"
  | "presence_changed"
  | "type_changed"
  | "correlated_with_snapshot";

export type DynamicCandidate = {
  pointer: string;
  reason: DynamicCandidateReason;
  observedTypes: string[];
  presentCount: number;
  captureCount: number;
  distinctValueCount: number;
};

type Observation = {
  present: boolean;
  value?: unknown;
};

function observedType(value: unknown): string {
  if (value === null) {
    return "null";
  }

  if (Array.isArray(value)) {
    return "array";
  }

  return typeof value;
}

function childPointer(
  pointer: string,
  token: string
): string {
  return `${pointer}/${escapeJsonPointerToken(token)}`;
}

function candidateFor(
  pointer: string,
  observations: Observation[]
): DynamicCandidate | undefined {
  const present = observations.filter(
    (observation) => observation.present
  );
  const observedTypes = Array.from(
    new Set(
      present.map((observation) =>
        observedType(observation.value)
      )
    )
  ).sort();
  const distinctValueCount = new Set(
    present.map((observation) =>
      canonicalStringify(observation.value)
    )
  ).size;

  if (present.length !== observations.length) {
    return {
      pointer,
      reason: "presence_changed",
      observedTypes,
      presentCount: present.length,
      captureCount: observations.length,
      distinctValueCount
    };
  }

  if (observedTypes.length > 1) {
    return {
      pointer,
      reason: "type_changed",
      observedTypes,
      presentCount: present.length,
      captureCount: observations.length,
      distinctValueCount
    };
  }

  const onlyType = observedTypes[0];

  if (onlyType === "object") {
    const keys = Array.from(
      new Set(
        present.flatMap((observation) =>
          Object.keys(
            observation.value as Record<
              string,
              unknown
            >
          )
        )
      )
    ).sort();

    return keys.length === 0 &&
      distinctValueCount > 1
      ? {
          pointer,
          reason: "value_changed",
          observedTypes,
          presentCount: present.length,
          captureCount: observations.length,
          distinctValueCount
        }
      : undefined;
  }

  if (onlyType === "array") {
    return undefined;
  }

  if (distinctValueCount > 1) {
    return {
      pointer,
      reason: "value_changed",
      observedTypes,
      presentCount: present.length,
      captureCount: observations.length,
      distinctValueCount
    };
  }

  return undefined;
}

function collectCandidates(
  pointer: string,
  observations: Observation[],
  candidates: DynamicCandidate[]
) {
  const candidate = candidateFor(
    pointer,
    observations
  );

  if (candidate) {
    candidates.push(candidate);
    return;
  }

  const present = observations.filter(
    (observation) => observation.present
  );

  if (present.length !== observations.length) {
    return;
  }

  const values = present.map(
    (observation) => observation.value
  );

  if (
    values.every(
      (value) =>
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value)
    )
  ) {
    const keys = Array.from(
      new Set(
        values.flatMap((value) =>
          Object.keys(
            value as Record<string, unknown>
          )
        )
      )
    ).sort();

    for (const key of keys) {
      collectCandidates(
        childPointer(pointer, key),
        values.map((value) => {
          const record =
            value as Record<string, unknown>;
          return Object.prototype.hasOwnProperty.call(
            record,
            key
          )
            ? { present: true, value: record[key] }
            : { present: false };
        }),
        candidates
      );
    }

    return;
  }

  if (values.every(Array.isArray)) {
    const maxLength = Math.max(
      ...values.map((value) => value.length),
      0
    );

    for (let index = 0; index < maxLength; index++) {
      collectCandidates(
        childPointer(pointer, String(index)),
        values.map((value) =>
          index < value.length
            ? { present: true, value: value[index] }
            : { present: false }
        ),
        candidates
      );
    }
  }
}

export function detectDynamicCandidates(
  responses: unknown[]
): DynamicCandidate[] {
  if (responses.length < 2) {
    return [];
  }

  const candidates: DynamicCandidate[] = [];

  collectCandidates(
    "",
    responses.map((value) => ({
      present: true,
      value
    })),
    candidates
  );

  return candidates.sort((left, right) =>
    left.pointer < right.pointer
      ? -1
      : left.pointer > right.pointer
        ? 1
        : 0
  );
}
