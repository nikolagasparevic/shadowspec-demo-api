import type { DatabaseSnapshot } from "./db-snapshot";

export type ScenarioResponse = {
  body: unknown;
  status: number;
  snapshot?: DatabaseSnapshot;
};

export type ScenarioGroup = {
  id: number;
  method: string;
  path: string;
  pathParams: Record<string, string>;
  queryParams: Record<string, string>;
  requestBody: unknown;
  responses: ScenarioResponse[];
};

export type CapturedRequest = {
  id: number;
  sessionId?: string;
  method: string;
  path: string;
  pathParams: Record<string, string>;
  queryParams: Record<string, string>;
  requestBody: unknown;
  responseBody: unknown;
  responseStatus: number;
  snapshot?: DatabaseSnapshot;
};

export type ScenarioSequence = {
  sessionId: string;
  requests: CapturedRequest[];
}
