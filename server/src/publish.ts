import {
  DynaPublishSourceSlicesSchema,
  DynaScheduledPublishedItemSchema,
} from "@flowzone/dyna-contracts";
import { DynaService } from "@flowzone/dyna-node";
import { z } from "zod";

const MAX_INPUT_BYTES = 256 * 1024;

const PublishEnvelopeSchema = z
  .object({
    runId: z.string().trim().min(1).max(256),
    sourceCompletedAt: z.iso.datetime({ offset: true }),
    mode: z.enum(["replace", "upsert"]).default("replace"),
    status: z.enum(["succeeded", "partial", "failed"]).default("succeeded"),
    failureMessage: z.string().trim().min(1).max(500).optional(),
    sourceSlices: DynaPublishSourceSlicesSchema.optional(),
    items: z.array(DynaScheduledPublishedItemSchema).max(200),
  })
  .strict();

function publisherIdFromArguments(arguments_: readonly string[]): string {
  if (arguments_.length !== 2 || arguments_[0] !== "--publisher") {
    throw new Error("usage");
  }
  return z.uuid().parse(arguments_[1]);
}

async function readBoundedInput(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const value: unknown = chunk;
    if (!(value instanceof Uint8Array) && typeof value !== "string") {
      throw new Error("invalid-input-chunk");
    }
    const bytes = Buffer.from(value);
    size += bytes.length;
    if (size > MAX_INPUT_BYTES) throw new Error("input-too-large");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  const publisherId = publisherIdFromArguments(process.argv.slice(2));
  const input = PublishEnvelopeSchema.parse(JSON.parse(await readBoundedInput()) as unknown);
  const service = new DynaService();
  try {
    const result = service.publishLocal(publisherId, input.items, {
      runId: input.runId,
      sourceCompletedAt: input.sourceCompletedAt,
      mode: input.mode,
      status: input.status,
      ...(input.failureMessage ? { failureMessage: input.failureMessage } : {}),
      ...(input.sourceSlices ? { sourceSlices: input.sourceSlices } : {}),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    service.close();
  }
}

main().catch(() => {
  process.stderr.write(
    "flowzone-publish failed: provide a valid publisher ID and a schema-valid JSON run on stdin.\n",
  );
  process.exitCode = 1;
});
