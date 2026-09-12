import {
  DynaDashboardSnapshotSchema,
  DynaUiPayloadSchema,
  type DynaPublishedItem,
  type DynaTaskStatus,
  type DynaUiPayload,
  type DynaSetItemStatusInput,
  type DynaWorkUpdateInput,
} from "@flowzone/dyna-contracts";

import {
  DynaStore,
  type DynaPublishOptions,
  type DynaPublishResult,
  type DynaStoreOptions,
  type DynaCliArchiveInput,
  type DynaCliEnrichmentInput,
  type DynaCliFollowUpInput,
  type DynaCliPlacementInput,
  type DynaItemActivityOptions,
  type DynaItemHistoryOptions,
} from "./store.js";

export class DynaService {
  readonly store: DynaStore;

  constructor(options: DynaStoreOptions = {}) {
    this.store = new DynaStore(options);
  }

  close(): void {
    this.store.close();
  }

  render(dashboardId: string): DynaUiPayload {
    const snapshot = this.store.snapshot(dashboardId);
    const payload = {
      schema: "dyna/ui-v7" as const,
      viewToken: this.store.createView(dashboardId),
      snapshot,
    };
    return DynaUiPayloadSchema.parse(payload);
  }

  refresh(viewToken: string, query = "", scope: "active" | "archive" = "active"): DynaUiPayload {
    const snapshot = this.store.snapshotForView(viewToken, query, scope);
    return DynaUiPayloadSchema.parse({
      schema: "dyna/ui-v7",
      viewToken,
      snapshot,
    });
  }

  publish(
    publisherId: string,
    secret: string,
    items: readonly DynaPublishedItem[],
    options: DynaPublishOptions,
  ): DynaPublishResult {
    return this.store.publish(publisherId, secret, items, options);
  }

  publishLocal(
    publisherId: string,
    items: readonly DynaPublishedItem[],
    options: DynaPublishOptions,
  ): DynaPublishResult {
    return this.store.publishLocal(publisherId, items, options);
  }

  snapshot(dashboardId: string) {
    return DynaDashboardSnapshotSchema.parse(this.store.snapshot(dashboardId));
  }

  updateTask(dashboardId: string, itemId: string, status: DynaTaskStatus): void {
    this.store.upsertTaskStatusForDashboard(dashboardId, itemId, status);
  }

  showItem(dashboardId: string, itemId: string) {
    return this.store.showItem(dashboardId, itemId);
  }

  itemHistory(dashboardId: string, itemId: string, options?: DynaItemHistoryOptions) {
    return this.store.itemHistory(dashboardId, itemId, options);
  }

  itemActivityPage(dashboardId: string, itemId: string, options?: DynaItemActivityOptions) {
    return this.store.itemActivityPage(dashboardId, itemId, options);
  }

  setItemStatus(input: DynaSetItemStatusInput) {
    return this.store.setItemStatus(input);
  }

  recordWorkUpdate(
    dashboardId: string,
    itemId: string,
    expectedFingerprint: string,
    input: DynaWorkUpdateInput,
  ) {
    return this.store.recordWorkUpdate(dashboardId, itemId, expectedFingerprint, input);
  }

  enrichItem(
    dashboardId: string,
    itemId: string,
    expectedFingerprint: string,
    expectedEnrichmentVersion: number,
    input: DynaCliEnrichmentInput,
  ) {
    return this.store.enrichItemFromCli(
      dashboardId,
      itemId,
      expectedFingerprint,
      expectedEnrichmentVersion,
      input,
    );
  }

  placeItem(
    dashboardId: string,
    itemId: string,
    expectedRevision: number,
    expectedFingerprint: string,
    input: DynaCliPlacementInput,
  ) {
    return this.store.placeItemFromCli(
      dashboardId,
      itemId,
      expectedRevision,
      expectedFingerprint,
      input,
    );
  }

  archiveItem(
    dashboardId: string,
    itemId: string,
    expectedRevision: number,
    expectedFingerprint: string,
    input: DynaCliArchiveInput,
  ) {
    return this.store.archiveItemFromCli(
      dashboardId,
      itemId,
      expectedRevision,
      expectedFingerprint,
      input,
    );
  }

  restoreItem(
    dashboardId: string,
    itemId: string,
    expectedRevision: number,
    expectedFingerprint: string,
    requestId: string,
  ) {
    return this.store.restoreItemFromCli(
      dashboardId,
      itemId,
      expectedRevision,
      expectedFingerprint,
      requestId,
    );
  }

  createFollowUp(
    dashboardId: string,
    sourceItemId: string,
    expectedRevision: number,
    expectedFingerprint: string,
    input: DynaCliFollowUpInput,
  ) {
    return this.store.createFollowUpFromCli(
      dashboardId,
      sourceItemId,
      expectedRevision,
      expectedFingerprint,
      input,
    );
  }
}
