export interface Request {
  readonly id: string;
  readonly payload: string;
}

export interface QueueMessage {
  readonly requestId: string;
  readonly payload: string;
}

const queue: QueueMessage[] = [];
const rows = new Map<string, string>();

export function handleRequest(request: Request): void {
  const validated = validateRequest(request);
  enqueueWork({ requestId: validated.id, payload: validated.payload });
}

function validateRequest(request: Request): Request {
  if (!request.id || !request.payload) throw new Error("invalid_request");
  return request;
}

function enqueueWork(message: QueueMessage): void {
  queue.push(message);
}

export function processNext(): "empty" | "processed" {
  const message = queue.shift();
  if (!message) return "empty";
  persistResult(message);
  notifyExternalSystem(message.requestId);
  return "processed";
}

function persistResult(message: QueueMessage): void {
  rows.set(message.requestId, message.payload.toUpperCase());
}

function notifyExternalSystem(requestId: string): void {
  // The fixture deliberately models the integration without making a network request.
  void requestId;
}
