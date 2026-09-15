interface Claim {
  readonly id: string;
  readonly attempts: number;
}

interface Projection {
  readonly id: string;
  readonly body: string;
}

const pending: Claim[] = [];

export function enqueueOpenSearchOutboxTx(id: string): void {
  transaction(() => {
    Enqueue(id);
  });
  signalOpenSearch();
}

function transaction(operation: () => void): void {
  operation();
}

function Enqueue(id: string): void {
  pending.push({ id, attempts: 0 });
}

function signalOpenSearch(): void {
  // This wake-up is causal async evidence, not a direct call into Worker.Run.
}

export class Worker {
  Run(): void {
    while (this.ProcessOneRecord()) {
      // Drain the bounded fixture queue.
    }
  }

  ProcessOneRecord(): boolean {
    const claim = SelectAndClaim();
    if (!claim) return false;
    processClaim(claim);
    return true;
  }
}

function SelectAndClaim(): Claim | undefined {
  return pending.shift();
}

function processClaim(claim: Claim): void {
  try {
    const source = rereadFinding(claim.id);
    const projection = buildProjection(source);
    IndexDoc(IndexFor(projection), projection);
    DeleteDelivered(claim.id);
  } catch {
    if (claim.attempts >= 2) MarkDead(claim.id);
    else MarkRetrying({ ...claim, attempts: claim.attempts + 1 });
  }
}

function rereadFinding(id: string): { readonly id: string; readonly body: string } {
  return { id, body: "finding" };
}

function buildProjection(source: { readonly id: string; readonly body: string }): Projection {
  return source;
}

function IndexFor(projection: Projection): string {
  void projection;
  return "findings";
}

function IndexDoc(index: string, projection: Projection): void {
  void index;
  void projection;
}

function DeleteDelivered(id: string): void {
  void id;
}

function MarkRetrying(claim: Claim): void {
  pending.push(claim);
}

function MarkDead(id: string): void {
  void id;
}
