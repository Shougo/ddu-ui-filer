import {
  ActionFlags,
  BaseUi,
  Context,
  DduItem,
  DduOptions,
  UiActions,
  UiOptions,
} from "https://deno.land/x/ddu_vim@v0.13/types.ts";
import { Denops, fn } from "https://deno.land/x/ddu_vim@v0.13/deps.ts";

type Params = {};

export class Ui extends BaseUi<Params> {
  private items: DduItem[] = [];

  refreshItems(args: {
    items: DduItem[];
  }): void {
    this.items = args.items;
  }

  async redraw(args: {
    denops: Denops;
    context: Context;
    options: DduOptions;
    uiOptions: UiOptions;
    uiParams: Params;
  }): Promise<void> {
  }

  async quit(args: {
    denops: Denops;
    context: Context;
    options: DduOptions;
    uiParams: Params;
  }): Promise<void> {
  }

  actions: UiActions<Params> = {
    itemAction: async (args: {
      denops: Denops;
      options: DduOptions;
      uiParams: Params;
      actionParams: unknown;
    }) => {
      return Promise.resolve(ActionFlags.None);
    },
    preview: async (args: {
      denops: Denops;
      context: Context;
      options: DduOptions;
      uiParams: Params;
    }) => {
      return Promise.resolve(ActionFlags.Persist);
    },
    // deno-lint-ignore require-await
    refreshItems: async (_: {
      denops: Denops;
    }) => {
      return Promise.resolve(ActionFlags.RefreshItems);
    },
    quit: async (args: {
      denops: Denops;
      context: Context;
      options: DduOptions;
      uiParams: Params;
    }) => {
      await this.quit({
        denops: args.denops,
        context: args.context,
        options: args.options,
        uiParams: args.uiParams,
      });
      await args.denops.call("ddu#pop", args.options.name);
      return Promise.resolve(ActionFlags.None);
    },
    toggleSelectItem: async (args: {
      denops: Denops;
      options: DduOptions;
      uiParams: Params;
    }) => {
      return Promise.resolve(ActionFlags.Redraw);
    },
  };

  params(): Params {
    return {};
  }

  private async getIndex(
    denops: Denops,
  ): Promise<number> {
    return (await fn.line(denops, ".")) - 1;
  }
}
