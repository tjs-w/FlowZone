import {
  DynaDashboardSnapshotSchema,
  DynaUiPayloadSchema,
  type DynaPublishedItem,
  type DynaTaskStatus,
  type DynaUiPayload,
} from "@flowzone/dyna-contracts";
import { compileDashboard } from "@flowzone/dyna-core";

import {
  DynaStore,
  type DynaPublishOptions,
  type DynaPublishResult,
  type DynaStoreOptions,
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
    compileDashboard(snapshot);
    const payload = {
      schema: "dyna/ui-v5" as const,
      viewToken: this.store.createView(dashboardId),
      snapshot,
    };
    return DynaUiPayloadSchema.parse(payload);
  }

  refresh(viewToken: string, query = ""): DynaUiPayload {
    const snapshot = this.store.snapshotForView(viewToken, query);
    compileDashboard(snapshot);
    return DynaUiPayloadSchema.parse({
      schema: "dyna/ui-v5",
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

  snapshot(dashboardId: string) {
    return DynaDashboardSnapshotSchema.parse(this.store.snapshot(dashboardId));
  }

  updateTask(itemId: string, status: DynaTaskStatus): void {
    this.store.upsertTaskStatus(itemId, status);
  }
}
