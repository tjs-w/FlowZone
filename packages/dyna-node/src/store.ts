/**
 * Compatibility entry point for existing store fixtures. Production adapters
 * import the application service from the package root.
 */
// @ts-expect-error -- Node's source fixtures require an explicit .ts extension.
import { DynaApplicationService } from "./service.ts";

type ServiceOptions = ConstructorParameters<typeof DynaApplicationService>[0];

// The constructor-only facade is intentionally constructable for legacy fixtures.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class DynaStore {
  constructor(options: ServiceOptions = {}) {
    const service = new DynaApplicationService(options);
    return new Proxy(service, {
      get(target, property) {
        if (property === "itemContext") {
          return target.compatibilityItemContext.bind(target);
        }
        if (property === "snapshotForView") {
          return target.compatibilitySnapshotForView.bind(target);
        }
        if (property === "createView") {
          return target.compatibilityCreateView.bind(target);
        }
        if (property === "listDashboards") {
          return target.compatibilityListDashboards.bind(target);
        }
        if (property === "upsertTaskStatus") {
          return target.compatibilityUpsertTaskStatus.bind(target);
        }
        if (property === "upsertTaskStatusForDashboard") {
          return target.updateTask.bind(target);
        }
        if (property === "placeItem") {
          return target.placeItemForView.bind(target);
        }
        if (property === "archiveItem") {
          return target.archiveItemForView.bind(target);
        }
        if (property === "restoreItem") {
          return target.restoreItemForView.bind(target);
        }
        if (property === "enrichItemFromCli") {
          return (
            dashboardId: string,
            itemId: string,
            expectedFingerprint: string,
            expectedEnrichmentVersion: number,
            input: Parameters<DynaApplicationService["enrichItem"]>[4] & {
              readonly provenance?: unknown;
            },
          ) => {
            const canonicalInput = { ...input };
            delete canonicalInput.provenance;
            return target.enrichItem(
              dashboardId,
              itemId,
              expectedFingerprint,
              expectedEnrichmentVersion,
              canonicalInput,
            );
          };
        }
        if (property === "placeItemFromCli") return target.placeItem.bind(target);
        if (property === "placeItemsFromCli") return target.placeMany.bind(target);
        if (property === "archiveItemFromCli") return target.archiveItem.bind(target);
        if (property === "restoreItemFromCli") return target.restoreItem.bind(target);
        if (property === "createTodoFromCli") return target.createTodo.bind(target);
        if (property === "createFollowUpFromCli") return target.createFollowUp.bind(target);
        const value: unknown = Reflect.get(target, property, target);
        if (typeof value !== "function") return value;
        return (...args: unknown[]): unknown => {
          const result: unknown = Reflect.apply(value, target, args);
          return result;
        };
      },
    });
  }
}

// @ts-expect-error -- Node's source fixtures require an explicit .ts extension.
export { DynaCliStoreError } from "./service.ts";
