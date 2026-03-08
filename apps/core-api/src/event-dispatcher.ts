import type { KorePlugin, MemoryEvent } from "@kore/shared-types";

/**
 * Dispatches plugin lifecycle events to all registered plugins.
 * Plugin errors are logged but never crash the core engine (plugin_system.md §4.3).
 */
export class EventDispatcher {
  private plugins: KorePlugin[] = [];

  registerPlugins(plugins: KorePlugin[]): void {
    this.plugins = plugins;
  }

  async emit(
    event: "memory.deleted" | "memory.updated" | "memory.indexed",
    payload: MemoryEvent
  ): Promise<void> {
    const hookMap = {
      "memory.deleted": "onMemoryDeleted",
      "memory.updated": "onMemoryUpdated",
      "memory.indexed": "onMemoryIndexed",
    } as const;

    const hookName = hookMap[event];

    for (const plugin of this.plugins) {
      const hook = plugin[hookName];
      if (hook) {
        try {
          await hook(payload);
        } catch (err) {
          console.error(
            `Plugin "${plugin.name}" threw on ${event}:`,
            err
          );
        }
      }
    }
  }
}
