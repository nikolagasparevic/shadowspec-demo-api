import type { DatabaseSnapshot } from "./db-snapshot";

export type ScenarioResponse = {
  body: any;
  status: number;
  snapshot?: DatabaseSnapshot;
};

export type ScenarioGroup = {
  id: number;
  method: string;
  path: string;
  pathParams: Record<string, string>;
  queryParams: Record<string, string>;
  requestBody: any;
  responses: ScenarioResponse[];
};

export type CapturedRequest = {
  id: number;
  sessionId?: string;
  method: string;
  path: string;
  pathParams: Record<string, string>;
  queryParams: Record<string, string>;
  requestBody: any;
  responseBody: any;
  responseStatus: number;
  snapshot?: DatabaseSnapshot;
};

export type ScenarioSequence = {
  sessionId: string;
  requests: CapturedRequest[];
};
