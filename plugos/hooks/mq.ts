import { Hook, Manifest } from "../types.ts";
import { System } from "../system.ts";
import { DexieMQ } from "../lib/mq.dexie.ts";
import { fullQueueName } from "../lib/mq_util.ts";
import { Message } from "$sb/types.ts";

type MQSubscription = {
  queue: string;
  batchSize?: number;
  autoAck?: boolean;
};

export type MQHookT = {
  mqSubscriptions?: MQSubscription[];
};

export class MQHook implements Hook<MQHookT> {
  subscriptions: (() => void)[] = [];

  constructor(private system: System<MQHookT>, readonly mq: DexieMQ) {
  }

  apply(system: System<MQHookT>): void {
    this.system = system;
    system.on({
      plugLoaded: () => {
        this.reloadQueues();
      },
      plugUnloaded: () => {
        this.reloadQueues();
      },
    });

    this.reloadQueues();
  }

  stop() {
    // console.log("Unsubscribing from all queues");
    this.subscriptions.forEach((sub) => sub());
    this.subscriptions = [];
  }

  reloadQueues() {
    this.stop();
    for (const plug of this.system.loadedPlugs.values()) {
      if (!plug.manifest) {
        continue;
      }
      for (
        const [name, functionDef] of Object.entries(
          plug.manifest.functions,
        )
      ) {
        if (!functionDef.mqSubscriptions) {
          continue;
        }
        const subscriptions = functionDef.mqSubscriptions;
        for (const subscriptionDef of subscriptions) {
          const queue = fullQueueName(plug.name!, subscriptionDef.queue);
          // console.log("Subscribing to queue", queue);
          this.subscriptions.push(
            this.mq.subscribe(
              queue,
              {
                batchSize: subscriptionDef.batchSize,
              },
              async (messages: Message[]) => {
                try {
                  await plug.invoke(name, [messages]);
                  if (subscriptionDef.autoAck) {
                    await this.mq.batchAck(queue, messages.map((m) => m.id));
                  }
                } catch (e: any) {
                  console.error(
                    "Execution of mqSubscription for queue",
                    queue,
                    "invoking",
                    name,
                    "with messages",
                    messages,
                    "failed:",
                    e,
                  );
                }
              },
            ),
          );
        }
      }
    }
  }

  validateManifest(manifest: Manifest<MQHookT>): string[] {
    const errors: string[] = [];
    for (const functionDef of Object.values(manifest.functions)) {
      if (!functionDef.mqSubscriptions) {
        continue;
      }
      for (const subscriptionDef of functionDef.mqSubscriptions) {
        if (!subscriptionDef.queue) {
          errors.push("Missing queue name for mqSubscription");
        }
      }
    }
    return errors;
  }
}