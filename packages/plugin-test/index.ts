import type { KorePlugin, PluginStartDeps, MemoryEvent } from "@kore/shared-types";

let deps: PluginStartDeps | null = null;

const testPlugin: KorePlugin = {
  name: "test-plugin",

  async start(d: PluginStartDeps) {
    deps = d;
    console.log("[test-plugin] started");
  },

  async stop() {
    deps = null;
    console.log("[test-plugin] stopped");
  },

  async onMemoryIndexed(event: MemoryEvent) {
    console.log("[test-plugin] onMemoryIndexed:", event.id, "taskId:", event.taskId);
    if (deps && event.taskId) {
      deps.setExternalKeyMapping(`task:${event.taskId}`, event.id);
    }
  },
};

export default testPlugin;
