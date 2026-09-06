import { type DynaCard, type DynaDashboardSnapshot } from "@flowzone/dyna-contracts";
import { dynaCatalog, type DynaRenderSpec } from "@flowzone/dyna-contracts/catalog";

const PRIORITY_ORDER = ["critical", "high", "normal", "low"] as const;

export function compareDynaCards(left: DynaCard, right: DynaCard): number {
  const byPriority = PRIORITY_ORDER.indexOf(left.priority) - PRIORITY_ORDER.indexOf(right.priority);
  if (byPriority !== 0) return byPriority;
  const bySequence =
    (left.sequence ?? Number.MAX_SAFE_INTEGER) - (right.sequence ?? Number.MAX_SAFE_INTEGER);
  if (bySequence !== 0) return bySequence;
  const byLeadership = right.leadershipScore - left.leadershipScore;
  if (byLeadership !== 0) return byLeadership;
  const leftDue = left.dueAt ?? "9999";
  const rightDue = right.dueAt ?? "9999";
  const byDue = leftDue.localeCompare(rightDue);
  if (byDue !== 0) return byDue;
  const byUpdatedAt = right.sourceUpdatedAt.localeCompare(left.sourceUpdatedAt);
  return byUpdatedAt !== 0 ? byUpdatedAt : left.id.localeCompare(right.id);
}

function cardActions(card: DynaCard) {
  const linkedTask = card.linkedTasks[0];
  const sourceActions =
    card.source === "manual" ? [] : [{ name: "open_source" as const, label: "Open source" }];
  return linkedTask
    ? [
        ...sourceActions,
        {
          name: "open_codex_task" as const,
          label: "Open Codex",
          taskId: linkedTask.taskId,
          taskHostId: linkedTask.hostId,
        },
        { name: "annotate" as const, label: "Add note" },
      ]
    : [
        ...sourceActions,
        { name: "annotate" as const, label: "Add note" },
        { name: "create_codex_task" as const, label: "Create Codex task" },
      ];
}

export function compileDashboard(snapshot: DynaDashboardSnapshot): DynaRenderSpec {
  const elements: Record<string, DynaRenderSpec["elements"][string]> = {};
  const queueKeys: string[] = [];
  elements["summary"] = {
    type: "SummaryStrip",
    props: {
      focus: snapshot.counts.critical + snapshot.counts.high,
      leadership: snapshot.counts.leadership,
      shown: snapshot.cards.length,
      total: snapshot.counts.total,
    },
    children: [],
  };

  const addCard = (card: DynaCard): string => {
    const cardKey = `card-${card.id}`;
    if (elements[cardKey]) return cardKey;
    const taskChildren: string[] = [];
    for (const task of card.linkedTasks) {
      const taskKey = `${cardKey}-task-${task.hostId}-${task.taskId}`;
      elements[taskKey] = {
        type: "TaskStatus",
        props: { ...task, itemId: card.id, itemFingerprint: card.fingerprint },
        children: [],
      };
      taskChildren.push(taskKey);
    }
    elements[cardKey] = {
      type: "PriorityCard",
      props: {
        itemId: card.id,
        fingerprint: card.fingerprint,
        source: card.source,
        sourceRef: card.sourceRef,
        sourceLabel: card.sourceLabel,
        title: card.title,
        summary: card.summary,
        sourcePriority: card.sourcePriority,
        priority: card.priority,
        priorityReason: card.priorityReason,
        sourceUpdatedAt: card.sourceUpdatedAt,
        ...(card.dueAt ? { dueAt: card.dueAt } : {}),
        labels: card.labels,
        people: card.people,
        leadershipScore: card.leadershipScore,
        priorityMode: card.priorityMode,
        ...(card.sequence !== undefined ? { sequence: card.sequence } : {}),
        workflowState: card.workflowState,
        ...(card.outcome ? { outcome: card.outcome } : {}),
        ...(card.followUpOfItemId ? { followUpOfItemId: card.followUpOfItemId } : {}),
        canMoveEarlier: card.canMoveEarlier,
        canMoveLater: card.canMoveLater,
        searchText: [
          ...card.annotations.map((annotation) => annotation.body),
          ...card.linkedTasks.flatMap((task) => [task.title, task.state, task.outcome ?? ""]),
        ]
          .join(" ")
          .slice(0, 5_000),
        ...(card.attention ? { attention: card.attention } : {}),
        plan: card.plan,
        nextSteps: card.nextSteps,
        ...(card.enrichmentState ? { enrichmentState: card.enrichmentState } : {}),
        annotationCount: card.annotations.length,
        annotationPreview: card.annotations.slice(0, 3).map((annotation) => annotation.body),
        actions: cardActions(card),
      },
      children: taskChildren,
    };
    return cardKey;
  };

  for (const priority of PRIORITY_ORDER) {
    const cards = snapshot.cards
      .filter((card) => card.workflowState !== "completed" && card.priority === priority)
      .sort(compareDynaCards);
    if (cards.length === 0) continue;
    const sectionKey = `queue-section-${priority}`;
    const children = cards.map((card) => addCard(card));
    elements[sectionKey] = {
      type: "Section",
      props: {
        title:
          priority === "normal"
            ? "Keep moving"
            : priority === "critical"
              ? "Act now"
              : priority === "high"
                ? "Needs your attention"
                : "On the radar",
        emptyMessage: "Nothing in this section.",
      },
      children,
    };
    queueKeys.push(sectionKey);
  }

  if (
    snapshot.query &&
    snapshot.cards.length > 0 &&
    snapshot.cards.every((card) => card.workflowState === "completed")
  ) {
    elements["completed-search-note"] = {
      type: "EmptyState",
      props: { message: "Matching completed work is available in the Progress pipeline." },
      children: [],
    };
    queueKeys.push("completed-search-note");
  }

  if (snapshot.cards.length === 0) {
    elements["empty"] = {
      type: "EmptyState",
      props: {
        message: snapshot.query
          ? `No dashboard items match “${snapshot.query}”.`
          : "No signals have been published to this dashboard yet.",
      },
      children: [],
    };
    queueKeys.push("empty");
  }

  if (snapshot.schedules.length > 0) {
    const scheduleChildren: string[] = [];
    for (const schedule of snapshot.schedules) {
      const scheduleKey = `schedule-${schedule.id}`;
      elements[scheduleKey] = { type: "ScheduleStatus", props: schedule, children: [] };
      scheduleChildren.push(scheduleKey);
    }
    elements["section-schedules"] = {
      type: "Section",
      props: {
        title: "Signal runs",
        emptyMessage: "No schedules are attached.",
        attention: snapshot.schedules.some(
          (schedule) =>
            schedule.lastRunStatus === "failed" ||
            schedule.lastRunStatus === "partial" ||
            schedule.scheduleState !== "active",
        ),
      },
      children: scheduleChildren,
    };
    queueKeys.push("section-schedules");
  }

  elements["queue"] = { type: "QueueView", props: {}, children: queueKeys };

  const pipelineKeys: string[] = [];
  const pipelineStates = [
    ["todo", "To do"],
    ["executing", "Executing in Codex"],
    ["paused", "Paused for input"],
    ["attention", "Needs attention"],
    ["completed", "Completed"],
  ] as const;
  for (const [state, title] of pipelineStates) {
    const cards = snapshot.cards
      .filter((card) => card.workflowState === state)
      .sort(compareDynaCards);
    const key = `pipeline-${state}`;
    elements[key] = {
      type: "PipelineColumn",
      props: { state, title, count: cards.length },
      children: cards.map((card) => addCard(card)),
    };
    pipelineKeys.push(key);
  }
  elements["pipeline"] = { type: "PipelineView", props: {}, children: pipelineKeys };

  elements["root"] = {
    type: "Dashboard",
    props: {
      dashboardId: snapshot.dashboard.id,
      name: snapshot.dashboard.name,
      description: snapshot.dashboard.description,
      freshness: snapshot.freshness,
      generatedAt: snapshot.generatedAt,
      revision: snapshot.revision,
    },
    children: ["summary", "queue", "pipeline"],
  };
  const spec = { root: "root", elements } as DynaRenderSpec;
  const validated = dynaCatalog.validate(spec);
  if (!validated.success || !validated.data) {
    throw new Error("The compiled Dyna dashboard did not satisfy its component catalog.");
  }
  return validated.data;
}
