import { schema } from "@json-render/react/schema";
import { z } from "zod";

import {
  DynaNextStepSchema,
  DynaPersonSignalSchema,
  DynaPrioritySchema,
  DynaPublisherSchema,
  DynaSourceRefSchema,
  DynaSourceSchema,
  DynaTaskStatusSchema,
} from "./index.js";

const IdentifierSchema = z.string().trim().min(1).max(256);
const TimestampSchema = z.iso.datetime({ offset: true });

const ActionDescriptorSchema = z
  .object({
    name: z.enum([
      "annotate",
      "open_source",
      "create_codex_task",
      "open_codex_task",
      "refresh_codex_status",
    ]),
    label: z.string().min(1).max(64),
    taskId: IdentifierSchema.optional(),
    taskHostId: IdentifierSchema.optional(),
  })
  .strict();

const [SucceededTaskStatusSchema, OtherTaskStatusSchema] = DynaTaskStatusSchema.options;

const DynaTaskStatusPropsSchema = z.discriminatedUnion("state", [
  SucceededTaskStatusSchema.extend({
    itemId: z.uuid(),
    itemFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
  OtherTaskStatusSchema.extend({
    itemId: z.uuid(),
    itemFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
]);

/**
 * Server-side allowlist for deterministic Dyna render specifications.
 *
 * Keep this catalog on the explicit `@flowzone/dyna-contracts/catalog`
 * subpath. Domain and UI payload consumers should import the package root so
 * their browser bundles do not pull the json-render runtime.
 */
export const dynaCatalog = schema.createCatalog({
  components: {
    Dashboard: {
      props: z
        .object({
          dashboardId: z.uuid(),
          name: z.string().max(96),
          description: z.string().max(500),
          freshness: z.enum(["fresh", "aging", "stale"]),
          generatedAt: TimestampSchema,
          revision: z.number().int().nonnegative(),
        })
        .strict(),
      slots: ["default"],
      description: "Top-level executive dashboard surface.",
    },
    SummaryStrip: {
      props: z
        .object({
          focus: z.number().int().nonnegative(),
          leadership: z.number().int().nonnegative(),
          shown: z.number().int().nonnegative(),
          total: z.number().int().nonnegative(),
        })
        .strict(),
      slots: [],
      description: "Compact counts of urgent and total signals.",
    },
    Section: {
      props: z
        .object({
          title: z.string().min(1).max(96),
          emptyMessage: z.string().max(200),
          attention: z.boolean().optional(),
        })
        .strict(),
      slots: ["default"],
      description: "A priority group in the dashboard.",
    },
    QueueView: {
      props: z.object({}).strict(),
      slots: ["default"],
      description: "Priority queue view with schedule context.",
    },
    PipelineView: {
      props: z.object({}).strict(),
      slots: ["default"],
      description: "Progress pipeline projected from the same Dyna items.",
    },
    PipelineColumn: {
      props: z
        .object({
          state: z.enum(["todo", "executing", "paused", "attention", "completed"]),
          title: z.string().trim().min(1).max(64),
          count: z.number().int().nonnegative(),
        })
        .strict(),
      slots: ["default"],
      description: "One fixed workflow column in the Dyna progress pipeline.",
    },
    PriorityCard: {
      props: z
        .object({
          itemId: z.uuid(),
          fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
          source: DynaSourceSchema,
          sourceRef: DynaSourceRefSchema,
          sourceLabel: z.string().trim().min(1).max(128),
          title: z.string().max(200),
          summary: z.string().max(1_000),
          sourcePriority: DynaPrioritySchema,
          priority: DynaPrioritySchema,
          priorityReason: z.string().max(500),
          sourceUpdatedAt: TimestampSchema,
          dueAt: TimestampSchema.optional(),
          labels: z.array(z.string().max(64)).max(20),
          people: z.array(DynaPersonSignalSchema).max(8),
          leadershipScore: z.number().int().min(0).max(120),
          priorityMode: z.enum(["source", "enrichment", "leadership", "manual"]),
          sequence: z.number().int().nonnegative().optional(),
          workflowState: z.enum(["todo", "executing", "paused", "attention", "completed"]),
          outcome: z.string().trim().min(1).max(200).optional(),
          followUpOfItemId: z.uuid().optional(),
          canMoveEarlier: z.boolean(),
          canMoveLater: z.boolean(),
          searchText: z.string().max(5_000),
          attention: z.string().trim().min(1).max(500).optional(),
          plan: z.array(z.string().trim().min(1).max(200)).max(4),
          nextSteps: z.array(DynaNextStepSchema).max(4),
          enrichmentState: z.enum(["active", "stale"]).optional(),
          annotationCount: z.number().int().nonnegative(),
          annotationPreview: z.array(z.string().trim().min(1).max(1_000)).max(3),
          actions: z.array(ActionDescriptorSchema).min(1).max(3),
        })
        .strict(),
      slots: ["default"],
      description: "One bounded actionable signal from an approved source.",
    },
    TaskStatus: {
      props: DynaTaskStatusPropsSchema,
      slots: [],
      description: "Controller-reported metadata for an explicitly linked Codex task.",
    },
    ScheduleStatus: {
      props: DynaPublisherSchema,
      slots: [],
      description: "Native Codex schedule identity and last reported publication status.",
    },
    EmptyState: {
      props: z.object({ message: z.string().min(1).max(200) }).strict(),
      slots: [],
      description: "An empty dashboard or section message.",
    },
  },
  actions: {},
});

export type DynaRenderSpec = typeof dynaCatalog._specType;
